# 企聊宝上下文分类填报工具

## 发布版一键 Agent 工作流

推荐使用统一入口完成 FineBI 下载、敏感词模板合并、DOM 识别和 Excel 写回：

```bash
cd /Users/yijunye/Documents/拟人工识别
python3 scripts/run_full_pipeline.py
```

默认无头运行；登录态失效时才临时打开有头浏览器人工验证。结果默认生成带运行号的版本文件，空数据关键词不会阻断流程，单行识别失败会记录并继续。

```bash
python3 scripts/run_full_pipeline.py --date 20260710 --from-row 3 --to-row 76
python3 scripts/run_full_pipeline.py --resume logs/full_pipeline_YYYYMMDD_HHMMSS.json
python3 scripts/run_full_pipeline.py --retry-failed
python3 scripts/run_full_pipeline.py --debug --from-row 3 --to-row 10
```

完整发布说明见 [docs/发布使用说明.md](docs/发布使用说明.md)，Agent 描述见 [workflow/qlchat-risk-pipeline.agent.json](workflow/qlchat-risk-pipeline.agent.json)。

## FineBI 下载文件合并

### 单独运行 FineBI 下载和合并

完整流程使用下面一条命令即可：

```bash
cd /Users/yijunye/Documents/拟人工识别
python3 -m pip install --user pandas openpyxl playwright
python3 -m playwright install chromium
python3 scripts/finebi_chat_export.py --download-and-merge
```

这是 FineBI 的单独阶段命令，只负责人工登录确认、关键词下载和模板合并。发布版完整流程（下载 -> 合并 -> DOM 识别 -> 写回）请统一使用：

```bash
python3 scripts/run_full_pipeline.py
```

发布版默认无头运行，只有登录态失效时临时打开有头浏览器；默认生成带运行号的结果文件，不覆盖历史结果。

`--download-and-merge` 是明确的完整流程标记；不带参数运行也会执行同样的下载后自动合并流程。

FineBI 聊天明细导出完成后，可只执行合并，不重新打开浏览器：

```bash
cd /Users/yijunye/Documents/拟人工识别
python3 -m pip install --user openpyxl
python3 scripts/finebi_chat_export.py --merge-only --date 20260709
```

合并模式默认读取 `~/Downloads/chat_export` 中的：

```text
投诉_20260709.xlsx
举报_20260709.xlsx
伪直播_20260709.xlsx
...
```

输出文件为：

```text
~/Downloads/chat_export/敏感词跟进表_聊天合并_20260709.xlsx
```

该文件使用 `~/敏感词跟进表【潜在风险】.classified 10.16.33.xlsx` 的 `6.1-6.30` 工作表作为模板，保留模板样式和列顺序，只写入 FineBI 原始聊天字段；按 `用户ID` 保留首条重复记录，同一用户命中多个关键词时只保留第一条，`AJ` 以后多余列会删除。模板路径或工作表可以临时覆盖：

```bash
python3 scripts/finebi_chat_export.py --merge-only \
  --date 20260709 \
  --output-dir ~/Downloads/chat_export \
  --template "/Users/yijunye/敏感词跟进表【潜在风险】.classified 10.16.33.xlsx" \
  --sheet "6.1-6.30"
```

合并后的模板文件可以继续交给发布版 DOM 阶段识别/写回：

- `U` 一级分类
- `V` 二级分类
- `W` 三级分类
- `Y` 用户聊天记录简要说明
- `T` 风险等级
- `Q/R/S` 订单档案字段
- `AH` 问题总结
- `AI` 老师处理进展

合法分类组合来自 `新版场景分类`；发布版由 DeepSeek 结合右侧聊天上下文判断三级分类，并按当前 DOM 规则写回总结和风险字段。

## 安装

```bash
npm install
```

如果在国内网络环境安装较慢，可使用：

```bash
npm config set registry https://registry.npmmirror.com
npm install
```

## 配置 DeepSeek Key

默认每次网页识别都会调用 DeepSeek。Key 不写入代码，请在终端设置环境变量：

```bash
export DEEPSEEK_API_KEY="你的DeepSeekKey"
```

默认模型是 `deepseek-v4-flash`。如需临时切换：

```bash
export DEEPSEEK_MODEL="deepseek-v4-pro"
```

默认会在不改变网页查询和分类阈值的前提下，让 DeepSeek 后台并发处理，配置项为 `config/default.json` 的 `llm.concurrency`，默认 `3`。如遇到接口限流，可调低到 `2`。

