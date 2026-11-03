import fs from "node:fs";
import path from "node:path";

export function createLogger() {
  const logDir = path.resolve(process.env.FULL_PIPELINE_LOG_DIR || "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  return {
    file,
    write(entry) {
      fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }, null, 0) + "\n");
    }
  };
}
