import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function loadConfig(configPath = "config/default.json") {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`未找到配置文件：${resolved}`);
  }

  const config = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return {
    server: {
      host: "127.0.0.1",
      port: 3128,
      trustProxy: false,
      requestTimeoutMs: 300000,
      allowedOrigins: [],
      requireProxyIdentity: false,
      identityHeader: "tailscale-user-login",
      adminUsers: [],
      queryRateLimit: 6,
      queryQueueGlobalLimit: 20,
      queryQueuePerUserLimit: 2,
      ...(config.server || {}),
      host: process.env.SERVER_HOST || config.server?.host || "127.0.0.1",
      port: numberFromEnv("PORT", config.server?.port || 3128),
      trustProxy: booleanFromEnv("TRUST_PROXY", config.server?.trustProxy || false),
      requestTimeoutMs: numberFromEnv("REQUEST_TIMEOUT_MS", config.server?.requestTimeoutMs || 300000),
      allowedOrigins: listFromEnv("ALLOWED_ORIGINS", config.server?.allowedOrigins || []),
      requireProxyIdentity: booleanFromEnv("REQUIRE_PROXY_IDENTITY", config.server?.requireProxyIdentity || false),
      adminUsers: listFromEnv("ADMIN_USERS", config.server?.adminUsers || []),
      queryRateLimit: numberFromEnv("QUERY_RATE_LIMIT", config.server?.queryRateLimit || 6),
      queryQueueGlobalLimit: numberFromEnv("QUERY_QUEUE_GLOBAL_LIMIT", config.server?.queryQueueGlobalLimit || 20),
      queryQueuePerUserLimit: numberFromEnv("QUERY_QUEUE_PER_USER_LIMIT", config.server?.queryQueuePerUserLimit || 2),
      sessionSecret: process.env.SESSION_SECRET || config.server?.sessionSecret || "dev-insecure-session-secret"
    },
    browser: {
      dashboardUrl: "",
      chanceAssUrl: "",
      contentCampUrl: "",
      complaintWorkUrl: "",
      intentionOrderUrl: "",
      allowedHosts: [],
      headless: false,
      profileRoot: ".browser-profiles",
      timeoutMs: 30000,
      viewport: { width: 1440, height: 960 },
      ...(config.browser || {}),
      dashboardUrl: process.env.BACKEND_DASHBOARD_URL || config.browser?.dashboardUrl || "",
      chanceAssUrl: process.env.BACKEND_CHANCE_ASS_URL || config.browser?.chanceAssUrl || "",
      contentCampUrl: process.env.BACKEND_CONTENT_CAMP_URL || config.browser?.contentCampUrl || "",
      complaintWorkUrl: process.env.BACKEND_COMPLAINT_WORK_URL || config.browser?.complaintWorkUrl || "",
      intentionOrderUrl: process.env.BACKEND_INTENTION_ORDER_URL || config.browser?.intentionOrderUrl || "",
      allowedHosts: listFromEnv("BACKEND_ALLOWED_HOSTS", config.browser?.allowedHosts || []),
      profileRoot: process.env.BROWSER_PROFILE_ROOT || config.browser?.profileRoot || ".browser-profiles"
    },
    storage: {
      dataDir: process.env.DATA_DIR || config.storage?.dataDir || ".data",
      legacyUsersFile: process.env.LEGACY_USERS_FILE || config.storage?.legacyUsersFile || "config/users.json"
    },
    photoComplaints: {
      enabled: true,
      tempDir: path.join(process.env.DATA_DIR || config.storage?.dataDir || ".data", "photo-complaints"),
      python: "python3",
      ocrScript: "scripts/photo_complaint_ocr.py",
      ocrTimeoutMs: 120000,
      llmEnabled: false,
      llmBaseUrl: "",
      llmModel: "",
      llmAllowedHosts: [],
      llmDataProcessingApproved: false,
      orphanRetentionMs: 24 * 60 * 60 * 1000,
      maxArtifactFiles: 500,
      maxArtifactBytes: 1024 * 1024 * 1024,
      ...(config.photoComplaints || {}),
      enabled: booleanFromEnv("PHOTO_COMPLAINTS_ENABLED", config.photoComplaints?.enabled ?? true),
      tempDir: expandHome(process.env.PHOTO_COMPLAINTS_TEMP_DIR || config.photoComplaints?.tempDir || path.join(process.env.DATA_DIR || config.storage?.dataDir || ".data", "photo-complaints")),
      python: process.env.PHOTO_OCR_PYTHON || config.photoComplaints?.python || "python3",
      ocrScript: path.resolve(process.env.PHOTO_OCR_SCRIPT || config.photoComplaints?.ocrScript || "scripts/photo_complaint_ocr.py"),
      ocrTimeoutMs: numberFromEnv("PHOTO_OCR_TIMEOUT_MS", config.photoComplaints?.ocrTimeoutMs || 120000),
      llmEnabled: booleanFromEnv("PHOTO_LLM_ENABLED", config.photoComplaints?.llmEnabled ?? false),
      llmBaseUrl: process.env.PHOTO_LLM_BASE_URL || config.photoComplaints?.llmBaseUrl || "",
      llmModel: process.env.PHOTO_LLM_MODEL || config.photoComplaints?.llmModel || "",
      llmAllowedHosts: listFromEnv("PHOTO_LLM_ALLOWED_HOSTS", config.photoComplaints?.llmAllowedHosts || []),
      llmDataProcessingApproved: booleanFromEnv("PHOTO_LLM_DATA_PROCESSING_APPROVED", config.photoComplaints?.llmDataProcessingApproved ?? false),
      orphanRetentionMs: numberFromEnv("PHOTO_ORPHAN_RETENTION_MS", config.photoComplaints?.orphanRetentionMs || 24 * 60 * 60 * 1000),
      maxArtifactFiles: numberFromEnv("PHOTO_MAX_ARTIFACT_FILES", config.photoComplaints?.maxArtifactFiles || 500),
      maxArtifactBytes: numberFromEnv("PHOTO_MAX_ARTIFACT_BYTES", config.photoComplaints?.maxArtifactBytes || 1024 * 1024 * 1024)
    },
    pipeline: {
      enabled: true,
      projectDir: "/Users/yijunye/Documents/拟人工识别",
      outputDir: "~/Downloads/chat_export",
      inputDirs: ["~/Downloads/chat_export", "~/Downloads"],
      template: "~/敏感词跟进表【潜在风险】.classified 10.16.33.xlsx",
      sheet: "6.1-6.30",
      sharedBrowserProfile: "~/.qlchat_unified_profile",
      python: "python3",
      node: "node",
      xvfbRun: "",
      xvfbScreen: "-screen 0 1440x1000x24",
      loginScreenshotDir: "~/Downloads/chat_export/.login-screens",
      maxLogLines: 1200,
      stopTimeoutMs: 8000,
      retentionDays: 14,
      maxWorkbookFiles: 200,
      maxWorkbookBytes: 5 * 1024 * 1024 * 1024,
      loginScreenshotRetentionMs: 24 * 60 * 60 * 1000,
      ...(config.pipeline || {}),
      enabled: booleanFromEnv("PIPELINE_ENABLED", config.pipeline?.enabled ?? true),
      projectDir: expandHome(process.env.PIPELINE_PROJECT_DIR || config.pipeline?.projectDir || "/Users/yijunye/Documents/拟人工识别"),
      outputDir: expandHome(process.env.PIPELINE_OUTPUT_DIR || config.pipeline?.outputDir || "~/Downloads/chat_export"),
      inputDirs: pathListFromEnv("PIPELINE_INPUT_DIRS", config.pipeline?.inputDirs || [
        process.env.PIPELINE_OUTPUT_DIR || config.pipeline?.outputDir || "~/Downloads/chat_export",
        "~/Downloads"
      ]),
      template: expandHome(process.env.PIPELINE_TEMPLATE || config.pipeline?.template || "~/敏感词跟进表【潜在风险】.classified 10.16.33.xlsx"),
      sheet: process.env.PIPELINE_SHEET || config.pipeline?.sheet || "6.1-6.30",
      sharedBrowserProfile: expandHome(process.env.PIPELINE_SHARED_PROFILE || config.pipeline?.sharedBrowserProfile || "~/.qlchat_unified_profile"),
      python: process.env.PIPELINE_PYTHON || config.pipeline?.python || "python3",
      node: process.env.PIPELINE_NODE || config.pipeline?.node || "node",
      xvfbRun: process.env.PIPELINE_XVFB_RUN || config.pipeline?.xvfbRun || "",
      xvfbScreen: process.env.PIPELINE_XVFB_SCREEN || config.pipeline?.xvfbScreen || "-screen 0 1440x1000x24",
      loginScreenshotDir: expandHome(
        process.env.PIPELINE_LOGIN_SCREENSHOT_DIR
          || config.pipeline?.loginScreenshotDir
          || path.join(process.env.PIPELINE_OUTPUT_DIR || config.pipeline?.outputDir || "~/Downloads/chat_export", ".login-screens")
      ),
      maxLogLines: numberFromEnv("PIPELINE_MAX_LOG_LINES", config.pipeline?.maxLogLines || 1200),
      stopTimeoutMs: numberFromEnv("PIPELINE_STOP_TIMEOUT_MS", config.pipeline?.stopTimeoutMs || 8000),
      retentionDays: numberFromEnv("PIPELINE_RETENTION_DAYS", config.pipeline?.retentionDays || 14),
      maxWorkbookFiles: numberFromEnv("PIPELINE_MAX_WORKBOOK_FILES", config.pipeline?.maxWorkbookFiles || 200),
      maxWorkbookBytes: numberFromEnv("PIPELINE_MAX_WORKBOOK_BYTES", config.pipeline?.maxWorkbookBytes || 5 * 1024 * 1024 * 1024),
      loginScreenshotRetentionMs: numberFromEnv("PIPELINE_LOGIN_SCREENSHOT_RETENTION_MS", config.pipeline?.loginScreenshotRetentionMs || 24 * 60 * 60 * 1000)
    },
    ui: {
      afterGotoWaitMs: 1000,
      afterFillWaitMs: 250,
      afterQueryWaitMs: 2500,
      afterClickWaitMs: 1200,
      ...(config.ui || {})
    },
    selectors: {
      queryButtonText: "查询",
      resetButtonText: "重置",
      studentProfileText: "学员档案",
      orderInfoText: "订单信息",
      detailButtonText: "查看详情",
      ...(config.selectors || {})
    },
    fields: config.fields || {},
    debug: {
      enabled: false,
      dir: "logs",
      includePageText: false,
      screenshots: false,
      retentionDays: 7,
      maxFiles: 300,
      maxBytes: 256 * 1024 * 1024,
      ...(config.debug || {}),
      enabled: booleanFromEnv("DEBUG_ENABLED", config.debug?.enabled ?? false),
      dir: process.env.DEBUG_DIR || config.debug?.dir || "logs",
      includePageText: booleanFromEnv("DEBUG_INCLUDE_PAGE_TEXT", config.debug?.includePageText ?? false),
      screenshots: booleanFromEnv("DEBUG_SCREENSHOTS", config.debug?.screenshots ?? false),
      retentionDays: numberFromEnv("DEBUG_RETENTION_DAYS", config.debug?.retentionDays || 7),
      maxFiles: numberFromEnv("DEBUG_MAX_FILES", config.debug?.maxFiles || 300),
      maxBytes: numberFromEnv("DEBUG_MAX_BYTES", config.debug?.maxBytes || 256 * 1024 * 1024)
    }
  };
}

