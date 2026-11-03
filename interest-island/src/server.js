import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import multer from "multer";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BrowserClient } from "./browserClient.js";
import { loadConfig, validateBackendConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createDebugLogger } from "./logger.js";
import { PipelineService } from "./pipelineService.js";
import { PhotoComplaintAutomation } from "./photoComplaintAutomation.js";
import { PhotoComplaintService } from "./photoComplaintService.js";
import { parseTaxonomyPath, reconcileTaxonomyOptions, taxonomyOptions } from "./complaintTaxonomy.js";
import { UserOverviewService } from "./userOverviewService.js";
import { createUserAuth } from "./userAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const cspHashes = collectInlineResourceHashes(path.join(rootDir, "public"));
const configPath = process.env.CONFIG || "config/default.json";
const config = loadConfig(configPath);
const production = process.env.NODE_ENV === "production" || /production\.json$/i.test(configPath);
validateBackendConfig(config, { production });
const secureCookies = booleanFromEnv("COOKIE_SECURE", production);
if (production && !process.env.SESSION_SECRET) {
  throw new Error("生产环境必须通过 SESSION_SECRET 提供高强度会话密钥");
}

const database = createDatabase(config);
const auth = createUserAuth(database);
const app = express();
const browserClient = new BrowserClient(config);
const logger = createDebugLogger(config);
const overviewService = new UserOverviewService({ config, browserClient, logger });
const pipelineService = new PipelineService(config, database.pipelineJobs, database.pipelineWorkbooks);
const photoIncomingDir = path.join(config.photoComplaints.tempDir, "incoming");
fs.mkdirSync(photoIncomingDir, { recursive: true, mode: 0o700 });
const photoUpload = multer({
  dest: photoIncomingDir,
  limits: { files: 10, fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, ["image/jpeg", "image/png", "image/bmp"].includes(file.mimetype))
});
const photoComplaintAutomation = new PhotoComplaintAutomation(config);
const photoComplaintService = new PhotoComplaintService({
  config,
  repository: database.photoComplaints,
  browserClient,
  automation: photoComplaintAutomation
});
let shuttingDown = false;

app.disable("x-powered-by");
app.set("trust proxy", config.server.trustProxy);

const QuerySchema = z.object({
  userId: z.string().trim().max(20).regex(/^\d*$/, "用户ID格式不正确").optional().default(""),
  phone: z.string().trim().optional().default(""),
  mode: z.enum(["order", "schedule", "complaint", "all"]).optional().default("all"),
  progressId: z.string().trim().max(80).regex(/^[a-zA-Z0-9_-]*$/).optional().default("")
}).superRefine((value, ctx) => {
  if (!value.userId && !value.phone) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "请填写用户ID或手机号" });
  }
  if (value.userId && value.userId.length < 5) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["userId"], message: "用户ID格式不正确" });
  }
  if (value.phone && !/^1\d{10}$/.test(value.phone)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["phone"], message: "手机号格式不正确" });
  }
});
const LoginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1)
});
const PasswordSchema = z.object({ password: z.string().min(10).max(128) });
const CreateUserSchema = z.object({
  username: z.string().trim(),
  password: z.string().min(10).max(128).optional(),
  role: z.enum(["admin", "user"]).optional().default("user")
});
const PatchUserSchema = z.object({ disabled: z.boolean() });
const TaskQuotaGrantSchema = z.object({
  taskType: z.enum(["overview", "pipeline", "photo"])
});
const PipelineJobSchema = z.object({
  mode: z.enum(["download", "recognize", "full"]),
  date: z.string().regex(/^\d{8}$/).optional().default(""),
  workbook: z.string().trim().max(255).optional().default(""),
  workbookPath: z.string().trim().max(2048).optional().default(""),
  fromRow: z.number().int().min(3).optional().default(3),
  toRow: z.number().int().min(3).nullable().optional().default(null),
  allowPartial: z.boolean().optional().default(false),
  inPlace: z.boolean().optional().default(false)
}).superRefine((value, ctx) => {
  if (value.toRow !== null && value.toRow < value.fromRow) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["toRow"], message: "结束行不能小于起始行" });
  }
  if (value.mode === "recognize" && !value.workbook && !value.workbookPath) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workbook"], message: "请选择 Excel 或填写文件路径" });
  }
});

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'unsafe-hashes' ${cspHashes.scripts.join(" ")}`,
    `style-src 'self' 'unsafe-hashes' ${cspHashes.styles.join(" ")} https://cdn.jsdelivr.net https://cdn.bootcdn.net`,
    "font-src 'self' data: https://cdn.jsdelivr.net https://cdn.bootcdn.net",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    production ? "upgrade-insecure-requests" : ""
  ].filter(Boolean).join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setTimeout(config.server.requestTimeoutMs, () => {
    if (!res.headersSent) res.status(504).json({ ok: false, error: "查询执行超时，请稍后重试" });
  });
  next();
});

