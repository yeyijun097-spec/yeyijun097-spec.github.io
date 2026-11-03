import fs from "node:fs";
import path from "node:path";

export function resolveWorkbookPath(config, args = {}) {
  const explicitPath = args.workbook || args.file || args.input;
  const configuredPath = explicitPath ? path.resolve(explicitPath) : path.resolve(config.workbookPath);

  if (fs.existsSync(configuredPath)) {
    config.workbookPath = configuredPath;
    return { path: configuredPath, changed: false, explicit: Boolean(explicitPath) };
  }

  if (explicitPath) {
    throw new Error(`指定的 Excel 文件不存在：${configuredPath}`);
  }

  const fallback = findLatestWorkbookLike(configuredPath);
  if (!fallback) {
    throw new Error(`Excel 文件不存在：${configuredPath}。请确认文件位置，或用 --workbook /完整路径/文件.xlsx 指定。`);
  }

  config.workbookPath = fallback;
  return { path: fallback, changed: true, missingPath: configuredPath, explicit: false };
}

function findLatestWorkbookLike(originalPath) {
  const dir = path.dirname(originalPath);
  if (!fs.existsSync(dir)) return "";

  const originalBase = path.basename(originalPath).replace(/\.xlsx$/i, "");
  const stableTokens = tokeniseWorkbookName(originalBase);
  const files = fs.readdirSync(dir)
    .filter((name) => /\.xlsx$/i.test(name))
    .filter((name) => !name.startsWith("~$"))
    .map((name) => {
      const fullPath = path.join(dir, name);
      const stat = safeStat(fullPath);
      return stat ? { name, fullPath, mtimeMs: stat.mtimeMs, score: scoreWorkbookName(name, stableTokens) } : null;
    })
    .filter(Boolean)
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);

  return files[0]?.fullPath || "";
}

function tokeniseWorkbookName(name) {
  const tokens = String(name || "")
    .replace(/\.classified.*$/i, "")
    .split(/[\s.【】\[\]（）()_-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.length ? tokens : ["敏感词", "潜在风险"];
}

function scoreWorkbookName(name, tokens) {
  const base = name.replace(/\.xlsx$/i, "");
  let score = 0;
  for (const token of tokens) {
    if (token && base.includes(token)) score += token.length >= 3 ? 3 : 1;
  }
  if (base.includes("敏感词")) score += 4;
  if (base.includes("潜在风险")) score += 4;
  if (/classified/i.test(base)) score += 1;
  return score;
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}
