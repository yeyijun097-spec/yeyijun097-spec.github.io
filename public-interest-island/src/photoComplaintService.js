import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { formatComplaintDetails, parseComplaintText, scoreOrders, suggestRelationship, uniqueUserIds } from "./photoComplaintParser.js";
import { COMPLAINT_TAXONOMY, suggestProblemLabels } from "./complaintTaxonomy.js";

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const TERMINAL = new Set(["completed", "manual_check", "failed", "cancelled"]);
export const PHOTO_STATUS_LABELS = {
  recognizing: "识别中", review: "待复核", queued: "排队中", waiting_login: "等待扫码",
  filling: "自动填表", awaiting_confirmation: "待提交确认", submitting: "提交中",
  completed: "已完成", manual_check: "需人工检查", failed: "失败", cancelled: "已取消"
};

export class PhotoComplaintService {
  constructor({ config, repository, browserClient, automation, ocrRunner } = {}) {
    this.config = config;
    this.repository = repository;
    this.browserClient = browserClient;
    this.automation = automation;
    this.ocrRunner = ocrRunner || ((file) => runOcr(config, file));
    this.baseDir = path.resolve(config.photoComplaints?.tempDir || path.join(config.storage.dataDir, "photo-complaints"));
    this.uploadDir = path.join(this.baseDir, "uploads");
    this.screenshotDir = path.join(this.baseDir, "screenshots");
    fs.mkdirSync(this.uploadDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.screenshotDir, { recursive: true, mode: 0o700 });
    this.queue = [];
    this.running = false;
    this.loginWatchTimers = new Map();
    this.loginWatchBusy = false;
    this.loginPollMs = Math.max(500, Number(config.photoComplaints?.loginPollMs || 1500));
    this.loginGraceMs = Math.max(10000, Number(config.photoComplaints?.loginGraceMs || 60000));
    this.loginWatchStartedAt = new Map();
    this.cleanup();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
    for (const task of this.repository.list("", true).filter((item) => item.status === "waiting_login")) {
      this.scheduleLoginWatch(task.id, task.ownerId);
    }
  }

  createTasks(files, ownerId) {
    if (!Array.isArray(files) || files.length < 1 || files.length > 10) throw serviceError("每次请选择1至10张图片", 400);
    const now = new Date();
    const batchId = `batch_${now.getTime()}_${crypto.randomBytes(4).toString("hex")}`;
    const tasks = files.map((file) => {
      const id = crypto.randomUUID();
      const ext = extensionFor(file.mimetype);
      const target = path.join(this.uploadDir, `${id}${ext}`);
      fs.renameSync(file.path, target); fs.chmodSync(target, 0o600);
      const task = this.repository.create({ id, ownerId, status: "queued", queuePosition: this.queue.length + 1,
        originalName: normalizeUploadedFilename(file.originalname || "图片"), mimeType: file.mimetype, imagePath: target, data: { batchId },
        createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString() });
      this.queue.push({ kind: "ocr", taskId: id, ownerId });
      return this.publicTask(task);
    });
    this.refreshQueuePositions(); this.pump(); return tasks;
  }

  list(ownerId, isAdmin = false) { return this.repository.list(ownerId, isAdmin).map((t) => this.publicTask(t)); }
  get(id, ownerId, isAdmin = false) { return this.publicTask(this.requireTask(id, ownerId, isAdmin)); }

  updateReview(id, ownerId, patch) {
    const task = this.requireTask(id, ownerId, false);
    if (!['review', 'waiting_login'].includes(task.status)) throw serviceError("当前状态不可修改复核内容", 409);
    const allowed = ["externalNumber", "registeredAt", "name", "phone", "amount", "productName", "disputeAt", "complaintType",
      "source", "relationship", "details", "notes", "userId", "orderType", "mainOrderId", "relatedOrderId", "problemLabels"];
    const data = { ...task.data };
    for (const key of allowed) if (Object.hasOwn(patch || {}, key)) data[key] = sanitizeField(key, patch[key]);
    if ([...String(data.details || "")].length > 500) throw serviceError("投诉详情不能超过500字", 400);
    return this.publicTask(this.repository.update(id, { data, error: "" }));
  }

