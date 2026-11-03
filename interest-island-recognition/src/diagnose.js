import fs from "node:fs";
import path from "node:path";

const showSensitive = process.argv.includes("--show-sensitive");
const logPath = process.argv.slice(2).find((argument) => argument !== "--show-sensitive");

if (!logPath) {
  console.error("用法：npm run diagnose -- logs/run-xxxx.jsonl [--show-sensitive]");
  process.exit(1);
}

const rows = fs
  .readFileSync(path.resolve(logPath), "utf8")
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const total = rows.length;
const pending = rows.filter((row) => row.needsReview);
const matched = rows.filter((row) => row.matchedMessage);
const found = rows.filter((row) => row.foundConversation);

console.log(`总行数：${total}`);
console.log(`待复核：${pending.length}`);
console.log(`找到会话：${found.length}`);
console.log(`查询到相关记录：${matched.length}`);
console.log("");

printCounter("待复核原因", pending.flatMap((row) => row.diagnosis?.length ? row.diagnosis : [fallbackReason(row)]));
printCounter("网页错误/提示", rows.map((row) => row.error || "无"));
printCounter("候选尝试数", rows.map((row) => `${row.candidateTried || 0} 个候选`));
printCounter("网页搜索关键词", rows.map((row) => row.searchKeyword || "未记录"));
printCounter("相关记录数", rows.map((row) => `${row.relatedRecords || 0} 条`));
printCounter("相关会话点击", rows.map((row) => row.conversationClicked ? "已点击" : "未点击"));
printCounter("相关记录点击", rows.map((row) => row.recordClicked ? "已点击" : "未点击"));
printCounter("右侧上下文", rows.map((row) => row.contextOpened ? "已打开" : "未打开"));

console.log("\n待复核明细：");
for (const row of pending) {
  const causes = row.diagnosis?.length ? row.diagnosis.join("、") : fallbackReason(row);
  const userId = showSensitive ? row.userId : maskIdentifier(row.userId);
  const receiverName = showSensitive ? row.receiverName : maskName(row.receiverName);
  const message = showSensitive ? trim(row.message, 40) : "[消息内容已隐藏]";
  console.log(`行 ${row.rowNumber}｜${userId}｜${receiverName}｜${causes}｜${message}`);
}

function printCounter(title, values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  console.log(`${title}：`);
  for (const [value, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`- ${count}：${value}`);
  }
  console.log("");
}

function fallbackReason(row) {
  if (!row.matchedMessage) return "未查询到相关记录";
  if (!row.firstCategory) return "规则未命中";
  return row.reason || "未知";
}

function trim(value, size) {
  const text = String(value || "").replace(/\s+/g, " ");
  return text.length > size ? `${text.slice(0, size)}...` : text;
}

function maskIdentifier(value) {
  const text = String(value || "");
  if (text.length <= 4) return "****";
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function maskName(value) {
  const text = String(value || "");
  if (!text) return "";
  return `${text.slice(0, 1)}${"*".repeat(Math.max(1, text.length - 1))}`;
}
