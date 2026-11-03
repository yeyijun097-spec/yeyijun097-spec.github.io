import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseComplaintText, scoreOrders, uniqueUserIds } from "./photoComplaintParser.js";
import { suggestProblemLabels } from "./complaintTaxonomy.js";
import { cleanupDirectory } from "./lifecycleCleanup.js";

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const TERMINAL = new Set(["manual_completed", "manual_check", "failed", "cancelled"]);
export const PHOTO_STATUS_LABELS = {
  recognizing: "识别中", review: "待复核", queued: "排队中", waiting_login: "等待扫码",
  filling: "自动填表", awaiting_confirmation: "待人工提交",
  manual_completed: "人工提交完成", manual_check: "需人工检查", failed: "失败", cancelled: "已取消"
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
    this.cleanup();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
    this.restoreAfterRestart();
  }

  createTasks(files, ownerId) {
    if (!Array.isArray(files) || files.length < 1 || files.length > 10) throw serviceError("每次请选择1至10张图片", 400);
    for (const file of files) {
      if (!isSupportedImageFile(file.path, file.mimetype)) {
        for (const candidate of files) {
          try { fs.rmSync(candidate.path, { force: true }); } catch {}
        }
        throw serviceError("图片内容与文件类型不匹配，仅支持 JPEG、PNG、BMP", 400);
      }
    }
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

  async markManualCompleted(id, ownerId) {
    const task = this.requireTask(id, ownerId, false);
    if (task.status !== "awaiting_confirmation") throw serviceError("当前任务不在待人工提交状态", 409);
    await this.automation?.release?.(task);
    return this.publicTask(this.repository.update(id, {
      status: "manual_completed",
      queuePosition: 0,
      error: ""
    }));
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
    try { if (item.kind === "ocr") await this.processOcr(item); else await this.processFill(item); }
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
  cleanup() {
    for (const task of this.repository.expired()) {
      if (!TERMINAL.has(task.status)) continue;
      this.deleteFiles(task);
      this.repository.remove(task.id);
    }
    const referenced = this.repository.list("", true)
      .flatMap((task) => [task.imagePath, task.loginScreenshotPath, task.formScreenshotPath])
      .filter(Boolean);
    const options = {
      retentionMs: this.config.photoComplaints?.orphanRetentionMs || 24 * 60 * 60 * 1000,
      maxFiles: this.config.photoComplaints?.maxArtifactFiles || 500,
      maxBytes: this.config.photoComplaints?.maxArtifactBytes || 1024 * 1024 * 1024,
      protectedPaths: referenced
    };
    cleanupDirectory({ dir: this.uploadDir, ...options });
    cleanupDirectory({ dir: this.screenshotDir, ...options });
  }
  restoreAfterRestart() {
    const tasks = typeof this.repository.recoverable === "function"
      ? this.repository.recoverable()
      : this.repository.list("", true);
    const ocrQueue = [];
    const fillQueue = [];
    for (const task of tasks) {
      if (task.status === "waiting_login") {
        this.scheduleLoginWatch(task.id, task.ownerId);
        continue;
      }
      if (task.status === "review") continue;
      if (task.status === "recognizing" || (task.status === "queued" && task.imagePath)) {
        if (!this.isRecoverableImage(task.imagePath)) {
          this.repository.update(task.id, {
            status: "failed",
            queuePosition: 0,
            imagePath: "",
            error: "服务重启后无法恢复图片识别：原图不存在或文件路径不安全，请重新上传"
          });
          continue;
        }
        this.repository.update(task.id, {
          status: "queued",
          queuePosition: 0,
          error: task.status === "recognizing" ? "服务重启，正在重新进行图片识别" : ""
        });
        ocrQueue.push({ kind: "ocr", taskId: task.id, ownerId: task.ownerId });
        continue;
      }
      if (task.status === "queued") {
        this.repository.update(task.id, {
          status: "queued",
          queuePosition: 0,
          error: "服务重启，正在恢复尚未开始的自动填表"
        });
        fillQueue.push({ kind: "fill", taskId: task.id, ownerId: task.ownerId });
        continue;
      }
      if (task.status === "filling" || task.status === "awaiting_confirmation") {
        this.repository.update(task.id, {
          status: "review",
          queuePosition: 0,
          formFingerprint: "",
          error: task.status === "filling"
            ? "服务在自动填表过程中重启，为避免重复操作，已退回复核；请确认后重新自动填表"
            : "服务重启后原后台表单已失效，已退回复核；请确认后重新自动填表"
        });
      }
    }
    this.queue.push(...ocrQueue, ...fillQueue);
    this.refreshQueuePositions();
    if (this.queue.length) queueMicrotask(() => this.pump());
  }
  isRecoverableImage(file) {
    if (!file) return false;
    const resolved = path.resolve(file);
    if (!resolved.startsWith(`${this.uploadDir}${path.sep}`)) return false;
    try {
      const stat = fs.lstatSync(resolved);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }
  scheduleLoginWatch(taskId, ownerId) {
    if (!this.browserClient || this.loginWatchTimers.has(taskId)) return;
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
        const dashboardUrl = this.config.browser?.dashboardUrl || "";
        if (this.browserClient.withIsolatedPage) {
          readiness = await this.browserClient.withIsolatedPage(dashboardUrl, (probePage) =>
            this.browserClient.ensureReady(probePage, { waitMs: 1200 })).catch(() => null);
        }
        if (readiness?.ready) {
          // 企业微信扫码成功后可能会自动关闭二维码页；
          // 已保存的 Cookie 能打开后台时应直接续跑，不能再生成二维码。
        } else {
        const latest = this.repository.get(taskId);
        if (!latest || latest.status !== "waiting_login") return;
        this.repository.update(taskId, { status: "queued", error: "扫码会话已恢复，正在重新生成二维码" });
        this.queue.push({ kind: "fill", taskId, ownerId });
        this.refreshQueuePositions();
        this.pump();
        return;
        }
      }
      if (!readiness && /login\.work\.weixin\.qq\.com/i.test(page?.url?.() || "")) {
        await page.waitForURL((url) => !/login\.work\.weixin\.qq\.com/i.test(url.hostname), { timeout: 900 }).catch(() => {});
        if (/login\.work\.weixin\.qq\.com/i.test(page.url?.() || "")) {
          const dashboardUrl = this.config.browser?.dashboardUrl || "";
          readiness = await this.browserClient.withIsolatedPage(dashboardUrl, (probePage) =>
            this.browserClient.ensureReady(probePage, { waitMs: 1200 }));
          if (readiness.ready) await page.close().catch(() => {});
        }
      }
      if (!readiness) readiness = await this.browserClient.ensureReady(page, { waitMs: 800 });
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
  close() { clearInterval(this.cleanupTimer); for (const timer of this.loginWatchTimers.values()) clearTimeout(timer); this.loginWatchTimers.clear(); }
}

function isSupportedImageFile(filePath, mimeType) {
  let header;
  try {
    const descriptor = fs.openSync(filePath, "r");
    try {
      header = Buffer.alloc(12);
      fs.readSync(descriptor, header, 0, header.length, 0);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return false;
  }
  if (mimeType === "image/jpeg") return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (mimeType === "image/png") return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/bmp") return header[0] === 0x42 && header[1] === 0x4d;
  return false;
}

function runOcr(config, file) {
  return new Promise((resolve, reject) => {
    const python = config.photoComplaints?.python || "python3";
    const script = path.resolve(config.photoComplaints?.ocrScript || "scripts/photo_complaint_ocr.py");
    const timeoutMs = Math.max(10000, Number(config.photoComplaints?.ocrTimeoutMs || 120000));
    const child = spawn(python, [script, file], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", settled = false, timedOut = false, forceKillTimer = null;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      forceKillTimer.unref?.();
      settle(() => reject(new Error("OCR执行超时，请重试")));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => { out = `${out}${chunk}`.slice(-1024 * 1024); });
    child.stderr.on("data", (chunk) => { err = `${err}${chunk}`.slice(-64 * 1024); });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      if (timedOut) return;
      settle(() => {
        try {
          const payload = JSON.parse(out.trim());
          if (code || payload.error) reject(new Error(payload.error || err || "OCR执行失败"));
          else resolve(payload);
        } catch {
          reject(new Error(err || "OCR返回格式不正确"));
        }
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      settle(() => reject(error));
    });
  });
}
async function runOptionalLlm(config, ocrText, parsed) {
  const options = config.photoComplaints || {};
  const apiKey = process.env.PHOTO_LLM_API_KEY;
  if (!options.llmEnabled || !apiKey || !options.llmBaseUrl || !options.llmModel) return null;
  const safePayload = sanitizeLlmPayload(ocrText, parsed);
  const response = await fetch(`${String(options.llmBaseUrl).replace(/\/$/, "")}/chat/completions`, {
    method: "POST", signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: options.llmModel, temperature: 0, response_format: { type: "json_object" }, messages: [
      { role: "system", content: "你是投诉工单OCR纠错器。当前输入已脱敏且不含原始正文；只能校验字段结构和格式，不得补造个人信息或投诉内容。输出JSON；details最多500字。" },
      { role: "user", content: JSON.stringify({ rules: "仅校验已脱敏字段的格式和完整性；不得生成姓名、手机号、订单号、编号或投诉正文。", payload: safePayload }) }
    ] })
  });
  if (!response.ok) return null;
  try {
    const payload = await response.json(); const value = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
    const allowed = ["externalNumber", "registeredAt", "name", "phone", "amount", "productName", "disputeAt", "complaintType", "source", "relationship", "details"];
    const result = {};
    for (const key of allowed) {
      if (value[key] === undefined || value[key] === null) continue;
      const sanitized = sanitizeField(key, value[key]);
      if (sanitized !== "") result[key] = sanitized;
    }
    return Object.keys(result).length ? result : null;
  } catch { return null; }
}

export function sanitizeLlmPayload(ocrText, parsed = {}) {
  const hasOcrText = Boolean(String(ocrText || "").trim());
  const safeFields = {};
  for (const key of ["registeredAt", "disputeAt", "complaintType", "source", "relationship"]) {
    const value = sanitizeField(key, parsed[key]);
    if (value) safeFields[key] = value;
  }
  return {
    version: "photo-llm-redaction-v1",
    hasOcrText,
    ocrContent: hasOcrText ? "[本地 OCR 已完成，原文及投诉正文不外发]" : "",
    parsed: safeFields
  };
}
export function mergeComplaintRecognition(parsed, assisted) {
  const nonEmptyAssisted = Object.fromEntries(Object.entries(assisted || {}).filter(([, value]) => String(value ?? "").trim() !== ""));
  const merged = { ...parsed, ...nonEmptyAssisted };
  merged.problemLabels = suggestProblemLabels(merged.details, merged.relationship);
  return merged;
}
function validateForLookup(data) { if (!/^1\d{10}$/.test(data.phone || "")) throw serviceError("手机号缺失或格式不正确", 400); if (data.userId && !/^\d{6,20}$/.test(data.userId)) throw serviceError("人工填写的用户ID格式不正确", 400); if (!data.registeredAt || !data.source) throw serviceError("投诉时间或投诉来源缺失", 400); if (!(data.problemLabels?.length === 3 || data.problemLabels?.[0] === "错误数据")) throw serviceError("投诉内容未能识别具体三级类，请人工选择", 400); }
function validateForFill(data) { if (!data.userId || !data.mainOrderId || !data.registeredAt || !data.source) throw serviceError("用户ID、主订单ID、投诉时间或投诉来源缺失", 409); }
function sanitizeField(key, value) { if (key === "problemLabels") return Array.isArray(value) ? value.slice(0, 3).map(String) : []; const limits = { details: 500, notes: 500 }; return String(value ?? "").trim().slice(0, limits[key] || 200); }
function extensionFor(type) { return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/bmp": ".bmp" })[type] || ".img"; }
function serviceError(message, statusCode = 500) { const e = new Error(message); e.statusCode = statusCode; return e; }
export function normalizeUploadedFilename(value) {
  const source = path.basename(String(value || "图片"));
  if (!/[\u0080-\u00ff]/.test(source)) return source;
  const decoded = Buffer.from(source, "latin1").toString("utf8");
  if (decoded.includes("\uFFFD")) return source;
  return /[\u3400-\u9fff]/.test(decoded) ? path.basename(decoded) : source;
}
export { scoreOrders, uniqueUserIds };
