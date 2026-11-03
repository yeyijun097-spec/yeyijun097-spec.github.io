import fs from "node:fs";
import path from "node:path";

export function createDebugLogger(config) {
  const enabled = Boolean(config.debug?.enabled);
  const dir = path.resolve(config.debug?.dir || "logs");
  const includePageText = config.debug?.includePageText !== false;
  const screenshots = config.debug?.screenshots !== false;
  const retentionDays = Math.max(1, Number(config.debug?.retentionDays || 7));
  const maxFiles = Math.max(20, Number(config.debug?.maxFiles || 300));
  if (enabled) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    cleanupDebugFiles(dir, retentionDays, maxFiles);
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
      cleanupDebugFiles(dir, retentionDays, maxFiles);
      return artifact;
    },

    writeJson(name, data) {
      if (!enabled) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `${stamp}-${safeName(name)}.json`);
      fs.writeFileSync(file, JSON.stringify(sanitizeJson(data), null, 2), { encoding: "utf8", mode: 0o600 });
      cleanupDebugFiles(dir, retentionDays, maxFiles);
      return file;
    }
  };
}

function cleanupDebugFiles(dir, retentionDays, maxFiles) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(dir, entry.name);
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const [index, item] of files.entries()) {
    if (item.mtimeMs >= cutoff && index < maxFiles) continue;
    fs.unlinkSync(item.file);
  }
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
  if (/^(userId|phone|mobile)$/i.test(key)) return maskToken(String(value));
  return value;
}

function safeName(value) {
  return String(value || "debug").replace(/[^\w.-]+/g, "-").slice(0, 80);
}

function sanitizeText(text, query) {
  let value = String(text || "");
  for (const item of [query.userId, query.phone]) {
    const token = String(item || "").trim();
    if (!token) continue;
    value = value.split(token).join(maskToken(token));
  }
  return value;
}

function maskToken(token) {
  if (token.length <= 4) return "****";
  return `${token.slice(0, 2)}****${token.slice(-2)}`;
}