function collectInlineResourceHashes(publicDir) {
  const scripts = new Set();
  const styles = new Set();
  for (const name of fs.readdirSync(publicDir)) {
    if (!name.endsWith(".html")) continue;
    const source = fs.readFileSync(path.join(publicDir, name), "utf8");
    for (const match of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      scripts.add(cspHash(match[1]));
    }
    for (const match of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      styles.add(cspHash(match[1]));
    }
    for (const match of source.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
      styles.add(cspHash(match[2]));
    }
    for (const match of source.matchAll(/\bon[a-z]+\s*=\s*(["'])([\s\S]*?)\1/gi)) {
      scripts.add(cspHash(match[2]));
    }
  }
  return { scripts: [...scripts], styles: [...styles] };
}

function cspHash(value) {
  return `'sha256-${crypto.createHash("sha256").update(value).digest("base64")}'`;
}

app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && !isAllowedOrigin(req, origin, config.server.allowedOrigins)) {
    res.status(403).json({ ok: false, error: "不允许的请求来源" });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-csrf-token");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "256kb" }));
app.use(session({
  name: "iis.sid",
  secret: process.env.SESSION_SECRET || config.server.sessionSecret,
  store: database.sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.username || "").trim().toLowerCase()}`,
  message: { ok: false, error: "登录失败，请稍后再试" }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.session?.user?.id || "anonymous"}`,
  message: { ok: false, error: "上传过于频繁，请稍后再试" }
});

const overviewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.server.queryRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.session?.user?.id || "anonymous"}`,
  message: { ok: false, error: "查询过于频繁，请稍后再试" }
});

app.get("/api/health/live", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/login", (req, res) => {
  const user = req.session?.user && auth.getUser(req.session.user.id);
  if (user && !user.disabled) return res.redirect(user.mustChangePassword ? "/change-password" : "/");
  if (req.session?.user) req.session.destroy(() => {});
  return res.sendFile(path.join(rootDir, "public", "login.html"));
});

app.get("/change-password", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(rootDir, "public", "change-password.html"));
});

app.get("/admin", requireAuthPage, requireAdminPage, (_req, res) => {
  res.sendFile(path.join(rootDir, "public", "admin.html"));
});

app.get("/pipeline", requireAuthPage, (_req, res) => {
  res.sendFile(path.join(rootDir, "public", "pipeline.html"));
});

app.get("/photo-complaints", requireAuthPage, (_req, res) => {
  if (!config.photoComplaints.enabled) return res.status(503).send("图片录单功能暂未启用");
  res.sendFile(path.join(rootDir, "public", "photo-complaints.html"));
});

app.get("/", requireAuthPage, (req, res) => {
  if (req.session.user.mustChangePassword) return res.redirect("/change-password");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-App-Build", "20260723-2");
  return res.sendFile(path.join(rootDir, "public", "index.html"));
});

app.post("/api/login", loginLimiter, async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body || {});
  if (!parsed.success) return delayedLoginFailure(res);
  const user = auth.authenticate(parsed.data.username, parsed.data.password);
  if (!user) {
    auth.audit(null, "login_failed", maskUsername(parsed.data.username));
    return delayedLoginFailure(res);
  }
  await regenerateSession(req);
  req.session.user = sessionUser(user);
  req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  auth.audit(user.id, "login_success");
  return res.json({ ok: true, user: publicSessionUser(req.session.user) });
});

app.use("/api", requireAuthApi);

app.get("/api/session", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    user: publicSessionUser(req.session.user),
    csrfToken: req.session.csrfToken,
    taskQuota: auth.taskQuotaStatus(req.session.user.id, req.session.user.role),
    queue: overviewService.getStatus()
  });
});

app.post("/api/logout", requireCsrf, async (req, res) => {
  const userId = req.session.user.id;
  await overviewService.closeUser(userId).catch(() => {});
  auth.audit(userId, "logout");
  await destroySession(req);
  res.clearCookie("iis.sid", { httpOnly: true, sameSite: "lax", secure: secureCookies });
  res.json({ ok: true });
});

app.post("/api/account/password", requireCsrf, async (req, res) => {
  const parsed = PasswordSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "密码长度需为10-128位" });
  const user = auth.setPassword(req.session.user.id, parsed.data.password, false);
  req.session.user = sessionUser(user);
  auth.audit(user.id, "password_changed");
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (!req.session.user.mustChangePassword) return next();
  res.status(428).json({ ok: false, code: "password_change_required", error: "首次登录请先修改密码" });
});

app.get("/api/photo-complaints", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, data: photoComplaintService.list(req.session.user.id, req.session.user.role === "admin") });
});

app.get("/api/photo-complaints-options/problem-labels", (req, res) => {
  const selected = parseTaxonomyPath(req.query.path);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.json({ ok: true, data: { loginRequired: false, options: taxonomyOptions(selected), source: "verified-fixed-taxonomy" } });
});

app.post("/api/photo-complaints", requireCsrf, uploadLimiter, photoUpload.array("images", 10), (req, res) => {
  const amount = (req.files || []).length;
  let quotaConsumed = false;
  try {
    if (amount > 0) {
      auth.consumeTaskQuota(req.session.user.id, req.session.user.role, "photo", amount);
      quotaConsumed = true;
    }
    const tasks = photoComplaintService.createTasks(req.files || [], req.session.user.id);
    auth.audit(req.session.user.id, "photo_complaints_uploaded", tasks.map((task) => task.id).join(","));
    res.status(202).json({ ok: true, data: tasks });
  } catch (error) {
    if (quotaConsumed) auth.refundTaskQuota(req.session.user.id, req.session.user.role, "photo", amount);
    for (const file of req.files || []) fsSafeRemove(file.path);
    handleApiError(res, error, "上传图片失败", error.statusCode || 400);
  }
});

app.get("/api/photo-complaints/:id", (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); res.json({ ok: true, data: photoComplaintService.get(req.params.id, req.session.user.id, req.session.user.role === "admin") }); }
  catch (error) { handleApiError(res, error, "读取图片录单任务失败", error.statusCode || 500); }
});

app.patch("/api/photo-complaints/:id/review", requireCsrf, (req, res) => {
  try { const data = photoComplaintService.updateReview(req.params.id, req.session.user.id, req.body || {}); auth.audit(req.session.user.id, "photo_complaint_reviewed", req.params.id); res.json({ ok: true, data }); }
  catch (error) { handleApiError(res, error, "保存复核结果失败", error.statusCode || 500); }
});

app.post("/api/photo-complaints/:id/fill", requireCsrf, async (req, res) => {
  try { const data = await photoComplaintService.requestFill(req.params.id, req.session.user.id); auth.audit(req.session.user.id, "photo_complaint_fill_requested", req.params.id); res.status(202).json({ ok: true, data }); }
  catch (error) { handleApiError(res, error, "启动自动填表失败", error.statusCode || 500); }
});

app.post("/api/photo-complaints/:id/resume-login", requireCsrf, async (req, res) => {
  try { res.status(202).json({ ok: true, data: await photoComplaintService.resumeLogin(req.params.id, req.session.user.id) }); }
  catch (error) { handleApiError(res, error, "继续扫码验证失败", error.statusCode || 500); }
});

app.get("/api/photo-complaints/:id/screenshots/:kind", (req, res) => {
  try { const file = photoComplaintService.screenshot(req.params.id, req.session.user.id, req.params.kind); res.setHeader("Cache-Control", "no-store"); res.type("png").sendFile(file); }
  catch (error) { handleApiError(res, error, "读取截图失败", error.statusCode || 500); }
});

app.patch("/api/photo-complaints/:id/main-order", requireCsrf, async (req, res) => {
  try {
    const data = await photoComplaintService.adjustMainOrder(req.params.id, req.session.user.id, req.body?.mainOrderId);
    auth.audit(req.session.user.id, "photo_complaint_main_order_adjusted", `${req.params.id}:${req.body?.mainOrderId || ""}`);
    res.json({ ok: true, data });
  } catch (error) { handleApiError(res, error, "调整主订单ID失败", error.statusCode || 500); }
});

app.post("/api/photo-complaints/:id/manual-complete", requireCsrf, async (req, res) => {
  try {
    const data = await photoComplaintService.markManualCompleted(req.params.id, req.session.user.id);
    auth.audit(req.session.user.id, "photo_complaint_manual_completed", req.params.id);
    res.json({ ok: true, data });
  } catch (error) { handleApiError(res, error, "标记人工提交完成失败", error.statusCode || 500); }
});

app.delete("/api/photo-complaints/:id", requireCsrf, (req, res) => {
  try { const data = photoComplaintService.cancel(req.params.id, req.session.user.id, req.session.user.role === "admin"); auth.audit(req.session.user.id, "photo_complaint_cancelled", req.params.id); res.json({ ok: true, data }); }
  catch (error) { handleApiError(res, error, "取消任务失败", error.statusCode || 500); }
});

app.get("/api/pipeline", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    data: pipelineService.getStatus(req.session.user.id, req.session.user.role === "admin")
  });
});

app.get("/api/pipeline/workbooks", (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, data: pipelineService.listWorkbooks(req.session.user.id) });
  } catch (error) {
    handleApiError(res, error, "读取 Excel 文件列表失败");
  }
});

app.post(
  "/api/pipeline/upload",
  requireCsrf,
  uploadLimiter,
  express.raw({
    type: ["application/octet-stream", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    limit: "64mb"
  }),
  (req, res) => {
    try {
      const filename = req.query.filename || req.get("x-file-name") || "";
      const uploaded = pipelineService.saveUploadedWorkbook(filename, req.body, req.session.user.id);
      auth.audit(req.session.user.id, "pipeline_workbook_uploaded", uploaded.name);
      res.status(201).json({ ok: true, data: { ...uploaded, path: undefined } });
    } catch (error) {
      handleApiError(res, error, "上传 Excel 失败", error.statusCode || 500);
    }
  }
);

app.post("/api/pipeline/jobs", requireCsrf, (req, res) => {
  const parsed = PipelineJobSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message || "工作流参数不正确" });
  }
  let quotaConsumed = false;
  try {
    auth.consumeTaskQuota(req.session.user.id, req.session.user.role, "pipeline");
    quotaConsumed = true;
    // 生产任务接口永远不接受客户端调试参数。即使请求体被手工篡改，
    // 传入执行层的值也会被服务端固定为 false。
    const job = pipelineService.start(
      { ...parsed.data, debug: false },
      req.session.user.id,
      req.session.user.role === "admin"
    );
    auth.audit(req.session.user.id, "pipeline_started", `${job.mode}:${job.id}`);
    res.status(202).json({ ok: true, data: job });
  } catch (error) {
    if (quotaConsumed) auth.refundTaskQuota(req.session.user.id, req.session.user.role, "pipeline");
    if (error.statusCode === 409) {
      return res.status(409).json({
        ok: false,
        code: "pipeline_busy",
        error: error.message,
        data: pipelineService.getStatus(req.session.user.id, req.session.user.role === "admin")
      });
    }
    handleApiError(res, error, "启动批量任务失败", error.statusCode || 500);
  }
});

app.get("/api/pipeline/jobs/:id", (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const job = pipelineService.getJob(req.params.id, req.session.user.id, req.session.user.role === "admin");
    res.json({ ok: true, data: job });
  } catch (error) {
    handleApiError(res, error, "读取任务状态失败", error.statusCode || 500);
  }
});

app.post("/api/pipeline/jobs/:id/continue-login", requireCsrf, (req, res) => {
  try {
    const job = pipelineService.continueLogin(req.params.id, req.session.user.id, req.session.user.role === "admin");
    res.json({ ok: true, data: job });
  } catch (error) {
    handleApiError(res, error, "继续登录验证失败", error.statusCode || 500);
  }
});

app.get("/api/pipeline/jobs/:id/login-screenshot", (req, res) => {
  try {
    const file = pipelineService.loginScreenshotFile(
      req.params.id,
      req.session.user.id,
      req.session.user.role === "admin"
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.type("png").sendFile(file.path);
  } catch (error) {
    handleApiError(res, error, "读取登录页画面失败", error.statusCode || 500);
  }
});

app.delete("/api/pipeline/jobs/:id", requireCsrf, async (req, res) => {
  try {
    const job = await pipelineService.cancel(req.params.id, req.session.user.id, req.session.user.role === "admin");
    auth.audit(req.session.user.id, "pipeline_cancelled", req.params.id);
    res.json({ ok: true, data: job });
  } catch (error) {
    handleApiError(res, error, "取消任务失败", error.statusCode || 500);
  }
});

app.get("/api/pipeline/jobs/:id/download", (req, res) => {
  try {
    const file = pipelineService.resultFile(req.params.id, req.session.user.id, req.session.user.role === "admin");
    res.download(file.path, file.name);
  } catch (error) {
    handleApiError(res, error, "下载任务结果失败", error.statusCode || 500);
  }
});

app.use(requireAuthPage);
app.use((req, res, next) => {
  if (/\.html$/i.test(req.path)) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  next();
});
app.use(express.static(path.join(rootDir, "public"), { index: false, maxAge: production ? "1h" : 0 }));

app.get("/api/health", (req, res) => {
  res.json({
    ok: !shuttingDown,
    name: "interest-island-user-overview",
    queue: overviewService.getStatus(),
    browser: browserClient.getStatus(),
    pipeline: pipelineService.getStatus(req.session.user.id),
    time: new Date().toISOString()
  });
});

app.post("/api/backend-login/start", requireCsrf, async (req, res) => {
  try {
    const data = await overviewService.startBackendLogin(req.session.user.id, req.sessionID);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, data, queue: overviewService.getStatus() });
  } catch (error) {
    handleApiError(res, error, "启动兴趣岛扫码失败");
  }
});

app.get("/api/backend-login/status", async (req, res) => {
  try {
    const data = await overviewService.getBackendLoginStatus(req.session.user.id, req.sessionID);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, data, queue: overviewService.getStatus() });
  } catch (error) {
    handleApiError(res, error, "检查扫码状态失败");
  }
});

app.get("/api/backend-login/screenshot", (req, res) => {
  const screenshot = overviewService.getBackendLoginScreenshot(req.session.user.id, req.sessionID);
  if (!screenshot) return res.status(404).json({ ok: false, error: "当前没有可用的扫码页面" });
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  return res.send(screenshot);
});

app.delete("/api/backend-login", requireCsrf, async (req, res) => {
  const cancelled = await overviewService.cancelBackendLogin(req.session.user.id, req.sessionID);
  res.json({ ok: true, cancelled });
});

app.get("/api/user-overview/progress", (req, res) => {
  const progressId = String(req.query.progressId || "").trim();
  if (!progressId || !/^[a-zA-Z0-9_-]{8,80}$/.test(progressId)) {
    return res.json({ ok: true, data: { state: "idle", stage: "idle", label: "等待开始查询", steps: [] } });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    ok: true,
    data: overviewService.getProgress(progressId, req.session.user.id)
  });
});

app.post("/api/user-overview", requireCsrf, overviewLimiter, (req, res) => {
  const parsed = QuerySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message || "请求参数不正确" });
  }
  let quotaConsumed = false;
  try {
    auth.consumeTaskQuota(req.session.user.id, req.session.user.role, "overview");
    quotaConsumed = true;
    auth.audit(req.session.user.id, "query_started", `${parsed.data.mode}:${maskQueryId(parsed.data.userId)}`);
    const task = overviewService.startOverview(parsed.data, req.session.user.id);
    if (task.resumed) {
      auth.refundTaskQuota(req.session.user.id, req.session.user.role, "overview");
      quotaConsumed = false;
    }
    return res.status(202).json({ ok: true, data: task });
  } catch (error) {
    if (quotaConsumed) auth.refundTaskQuota(req.session.user.id, req.session.user.role, "overview");
    logger.writeJson("request-error", {
      websiteUserId: req.session.user.id,
      queryId: maskQueryId(parsed.data.userId),
      message: error.message
    });
    return handleApiError(res, error, "查询失败");
  }
});

app.get("/api/admin/users", requireAdminApi, (_req, res) => {
  res.json({
    ok: true,
    data: auth.listUsers().map((user) => ({
      ...user,
      taskQuota: auth.taskQuotaStatus(user.id, user.role)
    }))
  });
});

app.post("/api/admin/users", requireAdminApi, requireCsrf, (req, res) => {
  const parsed = CreateUserSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "账号信息不正确" });
  if (auth.countUsers() >= 5) {
    return res.status(409).json({ ok: false, error: "账号总数不能超过5个（包含管理员账号）" });
  }
  try {
    const initialPassword = parsed.data.password || crypto.randomBytes(12).toString("base64url");
    const user = auth.createUser({ ...parsed.data, password: initialPassword, mustChangePassword: true });
    auth.audit(req.session.user.id, "admin_user_created", user.id);
    res.status(201).json({ ok: true, data: user, initialPassword });
  } catch (error) {
    handleApiError(res, error, "创建账号失败", 400);
  }
});

app.patch("/api/admin/users/:id", requireAdminApi, requireCsrf, async (req, res) => {
  const parsed = PatchUserSchema.safeParse(req.body || {});
  const target = auth.getUser(req.params.id);
  if (!parsed.success || !target) return res.status(404).json({ ok: false, error: "账号不存在或参数不正确" });
  if (target.id === req.session.user.id && parsed.data.disabled) {
    return res.status(400).json({ ok: false, error: "不能禁用当前登录的管理员账号" });
  }
  if (target.role === "admin" && parsed.data.disabled && auth.countAdmins() <= 1) {
    return res.status(400).json({ ok: false, error: "必须至少保留一个可用管理员" });
  }
  const user = auth.setDisabled(target.id, parsed.data.disabled);
  if (parsed.data.disabled) {
    database.sessionStore.destroyUserSessions(target.id);
    await overviewService.disableUser(target.id, { deleteProfile: true });
  } else {
    overviewService.enableUser(target.id);
  }
  auth.audit(req.session.user.id, parsed.data.disabled ? "admin_user_disabled" : "admin_user_enabled", target.id);
  res.json({ ok: true, data: user });
});

app.post("/api/admin/users/:id/reset-password", requireAdminApi, requireCsrf, (req, res) => {
  const target = auth.getUser(req.params.id);
  if (!target) return res.status(404).json({ ok: false, error: "账号不存在" });
  const password = crypto.randomBytes(12).toString("base64url");
  const user = auth.setPassword(target.id, password, true);
  database.sessionStore.destroyUserSessions(target.id);
  auth.audit(req.session.user.id, "admin_password_reset", target.id);
  res.json({ ok: true, data: user, initialPassword: password });
});

app.post("/api/admin/users/:id/task-quota", requireAdminApi, requireCsrf, (req, res) => {
  const parsed = TaskQuotaGrantSchema.safeParse(req.body || {});
  const target = auth.getUser(req.params.id);
  if (!parsed.success || !target) return res.status(404).json({ ok: false, error: "账号不存在或额度类型不正确" });
  try {
    const quota = auth.grantTaskQuota(target.id, target.role, parsed.data.taskType);
    auth.audit(req.session.user.id, "admin_task_quota_granted", `${target.id}:${parsed.data.taskType}:+15`);
    res.json({ ok: true, data: quota });
  } catch (error) {
    handleApiError(res, error, "追加任务额度失败", error.statusCode || 400);
  }
});

app.delete("/api/admin/users/:id/profile", requireAdminApi, requireCsrf, async (req, res) => {
  const target = auth.getUser(req.params.id);
  if (!target) return res.status(404).json({ ok: false, error: "账号不存在" });
  await overviewService.disableUser(target.id, { deleteProfile: true });
  if (!target.disabled) overviewService.enableUser(target.id);
  auth.audit(req.session.user.id, "admin_profile_deleted", target.id);
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  logger.writeJson("server-error", { message: error.message, stack: error.stack });
  if (!res.headersSent) res.status(500).json({ ok: false, error: "服务处理失败" });
});

const server = app.listen(config.server.port, config.server.host, () => {
  console.log(`客满运营台已就绪：http://${config.server.host}:${config.server.port}`);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function fsSafeRemove(file) { try { fs.rmSync(file, { force: true }); } catch {} }

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在退出...`);
  server.close();
  await pipelineService.close();
  photoComplaintService.close();
  await browserClient.close();
  database.close();
  process.exit(0);
}

function requireAuthPage(req, res, next) {
  const user = req.session?.user && auth.getUser(req.session.user.id);
  if (!user || user.disabled) return res.redirect("/login");
  req.session.user = sessionUser(user);
  next();
}

function requireAdminPage(req, res, next) {
  if (req.session.user.role !== "admin") return res.status(403).send("无权访问");
  next();
}

function requireAuthApi(req, res, next) {
  const user = req.session?.user && auth.getUser(req.session.user.id);
  if (!user || user.disabled) {
    req.session?.destroy?.(() => {});
    return res.status(401).json({ ok: false, error: "未登录、登录已过期或账号已禁用" });
  }
  req.session.user = sessionUser(user);
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  next();
}

function requireAdminApi(req, res, next) {
  if (req.session.user.role !== "admin") return res.status(403).json({ ok: false, error: "无管理员权限" });
  next();
}

function requireCsrf(req, res, next) {
  const supplied = String(req.get("x-csrf-token") || "");
  const expected = String(req.session?.csrfToken || "");
  const valid = supplied.length === expected.length && supplied.length > 0
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return res.status(403).json({ ok: false, error: "请求校验失败，请刷新页面后重试" });
  next();
}

function sessionUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: Boolean(user.mustChangePassword)
  };
}

function publicSessionUser(user) {
  return {
    username: user.username,
    role: user.role,
    mustChangePassword: Boolean(user.mustChangePassword)
  };
}

function isAllowedOrigin(req, origin, allowedOrigins = []) {
  try {
    const originUrl = new URL(origin);
    if (!production && originUrl.host === req.get("host")) return true;
    return allowedOrigins.includes(originUrl.origin.toLowerCase());
  } catch {
    return false;
  }
}

function booleanFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return Boolean(fallback);
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

async function delayedLoginFailure(res) {
  await new Promise((resolve) => setTimeout(resolve, 500 + crypto.randomInt(0, 301)));
  return res.status(401).json({ ok: false, error: "用户名或密码错误" });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
}

function destroySession(req) {
  return new Promise((resolve) => req.session.destroy(() => resolve()));
}

function handleApiError(res, error, fallback, status = 500) {
  if (res.headersSent) return;
  const message = error?.message || fallback;
  const clientStatus = error?.statusCode || (/不存在|参数|密码|用户名|无效/.test(message) ? 400 : status);
  const safeMessage = Number.isInteger(error?.statusCode) && clientStatus >= 400 && clientStatus < 500
    ? message
    : fallback;
  res.status(clientStatus).json({ ok: false, error: safeMessage });
}

function maskUsername(value) {
  const text = String(value || "");
  return text.length < 3 ? "***" : `${text.slice(0, 2)}***`;
}

function maskQueryId(value) {
  const text = String(value || "");
  return text.length <= 6 ? "***" : `${text.slice(0, 3)}***${text.slice(-3)}`;
}
