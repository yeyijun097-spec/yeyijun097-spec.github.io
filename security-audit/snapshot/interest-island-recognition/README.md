# 兴趣岛敏感词识别与风险分类工作流

本项目用于将 FineBI 敏感词聊天明细、企聊宝右侧聊天上下文和 chanceAss 学员档案整合到同一份 Excel，完成三级分类、风险等级、摘要与课程档案写回。

生产入口：[https://personalsearch.top/pipeline](https://personalsearch.top/pipeline)

## 工作流

1. 按数据日期从 FineBI 查询学员发送的敏感词记录。
2. 下载投诉、举报、伪直播、报警、虚假宣传、诱导、12315、黑猫、维权、市长热线、曝光你、消协等关键词文件。
3. 按用户 ID 合并去重，并复用标准模板的样式与列结构。
4. 在企聊宝中按老师、Excel D 列用户 ID 和 K 列关键词查询聊天记录。
5. 打开中间记录与右侧聊天上下文，验证当前用户后进行分类与摘要。
6. 在 chanceAss 中核验学员订单，填充 Q/R/S 档案字段。
7. 阶段性写回 Excel；即使任务异常结束，已完成的行仍可下载。
8. 首轮结束后只重跑聊天技术失败行，保留已成功的档案字段。

## 企聊宝查询规则

- 候选人员必须与 Excel 中的老师姓名匹配。
- 同名人员从页面列表最后一个开始倒序查询。例如 3 个同名候选按 `3 → 2 → 1` 执行。
- 所有同名候选都必须纳入查询，不按固定数量截断。
- 查到当前用户且通过结果卡片、会话用户 ID 和右侧学员气泡核验后立即停止遍历。
- 首轮所有候选均未命中时，刷新当前企聊宝页面，清理旧状态并完整重放当前行一次。
- 每行最多刷新重放一次，单行聊天查询默认最长 3 分钟。
- 超时或重放失败必须记录为技术失败，不得伪装成“无记录”。

## 身份与写回安全边界

自动写回前必须同时验证：

- Excel D 列用户 ID。
- 人员候选与查询表单中的老师。
- 查询表单中的用户 ID。
- 查询结果卡片中的当前用户。
- 会话用户 ID 与右侧学员气泡。

任何一项不一致都不允许分类或风险写回，也不允许把上一个用户的残留结果当作当前结果。

## Excel 输出字段

| 列 | 用途 |
| --- | --- |
| Q | 营类型/订单类型 |
| R | 训练营或订单商品名称 |
| S | 课程品类 |
| T | 风险等级 |
| U | 一级分类 |
| V | 二级分类 |
| W | 三级分类 |
| Y | 企聊宝记录简要说明 |
| AH | 问题总结 |
| AI | 老师处理进展 |

U/V/W 只能写入工作簿 `新版场景分类` 中存在的合法组合。低置信度、模型标记待复核或 DOM 身份验证失败时，不覆盖原有分类。

## 风险与分类口径

- 学员明确表达“不要再发消息，否则投诉/举报”时，纠偏为 `服务争议 / 售后服务问题 / 过度骚扰`，T 为低风险。
- 学员明确投诉平台并要求调整课程安排时，不允许归入 `无风险 / 话题分享`。
- 投诉对象明确为 WiFi、宽带、邻居或其他非兴趣岛主体时，保持无风险。
- 设备/系统“报警”、家庭生活分享、否定表达“不存在虚假宣传”不作为平台风险证据。
- 风险证据只采信 K 列原文、右侧学员气泡和学员侧对话文本，不让老师广告或模型摘要单独制造风险。

## 常用执行方式

优先使用生产页面启动任务。本地命令行用于调试和回放：

```bash
python3 scripts/run_full_pipeline.py --date 20260910
python3 scripts/run_full_pipeline.py --date 20260910 --from-row 3 --to-row 20
python3 scripts/run_full_pipeline.py --resume /path/to/full_pipeline_YYYYMMDD_HHMMSS.json
python3 scripts/run_full_pipeline.py --retry-failed
```

只执行识别器：

```bash
node src/index.js --config config/default.json --workbook /path/to/input.xlsx --write
node src/index.js --config config/default.json --workbook /path/to/input.xlsx --from-row 30 --to-row 40 --write
node src/index.js --retry-failed /path/to/run.jsonl --chat-only --write
```

运行测试：

```bash
npm test
```

## 登录、日志与失败处理

- 默认使用已保存的浏览器登录态后台运行。
- 企聊宝或 chanceAss 登录失效时，任务页会要求人工登录并确认继续。
- 单行日志会记录人员搜索、候选序号、查询提交、结果等待、右侧打开、页面刷新和重放结果。
- 进度分开统计已处理、聊天成功、聊天技术失败、档案成功与档案失败。
- 技术失败行保留完整失败阶段，可使用失败重跑功能单独处理。
- 任务中止或异常时，优先下载已阶段写回的 Excel，不要丢弃已识别行。

生产端常用路径：

```text
识别代码：/opt/interest-island-recognition
网站代码：/opt/interest-island
流水线日志：/var/log/interest-island/pipeline
输出目录：/var/lib/interest-island/pipeline-output
浏览器会话：/var/lib/interest-island/qlchat-profile
部署备份：/var/backups/interest-island
```

## 部署与回退

1. 本地先运行完整测试和 JavaScript/Python 语法检查。
2. 部署前将生产对应文件备份到 `/var/backups/interest-island/<release-name>`。
3. 只同步本次修改的工作流文件，不覆盖浏览器会话、日志、输出文件或密钥。
4. 部署后比较本地/云端 SHA-256，检查服务状态及 `/pipeline` HTTP 响应。
5. 生产异常时从最近一个备份目录恢复对应文件，再执行语法检查。

最近可用回退点：

```text
/var/backups/interest-island/20260911-reverse-same-name-candidates
/var/backups/interest-island/20260911-all-same-name-candidates
/var/backups/interest-island/20260911-performance-risk-fix
```

## 安全注意事项

- 不要将 API Key、Cookie、会话文件、用户隐私数据和生产环境变量提交到 Git。
- 不要通过降低身份校验、强行接受空结果或复用上一行结果来提速。
- 生产工作簿可能包含敏感用户信息，排查时应优先使用行号和脱敏诊断字段。

## 当前验证基线

2026-09-11 当前仓库本地自动测试为 `89/89` 通过，并完成云端文件校验和页面存活检查。自动测试不代替真实页面验收；每次企聊宝或 FineBI DOM 变更后，仍需使用小批量复制工作簿验证。
