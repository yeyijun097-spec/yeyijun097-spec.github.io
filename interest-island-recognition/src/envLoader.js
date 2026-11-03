import fs from "node:fs";
import path from "node:path";

export function loadLocalEnv(filePath = ".env.local") {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return false;

  const content = fs.readFileSync(resolved, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index <= 0) continue;

    const key = trimmed.slice(0, index).trim();
    const value = unquote(trimmed.slice(index + 1).trim());
    if (!key || process.env[key]) continue;
    process.env[key] = value;
  }

  return true;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
