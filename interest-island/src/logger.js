import fs from "node:fs";
import path from "node:path";
import { cleanupDirectory } from "./lifecycleCleanup.js";

export function createDebugLogger(config) {
  const enabled = Boolean(config.debug?.enabled);
  const dir = path.resolve(config.debug?.dir || "logs");
  const includePageText = config.debug?.includePageText !== false;
  const screenshots = config.debug?.screenshots !== false;
  const retentionDays = Math.max(1, Number(config.debug?.retentionDays || 7));
  const maxFiles = Math.max(20, Number(config.debug?.maxFiles || 300));
  const maxBytes = Math.max(1024 * 1024, Number(config.debug?.maxBytes || 256 * 1024 * 1024));
  if (enabled) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    cleanupDebugFiles(dir, retentionDays, maxFiles, maxBytes);
  }

  return {
    async pageSnapshot(page, name, query = {}) {
      if (!enabled) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = path.join(dir, `${stamp}-${safeName(name)}`);
      const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
      const sanitized = sanitizeText(bodyText, query);
      let artifact = null;
      if (includePageText) {
        const txtFile = `${base}.txt`;
        fs.writeFileSync(txtFile, sanitized, { encoding: "utf8", mode: 0o600 });
        artifact = txtFile;
      }
      if (screenshots) {
        const pngFile = `${base}.png`;
        await page.screenshot({ path: pngFile, fullPage: true }).catch(() => {});
        if (fs.existsSync(pngFile)) fs.chmodSync(pngFile, 0o600);
        artifact ||= pngFile;
      }
      cleanupDebugFiles(dir, retentionDays, maxFiles, maxBytes);
      return artifact;
    },

    writeJson(name, data) {
      if (!enabled) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `${stamp}-${safeName(name)}.json`);
      fs.writeFileSync(file, JSON.stringify(sanitizeJson(data), null, 2), { encoding: "utf8", mode: 0o600 });
      cleanupDebugFiles(dir, retentionDays, maxFiles, maxBytes);
      return file;
    }
  };
}

function cleanupDebugFiles(dir, retentionDays, maxFiles, maxBytes) {
  cleanupDirectory({
    dir,
    retentionMs: retentionDays * 24 * 60 * 60 * 1000,
    maxFiles,
    maxBytes
  });
}

function sanitizeJson(value, key = "") {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, key));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeJson(childValue, childKey)
    ]));
  }
  if (/cookie|token|authorization|password|secret/i.test(key)) return "[REDACTED]";
  if (/^(userId|phone|mobile|email|idCard|bankCard)$/i.test(key)) {
    return maskSensitiveValue(key, String(value));
  }
  if (/^(name|receiverName|realName|nickname|address)$/i.test(key)) return "[REDACTED]";
  if (/^(text|childTexts|rawText|bodyText|pageText|content|details|value)$/i.test(key)) {
    return `[REDACTED:${String(value).length}]`;
  }
  return value;
}

function safeName(value) {
  return String(value || "debug").replace(/[^\w.-]+/g, "-").slice(0, 80);
}

function sanitizeText(text, query) {
  let value = String(text || "");
  for (const [key, item] of [["userId", query.userId], ["phone", query.phone]]) {
    const token = String(item || "").trim();
    if (!token) continue;
    value = value.split(token).join(maskSensitiveValue(key, token));
  }
  return value;
}

function maskToken(token) {
  if (token.length <= 4) return "****";
  return `${token.slice(0, 2)}****${token.slice(-2)}`;
}

function maskSensitiveValue(key, value) {
  const token = String(value || "").trim();
  if (/^(phone|mobile)$/i.test(key) && /^1\d{10}$/.test(token)) {
    return `${token.slice(0, 3)}****${token.slice(-4)}`;
  }
  if (/^idCard$/i.test(key) && token.length >= 7) {
    return `${token.slice(0, 3)}${"*".repeat(Math.max(4, token.length - 7))}${token.slice(-4)}`;
  }
  if (/^bankCard$/i.test(key) && token.length >= 4) {
    return `${"*".repeat(Math.max(4, token.length - 4))}${token.slice(-4)}`;
  }
  if (/^email$/i.test(key)) {
    const at = token.indexOf("@");
    if (at > 0) return `${token.slice(0, Math.min(2, at))}***${token.slice(at)}`;
  }
  return maskToken(token);
}
