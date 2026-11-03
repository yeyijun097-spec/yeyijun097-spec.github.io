import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env.CONFIG || "config/default.json");
const profileDir = path.resolve(config.browser.userDataDir || ".browser-profile");
const defaultDir = path.join(profileDir, "Default");
const blockedHostPatterns = [/doc\.weixin\.qq\.com/i, /docs\.qq\.com/i];

async function main() {
  if (!fs.existsSync(profileDir)) {
    console.log(`未找到浏览器 profile：${profileDir}`);
    return;
  }

  const removed = [];
  for (const fileName of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    await removePath(path.join(defaultDir, fileName), removed);
  }

  for (const fileName of ["Network Persistent State"]) {
    await removePath(path.join(defaultDir, fileName), removed);
  }

  for (const dirName of [
    "IndexedDB",
    "Local Storage",
    "Session Storage",
    "Cache",
    "Code Cache",
    "Service Worker",
    "GPUCache"
  ]) {
    await removeMatchingChildren(path.join(defaultDir, dirName), removed);
  }

  await cleanPreferences(path.join(defaultDir, "Preferences"));

  console.log("已清理当前项目 .browser-profile 中的腾讯文档残留。");
  if (removed.length) {
    console.log(`删除条目 ${removed.length} 个：`);
    for (const item of removed.slice(0, 30)) console.log(`- ${path.relative(profileDir, item)}`);
    if (removed.length > 30) console.log(`... 其余 ${removed.length - 30} 个已省略`);
  }
}

async function removeMatchingChildren(root, removed) {
  if (!fs.existsSync(root)) return;
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (isBlockedText(entry.name) || isBlockedText(fullPath)) {
      await removePath(fullPath, removed);
    }
  }
}

async function removePath(target, removed) {
  if (!fs.existsSync(target)) return;
  await fs.promises.rm(target, { recursive: true, force: true });
  removed.push(target);
}

async function cleanPreferences(preferencesPath) {
  if (!fs.existsSync(preferencesPath)) return;
  const raw = await fs.promises.readFile(preferencesPath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  removeBlockedKeys(data);
  if (data.profile) data.profile.exit_type = "Normal";
  if (data.sessions) {
    delete data.sessions.event_log;
    data.sessions.session_data_status = 0;
  }
  await fs.promises.writeFile(preferencesPath, `${JSON.stringify(data)}\n`);
}

function removeBlockedKeys(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index];
      if (typeof item === "string" && isBlockedText(item)) {
        value.splice(index, 1);
      } else {
        removeBlockedKeys(item);
      }
    }
    return;
  }
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (isBlockedText(key) || (typeof item === "string" && isBlockedText(item))) {
      delete value[key];
    } else {
      removeBlockedKeys(item);
    }
  }
}

function isBlockedText(value) {
  const text = String(value || "");
  return blockedHostPatterns.some((pattern) => pattern.test(text));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