const BACKEND_URL_FIELDS = Object.freeze([
  ["dashboardUrl", "BACKEND_DASHBOARD_URL"],
  ["chanceAssUrl", "BACKEND_CHANCE_ASS_URL"],
  ["contentCampUrl", "BACKEND_CONTENT_CAMP_URL"],
  ["complaintWorkUrl", "BACKEND_COMPLAINT_WORK_URL"],
  ["intentionOrderUrl", "BACKEND_INTENTION_ORDER_URL"]
]);

export function validateBackendConfig(config, { production = false } = {}) {
  const allowedHosts = new Set((config.browser?.allowedHosts || []).map(normalizeHost).filter(Boolean));
  if (production && !allowedHosts.size) {
    throw new Error("生产环境必须通过 BACKEND_ALLOWED_HOSTS 配置后台主机白名单");
  }
  for (const [field, envName] of BACKEND_URL_FIELDS) {
    const value = String(config.browser?.[field] || "").trim();
    if (!value) {
      if (production) throw new Error(`生产环境缺少后台地址环境变量：${envName}`);
      continue;
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`后台地址格式不正确：${envName}`);
    }
    if (parsed.protocol !== "https:") throw new Error(`后台地址必须使用 HTTPS：${envName}`);
    if (parsed.hostname.endsWith(".invalid")) throw new Error(`后台地址仍为无效占位值：${envName}`);
    if (isForbiddenBackendHost(parsed.hostname)) throw new Error(`后台地址不得使用本机或内网主机：${envName}`);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`后台地址不得包含凭证、查询参数或片段：${envName}`);
    }
    if (production && !allowedHosts.has(parsed.hostname.toLowerCase())) {
      throw new Error(`后台地址主机不在 BACKEND_ALLOWED_HOSTS 白名单：${envName}`);
    }
  }
  validatePhotoLlmConfig(config);
  return config;
}