  async requestFill(id, ownerId) {
    const task = this.requireTask(id, ownerId, false);
    if (task.status !== "review" && task.status !== "waiting_login") throw serviceError("请先完成识别结果复核", 409);
    validateForLookup(task.data);
    if (this.queue.some((item) => item.taskId === id && item.kind === "fill")) throw serviceError("该任务已在自动填表队列中", 409);
    this.repository.update(id, { status: "queued", error: "" });
    this.queue.push({ kind: "fill", taskId: id, ownerId }); this.refreshQueuePositions(); this.pump();
    return this.get(id, ownerId);
  }

  async resumeLogin(id, ownerId) {
    const task = this.requireTask(id, ownerId, false);
    if (task.status !== "waiting_login") throw serviceError("当前任务不在等待扫码状态", 409);
    this.repository.update(id, { status: "queued", error: "" });
    this.clearLoginWatch(id);
    this.queue.push({ kind: "fill", taskId: id, ownerId }); this.refreshQueuePositions(); this.pump();
    return this.get(id, ownerId);
  }

  confirmToken(id, ownerId, ttlMs = TOKEN_TTL_MS) {
    const task = this.requireTask(id, ownerId, false);
    if (task.status !== "awaiting_confirmation" || !task.formFingerprint) throw serviceError("表单尚未完成或已失效", 409);
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    this.repository.createToken({ tokenHash: hashToken(token), taskId: id, ownerId, formFingerprint: task.formFingerprint,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() });
    return { token, expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
  }

  async adjustMainOrder(id, ownerId, mainOrderId) {
    const task = this.requireTask(id, ownerId, false);
    if (task.status !== "awaiting_confirmation") throw serviceError("仅待提交确认的任务可以调整主订单ID", 409);
    const selectedId = String(mainOrderId || "").trim();
    const candidates = Array.isArray(task.data?.orderCandidates) ? task.data.orderCandidates : [];
    if (!candidates.some((order) => String(order?.id || "") === selectedId)) {
      throw serviceError("所选主订单ID不在当前兴趣岛候选订单中", 400);
    }
    if (!this.automation?.adjustMainOrder) throw serviceError("主订单调整功能尚未配置", 503);
    await this.browserClient.activateUser(ownerId);
    const result = await this.automation.adjustMainOrder(task, selectedId, {
      browserClient: this.browserClient, screenshotDir: this.screenshotDir
    });
    const data = { ...task.data, ...(result.data || {}), mainOrderId: selectedId, relatedOrderId: "", orderSelectionReason: "用户人工调整" };
    return this.publicTask(this.repository.update(id, {
      status: "awaiting_confirmation", data, formScreenshotPath: result.formScreenshotPath,
      formFingerprint: result.formFingerprint, error: ""
    }));
  }

  submit(id, ownerId, token) {
    const task = this.requireTask(id, ownerId, false);
    if (task.status !== "awaiting_confirmation") throw serviceError("当前任务不可提交", 409);
    if (!this.repository.consumeToken(hashToken(token), id, ownerId, task.formFingerprint)) throw serviceError("确认令牌无效、已使用或已过期", 409);
    this.repository.update(id, { status: "queued", error: "" });
    this.queue.push({ kind: "submit", taskId: id, ownerId }); this.refreshQueuePositions(); this.pump();
    return this.get(id, ownerId);
  }

  cancel(id, ownerId, isAdmin = false) {
    const task = this.requireTask(id, ownerId, isAdmin); if (TERMINAL.has(task.status)) return this.publicTask(task);
    this.clearLoginWatch(id);
    this.queue = this.queue.filter((item) => item.taskId !== id); this.deleteFiles(task);
    return this.publicTask(this.repository.update(id, { status: "cancelled", queuePosition: 0, imagePath: "", error: "" }));
  }

  screenshot(id, ownerId, kind) {
    const task = this.requireTask(id, ownerId, false);
    const file = kind === "login" ? task.loginScreenshotPath : task.formScreenshotPath;
    if (!file || !this.isAllowedFile(file) || !fs.existsSync(file)) throw serviceError("截图尚未生成", 404);
    return file;
  }

  async pump() {
    if (this.running) return;
    const pending = this.queue[0];
    if (!pending) return;
    // 同一网站用户只保留一个扫码会话。已有任务等待扫码时，后续填表任务
    // 留在队列中，待登录监听确认成功后继续，不能逐张生成二维码截图。
    if (pending.kind === "fill" && this.hasWaitingLogin(pending.ownerId, pending.taskId)) return;
    const item = this.queue.shift();
    this.running = true; this.refreshQueuePositions();
    try { if (item.kind === "ocr") await this.processOcr(item); else if (item.kind === "fill") await this.processFill(item); else await this.processSubmit(item); }
    catch (error) { const task = this.repository.get(item.taskId); if (task && !TERMINAL.has(task.status)) this.repository.update(item.taskId, {
      status: error.reviewRequired ? "review" : error.manualCheck ? "manual_check" : "failed",
      data: error.data ? { ...task.data, ...error.data } : task.data,
      formScreenshotPath: error.formScreenshotPath || task.formScreenshotPath,
      error: error.message
    }); }
    finally { this.running = false; queueMicrotask(() => this.pump()); }
  }

  async processOcr(item) {
    const task = this.repository.update(item.taskId, { status: "recognizing", queuePosition: 0 });
    try {
      const ocr = await this.ocrRunner(task.imagePath);
      const parsed = parseComplaintText(ocr.text);
      const assisted = await runOptionalLlm(this.config, ocr.text, parsed).catch(() => null);
      const recognized = mergeComplaintRecognition(parsed, assisted);
      const data = { ...task.data, ...recognized, ocrAverageConfidence: Number(ocr.averageConfidence || 0), llmAssisted: Boolean(assisted) };
      this.repository.update(task.id, { status: "review", ocrText: ocr.text, data, imagePath: "" });
    } finally { fs.rmSync(task.imagePath, { force: true }); }
  }

  async processFill(item) {
    if (!this.automation) throw serviceError("兴趣岛自动填表适配器尚未配置", 503);
    let task = this.repository.update(item.taskId, { status: "filling", queuePosition: 0 });
    await this.browserClient.activateUser(item.ownerId);
    const result = await this.automation.fill(task, { browserClient: this.browserClient, screenshotDir: this.screenshotDir });
    if (result.loginRequired) {
      this.repository.update(task.id, { status: "waiting_login", loginScreenshotPath: result.loginScreenshotPath, data: { ...task.data, ...(result.data || {}) }, error: "扫码成功后将自动继续，无需手动确认" });
      this.scheduleLoginWatch(task.id, item.ownerId);
      return;
    }
    this.clearLoginWatch(task.id);
    const data = { ...task.data, ...(result.data || {}) }; validateForFill(data);
    this.repository.update(task.id, { status: "awaiting_confirmation", data, formScreenshotPath: result.formScreenshotPath,
      formFingerprint: result.formFingerprint, loginScreenshotPath: "", error: "" });
  }

  async processSubmit(item) {
    if (!this.automation) throw serviceError("兴趣岛自动提交适配器尚未配置", 503);
    const task = this.repository.update(item.taskId, { status: "submitting", queuePosition: 0 });
    try {
      await this.browserClient.activateUser(item.ownerId);
      const result = await this.automation.submit(task, { browserClient: this.browserClient });
      this.repository.update(task.id, {
        status: result.verified ? "completed" : "manual_check",
        error: result.verified ? "" : "已点击提交，但结果无法验证；请查看提交后现场并检查工单列表，系统不会自动重试",
        formScreenshotPath: result.formScreenshotPath || task.formScreenshotPath
      });
    } catch (error) {
      if (error.submissionAttempted) {
        error.manualCheck = true;
        throw error;
      }
      this.repository.update(task.id, {
        status: "review",
        queuePosition: 0,
        formFingerprint: "",
        formScreenshotPath: "",
        error: `提交前未执行官方提交：${error.message}。请重新自动填表并确认。`
      });
    }
  }

  requireTask(id, ownerId, isAdmin) { const task = this.repository.get(id); if (!task || (!isAdmin && task.ownerId !== ownerId)) throw serviceError("任务不存在", 404); return task; }
  publicTask(task) { if (!task) return null; return { ...task, formScreenshotAvailable: Boolean(task.formScreenshotPath && fs.existsSync(task.formScreenshotPath)), imagePath: undefined, loginScreenshotPath: undefined, formScreenshotPath: undefined,
    ocrText: undefined, formFingerprint: undefined, statusLabel: PHOTO_STATUS_LABELS[task.status] || task.status } }
  refreshQueuePositions() { this.queue.forEach((item, index) => this.repository.update(item.taskId, { queuePosition: index + 1 })); }
  hasWaitingLogin(ownerId, excludeTaskId = "") {
    return this.repository.list(ownerId, false).some((task) =>
      task.status === "waiting_login" && task.id !== excludeTaskId);
  }
  isAllowedFile(file) { const p = path.resolve(file); return p.startsWith(`${this.baseDir}${path.sep}`); }
  deleteFiles(task) { for (const file of [task.imagePath, task.loginScreenshotPath, task.formScreenshotPath]) if (file && this.isAllowedFile(file)) fs.rmSync(file, { force: true }); }
  cleanup() { for (const task of this.repository.expired()) { this.deleteFiles(task); this.repository.remove(task.id); } }
  scheduleLoginWatch(taskId, ownerId) {
    if (!this.browserClient || this.loginWatchTimers.has(taskId)) return;
    if (!this.loginWatchStartedAt.has(taskId)) this.loginWatchStartedAt.set(taskId, Date.now());
    const timer = setTimeout(() => {
      this.loginWatchTimers.delete(taskId);
      this.pollLoginAndResume(taskId, ownerId).catch(() => this.scheduleLoginWatch(taskId, ownerId));
    }, this.loginPollMs);
    timer.unref?.();
    this.loginWatchTimers.set(taskId, timer);
  }
  clearLoginWatch(taskId) {
    clearTimeout(this.loginWatchTimers.get(taskId));
    this.loginWatchTimers.delete(taskId);
    this.loginWatchStartedAt.delete(taskId);
  }
  async pollLoginAndResume(taskId, ownerId) {
    const task = this.repository.get(taskId);
    if (!task || task.status !== "waiting_login") return this.clearLoginWatch(taskId);
    if (this.running || this.loginWatchBusy) return this.scheduleLoginWatch(taskId, ownerId);
    this.loginWatchBusy = true;
    try {
      await this.browserClient.activateUser(ownerId);
      const page = this.browserClient.getExistingPage();
      let readiness;
      if (!page) {
        const dashboardUrl = resolveLoginProbeUrl(this.config);
        if (this.browserClient.withIsolatedPage) {
          readiness = await this.browserClient.withIsolatedPage(dashboardUrl, (probePage) =>
            this.browserClient.ensureReady(probePage, { waitMs: 5000 })).catch(() => null);
        }
        if (readiness?.ready) {
          // 企业微信扫码成功后可能会自动关闭二维码页；
          // 已保存的 Cookie 能打开后台时应直接续跑，不能再生成二维码。
        } else {
          const latest = this.repository.get(taskId);
          if (!latest || latest.status !== "waiting_login") return;
          const elapsed = Date.now() - (this.loginWatchStartedAt.get(taskId) || Date.now());
          this.repository.update(taskId, { error: elapsed < this.loginGraceMs
            ? "正在等待首次扫码授权回调，请勿重复扫码"
            : "尚未检测到登录态；如二维码已失效，请点击查看扫码页后主动刷新" });
          return;
        }
      }
      if (!readiness && /login\.work\.weixin\.qq\.com/i.test(page?.url?.() || "")) {
        await page.waitForURL((url) => !/login\.work\.weixin\.qq\.com/i.test(url.hostname), { timeout: 5000 }).catch(() => {});
        if (/login\.work\.weixin\.qq\.com/i.test(page.url?.() || "")) {
          const dashboardUrl = resolveLoginProbeUrl(this.config);
          readiness = await this.browserClient.withIsolatedPage(dashboardUrl, (probePage) =>
            this.browserClient.ensureReady(probePage, { waitMs: 5000 }));
          if (readiness.ready) await page.close().catch(() => {});
        }
      }
      if (!readiness) readiness = await this.browserClient.ensureReady(page, { waitMs: 5000 });
      if (!readiness.ready) return;
      const latest = this.repository.get(taskId);
      if (!latest || latest.status !== "waiting_login") return;
      this.repository.update(taskId, { status: "queued", error: "已检测到兴趣岛登录态，正在自动继续填表" });
      const recoverable = this.recoverBatchTasksAfterLogin(latest, ownerId);
      this.queue.unshift(
        { kind: "fill", taskId, ownerId },
        ...recoverable.map((failedTask) => ({ kind: "fill", taskId: failedTask.id, ownerId }))
      );
      this.refreshQueuePositions();
      this.pump();
    } finally {
      this.loginWatchBusy = false;
      if (this.repository.get(taskId)?.status === "waiting_login") this.scheduleLoginWatch(taskId, ownerId);
    }
  }
  recoverBatchTasksAfterLogin(anchorTask, ownerId) {
    const batchId = String(anchorTask?.data?.batchId || "");
    if (!batchId) return [];
    const recoverableError = /(登录页|协议勾选框|企业微信扫码|扫码页面|扫码截图来源|筛选条件未能切换为手机号|同一行的筛选类型与手机号输入框组合)/;
    const queuedIds = new Set(this.queue.map((item) => item.taskId));
    return this.repository.list(ownerId, false)
      .filter((task) => task.id !== anchorTask.id
        && task.status === "failed"
        && String(task.data?.batchId || "") === batchId
        && recoverableError.test(String(task.error || ""))
        && !queuedIds.has(task.id))
      .map((task) => {
        this.repository.update(task.id, { status: "queued", error: "本批次已完成扫码，正在恢复自动填表" });
        return task;
      });
  }
  close() { clearInterval(this.cleanupTimer); for (const timer of this.loginWatchTimers.values()) clearTimeout(timer); this.loginWatchTimers.clear(); this.loginWatchStartedAt.clear(); }
}

function resolveLoginProbeUrl(config) {
  return config.browser?.chanceAssUrl
    || config.browser?.complaintWorkUrl
    || config.browser?.dashboardUrl
    || "https://edu-admin.qlchat.com/saleAssign/chanceAss";
}

function runOcr(config, file) {
  return new Promise((resolve, reject) => {
    const python = config.photoComplaints?.python || "python3";
    const script = path.resolve(config.photoComplaints?.ocrScript || "scripts/photo_complaint_ocr.py");
    const child = spawn(python, [script, file], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", (c) => out += c); child.stderr.on("data", (c) => err += c);
    child.on("close", (code) => { try { const payload = JSON.parse(out.trim()); if (code || payload.error) reject(new Error(payload.error || err || "OCR执行失败")); else resolve(payload); } catch { reject(new Error(err || "OCR返回格式不正确")); } });
    child.on("error", reject);
  });
}
export async function runOptionalLlm(config, ocrText, parsed, fetchImpl = fetch) {
  const options = config.photoComplaints || {};
  const apiKey = resolveLlmApiKey(options.llmBaseUrl);
  if (!options.llmEnabled || !apiKey || !options.llmBaseUrl || !options.llmModel) return null;
  const sensitiveValues = [
    parsed?.name,
    parsed?.phone,
    parsed?.externalNumber
  ];
  const details = redactComplaintForClassification(parsed?.details, sensitiveValues);
  const sanitizedOcr = details ? "" : redactComplaintText(ocrText, sensitiveValues, 6000);
  if (!details && !sanitizedOcr) return null;
  const endpoint = resolveLlmEndpoint(options.llmBaseUrl);
  if (!endpoint) return null;
  const response = await fetchImpl(endpoint, {
    method: "POST", signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: options.llmModel, temperature: 0, response_format: { type: "json_object" }, messages: [
      { role: "system", content: details
        ? "你是投诉工单三级分类器。只能从给定分类树中选择一条完整的一级、二级、三级路径，不得创造、改写或拼接任何分类。只依据投诉正文判断。优先选择最具体且完整的标准路径；没有具体分类匹配时必须返回[\"其他\",\"其他\",\"以下分类未包含场景\"]。仅输出JSON。"
        : "你是投诉工单正文提取与三级分类器。OCR版式可能变化。detailsEvidence必须逐字复制OCR中完整、连续的投诉事实或诉求原文，不得概括、改写、补充或编造；无法找到连续原文时返回空字符串。分类只能从给定分类树选择完整路径；无具体匹配时返回[\"其他\",\"其他\",\"以下分类未包含场景\"]。仅输出JSON。" },
      { role: "user", content: JSON.stringify({
        taxonomy: COMPLAINT_TAXONOMY,
        ...(details ? { complaint: details } : { sanitizedOcr }),
        output: details ? {
          problemLabels: ["一级分类", "二级分类", "三级分类"],
          classificationConfidence: "0到1之间的数字",
          classificationReason: "不超过80字且不得复述手机号、姓名、证件号或工单号"
        } : {
          detailsEvidence: "从sanitizedOcr逐字复制的完整连续投诉正文；不得改写",
          detailsConfidence: "0到1之间的数字",
          problemLabels: ["一级分类", "二级分类", "三级分类"],
          classificationConfidence: "0到1之间的数字",
          classificationReason: "不超过80字且不得复述个人字段"
        },
        acceptance: "必须返回固定分类树中的一条完整路径；没有具体分类匹配时必须返回其他/其他/以下分类未包含场景，不得返回空数组。"
      }) }
    ] })
  });
  if (!response.ok) return null;
  try {
    const payload = await response.json(); const value = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
    const problemLabels = normalizeProblemLabels(value.problemLabels);
    const classificationConfidence = normalizeConfidence(value.classificationConfidence);
    const classificationReason = redactComplaintForClassification(value.classificationReason, sensitiveValues).slice(0, 80);
    const proposedEvidence = formatComplaintDetails(String(value.detailsEvidence || ""));
    const normalizedOcr = normalizeEvidenceText(sanitizedOcr);
    const detailsEvidence = proposedEvidence && normalizedOcr.includes(normalizeEvidenceText(proposedEvidence))
      ? proposedEvidence
      : "";
    return {
      problemLabels, classificationConfidence, classificationReason,
      detailsEvidence,
      detailsConfidence: detailsEvidence ? normalizeConfidence(value.detailsConfidence) : 0
    };
  } catch { return null; }
}
export function mergeComplaintRecognition(parsed, assisted) {
  const merged = { ...parsed };
  const evidenceConfidence = normalizeConfidence(assisted?.detailsConfidence);
  if (!merged.details && assisted?.detailsEvidence && evidenceConfidence >= 0.6) {
    const extracted = formatComplaintDetails(assisted.detailsEvidence);
    const chars = [...extracted];
    merged.detailsOriginalLength = chars.length;
    merged.details = chars.slice(0, 500).join("");
    merged.detailsTruncated = chars.length > 500;
    merged.relationship = suggestRelationship(merged.details);
    merged.confidences = { ...(merged.confidences || {}), details: evidenceConfidence };
    merged.detailsSource = "deepseek-evidence";
  }
  const localLabels = suggestProblemLabels(merged.details, merged.relationship);
  const assistedLabels = normalizeProblemLabels(assisted?.problemLabels);
  const confidence = normalizeConfidence(assisted?.classificationConfidence);
  if (assistedLabels.length === 3 && isValidProblemLabels(assistedLabels) && confidence >= 0.6) {
    merged.problemLabels = assistedLabels;
    merged.problemLabelSource = "deepseek";
    merged.problemLabelConfidence = confidence;
    merged.problemLabelReason = redactComplaintForClassification(assisted?.classificationReason, [
      parsed?.name,
      parsed?.phone,
      parsed?.externalNumber
    ]).slice(0, 80);
  } else {
    merged.problemLabels = isValidProblemLabels(localLabels) ? localLabels : [];
    merged.problemLabelSource = merged.problemLabels.length ? "rules" : "manual";
  }
  return merged;
}

