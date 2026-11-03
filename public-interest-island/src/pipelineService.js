import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODES = new Set(["download", "recognize", "full"]);
const TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const RESULT_MARKER = "WEB_PIPELINE_RESULT=";
const STATE_MARKER = "WEB_PIPELINE_STATE=";
const LOGIN_REQUIRED_MARKER = "WEB_LOGIN_REQUIRED=";
const LOGIN_READY_MARKER = "WEB_LOGIN_READY=";
const LOGIN_CONFIRM_PREFIX = "WEB_LOGIN_CONFIRM=";

export class PipelineService {
  constructor(config) {
    this.config = config.pipeline;
    this.config.loginScreenshotDir ||= path.join(this.config.outputDir, ".login-screens");
    this.jobs = new Map();
    this.activeJobId = null;
    fs.mkdirSync(this.config.outputDir, { recursive: true });
    fs.mkdirSync(this.config.loginScreenshotDir, { recursive: true });
  }

  getStatus(ownerId, isAdmin = false) {
    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : null;
    return {
      enabled: Boolean(this.config.enabled),
      busy: Boolean(active && !TERMINAL_STATUSES.has(active.status)),
      activeJob: active && (isAdmin || active.ownerId === ownerId) ? publicJob(active) : null
    };
  }

  listWorkbooks() {
    if (!fs.existsSync(this.config.outputDir)) return [];
    return fs.readdirSync(this.config.outputDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isRecognizableWorkbookName(entry.name))
      .map((entry) => {
        const filePath = path.join(this.config.outputDir, entry.name);
        const stat = fs.statSync(filePath);
        return {
          name: entry.name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => {
        const mergedDifference = mergedWorkbookRank(b.name) - mergedWorkbookRank(a.name);
        return mergedDifference || b.modifiedAt.localeCompare(a.modifiedAt);
      });
  }

  saveUploadedWorkbook(originalName, content) {
    if (!Buffer.isBuffer(content) || content.length < 4) {
      throw pipelineError("上传文件为空", 400);
    }

    const sourceName = path.basename(String(originalName || "").trim());
    if (!sourceName || sourceName.startsWith("~$") || path.extname(sourceName).toLowerCase() !== ".xlsx") {
      throw pipelineError("仅支持非临时 .xlsx 文件", 400);
    }

    const safeName = sanitizeUploadedWorkbookName(sourceName);
    // 保留可识别的工作簿前缀，避免上传后被“可识别文件名”校验拒绝。
    const storedName = `敏感词跟进表_聊天合并_上传_${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;
    const target = path.resolve(this.config.outputDir, storedName);
    const allowedRoot = `${path.resolve(this.config.outputDir)}${path.sep}`;
    if (!target.startsWith(allowedRoot)) throw pipelineError("上传文件名不合法", 400);

    try {
      fs.writeFileSync(target, content, { flag: "wx", mode: 0o600 });
      assertXlsxFile(target);
    } catch (error) {
      fs.rmSync(target, { force: true });
      if (error.statusCode) throw error;
      throw pipelineError(`上传文件校验失败：${error.message}`, 400);
    }

    const stat = fs.statSync(target);
    return {
      name: storedName,
      originalName: sourceName,
      path: target,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString()
    };
  }

  start(input, ownerId) {
    if (!this.config.enabled) throw pipelineError("批量识别工作流未启用", 503);
    validatePipelineLayout(this.config);
    const current = this.activeJobId ? this.jobs.get(this.activeJobId) : null;
    if (current && !TERMINAL_STATUSES.has(current.status)) {
      throw pipelineError("已有批量任务正在运行，请等待完成或先取消", 409);
    }

    const normalized = normalizeInput(input);
    const workbookPath = normalized.mode === "recognize"
      ? resolveWorkbookSelection(this.config, normalized)
      : null;
    const jobId = crypto.randomUUID();
    const loginScreenshotPath = path.join(this.config.loginScreenshotDir, `${jobId}.png`);
    const command = buildPipelineCommand(this.config, normalized, workbookPath);
    const now = new Date().toISOString();
    const job = {
      id: jobId,
      ownerId,
      mode: normalized.mode,
      input: {
        ...normalized,
        workbook: normalized.workbook || path.basename(workbookPath || ""),
        workbookPath: normalized.workbookPath ? path.basename(workbookPath) : ""
      },
      status: "running",
      stage: stageForMode(normalized.mode),
      progress: 2,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      exitCode: null,
      resultPath: null,
      statePath: null,
      error: null,
      logs: [],
      process: null,
      outputTail: "",
      outputLineBuffer: "",
      loginPrompts: 0,
      loginKind: null,
      loginToken: null,
      loginPending: false,
      loginScreenshotPath,
      cancelRequested: false
    };

    const child = spawn(command.executable, command.args, {
      cwd: this.config.projectDir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        WEB_PIPELINE_MODE: "1",
        PIPELINE_NODE: this.config.node,
        PIPELINE_LOGIN_SCREENSHOT: loginScreenshotPath,
        PIPELINE_LOGIN_SCREENSHOT_INTERVAL: "2"
      },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    job.process = child;
    this.jobs.set(job.id, job);
    this.activeJobId = job.id;
    this.pruneJobs();
    appendLog(job, "system", `任务已启动：${modeLabel(job.mode)}`, this.config.maxLogLines);

    child.stdout.on("data", (chunk) => this.handleOutput(job, "stdout", chunk));
    child.stderr.on("data", (chunk) => this.handleOutput(job, "stderr", chunk));
    child.on("error", (error) => {
      job.error = `任务进程启动失败：${error.message}`;
      job.spawnError = true;
      job.status = "failed";
      job.stage = "任务启动失败";
      job.updatedAt = new Date().toISOString();
      appendLog(job, "stderr", job.error, this.config.maxLogLines);
    });
    child.on("close", (code, signal) => this.finishJob(job, code, signal));
    return publicJob(job);
  }

  getJob(jobId, ownerId, isAdmin = false) {
    const job = this.jobs.get(jobId);
    if (!job || (!isAdmin && job.ownerId !== ownerId)) throw pipelineError("任务不存在", 404);
    return publicJob(job);
  }

  continueLogin(jobId, ownerId, isAdmin = false) {
    const job = this.requireJob(jobId, ownerId, isAdmin);
    if (job.status !== "waiting_login") throw pipelineError("当前任务不在等待登录状态", 409);
    if (!job.process?.stdin?.writable) throw pipelineError("任务登录确认通道已关闭", 409);
    const confirmation = job.loginToken ? `${LOGIN_CONFIRM_PREFIX}${job.loginToken}\n` : "\n";
    job.process.stdin.write(confirmation);
    job.status = "running";
    job.loginPending = Boolean(job.loginToken);
    job.stage = job.loginPending ? "正在验证网页登录确认" : "正在验证登录并继续";
    job.updatedAt = new Date().toISOString();
    appendLog(job, "system", "已提交人工登录确认，继续执行", this.config.maxLogLines);
    return publicJob(job);
  }

  async cancel(jobId, ownerId, isAdmin = false) {
    const job = this.requireJob(jobId, ownerId, isAdmin);
    if (TERMINAL_STATUSES.has(job.status)) return publicJob(job);
    job.cancelRequested = true;
    job.status = "cancelled";
    job.stage = "正在取消";
    job.updatedAt = new Date().toISOString();
    appendLog(job, "system", "已请求取消任务", this.config.maxLogLines);
    terminateProcess(job.process, "SIGINT");
    const timer = setTimeout(() => terminateProcess(job.process, "SIGKILL"), this.config.stopTimeoutMs);
    timer.unref?.();
    return publicJob(job);
  }

  resultFile(jobId, ownerId, isAdmin = false) {
    const job = this.requireJob(jobId, ownerId, isAdmin);
    if (!job.resultPath || !["completed", "partial"].includes(job.status)) {
      throw pipelineError("任务尚无可下载结果", 409);
    }
    const filePath = resolveAllowedResult(this.config.outputDir, job.resultPath);
    return { path: filePath, name: path.basename(filePath) };
  }

  loginScreenshotFile(jobId, ownerId, isAdmin = false) {
    const job = this.requireJob(jobId, ownerId, isAdmin);
    const filePath = path.resolve(job.loginScreenshotPath || "");
    const allowedRoot = `${path.resolve(this.config.loginScreenshotDir)}${path.sep}`;
    if (!filePath.startsWith(allowedRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw pipelineError("登录页画面尚未生成，请稍候", 404);
    }
    return { path: filePath, name: path.basename(filePath) };
  }

  async close() {
    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : null;
    if (active && !TERMINAL_STATUSES.has(active.status)) {
      active.cancelRequested = true;
      terminateProcess(active.process, "SIGINT");
    }
  }

  requireJob(jobId, ownerId, isAdmin) {
    const job = this.jobs.get(jobId);
    if (!job || (!isAdmin && job.ownerId !== ownerId)) throw pipelineError("任务不存在", 404);
    return job;
  }

  handleOutput(job, source, chunk) {
    const text = chunk.toString("utf8");
    job.updatedAt = new Date().toISOString();
    job.outputTail = `${job.outputTail}${text}`.slice(-8192);
    for (const line of splitOutputLines(job, text)) {
      const clean = line.trim();
      if (clean) appendLog(job, source, clean, this.config.maxLogLines);
      const event = parseLoginEvent(clean);
      if (event?.type === "required") {
        if (job.status !== "waiting_login" || job.loginToken !== event.token) job.loginPrompts += 1;
        job.status = "waiting_login";
        job.stage = "等待人工登录确认";
        job.loginKind = event.kind;
        job.loginToken = event.token;
        job.loginPending = false;
      } else if (event?.type === "ready") {
        if (!job.loginToken || job.loginToken === event.token) {
          job.loginKind = null;
          job.loginToken = null;
          job.loginPending = false;
          if (job.status === "waiting_login") {
            job.status = "running";
            job.stage = "登录验证完成，继续执行";
          }
        }
      } else if (isLoginPrompt(clean)) {
        if (job.status !== "waiting_login") job.loginPrompts += 1;
        job.status = "waiting_login";
        job.stage = "等待人工登录确认";
        job.loginKind = null;
        job.loginToken = null;
        job.loginPending = false;
      }
    }
    const result = parseMarker(job.outputTail, RESULT_MARKER);
    const state = parseMarker(job.outputTail, STATE_MARKER);
    if (result) job.resultPath = result;
    if (state) job.statePath = state;
    updateProgress(job, text);
  }

  finishJob(job, code, signal) {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    job.process = null;
    if (this.activeJobId === job.id) this.activeJobId = null;

    if (job.cancelRequested) {
      job.status = "cancelled";
      job.stage = "任务已取消";
      return;
    }

    if (job.spawnError) {
      job.status = "failed";
      job.stage = "任务启动失败";
      return;
    }

    const pipelineState = readPipelineState(job.statePath);
    if (pipelineState?.resultFile && !job.resultPath) job.resultPath = pipelineState.resultFile;
    if (code === 0 && job.resultPath) {
      job.status = pipelineState?.status === "partial" ? "partial" : "completed";
      job.stage = job.status === "partial" ? "任务部分完成" : "任务已完成";
      job.progress = 100;
      appendLog(job, "system", job.stage, this.config.maxLogLines);
      return;
    }

    job.status = "failed";
    job.stage = "任务失败";
    job.error = pipelineState?.error || `任务退出码 ${code ?? "-"}${signal ? `，信号 ${signal}` : ""}`;
    appendLog(job, "stderr", job.error, this.config.maxLogLines);
  }

  pruneJobs() {
    const jobs = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const job of jobs.slice(20)) {
      if (TERMINAL_STATUSES.has(job.status)) this.jobs.delete(job.id);
    }
  }
}

export function buildPipelineCommand(config, input, workbookPath = null) {
  const scriptPath = path.join(config.projectDir, "scripts", "run_full_pipeline.py");
  const args = [
    scriptPath,
    "--mode", input.mode,
    "--output-dir", config.outputDir,
    "--template", config.template,
    "--sheet", config.sheet,
    "--shared-browser-profile", config.sharedBrowserProfile,
    "--python", config.python,
    "--node", config.node
  ];
  if (input.date) args.push("--date", input.date);
  if (["recognize", "full"].includes(input.mode)) {
    args.push("--from-row", String(input.fromRow));
    if (input.toRow) args.push("--to-row", String(input.toRow));
  }
  if (input.mode === "recognize") args.push("--workbook", workbookPath);
  if (input.allowPartial) args.push("--allow-partial");
  if (input.inPlace) args.push("--in-place");
  if (input.debug) args.push("--debug");
  if (config.xvfbRun) {
    return {
      executable: config.xvfbRun,
      args: ["-a", "-s", config.xvfbScreen || "-screen 0 1440x1000x24", config.python, ...args]
    };
  }
  return { executable: config.python, args };
}

export function isLoginPrompt(value) {
  const text = String(value || "");
  return text.includes(LOGIN_REQUIRED_MARKER)
    || /完成登录\/验证.*按回车|完成登录.*按回车|登录后.*按回车|等待人工.*登录/i.test(text);
}

export function parseLoginEvent(value) {
  const text = String(value || "").trim();
  if (text.startsWith(LOGIN_REQUIRED_MARKER)) {
    const [kind, token] = text.slice(LOGIN_REQUIRED_MARKER.length).split(":", 2);
    return kind && token ? { type: "required", kind, token } : null;
  }
  if (text.startsWith(LOGIN_READY_MARKER)) {
    const [kind, token] = text.slice(LOGIN_READY_MARKER.length).split(":", 2);
    return kind && token ? { type: "ready", kind, token } : null;
  }
  return null;
}

export function parseMarker(value, marker) {
  const text = String(value || "");
  const index = text.lastIndexOf(marker);
  if (index < 0) return null;
  const line = text.slice(index + marker.length).split(/\r?\n/, 1)[0].trim();
  return line || null;
}

export function isRecognizableWorkbookName(name) {
  const basename = path.basename(String(name || ""));
  return basename === name
    && !basename.startsWith("~$")
    && /^(敏感词跟进表_聊天合并|敏感词跟进表【潜在风险】).*\.xlsx$/i.test(basename);
}

function validatePipelineLayout(config) {
  if (!fs.existsSync(config.projectDir) || !fs.statSync(config.projectDir).isDirectory()) {
    throw pipelineError(`拟人工识别项目目录不存在：${config.projectDir}`, 503);
  }
  const scriptPath = path.join(config.projectDir, "scripts", "run_full_pipeline.py");
  if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
    throw pipelineError(`流水线入口脚本不存在：${scriptPath}`, 503);
  }
}

function normalizeInput(input) {
  const mode = String(input?.mode || "full");
  if (!MODES.has(mode)) throw pipelineError("不支持的工作流模式", 400);
  const date = String(input?.date || "").trim();
  if (date && !/^\d{8}$/.test(date)) throw pipelineError("日期必须为 YYYYMMDD", 400);
  const fromRow = Number(input?.fromRow || 3);
  const toRow = input?.toRow === null || input?.toRow === undefined || input?.toRow === ""
    ? null
    : Number(input.toRow);
  if (!Number.isInteger(fromRow) || fromRow < 3) throw pipelineError("起始行必须为不小于 3 的整数", 400);
  if (toRow !== null && (!Number.isInteger(toRow) || toRow < fromRow)) {
    throw pipelineError("结束行必须是不小于起始行的整数", 400);
  }
  const workbook = String(input?.workbook || "").trim();
  const workbookPath = stripWrappingQuotes(String(input?.workbookPath || "").trim());
  if (mode === "recognize" && !workbook && !workbookPath) {
    throw pipelineError("仅识别模式必须选择 Excel 或填写文件路径", 400);
  }
  return {
    mode,
    date,
    fromRow,
    toRow,
    workbook,
    workbookPath,
    allowPartial: Boolean(input?.allowPartial),
    inPlace: Boolean(input?.inPlace),
    debug: Boolean(input?.debug)
  };
}

export function resolveWorkbookSelection(config, input) {
  const workbookPath = stripWrappingQuotes(String(input.workbookPath || "").trim());
  if (workbookPath) {
    return resolveManualWorkbook(config.inputDirs || [config.outputDir], workbookPath);
  }
  return resolveWorkbook(config.outputDir, input.workbook);
}

function resolveManualWorkbook(inputDirs, rawPath) {
  const sourcePath = String(rawPath || "").trim();
  if (!path.isAbsolute(sourcePath) && !sourcePath.startsWith("~/")) {
    throw pipelineError("Excel 文件路径必须是绝对路径或以 ~/ 开头", 400);
  }
  const requested = expandUserPath(rawPath);
  if (path.extname(requested).toLowerCase() !== ".xlsx" || path.basename(requested).startsWith("~$")) {
    throw pipelineError("仅支持非临时 .xlsx 文件", 400);
  }
  if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) {
    throw pipelineError("Excel 文件不存在", 404);
  }

  const realFile = fs.realpathSync(requested);
  const allowed = (inputDirs || [])
    .map(expandUserPath)
    .filter((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory())
    .map((dir) => fs.realpathSync(dir));
  const insideAllowedDir = allowed.some((root) => realFile === root || realFile.startsWith(`${root}${path.sep}`));
  if (!insideAllowedDir) {
    throw pipelineError(`Excel 文件不在允许目录内：${allowed.join("、") || "未配置目录"}`, 400);
  }
  assertXlsxFile(realFile);
  return realFile;
}

function resolveWorkbook(outputDir, name) {
  if (!isRecognizableWorkbookName(name)) throw pipelineError("Excel 文件名不在允许范围内", 400);
  const resolved = path.resolve(outputDir, name);
  const allowedRoot = `${path.resolve(outputDir)}${path.sep}`;
  if (!resolved.startsWith(allowedRoot) || !fs.existsSync(resolved)) throw pipelineError("Excel 文件不存在", 404);
  assertXlsxFile(resolved);
  return resolved;
}

function mergedWorkbookRank(name) {
  return String(name || "").startsWith("敏感词跟进表_聊天合并") ? 1 : 0;
}

function expandUserPath(value) {
  const text = String(value || "").trim();
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}

function stripWrappingQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function assertXlsxFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 4) throw pipelineError("Excel 文件为空或已损坏", 400);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const signature = Buffer.alloc(2);
    fs.readSync(descriptor, signature, 0, signature.length, 0);
    if (signature.toString("binary") !== "PK") throw pipelineError("文件不是有效的 XLSX 压缩格式", 400);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sanitizeUploadedWorkbookName(name) {
  const basename = path.basename(String(name || ""));
  const extension = path.extname(basename).toLowerCase();
  const stem = basename.slice(0, -extension.length)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "上传文件";
  return `${stem}.xlsx`;
}

function resolveAllowedResult(outputDir, resultPath) {
  const resolved = path.resolve(resultPath);
  const allowedRoot = `${path.resolve(outputDir)}${path.sep}`;
  if (!resolved.startsWith(allowedRoot) || path.extname(resolved).toLowerCase() !== ".xlsx" || !fs.existsSync(resolved)) {
    throw pipelineError("结果文件不存在或不在允许目录内", 404);
  }
  return resolved;
}

function appendLog(job, source, message, maxLines) {
  job.logs.push({ time: new Date().toISOString(), source, message });
  if (job.logs.length > maxLines) job.logs.splice(0, job.logs.length - maxLines);
}

function splitOutputLines(job, text) {
  const combined = `${job.outputLineBuffer || ""}${text}`;
  const lines = combined.split(/\r?\n/);
  job.outputLineBuffer = lines.pop() || "";
  return lines;
}

function updateProgress(job, text) {
  const rules = [
    [/FineBI 下载开始|\[1\/3\]/, 10, "FineBI 下载中"],
    [/FineBI 下载完成/, 35, "FineBI 下载完成"],
    [/Excel 合并去重开始|\[2\/3\]/, 45, "Excel 合并去重中"],
    [/Excel 合并去重完成|WEB_PIPELINE_RESULT=/, job.mode === "download" ? 95 : 60, "Excel 汇总完成"],
    [/拟人工识别开始|\[3\/3\]|\[1\/1\]/, 65, "拟人工识别中"],
    [/拟人工识别完成|流程全部完成/, 95, "正在校验结果"]
  ];
  for (const [pattern, progress, stage] of rules) {
    if (pattern.test(text) && progress >= job.progress) {
      job.progress = progress;
      job.stage = stage;
    }
  }
}

function publicJob(job) {
  return {
    id: job.id,
    mode: job.mode,
    input: job.input,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    resultFile: job.resultPath ? path.basename(job.resultPath) : null,
    error: job.error,
    loginPrompts: job.loginPrompts,
    loginKind: job.loginKind || null,
    loginPending: Boolean(job.loginPending),
    loginScreenshotAvailable: Boolean(job.loginScreenshotPath && fs.existsSync(job.loginScreenshotPath)),
    logs: job.logs
  };
}

function readPipelineState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function terminateProcess(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // 进程可能已经自然退出。
  }
}

function stageForMode(mode) {
  if (mode === "download") return "准备下载并汇总";
  if (mode === "recognize") return "准备识别 Excel";
  return "准备一键全流程";
}

function modeLabel(mode) {
  return { download: "仅下载汇总", recognize: "指定 Excel 识别", full: "一键全流程" }[mode] || mode;
}

function pipelineError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
