# 客满运营台

这是“基于敏感词延伸版本”的本地网页控制台。当前可同时使用原有的单用户信息查询，以及“拟人工识别”项目的批量工作流。

## 批量识别模式

网页中的“批量识别”页签提供三种模式：

- **一键全流程**：FineBI 下载关键词数据、Excel 合并去重、聊天与订单识别、结果写回。
- **仅下载汇总**：只完成 FineBI 下载和 Excel 汇总，不运行拟人工识别。
- **指定 Excel 识别**：选择输出目录中的 Excel，并设置起始行、结束行后运行识别。

后台不接受任意命令或任意文件路径。Excel 只能从配置的输出目录选择，工作流参数由服务端组装并通过 `spawn(..., { shell: false })` 启动。

## 本地运行

### 1. 安装依赖

```bash
cd /Users/yijunye/Documents/基于敏感词延伸版本
npm install --registry=https://registry.npmmirror.com
```

Python 依赖在“拟人工识别”项目中安装：

```bash
python3 -m pip install --user -i https://pypi.tuna.tsinghua.edu.cn/simple playwright pandas openpyxl
python3 -m playwright install chromium
```

### 2. 检查本地配置

默认配置位于 `config/default.json`，批量工作流主要字段为：

```json
{
  "pipeline": {
    "projectDir": "/Users/yijunye/Documents/拟人工识别",
    "outputDir": "~/Downloads/chat_export",
    "template": "~/敏感词跟进表【潜在风险】.classified 10.16.33.xlsx",
    "sheet": "6.1-6.30",
    "sharedBrowserProfile": "~/.qlchat_unified_profile"
  }
}
```

请确认模板文件名和目标工作表与当天实际文件一致。

### 3. 创建网站账号

```bash
cd /Users/yijunye/Documents/基于敏感词延伸版本
npm run add-user -- admin '<初始密码>' admin
```

首次登录会要求修改密码。

### 4. 启动本地网站

```bash
cd /Users/yijunye/Documents/基于敏感词延伸版本
npm start
```

浏览器访问：`http://127.0.0.1:3128`

批量任务遇到 FineBI、企聊宝或 chanceAss 登录失效时，页面会显示“等待人工登录”。在自动打开的浏览器完成扫码验证并确认后台页面可用后，必须回到网页手动点击“我已扫码登录，确认继续”。网页不会自动确认或跳过扫码步骤。

## 结果文件

默认输出目录：

```text
~/Downloads/chat_export
```

任务完成后可在网页直接下载结果。默认生成版本化文件；只有勾选“原文件写回”时才覆盖所选 Excel。

## 本地验收

```bash
cd /Users/yijunye/Documents/基于敏感词延伸版本
npm run check
npm test
```

流水线入口检查：

```bash
cd /Users/yijunye/Documents/拟人工识别
PYTHONPYCACHEPREFIX=/private/tmp python3 -m py_compile scripts/run_full_pipeline.py
python3 scripts/run_full_pipeline.py --help
```

## 备案完成后迁移云端

云端仍使用同一套网页和 API，通过环境变量替换本机路径。示例见 `deploy/interest-island.env.example`，重点配置：

- `PIPELINE_PROJECT_DIR`：云端“拟人工识别”项目目录
- `PIPELINE_OUTPUT_DIR`：可持久化的结果目录
- `PIPELINE_INPUT_DIRS`：手动输入 Excel 路径的允许目录，多个目录用英文逗号分隔
- `PIPELINE_TEMPLATE`：模板绝对路径
- `PIPELINE_SHARED_PROFILE`：可持久化的浏览器登录目录
- `SESSION_SECRET`：独立随机密钥
- `ALLOWED_ORIGINS`：备案后的 HTTPS 域名
- `BACKEND_ALLOWED_HOSTS`：后台主机白名单，只填写主机名，不含协议和路径
- `BACKEND_DASHBOARD_URL`：后台工作台 HTTPS 地址
- `BACKEND_CHANCE_ASS_URL`：机会管理 HTTPS 地址
- `BACKEND_CONTENT_CAMP_URL`：训练营管理 HTTPS 地址
- `BACKEND_COMPLAINT_WORK_URL`：投诉工单 HTTPS 地址
- `BACKEND_INTENTION_ORDER_URL`：意向订单 HTTPS 地址
- `REQUIRE_PROXY_IDENTITY`：接入可信反向代理身份后再启用

迁云前应确保：

1. 服务端具备有头浏览器或远程人工验证能力；仅提供纯无头容器时，登录失效后无法扫码。
2. 浏览器 profile、SQLite 数据、输出 Excel 和日志目录都使用持久化磁盘。
3. 同一浏览器 profile 只允许一个批量任务占用；当前服务已限制全局单任务。
4. 网站必须通过 HTTPS，设置强随机 `SESSION_SECRET`，并由反向代理限制访问人员。
5. 不把管理后台 Cookie、浏览器 profile、结果 Excel 放进 Git 仓库或公开对象存储。
6. 后台 URL 只写入服务器的 `/etc/interest-island/interest-island.env`；缺失、使用 HTTP、主机不在白名单或仍为 `.invalid` 占位值时，生产服务会拒绝启动。

## 常见问题

- **网页显示工作流不可用**：检查 `pipeline.enabled`、`projectDir` 和 `scripts/run_full_pipeline.py` 是否存在。
- **指定 Excel 下拉为空**：列表只读取 `PIPELINE_OUTPUT_DIR` 中符合命名规则的文件；也可在“或输入文件路径”中填写 `PIPELINE_INPUT_DIRS` 白名单目录内的 `.xlsx` 绝对路径。
- **默认识别文件**：进入“指定 Excel 识别”后会自动选择 `PIPELINE_OUTPUT_DIR` 中最新的下载汇总文件；手动路径有值时优先使用手动路径。
- **任务一直等待登录**：完成弹出浏览器中的扫码登录并确认后台页面可用后，在网页点击“我已扫码登录，确认继续”；未点击前任务会一直保持暂停。
- **已有任务正在运行**：当前为稳定性考虑只允许一个批量任务；等待完成或取消后再启动。
- **结果无法下载**：只有任务状态为“完成/部分完成”，且结果仍位于输出目录时才允许下载。
