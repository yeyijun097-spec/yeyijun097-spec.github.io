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
      ...(config.server || {}),
      host: process.env.SERVER_HOST || config.server?.host || "127.0.0.1",
      port: numberFromEnv("PORT", config.server?.port || 3128),
      trustProxy: booleanFromEnv("TRUST_PROXY", config.server?.trustProxy || false),
      requestTimeoutMs: numberFromEnv("REQUEST_TIMEOUT_MS", config.server?.requestTimeoutMs || 300000),
      allowedOrigins: listFromEnv("ALLOWED_ORIGINS", config.server?.allowedOrigins || []),
      requireProxyIdentity: booleanFromEnv("REQUIRE_PROXY_IDENTITY", config.server?.requireProxyIdentity || false),
      adminUsers: listFromEnv("ADMIN_USERS", config.server?.adminUsers || []),
      sessionSecret: process.env.SESSION_SECRET || config.server?.sessionSecret || "dev-insecure-session-secret"
    },
    browser: {
      dashboardUrl: "https://edu-admin.qlchat.com/dashboard",
      chanceAssUrl: "https://edu-admin.qlchat.com/saleAssign/chanceAss",
      contentCampUrl: "https://edu-admin.qlchat.com/content/camp",
      complaintWorkUrl: "https://edu-admin.qlchat.com/complaint/complaintWork",
      headless: false,
      profileRoot: ".browser-profiles",
      timeoutMs: 30000,
      viewport: { width: 1440, height: 960 },
      ...(config.browser || {}),
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
      llmEnabled: false,
      llmBaseUrl: "",
      llmModel: "",
      loginGraceMs: 60000,
      ...(config.photoComplaints || {}),
      enabled: booleanFromEnv("PHOTO_COMPLAINTS_ENABLED", config.photoComplaints?.enabled ?? true),
      tempDir: expandHome(process.env.PHOTO_COMPLAINTS_TEMP_DIR || config.photoComplaints?.tempDir || path.join(process.env.DATA_DIR || config.storage?.dataDir || ".data", "photo-complaints")),
      python: process.env.PHOTO_OCR_PYTHON || config.photoComplaints?.python || "python3",
      ocrScript: path.resolve(process.env.PHOTO_OCR_SCRIPT || config.photoComplaints?.ocrScript || "scripts/photo_complaint_ocr.py"),
      llmEnabled: booleanFromEnv("PHOTO_LLM_ENABLED", config.photoComplaints?.llmEnabled ?? false),
      llmBaseUrl: process.env.PHOTO_LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || config.photoComplaints?.llmBaseUrl || "",
      llmModel: process.env.PHOTO_LLM_MODEL || process.env.DEEPSEEK_MODEL || config.photoComplaints?.llmModel || "",
      loginGraceMs: numberFromEnv("PHOTO_LOGIN_GRACE_MS", config.photoComplaints?.loginGraceMs || 60000)
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
      stopTimeoutMs: numberFromEnv("PIPELINE_STOP_TIMEOUT_MS", config.pipeline?.stopTimeoutMs || 8000)
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
      enabled: true,
      dir: "logs",
      includePageText: true,
      screenshots: true,
      retentionDays: 7,
      maxFiles: 300,
      ...(config.debug || {}),
      dir: process.env.DEBUG_DIR || config.debug?.dir || "logs"
    }
  };
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