function validatePhotoLlmConfig(config) {
  const options = config.photoComplaints || {};
  if (!options.llmEnabled) return;

  if (!options.llmDataProcessingApproved) {
    throw new Error("启用图片 LLM 前必须明确设置 PHOTO_LLM_DATA_PROCESSING_APPROVED=true");
  }
  const allowedHosts = new Set((options.llmAllowedHosts || []).map(normalizeHost).filter(Boolean));
  if (!allowedHosts.size) {
    throw new Error("启用图片 LLM 前必须通过 PHOTO_LLM_ALLOWED_HOSTS 配置受控主机白名单");
  }
  const value = String(options.llmBaseUrl || "").trim();
  if (!value) throw new Error("启用图片 LLM 前必须配置 PHOTO_LLM_BASE_URL");

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("图片 LLM 地址格式不正确：PHOTO_LLM_BASE_URL");
  }
  if (parsed.protocol !== "https:") throw new Error("图片 LLM 地址必须使用 HTTPS：PHOTO_LLM_BASE_URL");
  if (parsed.hostname.endsWith(".invalid")) throw new Error("图片 LLM 地址不得使用无效占位域名：PHOTO_LLM_BASE_URL");
  if (isForbiddenBackendHost(parsed.hostname)) throw new Error("图片 LLM 地址不得使用本机或内网主机：PHOTO_LLM_BASE_URL");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("图片 LLM 地址不得包含凭证、查询参数或片段：PHOTO_LLM_BASE_URL");
  }
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error("图片 LLM 地址主机不在 PHOTO_LLM_ALLOWED_HOSTS 白名单");
  }
}

function normalizeHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (!host || host.includes("/") || host.includes(":") || !/^[a-z0-9.-]+$/.test(host)) return "";
  return host;
}

function isForbiddenBackendHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

function booleanFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return Boolean(fallback);
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : Number(fallback);
}

function listFromEnv(name, fallback) {
  const value = process.env[name];
  const source = value === undefined ? fallback : value.split(",");
  return [...new Set((source || []).map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

function pathListFromEnv(name, fallback) {
  const value = process.env[name];
  const source = value === undefined ? fallback : value.split(",");
  return [...new Set((source || []).map((item) => String(item).trim()).filter(Boolean).map(expandHome))];
}

function expandHome(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}
