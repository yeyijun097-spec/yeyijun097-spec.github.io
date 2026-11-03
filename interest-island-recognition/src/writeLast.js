import fs from "node:fs";
import path from "node:path";
import { getWritableQrsUpdates } from "./profileFieldTrust.js";
import { writeWorkbook } from "./excelBridge.js";
import { resolveWorkbookPath } from "./workbookResolver.js";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config || "config/default.json";
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const workbookResolution = resolveWorkbookPath(config, args);
  const selected = args.log ? selectExplicitLog(path.resolve(args.log)) : latestWritableLogFile();
  const logFile = selected?.logFile || "";

  if (!logFile) {
    throw new Error("未找到包含可写回结果的 logs/*.jsonl，需先成功运行一次 preview:web。");
  }

  const entries = selected.entries;
  const writableUpdates = selected.writableUpdates;

  if (!writableUpdates.length) {
    console.log(`日志：${logFile}`);
    console.log("没有可写回的行，未生成 Excel。");
    return;
  }

  const outputPath = args.output ? path.resolve(args.output) : config.workbookPath;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const writeResult = writeWorkbook(config, outputPath, writableUpdates);

  console.log(`日志：${logFile}`);
  if (workbookResolution.changed) {
    console.log(`原 Excel 路径不存在：${workbookResolution.missingPath}`);
    console.log(`已自动改用最新匹配文件：${workbookResolution.path}`);
  }
  console.log(`已从最近一次预览写回 ${writeResult.updatedRows} 行到：${outputPath}`);
  console.log(`待复核或空分类行已跳过：${entries.length - writableUpdates.length} 行。默认直接更新读取的原 Excel。`);
}

function selectExplicitLog(logFile) {
  const entries = readLogEntries(logFile);
  return { logFile, entries, writableUpdates: writableEntries(entries) };
}

function latestWritableLogFile() {
  if (!fs.existsSync("logs")) return "";
  const files = fs.readdirSync("logs")
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => {
      const fullPath = path.resolve("logs", file);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const skipped = [];
  for (const file of files) {
    const entries = readLogEntries(file.fullPath);
    const writableUpdates = writableEntries(entries);
    if (writableUpdates.length) return { logFile: file.fullPath, entries, writableUpdates, skipped };
    skipped.push(path.basename(file.fullPath));
  }

  return "";
}

function readLogEntries(logFile) {
  return fs.readFileSync(logFile, "utf8")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writableEntries(entries) {
  return entries
    .map((entry) => {
      const summaryFallback = resolveSummaryFallbacks(entry);
      const hasDialogOutput = entry.dialogSummarySource
        || entry.overallDialogSummary
        || entry.studentDialogSummary
        || entry.teacherDialogSummary
        || entry.teacherHandlingSummary;
      return {
        rowNumber: entry.rowNumber,
        ...(!entry.needsReview && entry.firstCategory && entry.secondCategory && entry.thirdCategory
          ? { U: entry.firstCategory, V: entry.secondCategory, W: entry.thirdCategory }
          : {}),
        ...(summaryFallback.userSummary ? { Y: summaryFallback.userSummary } : {}),
        ...(summaryFallback.overallDialogSummary ? { AH: summaryFallback.overallDialogSummary } : {}),
        ...(hasDialogOutput ? {
          AI: entry.teacherHandlingSummary
            || (entry.teacherResponseStatus === "未回应" ? "未回复学员问题" : "")
        } : {}),
        ...getWritableQrsUpdates(entry)
      };
    })
    .filter((entry) => Object.keys(entry).length > 1);
}

function resolveSummaryFallbacks(entry = {}) {
  const userSummary = limitText(cleanText(entry.userSummary || ""), 15);
  const overallDialogSummary = limitText(cleanText(entry.overallDialogSummary || ""), 50);
  if (userSummary && overallDialogSummary) {
    return { userSummary, overallDialogSummary };
  }
  if (!userSummary && overallDialogSummary) {
    return {
      userSummary: limitText(overallDialogSummary, 15),
      overallDialogSummary
    };
  }
  if (userSummary && !overallDialogSummary) {
    return {
      userSummary,
      overallDialogSummary: limitText(userSummary, 50)
    };
  }
  return { userSummary: "", overallDialogSummary: "" };
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/[，,。；;]+$/, "").trim();
}

function limitText(value, maxLength) {
  const chars = [...cleanText(value)];
  if (chars.length <= maxLength) return chars.join("");
  return chars.slice(0, maxLength).join("");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

main();
