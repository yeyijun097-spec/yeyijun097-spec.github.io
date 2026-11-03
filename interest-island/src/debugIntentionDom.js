import { BrowserClient } from "./browserClient.js";
import { loadConfig } from "./config.js";
import { createDebugLogger } from "./logger.js";
import { IntentionOrderService } from "./intentionOrderService.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const config = loadConfig(process.env.CONFIG || "config/default.json");
const browserClient = new BrowserClient(config);
const logger = createDebugLogger(config);
const service = new IntentionOrderService({ config, browserClient, logger });

async function main() {
  const complaintOrderId = String(process.argv[2] || "").trim();
  let result = await service.debugDateDom(complaintOrderId);
  if (!result.ready) {
    console.log(result.message || "未检测到登录态。请在弹出的浏览器完成登录。");
    const rl = readline.createInterface({ input, output });
    await rl.question("登录完成后按回车继续 DOM 诊断...");
    rl.close();
    result = await service.debugDateDom(complaintOrderId);
  }
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await browserClient.close();
  });