export function isValidProblemLabels(labels) {
  if (!Array.isArray(labels)) return false;
  if (labels.length === 1 && labels[0] === "错误数据") return true;
  if (labels.length !== 3) return false;
  return Array.isArray(COMPLAINT_TAXONOMY[labels[0]]?.[labels[1]])
    && COMPLAINT_TAXONOMY[labels[0]][labels[1]].includes(labels[2]);
}

export function redactComplaintForClassification(value, sensitiveValues = []) {
  return redactComplaintText(value, sensitiveValues, 500);
}

function redactComplaintText(value, sensitiveValues = [], maxLength = 500) {
  let redacted = String(value || "");
  for (const sensitive of sensitiveValues) {
    const token = String(sensitive || "").trim();
    if (token.length >= 2) redacted = redacted.split(token).join("<已脱敏>");
  }
  return redacted
    .replace(/(?<!\d)1\d{10}(?!\d)/g, "<手机号>")
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, "<证件号>")
    .replace(/(?<!\d)\d{15}(?!\d)/g, "<证件号>")
    .replace(/(?:穗\s*)?12345\s*转字第?\s*[A-Za-z0-9-]{8,}\s*号?/gi, "<工单号>")
    .replace(/(?<!\d)\d{20,}(?!\d)/g, "<编号>")
    .trim()
    .slice(0, maxLength);
}