接口模式下，如果程序无法从企聊宝接口响应中直接提取真实聊天消息，会调用 DeepSeek 做上下文解析。配置项为 `contextExtractor`，默认启用，提取置信度低于 `0.85` 时仍会待复核，不进入自动写回。

批量写回时默认每 20 行阶段性落盘一次，配置项为 `batch.autoWriteEvery`。这只在带 `--write` 时生效。

网页 UI 等待参数在 `config/default.json` 的 `ui` 中维护：

- `queryWaitMs`：点击查询后等待相关记录出现的最长时间。
- `middleWaitMs`：点击会话卡片后等待中间相关记录出现的最长时间。
- `rightWaitMs`：点击相关记录后等待右侧聊天气泡出现的最长时间。
- `rightStableMs`：右侧聊天气泡出现后，等待文本稳定的时间。

如果日志里 `网页平均` 仍明显偏高，优先看是否有“右侧上下文未打开”的行；如果打开率稳定，可以小幅降低 `rightWaitMs`，但不建议降低分类置信度阈值。

## 离线规则预览

不打开企聊宝，只用表格里的 `K列 消息内容` 做旧规则匹配预览：

```bash
npm run preview:rules
```

## 接口模式 + 大模型预览

默认使用接口模式：浏览器只用于确认登录态和首次发现接口，批量行处理不再逐行操作网页 UI。

首次使用或企聊宝接口变化后，先运行接口发现：

```bash
npm run api:discover -- --debug-row 3
```

运行后如果弹出扫码页，先扫码登录，再回到终端按回车继续。发现成功后会生成本地映射：

```bash
config/qlchat-api-map.local.json
```

这个文件已加入 `.gitignore`，不会保存 Cookie、Token 或 DeepSeek Key。

接口发现完成后，运行预览：

```bash
npm run preview:api
```

## 写回结果

默认直接写回读取的原 Excel：`/Users/yijunye/敏感词跟进表【潜在风险】.xlsx`。运行前建议关闭 Excel/WPS 中打开的原文件：

```bash
npm run write:api
```

## 常用参数

```bash
node src/index.js --from-row 3 --to-row 24
node src/index.js --from-row 3 --to-row 24 --write
node src/index.js --debug-row 3 --keep-open
node src/index.js --from-row 3 --to-row 24 --no-llm
node src/index.js --from-row 3 --to-row 24 --ui
node src/index.js --from-row 3 --to-row 200 --write --resume
node src/index.js --retry-failed --write
node src/index.js --debug-row 3 --keep-open --capture-api
node src/index.js --config config/default.json --output output/result.xlsx --write
```

## 注意

- 页面选择器在 `config/default.json` 的 `selectors` 中维护，企聊宝页面结构变化时优先改这里。
- 默认 `context.mode=api`，接口模式只复用浏览器登录态，不逐行点击网页；旧 UI 模式需显式加 `--ui`。
- 接口模式首次缺少 `config/qlchat-api-map.local.json` 时，会自动用首行样本做一次接口发现；也可以手动运行 `npm run api:discover -- --debug-row 3`。
- 只有右侧上下文真实打开后才会调用 DeepSeek；上下文未打开会标记 `needsReview=true`。
- 大模型返回的 U/V/W 必须完全匹配 `新版场景分类` 中的合法组合，否则不会写回。
- Y列摘要可独立写回：即使 U-W 待复核，只要成功提取白色气泡并生成摘要，也会写入 Y。
- 如果 U-W 主判断不可靠，但 Y摘要可以 95% 以上可靠判断三级分类，会基于 Y摘要反推 U-W；否则仍待复核。
- 无法明确判断、置信度低于阈值、模型接口异常时会标记 `needsReview=true`，写回模式默认不覆盖该行 U-W。
- 每次运行都会生成 `logs/run-*.jsonl` 日志。
- 日志会记录 `contextSource`、`contextExtractor`、`llmContextUsed`、`contextExtractConfidence`、`contextMs`、`llmMs`、`totalMs`、`apiSearchMs`、`apiDetailMs` 和 `webTimings`，用于判断慢在接口搜索、接口详情、上下文解析、旧 UI 点击，还是分类模型返回。
- `--resume` 会跳过最近日志中已经处理过的行，用于断点续跑。
- `--retry-failed` 会读取最近日志，只重跑待复核、上下文未打开、模型异常等失败行。
- `--capture-api` 会记录企聊宝搜索/聊天相关 XHR 到 `logs/api-capture-*.jsonl`，用于后续切换后台接口模式。
