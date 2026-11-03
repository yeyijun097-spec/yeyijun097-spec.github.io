# FineBI 聊天记录关键词导出脚本使用说明

脚本路径：

```bash
/Users/yijunye/Documents/拟人工识别/scripts/finebi_chat_export.py
```

## 1. 安装依赖

建议使用国内镜像安装 Python 依赖：

```bash
python3 -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple playwright pandas openpyxl
python3 -m playwright install chromium
```

脚本默认使用 Playwright 自带 Chromium，不依赖系统是否安装 Google Chrome。

如果你把脚本里的配置改成：

```python
BROWSER_CHANNEL = "chrome"
```

请确保本机已安装 Google Chrome，或执行：

```bash
python3 -m playwright install chrome
```

## 2. 登录态复用

脚本默认使用独立浏览器用户数据目录：

```python
BROWSER_USER_DATA_DIR = "~/.finebi_playwright_chrome_profile"
```

注意：这是浏览器登录态目录，不是终端命令，不能直接运行：

```bash
~/.finebi_playwright_chrome_profile
```

当前脚本默认是有头模式：

```python
HEADLESS = False
```

方便观察页面加载、登录态和导出弹窗。确认流程稳定后，可改回：

```python
HEADLESS = True
```

首次使用建议这样做：

1. 运行脚本，让浏览器弹出后手动登录 FineBI。
2. 登录成功后重新运行脚本。
3. 若后续需要后台运行，再把 `HEADLESS` 改回 `True`。

之后脚本会复用该目录里的登录态。若页面出现“获取验证码 / 登录”或未检测到报表筛选栏，脚本会暂停并提示你在浏览器里完成登录/验证；完成后回到终端按回车继续。脚本不会尝试自动登录或处理验证码。

## 3. 运行命令

```bash
cd /Users/yijunye/Documents/拟人工识别
python3 scripts/finebi_chat_export.py
```

脚本进入 FineBI 后会自动尝试点击左侧菜单：

```text
兴趣岛 -> 服务复购 -> 用户满意度 -> 用户聊天记录明细
```

进入明细页面后再设置日期、发送人和关键词，并执行查询导出。

默认导出到：

```bash
~/Downloads/chat_export
```

日志和失败截图默认保存到：

```bash
/Users/yijunye/Documents/拟人工识别/logs
```

## 4. 输出文件

每个关键词会生成一个单独 Excel：

```text
投诉_20260708.xlsx
举报_20260708.xlsx
...
```

全部关键词完成后，会自动合并去重并生成：

```text
聊天记录汇总_20260708.xlsx
```

这里的日期会按实际数据日期生成，不是字面量 `YYYYMMDD`。例如 2026-07-09 执行、偏移量为 -1 时，文件名是：

```text
聊天记录汇总_20260708.xlsx
```

去重规则：

```text
用户ID
```

同一用户命中多个关键词时只保留首次出现的记录，模板格式合并文件不会额外增加“搜索关键词”列。

## 5. 可修改配置

脚本顶部集中配置：

```python
HEADLESS = True
OUTPUT_DIR = "~/Downloads/chat_export"
LOG_DIR = "./logs"
DATA_DATE_OFFSET = -1
MAX_RETRIES = 2
KEEP_RAW_FILES = True
BROWSER_USER_DATA_DIR = "~/.finebi_playwright_chrome_profile"
```

关键词顺序固定在：

```python
KEYWORDS = ["投诉", "举报", "伪直播", "报警", "虚假宣传", "诱导", "12315", "黑猫", "维权", "市长热线", "曝光你", "消协"]
```

## 6. macOS 权限

如果浏览器无法启动、下载失败或无法写入文件，请检查：

- 终端 App 是否有“完全磁盘访问权限”
- 终端 App 是否允许“自动化”
- 下载目录 `~/Downloads/chat_export` 是否可写
- Chrome 是否被其他进程锁住同一个用户数据目录

系统设置路径通常为：

```text
系统设置 -> 隐私与安全性 -> 完全磁盘访问权限
系统设置 -> 隐私与安全性 -> 自动化
```

## 7. 常见问题

### 检测到登录页

说明当前 `BROWSER_USER_DATA_DIR` 没有有效登录态。当前脚本默认 `HEADLESS=False`，在弹出的浏览器手动登录后，回到终端按回车继续。

### 找不到日期或关键词输入框

说明 FineBI 页面结构变化，查看 `logs` 中失败截图。脚本只使用 DOM 文本、label、id/name 等定位，不使用坐标点击。

### 导出按钮找不到

确认查询后表格区域已加载，并且页面底部分页栏存在“数据导出”。若页面权限没有导出按钮，脚本会截图并跳过该关键词。

### 单个关键词失败

脚本会自动重试 `MAX_RETRIES` 次，仍失败则记录日志并继续下一个关键词。

### 汇总失败提示没有“用户ID”列

说明导出的 Excel 表头和预期不一致。脚本会自动去除列名首尾空格，但仍要求存在 `用户ID` 字段。

## 8. 重要边界

- 所有页面操作只使用 DOM 选择器、文本定位和 JS DOM 赋值/点击。
- 不使用坐标点击。
- 不使用图像识别。
- 不读取屏幕像素。
- 不自动登录，不破解验证码。
- 不添加定时任务，只有手动运行入口。

## 9. 一键完成下载、整理和拟人工识别

如果需要把 FineBI 下载、Excel 模板合并去重和最后的 DOM 拟人工识别串成一次运行，使用统一编排入口：

```bash
cd /Users/yijunye/Documents/拟人工识别
python3 scripts/run_full_pipeline.py
```

统一入口会按以下顺序执行：

```text
FineBI 登录/验证 -> 12 个关键词下载 -> 模板合并并按用户ID去重 -> DOM拟人工识别并写回合并文件
```

默认无头运行。FineBI、企聊宝或 chanceAss 登录态失效时，才临时打开有头浏览器暂停等待人工完成登录/验证；回到终端按回车后重新回到无头流程。脚本不会自动处理验证码。

常用参数：

```bash
# 指定处理行范围
python3 scripts/run_full_pipeline.py --from-row 3 --to-row 76

# 指定数据日期（避免跨日运行时日期不一致）
python3 scripts/run_full_pipeline.py --date 20260710

# 仅在明确接受文件缺失/损坏时使用；查询结果为 0 行无需此参数
python3 scripts/run_full_pipeline.py --allow-partial

# 继续中断的一轮流程
python3 scripts/run_full_pipeline.py --resume logs/full_pipeline_YYYYMMDD_HHMMSS.json

# 只重试最近一轮识别失败的行
python3 scripts/run_full_pipeline.py --retry-failed

# 显式覆盖合并文件；默认会生成带运行号的新文件
python3 scripts/run_full_pipeline.py --in-place
```

一键入口默认使用共享登录目录：

```text
~/.qlchat_unified_profile
```

FineBI 下载阶段和后续企聊宝/机会管理 DOM 阶段是串行运行的，因此两阶段可以复用同一登录态，通常只需扫码一次。原来的 FineBI 独立命令仍使用 `~/.finebi_playwright_chrome_profile`，不会被改变。

如需指定共享目录：

```bash
python3 scripts/run_full_pipeline.py --shared-browser-profile "$HOME/.qlchat_unified_profile"
```

默认最终文件位于：

```text
~/Downloads/chat_export/敏感词跟进表_聊天合并_YYYYMMDD_runHHMMSS.xlsx
```

拟人工识别结果会直接写回该版本文件；原始关键词文件和基础合并文件保留。统一流程状态和日志保存到 `logs/full_pipeline_*.json` 与 `logs/full_pipeline_*.log`。
