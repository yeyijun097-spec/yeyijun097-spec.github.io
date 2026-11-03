import path from "node:path";
import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import ExcelJS from "exceljs";
import { BrowserClient } from "./browserClient.js";
import { loadConfig } from "./config.js";
import { createDebugLogger } from "./logger.js";
import { IntentionOrderService, OUTPUT_FIELDS } from "./intentionOrderService.js";

const config = loadConfig(process.env.CONFIG || "config/default.json");
const browserClient = new BrowserClient(config);
const logger = createDebugLogger(config);
const service = new IntentionOrderService({ config, browserClient, logger });

async function main() {
  const inputFile = String(process.argv[2] || "").trim();
  const outputFile = String(process.argv[3] || "").trim() || inputFile;
  if (!inputFile) {
    console.error("用法：npm run batch:intention -- <Excel路径> [输出Excel路径]");
    process.exitCode = 1;
    return;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputFile);
  if (path.resolve(outputFile) === path.resolve(inputFile)) {
    const backupFile = defaultBackupPath(inputFile);
    if (!fs.existsSync(backupFile)) {
      fs.copyFileSync(inputFile, backupFile);
      console.log(`已备份原表：${backupFile}`);
    }
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Excel 中没有可读取的工作表");

  const header = readHeader(sheet);
  const inputCol = 1;

  ensureHeaders(sheet, header);
  const entries = readInputEntries(sheet, inputCol);
  if (!entries.length) {
    console.error("未在第一个工作表 A 列找到待查询主订单ID。请从第 2 行开始填入订单ID。");
    process.exitCode = 1;
    return;
  }

  const outputHeader = readHeader(sheet);
  const outputCols = ensureHeaders(sheet, outputHeader);
  await workbook.xlsx.writeFile(outputFile);

  console.log(`读取到 ${entries.length} 个投诉订单ID，结果将写入：${outputFile}`);
  console.log("正在检查后台登录态...");
  let login = await service.checkLogin();
  if (!login.ready) {
    console.log(login.message || "请在弹出的浏览器完成扫码/验证。");
    const rl = readline.createInterface({ input, output });
    await rl.question("登录完成后按回车继续批量查询...");
    rl.close();
    login = await service.checkLogin();
  }
  if (!login.ready) {
    console.error(login.message || "仍未检测到登录态，请重新运行命令。");
    process.exitCode = 1;
    return;
  }
  await browserClient.closeForeignPages(config.browser.intentionOrderUrl);

  let rowOffset = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const complaintOrderId = entry.id;
    const targetRowNumber = entry.rowNumber + rowOffset;
    console.log(`[${index + 1}/${entries.length}] 查询投诉订单ID：${complaintOrderId}`);
    const result = await service.fetchByComplaintOrderId(complaintOrderId);
    if (result.loginRequired) throw new Error(result.error || "登录态失效，请重新运行并登录");
    if (!result.rows?.length) {
      console.log(`  未找到：${result.error || "无记录"}`);
      continue;
    } else {
      console.log(`  提取 ${result.rows.length} 条记录`);
    }
    const inserted = writeResultRowsAt(sheet, targetRowNumber, result.rows, outputCols);
    rowOffset += inserted;
    await workbook.xlsx.writeFile(outputFile);
    console.log(`  已写入：${outputFile}`);
  }

  console.log(`已生成：${outputFile}`);
}

function readHeader(sheet) {
  const map = new Map();
  const row = sheet.getRow(1);
  row.eachCell((cell, colNumber) => {
    const value = String(cell.value || "").trim();
    if (value) map.set(value, colNumber);
  });
  return map;
}

function ensureHeaders(sheet, header) {
  const row = sheet.getRow(1);
  const cols = new Map();
  for (let index = 0; index < OUTPUT_FIELDS.length; index += 1) {
    const field = OUTPUT_FIELDS[index];
    const col = index + 1;
    if (!header.has(field)) {
      row.getCell(col).value = field;
      header.set(field, col);
    }
    cols.set(field, header.get(field) || col);
  }
  row.commit();
  return cols;
}

function readInputEntries(sheet, inputCol) {
  const entries = [];
  const seen = new Set();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 2) return;
    const value = normalizeCell(row.getCell(inputCol).value);
    if (!value || seen.has(value)) return;
    seen.add(value);
    entries.push({ rowNumber, id: value });
  });
  return entries;
}

function writeResultRowsAt(sheet, targetRowNumber, rows, outputCols) {
  const extraRows = Math.max(0, rows.length - 1);
  if (extraRows) {
    sheet.spliceRows(targetRowNumber + 1, 0, ...Array.from({ length: extraRows }, () => []));
    copyRowStyle(sheet.getRow(targetRowNumber), targetRowNumber + 1, targetRowNumber + extraRows);
  }
  for (let index = 0; index < rows.length; index += 1) {
    const item = rows[index];
    const row = sheet.getRow(targetRowNumber + index);
    for (const field of OUTPUT_FIELDS) {
      const col = outputCols.get(field);
      const nextValue = item[field] || "";
      if (nextValue || !row.getCell(col).value) row.getCell(col).value = nextValue;
    }
    row.commit();
  }
  for (let col = 1; col <= OUTPUT_FIELDS.length; col += 1) {
    const current = sheet.getColumn(col);
    current.width = Math.max(current.width || 12, OUTPUT_FIELDS[col - 1].length + 4, 16);
  }
  return extraRows;
}

function cloneRowStyle(row) {
  const styles = [];
  for (let index = 1; index <= Math.max(row.cellCount, OUTPUT_FIELDS.length); index += 1) {
    const cell = row.getCell(index);
    styles[index] = {
      style: cell.style ? JSON.parse(JSON.stringify(cell.style)) : {},
      numFmt: cell.numFmt
    };
  }
  return styles;
}

function applyRowStyle(row, styles) {
  for (let index = 1; index < styles.length; index += 1) {
    const cell = row.getCell(index);
    if (styles[index]?.style) cell.style = styles[index].style;
    if (styles[index]?.numFmt) cell.numFmt = styles[index].numFmt;
  }
  row.commit();
}

function copyRowStyle(sourceRow, startRowNumber, endRowNumber) {
  const styles = cloneRowStyle(sourceRow);
  for (let rowNumber = startRowNumber; rowNumber <= endRowNumber; rowNumber += 1) {
    applyRowStyle(sourceRow.worksheet.getRow(rowNumber), styles);
  }
}

function normalizeCell(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.text) return String(value.text).trim();
    if (value.result != null) return String(value.result).trim();
    if (value.richText) return value.richText.map((item) => item.text || "").join("").trim();
  }
  return String(value).trim();
}

function defaultOutputPath(inputFile) {
  if (!inputFile) return "";
  const parsed = path.parse(inputFile);
  return path.join(parsed.dir, `${parsed.name}-已回填${parsed.ext || ".xlsx"}`);
}

function defaultBackupPath(inputFile) {
  const parsed = path.parse(inputFile);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(parsed.dir, `${parsed.name}-备份-${stamp}${parsed.ext || ".xlsx"}`);
}

main()
  .catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await browserClient.close();
  });
