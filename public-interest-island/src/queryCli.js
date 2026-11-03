import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { BrowserClient } from "./browserClient.js";
import { loadConfig } from "./config.js";
import { createDebugLogger } from "./logger.js";
import { UserOverviewService } from "./userOverviewService.js";

const config = loadConfig(process.env.CONFIG || "config/default.json");
const browserClient = new BrowserClient(config);
const logger = createDebugLogger(config);
const service = new UserOverviewService({ config, browserClient, logger });

async function main() {
  const userId = String(process.argv[2] || "").trim();
  if (!userId) {
    console.error("用法：npm run query -- <用户ID>");
    process.exitCode = 1;
    return;
  }

  console.log("正在打开/复用后台浏览器并检查登录态...");
  let login = await service.checkLogin();
  if (!login.ready) {
    console.log(login.message || "请在弹出的浏览器完成扫码/验证。");
    const rl = readline.createInterface({ input, output });
    await rl.question("登录完成后按回车继续查询...");
    rl.close();
    login = await service.checkLogin();
  }

  if (!login.ready) {
    console.error(login.message || "仍未检测到登录态，请重新运行命令。");
    process.exitCode = 1;
    return;
  }

  const result = await service.fetchOverview({ userId });
  const redBox = result.overview?.redBox || {};
  if (!result.found || result.error) {
    console.error(result.error || "未查询到用户记录");
    if (result.trace?.length) console.error(`执行阶段：${result.trace.join(" -> ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(redBox.text || [
    `所属品类：${redBox.category || ""}`,
    `开营时间：${redBox.startTime || ""}`,
    `训练营名称：${redBox.trainingCampName || ""}`
  ].join("\n"));
}

main()
  .catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await browserClient.close();
  });
