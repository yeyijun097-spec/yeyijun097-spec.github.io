import { spawnSync } from "node:child_process";
import path from "node:path";

const bridgePath = path.resolve("scripts", "excel_bridge.py");

export function readWorkbook(config) {
  return runBridge(["read", "--workbook", config.workbookPath, "--target-sheet", config.targetSheet, "--rules-sheet", config.rulesSheet]);
}

export function writeWorkbook(config, outputPath, updates) {
  return runBridge([
    "write",
    "--workbook",
    config.workbookPath,
    "--target-sheet",
    config.targetSheet,
    "--output",
    outputPath,
    "--updates-json",
    JSON.stringify(updates)
  ]);
}

function runBridge(args) {
  const result = spawnSync("python3", [bridgePath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 50
  });

  if (result.status !== 0) {
    throw new Error(`Excel bridge failed:\n${result.stderr || result.stdout}`);
  }

  return JSON.parse(result.stdout);
}