function normalizeEvidenceText(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function normalizeProblemLabels(value) {
  const labels = Array.isArray(value)
    ? value
    : String(value || "").split(/[\/＞>]/);
  return labels.map((item) => String(item).trim()).filter(Boolean).slice(0, 3);
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function resolveLlmEndpoint(baseUrl) {
  try {
    const endpoint = new URL(String(baseUrl || ""));
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) return "";
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/chat/completions`;
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString();
  } catch { return ""; }
}

function resolveLlmApiKey(baseUrl) {
  if (process.env.PHOTO_LLM_API_KEY) return process.env.PHOTO_LLM_API_KEY;
  try {
    const hostname = new URL(String(baseUrl || "")).hostname.toLowerCase();
    if (hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com")) {
      return process.env.DEEPSEEK_API_KEY || "";
    }
    if (hostname === "volces.com" || hostname.endsWith(".volces.com")) {
      return process.env.ARK_API_KEY || "";
    }
  } catch {}
  return "";
}
function validateForLookup(data) { if (!/^1\d{10}$/.test(data.phone || "")) throw serviceError("手机号缺失或格式不正确", 400); if (data.userId && !/^\d{6,20}$/.test(data.userId)) throw serviceError("人工填写的用户ID格式不正确", 400); if (!data.registeredAt || !data.source) throw serviceError("投诉时间或投诉来源缺失", 400); if (!(data.problemLabels?.length === 3 || data.problemLabels?.[0] === "错误数据")) throw serviceError("投诉内容未能识别具体三级类，请人工选择", 400); }
function validateForFill(data) { if (!data.userId || !data.mainOrderId || !data.registeredAt || !data.source) throw serviceError("用户ID、主订单ID、投诉时间或投诉来源缺失", 409); }
function sanitizeField(key, value) { if (key === "problemLabels") return Array.isArray(value) ? value.slice(0, 3).map(String) : []; const limits = { details: 500, notes: 500 }; return String(value ?? "").trim().slice(0, limits[key] || 200); }
function extensionFor(type) { return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/bmp": ".bmp" })[type] || ".img"; }
function hashToken(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function serviceError(message, statusCode = 500) { const e = new Error(message); e.statusCode = statusCode; return e; }
export function normalizeUploadedFilename(value) {
  const source = path.basename(String(value || "图片"));
  if (!/[\u0080-\u00ff]/.test(source)) return source;
  const decoded = Buffer.from(source, "latin1").toString("utf8");
  if (decoded.includes("\uFFFD")) return source;
  return /[\u3400-\u9fff]/.test(decoded) ? path.basename(decoded) : source;
}
export { scoreOrders, uniqueUserIds };
