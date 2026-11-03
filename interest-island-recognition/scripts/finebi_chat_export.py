#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FineBI 聊天记录关键词批量导出脚本

规则边界：
- 仅使用 DOM 选择器、文本定位、label 关联、JS DOM 赋值/点击。
- 禁止坐标点击、图像识别、屏幕像素定位。
- 不自动登录，不处理验证码；需要人工登录/验证时暂停等待回车继续。
"""

import glob
import logging
import os
import re
import select
import shutil
import sys
import tempfile
import time
import zipfile
from decimal import Decimal, InvalidOperation
from copy import copy
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Tuple
from uuid import uuid4
from xml.etree import ElementTree as ET

import pandas as pd
try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    from playwright.sync_api import sync_playwright
except ImportError:  # 合并模式不需要浏览器依赖
    PlaywrightTimeoutError = TimeoutError
    sync_playwright = None


# =========================
# 全局配置区
# =========================

HEADLESS = True
KEEP_BROWSER_OPEN_ON_ERROR = True
# 历史稳定入口：目录页菜单点击不一定会切换至报表 iframe，先直达实际
# report entry，再把目录菜单保留为后备路径。
REPORT_ENTRY_URL = "https://finebi.qlchat.com/webroot/decision/v10/entry/access/d710bdca-fc75-4627-a15b-5d1bcda4cdb9"
TARGET_URL = REPORT_ENTRY_URL

OUTPUT_DIR = os.path.expanduser("~/Downloads/chat_export")
LOG_DIR = os.path.expanduser(os.environ.get("FINEBI_LOG_DIR", "./logs"))
DATA_DATE_OFFSET = -1

# 汇总后的最终文件按用户ID去重；同一用户命中多个关键词时只保留首次出现记录。
DEDUP_KEYS = ["用户ID"]
KEYWORDS = ["投诉", "举报", "伪直播", "报警", "虚假宣传", "诱导", "12315", "黑猫", "维权", "市长热线", "曝光你", "消协"]
MAX_RETRIES = 2
KEEP_RAW_FILES = True
WARN_ROW_LIMIT = 100000

# 说明：
# 1. 推荐使用独立 Playwright Chrome 用户数据目录，先把 HEADLESS 改 False 跑一次并手动登录。
# 2. 如果一定要复用本机 Chrome 登录态，可改为：
#    ~/Library/Application Support/Google/Chrome
#    但 Chrome 正在运行时可能被系统锁定。
BROWSER_USER_DATA_DIR = os.path.expanduser("~/.finebi_playwright_chrome_profile")
# 默认使用 Playwright 自带 Chromium，避免依赖系统是否安装 Google Chrome。
# 如需强制使用本机 Chrome，可改为 "chrome"，并先执行：python3 -m playwright install chrome
BROWSER_CHANNEL = None

# 合并模式使用的历史敏感词表模板。可通过 --template 临时覆盖。
TEMPLATE_WORKBOOK = os.path.expanduser(
    "~/敏感词跟进表【潜在风险】.classified 10.16.33.xlsx"
)
TEMPLATE_SHEET = "6.1-6.30"
MERGE_OUTPUT_PREFIX = "敏感词跟进表_聊天合并"

ONLINE_DOCUMENT_TITLE = (
    "用户信息（投诉、举报、伪直播、报警、虚假宣传、诱导、12315、黑猫、维权、市长热线、曝光你、消协）"
)
ONLINE_SOURCE_HEADERS = [
    "序列",
    "数据日期",
    "聊天发送人角色",
    "用户ID",
    "用户企微名称",
    "聊天发送人企微用户名称",
    "老师id",
    "老师企微名称",
    "聊天接收人用户名称",
    "发送时间",
    "消息内容",
    "商品类型",
    "训练营名称",
    "期数名称",
]

PAGE_READY_TIMEOUT_MS = 30000
QUERY_TIMEOUT_MS = 60000
# 仅作为异常保护上限，不是固定等待时间；结果区/导出按钮一出现就立即继续。
RESULT_CONTENT_TIMEOUT_MS = 60000
# 点击“数据导出”后等待直接下载的保护时间；超时立即检查 Excel 弹窗，
# 不把“点击成功”误报成“下载成功”。
DOWNLOAD_TRIGGER_TIMEOUT_MS = 10000
DOWNLOAD_TIMEOUT_MS = 60000
# 下载文件已经通过 XLSX 完整性校验后才进入这里，无需再固定等待 2 秒。
# 保留短暂间隔，给 FineBI 收起下载状态和刷新控件的时间。
STEP_INTERVAL_SECONDS = 0.5
WAIT_FOR_MANUAL_LOGIN = True
AUTO_OPEN_REPORT_MENU = True
REPORT_MENU_PATH = ["兴趣岛", "服务复购", "用户满意度", "用户聊天记录明细"]


class LoginRequiredError(RuntimeError):
    """无头探测发现需要人工登录，交由外层工作流临时切换有头模式。"""

    exit_code = 20


# =========================
# 日志工具
# =========================

def setup_logger() -> logging.Logger:
    Path(LOG_DIR).mkdir(parents=True, exist_ok=True)
    log_path = Path(LOG_DIR) / f"finebi_export_{datetime.now().strftime('%Y%m%d')}.log"
    logger = logging.getLogger("finebi_export")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()

    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    logger.addHandler(console)

    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    return logger


LOGGER = setup_logger()


def screenshot_error(page, scene: str) -> str:
    Path(LOG_DIR).mkdir(parents=True, exist_ok=True)
    safe_scene = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", scene)[:40]
    path = Path(LOG_DIR) / f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{safe_scene}.png"
    try:
        page.screenshot(path=str(path), full_page=True)
        LOGGER.error("错误截图已保存：%s", path)
    except Exception as exc:
        LOGGER.error("截图失败：%s", exc)
    return str(path)


def switch_login_to_qr_mode(page) -> None:
    """按真实登录链路进入企业微信官方扫码页。

    登录页必须先点击底部企业微信 Logo，等待协议倒计时结束并
    点击“同意协议”，然后再点击一次 Logo。第二次点击会直接导航到
    login.work.weixin.qq.com，不会在原页显示 #qr-login。
    """
    try:
        if "login.work.weixin.qq.com" in page.url:
            page.wait_for_timeout(1200)
            LOGGER.info("当前已在企业微信官方扫码页")
            return

        # 登录页首屏在服务器上可能先完成 DOM 渲染、后绑定 Vue 点击事件。
        # 等待页面与登录组件稳定，避免日志显示已点击但页面实际无响应。
        try:
            page.wait_for_load_state("networkidle", timeout=5000)
        except PlaywrightTimeoutError:
            pass
        page.wait_for_timeout(1500)

        # 底部企业微信 Logo。右上角 /static/img/qr.png 只是登录表单
        # 样式切换图标，不是本登录链路的入口。
        # 点击事件绑定在外层 el-image，直接点内部 img 不会稳定打开协议弹窗。
        wecom_logo_selector = ".el-image:has(img.el-image__inner)"
        wecom_logo = page.locator(wecom_logo_selector).first
        wecom_logo.wait_for(state="visible", timeout=12000)

        agreement_checkbox = page.locator(
            'input.el-checkbox__original[type="checkbox"]'
        ).first
        agreement_checked = False
        if agreement_checkbox.count():
            agreement_checked = bool(
                agreement_checkbox.evaluate("element => Boolean(element.checked)")
            )

        if not agreement_checked:
            wecom_logo.click(timeout=5000)
            LOGGER.info("已第一次点击底部企业微信 Logo，等待协议倒计时")

            try:
                page.wait_for_function(
                    """
                    () => Boolean(
                      document.querySelector('button.agree-button') ||
                      location.hostname === 'login.work.weixin.qq.com'
                    )
                    """,
                    timeout=4000,
                )
            except PlaywrightTimeoutError:
                # 只在页面完全没有变化时补发一次 DOM 点击。协议窗已经出现时
                # 绝不重复点击，避免关闭弹层或扰乱倒计时。
                wecom_logo = page.locator(wecom_logo_selector).first
                wecom_logo.evaluate("element => element.click()")
                LOGGER.warning("首次点击未触发页面变化，已补发一次企业微信 Logo DOM 点击")
                page.wait_for_function(
                    """
                    () => Boolean(
                      document.querySelector('button.agree-button') ||
                      location.hostname === 'login.work.weixin.qq.com'
                    )
                    """,
                    timeout=8000,
                )

            if "login.work.weixin.qq.com" in page.url:
                page.wait_for_timeout(5000)
                LOGGER.info("协议已由历史状态确认，已直接进入企业微信官方扫码页")
                return

            agree_button = page.locator("button.agree-button").first
            agree_button.wait_for(state="visible", timeout=10000)
            LOGGER.info("已确认登录协议弹窗打开，等待5秒倒计时结束")
            page.wait_for_function(
                """
                () => {
                  const button = document.querySelector('button.agree-button');
                  return Boolean(
                    button &&
                    !button.disabled &&
                    !button.classList.contains('is-disabled') &&
                    (button.textContent || '').trim() === '同意协议'
                  );
                }
                """,
                timeout=12000,
            )
            LOGGER.info("协议验证倒计时已结束，准备点击同意协议")
            agree_button.click(timeout=5000)
            page.wait_for_function(
                """
                () => {
                  const checkbox = document.querySelector(
                    'input.el-checkbox__original[type="checkbox"]'
                  );
                  return Boolean(checkbox && checkbox.checked);
                }
                """,
                timeout=5000,
            )
            LOGGER.info("已点击同意协议，登录页协议状态已验证")
            page.wait_for_timeout(500)
        else:
            LOGGER.info("登录页协议已同意，跳过协议弹窗")

        # 同意协议后 Vue 会重绘登录区，不复用之前的 locator。
        wecom_logo = page.locator(wecom_logo_selector).first
        wecom_logo.wait_for(state="visible", timeout=5000)
        wecom_logo.click(timeout=5000)
        LOGGER.info("已第二次点击底部企业微信 Logo，等待官方扫码页")
        try:
            page.wait_for_url(
                re.compile(r"^https://login\.work\.weixin\.qq\.com/"),
                timeout=6000,
                wait_until="domcontentloaded",
            )
        except PlaywrightTimeoutError:
            # 与第一次点击相同，只在 URL 未变化时补发一次 DOM 点击。
            wecom_logo = page.locator(wecom_logo_selector).first
            wecom_logo.evaluate("element => element.click()")
            LOGGER.warning("第二次点击未触发跳转，已补发一次企业微信 Logo DOM 点击")
            page.wait_for_url(
                re.compile(r"^https://login\.work\.weixin\.qq\.com/"),
                timeout=12000,
                wait_until="domcontentloaded",
            )
        # 官方页会在导航后异步生成二维码，给它完整 5 秒，
        # 然后再将画面同步到网页任务。
        page.wait_for_timeout(5000)
        official_page_text = page.locator("body").inner_text(timeout=5000)
        if not re.search(r"Scan the QR code|WeCom|企业微信|扫码", official_page_text, re.I):
            raise RuntimeError("已进入企业微信登录域名，但扫码页内容尚未渲染")
        LOGGER.info("已进入企业微信官方扫码页，可进行人工扫码")
    except Exception as exc:
        # 保留当前浏览器画面，使用户仍可手动完成登录；
        # 不强制显示隐藏的 iframe，避免伪造“二维码已准备”状态。
        LOGGER.warning("未能按真实链路进入企业微信扫码页：%s", exc)


def wait_for_manual_login_confirmation(page) -> None:
    """等待人工登录，并向网页工作流持续更新当前登录页截图。"""
    switch_login_to_qr_mode(page)
    screenshot_target = os.environ.get("PIPELINE_LOGIN_SCREENSHOT", "").strip()
    screenshot_interval = max(1.0, float(os.environ.get("PIPELINE_LOGIN_SCREENSHOT_INTERVAL", "2")))
    if screenshot_target:
        Path(screenshot_target).expanduser().parent.mkdir(parents=True, exist_ok=True)

    prompt = "完成登录/验证并确认页面可操作后按回车继续；输入 Ctrl+C 可退出："
    print(prompt, end="", flush=True)
    while True:
        if screenshot_target:
            target = Path(screenshot_target).expanduser()
            temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp.png")
            try:
                page.screenshot(path=str(temporary), full_page=True)
                os.replace(temporary, target)
            except Exception as exc:
                LOGGER.warning("登录页截图更新失败：%s", exc)
                temporary.unlink(missing_ok=True)

        try:
            readable, _, _ = select.select([sys.stdin], [], [], screenshot_interval)
        except (OSError, ValueError):
            input()
            return
        if not readable:
            continue
        line = sys.stdin.readline()
        # 网页任务的 stdin 是持续管道；只有收到真实换行才继续。
        if line == "":
            time.sleep(screenshot_interval)
            continue
        return


# =========================
# 通用 DOM 工具
# =========================

def data_date() -> str:
    return (datetime.now() + timedelta(days=DATA_DATE_OFFSET)).strftime("%Y%m%d")


def safe_filename_part(value: str) -> str:
    return re.sub(r'[\\/:*?"<>|\s]+', "_", str(value)).strip("_")


def _normal_header(value) -> str:
    return re.sub(r"\s+", "", str(value or "")).strip().lower()


def _clean_user_id(value) -> str:
    """把 pandas 读出的数字/字符串统一成可去重的用户 ID。"""
    text = str(value or "").strip()
    if text.lower() in {"nan", "none", "nat"}:
        return ""
    if re.fullmatch(r"\d+\.0+", text):
        return text.split(".", 1)[0]
    if re.fullmatch(r"\d+(?:\.\d+)?[eE][+-]?\d+", text):
        try:
            decimal_value = Decimal(text)
            if decimal_value == decimal_value.to_integral_value():
                return format(decimal_value.quantize(Decimal("1")), "f")
        except (InvalidOperation, ValueError):
            return ""
    return text


def _date_value_from_filename(path: Path) -> Optional[str]:
    match = re.search(r"_(\d{8})\.xlsx$", path.name, flags=re.IGNORECASE)
    return match.group(1) if match else None


def ensure_excel_merge_dependency() -> None:
    """在打开浏览器前确认完整流程最后的 Excel 合并依赖可用。"""
    try:
        import openpyxl  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(
            "下载并合并流程需要 openpyxl，请先执行：python3 -m pip install --user openpyxl"
        ) from exc


XLSX_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
XLSX_NS = {"m": XLSX_MAIN_NS}


def _xlsx_column_number(cell_ref: str) -> int:
    match = re.match(r"([A-Z]+)", str(cell_ref or "").upper())
    if not match:
        return 0
    result = 0
    for char in match.group(1):
        result = result * 26 + ord(char) - ord("A") + 1
    return result


def _xlsx_cell_text(cell, shared_strings) -> str:
    cell_type = cell.get("t")
    if cell_type == "s":
        value = cell.find(f"{{{XLSX_MAIN_NS}}}v")
        try:
            return shared_strings[int(value.text)] if value is not None and value.text else ""
        except (ValueError, IndexError):
            return ""
    inline = cell.find(f"{{{XLSX_MAIN_NS}}}is")
    if inline is not None:
        return "".join(inline.itertext())
    value = cell.find(f"{{{XLSX_MAIN_NS}}}v")
    return value.text if value is not None and value.text else ""


def validate_and_repair_xlsx(path: Path, keyword: str) -> dict:
    """验证 FineBI 下载结果，并修正其错误的 worksheet dimension 元数据。

    FineBI 返回的下载名有时是 UUID，且 sheet1.xml 会把范围写成 A1，
    但实际仍含有数据。这里不按文件名判断真假，而按 OOXML 包、表头和实际
    行列判断；修正范围后，一些严格的表格软件也能正确显示完整工作表。
    """
    if path.suffix.lower() != ".xlsx":
        raise RuntimeError(f"导出文件扩展名异常：{path.name}")
    if not path.exists() or path.stat().st_size == 0:
        raise RuntimeError(f"导出文件为空或不存在：{path}")
    if not zipfile.is_zipfile(path):
        raise RuntimeError(f"导出文件不是有效 XLSX/OOXML：{path.name}")

    required = {"[Content_Types].xml", "xl/workbook.xml"}
    changed = False
    row_count = 0
    column_count = 0
    headers = []

    with zipfile.ZipFile(path, "r") as archive:
        bad_member = archive.testzip()
        if bad_member:
            raise RuntimeError(f"导出压缩包校验失败：{bad_member}")
        names = set(archive.namelist())
        missing = required - names
        sheet_names = sorted(
            name for name in names
            if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)
        )
        if missing or not sheet_names:
            raise RuntimeError(
                f"导出文件缺少工作簿结构：missing={sorted(missing)} sheets={sheet_names}"
            )

        shared_strings = []
        if "xl/sharedStrings.xml" in names:
            shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared_strings = [
                "".join(item.itertext())
                for item in shared_root.findall("m:si", XLSX_NS)
            ]

        rewrites = {}
        for sheet_name in sheet_names:
            root = ET.fromstring(archive.read(sheet_name))
            rows = root.findall(".//m:sheetData/m:row", XLSX_NS)
            cells = root.findall(".//m:sheetData/m:row/m:c", XLSX_NS)
            if not rows:
                continue
            row_count = max(row_count, len(rows))
            column_count = max(
                column_count,
                max((_xlsx_column_number(cell.get("r")) for cell in cells), default=0),
            )
            if sheet_name == sheet_names[0]:
                headers = [
                    _xlsx_cell_text(cell, shared_strings).strip()
                    for cell in rows[0].findall("m:c", XLSX_NS)
                ]

            if cells:
                max_row = max(int(re.search(r"\d+", cell.get("r", "0")).group()) for cell in cells)
                max_col = max((_xlsx_column_number(cell.get("r")) for cell in cells), default=0)
                col_text = ""
                number = max_col
                while number:
                    number, remainder = divmod(number - 1, 26)
                    col_text = chr(65 + remainder) + col_text
                expected_dimension = f"A1:{col_text}{max_row}"
                dimension = root.find("m:dimension", XLSX_NS)
                if dimension is not None and dimension.get("ref") != expected_dimension:
                    dimension.set("ref", expected_dimension)
                    ET.register_namespace("", XLSX_MAIN_NS)
                    rewrites[sheet_name] = ET.tostring(root, encoding="utf-8", xml_declaration=True)

        header_text = "|".join(headers)
        expected_headers = ("用户id", "用户ID")
        if not any(item in headers for item in expected_headers) or "消息内容" not in headers:
            raise RuntimeError(
                f"导出内容不是聊天记录明细：keyword={keyword} headers={headers[:20]}"
            )
        if row_count < 1 or column_count < 2:
            raise RuntimeError(f"导出工作表没有有效数据结构：rows={row_count} columns={column_count}")

        if rewrites:
            fd, temp_name = tempfile.mkstemp(prefix="finebi_xlsx_", suffix=".xlsx", dir=str(path.parent))
            os.close(fd)
            temp_path = Path(temp_name)
            try:
                with zipfile.ZipFile(temp_path, "w") as output:
                    for item in archive.infolist():
                        output.writestr(item, rewrites.get(item.filename, archive.read(item.filename)))
                os.replace(temp_path, path)
                changed = True
            finally:
                temp_path.unlink(missing_ok=True)

    return {
        "rows": row_count,
        "columns": column_count,
        "headers": headers,
        "repairedDimension": changed,
        "headerText": header_text,
    }


def xpath_literal(value: str) -> str:
    if "'" not in value:
        return f"'{value}'"
    if '"' not in value:
        return f'"{value}"'
    parts = value.split("'")
    return "concat(" + ", \"'\", ".join(f"'{part}'" for part in parts) + ")"


def text_xpath(text: str, exact: bool = True) -> str:
    literal = xpath_literal(text)
    node_filter = (
        "self::span or self::div or self::a or self::button or self::li or "
        "self::label or self::p or self::td or self::th or "
        "@role='treeitem' or @role='menuitem' or @role='button'"
    )
    if exact:
        condition = f"normalize-space(.)={literal}"
    else:
        condition = f"contains(normalize-space(.), {literal})"
    return f"xpath=.//*[{node_filter}][{condition}]"


def locator_has_visible(locator, timeout: int = 800) -> bool:
    try:
        count = min(locator.count(), 10)
        for index in range(count):
            item = locator.nth(index)
            if item.is_visible(timeout=timeout):
                return True
    except Exception:
        return False
    return False


def dispatch_set_value(page, label_text: str, value: str, occurrence: int = 0) -> bool:
    """按 label 文本找到后续输入框，直接赋值并触发 input/change/blur。"""
    return bool(page.evaluate(
        """
        ({ labelText, value, occurrence }) => {
          const norm = (s) => String(s || '').replace(/\\s+/g, '').trim();
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
          };
          const labels = [...document.querySelectorAll('label,span,div,p,td,th')]
            .filter(visible)
            .filter(el => norm(el.innerText || el.textContent) === norm(labelText) || norm(el.innerText || el.textContent).startsWith(norm(labelText)));
          if (!labels.length) return false;
          const label = labels[0];
          const allInputs = [...document.querySelectorAll('input,textarea')]
            .filter(visible)
            .filter(el => !el.disabled && !el.readOnly);
          const labelIndex = allInputs.findIndex(input => input.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING);
          const after = allInputs.filter(input => label.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING);
          const target = after[occurrence] || after[0] || allInputs[Math.max(0, labelIndex)];
          if (!target) return false;
          target.value = value;
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          target.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        }
        """,
        {"labelText": label_text, "value": value, "occurrence": occurrence},
    ))


def dispatch_set_input_by_placeholder(page, placeholder_text: str, value: str) -> bool:
    """按输入框 placeholder/value/title 精准赋值，适配 FineBI 伪标签输入框。"""
    return bool(page.evaluate(
        """
        ({ placeholderText, value }) => {
          const norm = (s) => String(s || '').replace(/\\s+/g, '').trim();
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
          };
          const wanted = norm(placeholderText);
          const inputs = [...document.querySelectorAll('input,textarea')]
            .filter(visible)
            .filter(el => !el.disabled && !el.readOnly)
            .filter(el => {
              const raw = norm([
                el.getAttribute('placeholder') || '',
                el.value || '',
                el.getAttribute('title') || '',
                el.getAttribute('aria-label') || ''
              ].join(' '));
              return raw === wanted || raw.includes(wanted);
            })
            .sort((a, b) => {
              const ar = a.getBoundingClientRect();
              const br = b.getBoundingClientRect();
              return (ar.top - br.top) || (ar.left - br.left);
            });
          const target = inputs[0];
          if (!target) return false;
          const proto = Object.getPrototypeOf(target);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(target, value);
          else target.value = value;
          target.setAttribute('value', value);
          target.setAttribute('title', value);
          for (const type of ['input', 'change', 'blur']) {
            target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
          }
          return true;
        }
        """,
        {"placeholderText": placeholder_text, "value": value},
    ))


def discover_filter_controls(page) -> dict:
    """按语义控件和真实视觉行标记日期、角色、关键词。

    FineBI 的 DOM 顺序不稳定：角色/关键词用 placeholder 锚定，日期只从
    关键词同一行、角色左侧的两个输入框中识别，避免串到用户ID等字段。
    """
    result = page.evaluate(
        """
        () => {
          const norm = (s) => String(s || '').replace(/\s+/g, '').trim();
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return r.width >= 80 && r.height >= 18 && r.width > 0 && r.height > 0
              && st.display !== 'none' && st.visibility !== 'hidden';
          };
          const inputs = [...document.querySelectorAll('input,textarea')]
            .filter(visible)
            .filter(el => !el.disabled)
            .map(el => ({ el, rect: el.getBoundingClientRect() }))
            .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
          if (!inputs.length) return { ok: false, reason: '没有可见筛选输入框', controls: [] };

          // 关键词通常有稳定 placeholder；角色在选中后可能只剩下标签和蓝色箭头，
          // 因此不能把角色控件完全绑定到 placeholder/value。
          // 不能再用全局 input 下标，否则 FineBI 重渲染后会把用户ID/用户名称当成日期。
          const placeholderOf = (el) => norm(el.getAttribute('placeholder') || '');
          const ariaOf = (el) => norm(el.getAttribute('aria-label') || '');
          const titleOf = (el) => norm(el.getAttribute('title') || '');
          const valueOf = (el) => norm(el.value || '');
          const semantic = (el) => norm([
            placeholderOf(el), ariaOf(el), titleOf(el), valueOf(el)
          ].join(' '));
          const roleBySemantic = inputs
            .map(item => item.el)
            .find(el => placeholderOf(el) === '聊天发送人角色'
              || ariaOf(el) === '聊天发送人角色'
              || ['学员', '老师', '全选/不选'].includes(valueOf(el)));
          const roleByContainer = inputs
            .map(item => item.el)
            .find(el => Boolean(el.closest('[role="combobox"]')));
          const keyword = inputs
            .map(item => item.el)
            .find(el => placeholderOf(el) === '关键词' || ariaOf(el) === '关键词');
          if (!keyword) return { ok: false, reason: '未找到关键词控件', controls: [] };

          const keywordRect = keyword.getBoundingClientRect();
          const sameRowAsKeyword = inputs
            .map(item => item.el)
            .filter(el => {
              const r = el.getBoundingClientRect();
              return Math.abs((r.top + r.bottom) / 2 - (keywordRect.top + keywordRect.bottom) / 2) < Math.max(18, keywordRect.height * 0.8);
            })
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

          const hasArrowControl = (el) => {
            const rr = el.getBoundingClientRect();
            const ancestors = [el.closest('[role="combobox"]'), el.parentElement, el.parentElement?.parentElement, el.parentElement?.parentElement?.parentElement].filter(Boolean);
            return ancestors.some(container => [...container.querySelectorAll('button,[role="button"],[aria-haspopup],svg,i,span,div')].some(node => {
              if (node === el) return false;
              const r = node.getBoundingClientRect();
              const style = window.getComputedStyle(node);
              if (r.width <= 0 || r.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return false;
              const rightSide = r.left >= rr.left + rr.width * 0.58 && r.right <= rr.right + 90;
              const small = r.width >= 12 && r.width <= 110 && r.height >= 12 && r.height <= 100;
              return rightSide && small;
            }));
          };

          // 选中后 placeholder 可能消失，此时取“关键词左侧最近的、带蓝色下拉控件”的输入。
          const role = roleBySemantic || roleByContainer || sameRowAsKeyword
            .filter(el => el !== keyword && el.getBoundingClientRect().right <= keywordRect.left + 8)
            .filter(el => !/用户ID|用户名称|系统用户ID|系统用户名称|品类名称|训练营名称|期数名称|老师企微ID/.test(semantic(el)))
            .filter(el => Boolean(el.closest('[role="combobox"]')) || hasArrowControl(el))
            .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0]
            || null;
          if (!role) return { ok: false, reason: '未找到聊天发送人角色控件（未找到同一行蓝色下拉控件）', controls: [] };

          const roleRect = role.getBoundingClientRect();
          // 下拉展开后角色容器可能被菜单内容撑高，角色输入框会暂时换行。
          // 关键词输入框仍处于筛选首行，因此优先用关键词作为日期行锚点。
          const rowRect = keywordRect.width > 0 ? keywordRect : roleRect;
          const roleMid = (rowRect.top + rowRect.bottom) / 2;
          const sameRow = inputs
            .map(item => item.el)
            .filter(el => {
              const r = el.getBoundingClientRect();
              return Math.abs((r.top + r.bottom) / 2 - roleMid) < Math.max(18, rowRect.height * 0.8);
            })
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

          // 只有角色左侧、与角色同一行的两个非语义输入框才可能是日期起止。
          // 排除用户ID等第二行输入框，也排除任何带业务 placeholder 的输入框。
          const dateCandidates = sameRow.filter(el => {
            const r = el.getBoundingClientRect();
            const text = semantic(el);
            const hasBusinessPlaceholder = /用户ID|用户名称|系统用户ID|系统用户名称|品类名称|训练营名称|期数名称|老师企微ID|关键词|聊天发送人角色/.test(text);
            return r.right <= roleRect.left + 8 && !hasBusinessPlaceholder;
          });
          if (dateCandidates.length < 2) {
            return {
              ok: false,
              reason: `角色左侧同一行仅识别到${dateCandidates.length}个日期候选`,
              controls: [],
              sameRow: sameRow.map(el => ({ placeholder: el.getAttribute('placeholder') || '', value: el.value || '', left: Math.round(el.getBoundingClientRect().left), top: Math.round(el.getBoundingClientRect().top) })),
            };
          }
          const targets = [dateCandidates[0], dateCandidates[1], role, keyword];
          const names = ['date-start', 'date-end', 'role', 'keyword'];
          document.querySelectorAll('[data-finebi-filter-control]').forEach(el => el.removeAttribute('data-finebi-filter-control'));
          const controls = [];
          targets.forEach((el, index) => {
            if (!el || controls.some(item => item.el === el)) return;
            const name = names[index];
            el.setAttribute('data-finebi-filter-control', name);
            const r = el.getBoundingClientRect();
            controls.push({
              name,
              placeholder: el.getAttribute('placeholder') || '',
              value: el.value || '',
              title: el.getAttribute('title') || '',
              top: Math.round(r.top),
              left: Math.round(r.left),
              width: Math.round(r.width),
              height: Math.round(r.height),
            });
          });
          return {
            ok: controls.length === 4,
            reason: controls.length === 4 ? '' : `筛选行仅识别到${controls.length}个控件`,
            controls,
            rowInputCount: sameRow.length,
          };
        }
        """
    )
    if not result.get("ok"):
        raise RuntimeError(f"筛选控件识别失败：{result.get('reason')}; snapshot={result}")
    LOGGER.info("已识别筛选控件：%s", ", ".join(
        f"{item['name']}={item.get('placeholder') or item.get('value') or '-'}"
        for item in result.get("controls", [])
    ))
    return result


def set_keyword_dom_value(context, keyword: str) -> bool:
    """FineBI 自绘输入框的 DOM 赋值兜底，不依赖旧 locator 节点。"""
    try:
        result = context.evaluate(
            """
            (keyword) => {
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return r.width > 0 && r.height > 0
                  && st.display !== 'none' && st.visibility !== 'hidden';
              };
              const inputs = [...document.querySelectorAll(
                'input[data-finebi-filter-control="keyword"],'
                + 'textarea[data-finebi-filter-control="keyword"],'
                + 'input[placeholder="关键词"],textarea[placeholder="关键词"]'
              )].filter(visible);
              const el = inputs[0];
              if (!el) return { ok: false, value: '' };
              const proto = el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(el, keyword);
              else el.value = keyword;
              el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              return { ok: el.value === keyword, value: el.value || '' };
            }
            """,
            keyword,
        )
        return bool(result and result.get("ok"))
    except Exception:
        return False


def set_keyword_value(page, keyword: str, root_page=None) -> bool:
    """等待关键词控件真实出现后再通过 DOM locator 填充。"""
    deadline = time.time() + RESULT_CONTENT_TIMEOUT_MS / 1000
    last_error = None

    def current_keyword_value(context) -> str:
        try:
            return str(context.evaluate(
                """
                () => {
                  const visible = (el) => {
                    const r = el.getBoundingClientRect();
                    const st = getComputedStyle(el);
                    return r.width > 0 && r.height > 0
                      && st.display !== 'none' && st.visibility !== 'hidden';
                  };
                  const el = [...document.querySelectorAll(
                    "input[placeholder='关键词'],textarea[placeholder='关键词']"
                  )].find(visible);
                  return el ? (el.value || '') : '';
                }
                """
            ) or "")
        except Exception:
            return ""

    while time.time() < deadline:
        for context in export_contexts(page, root_page):
            try:
                if set_keyword_dom_value(context, keyword):
                    LOGGER.info("关键词已通过 DOM 赋值并验证：%s", keyword)
                    return True
                locator = context.locator(
                    "input[placeholder='关键词'],textarea[placeholder='关键词']"
                ).first
                if not locator.count() or not locator.is_visible(timeout=400):
                    continue
                # Playwright fill 本身会触发 input 事件。先确认真实 value，
                # 再补 change/blur；FineBI 可能在事件期间重建节点，不能
                # 因为旧 locator 被替换就否定已经成功显示的关键词。
                locator.fill(keyword, timeout=1500)
                value = ""
                try:
                    value = locator.input_value(timeout=800)
                except Exception:
                    value = current_keyword_value(context)
                if value == keyword:
                    try:
                        locator.evaluate(
                            """
                            el => {
                              el.dispatchEvent(new Event('change', {bubbles:true, cancelable:true}));
                              el.dispatchEvent(new Event('blur', {bubbles:true, cancelable:true}));
                            }
                            """,
                            timeout=800,
                        )
                    except Exception as exc:
                        LOGGER.info("关键词已写入，FineBI 重绘期间补发 change/blur 未完成，继续查询：%s", exc)
                    LOGGER.info("关键词 DOM 控件已出现并完成填充：%s", keyword)
                    return True
                if current_keyword_value(context) == keyword:
                    LOGGER.info("关键词已通过当前页面 DOM value 验证：%s", keyword)
                    return True
            except Exception as exc:
                last_error = exc
        page.wait_for_timeout(300)
    if last_error:
        LOGGER.warning("关键词 DOM locator 写入失败：%s", last_error)
    else:
        LOGGER.warning("关键词 DOM 控件尚未出现，等待%s秒后仍无法填充：%s", RESULT_CONTENT_TIMEOUT_MS // 1000, keyword)
    return False


def get_filter_state(page) -> dict:
    """读取当前 FineBI 筛选区关键控件状态。

    当前报表布局固定为：日期起、日期止、聊天发送人角色、关键词。
    这里按同一顶行的视觉顺序取控件，避免把日期框误当角色框。
    """
    try:
        return page.evaluate(
            """
            () => {
              const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
              const compact = (s) => String(s || '').replace(/\\s+/g, '').trim();
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const st = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0
                  && st.display !== 'none'
                  && st.visibility !== 'hidden'
                  && st.opacity !== '0';
              };
              const valueOf = (el) => norm([
                el?.value || '',
                el?.getAttribute?.('title') || '',
                el?.getAttribute?.('placeholder') || '',
                el?.getAttribute?.('aria-label') || '',
                el?.innerText || '',
                el?.textContent || ''
              ].filter(Boolean).join(' '));
              const marked = (name) => document.querySelector(`[data-finebi-filter-control="${name}"]`);
              const markedStart = marked('date-start');
              const markedEnd = marked('date-end');
              const markedRole = marked('role');
              const markedKeyword = marked('keyword');
              if (markedStart && markedEnd && markedRole && markedKeyword) {
                const roleBox = markedRole.closest('[role="combobox"],[role="button"],td,label,div') || markedRole.parentElement || markedRole;
                const roleOwn = norm([
                  markedRole.value || '',
                  markedRole.getAttribute('title') || '',
                  markedRole.getAttribute('aria-label') || ''
                ].join(' '));
                return {
                  dateStart: markedStart.value || '',
                  dateEnd: markedEnd.value || '',
                  roleValue: markedRole.value || '',
                  roleTitle: markedRole.getAttribute('title') || '',
                  roleText: roleOwn || norm(roleBox.innerText || roleBox.textContent || ''),
                  roleBoxText: norm(roleBox.innerText || roleBox.textContent || ''),
                  keywordValue: markedKeyword.value || '',
                  keywordTitle: markedKeyword.getAttribute('title') || '',
                  keywordPlaceholder: markedKeyword.getAttribute('placeholder') || '',
                  roleIsDatePolluted: /^\d{8}$/.test(compact(roleOwn)),
                  topRowValues: [markedStart, markedEnd, markedRole, markedKeyword].map(valueOf),
                  visibleInputs: [markedStart, markedEnd, markedRole, markedKeyword].map((el, i) => {
                    const r = el.getBoundingClientRect();
                    return { index: i, placeholder: el.getAttribute('placeholder') || '', value: el.value || '', title: el.getAttribute('title') || '', aria: el.getAttribute('aria-label') || '', top: Math.round(r.top), left: Math.round(r.left) };
                  }),
                };
              }
              const inputs = [...document.querySelectorAll('input,textarea')]
                .filter(visible)
                .filter(el => {
                  const r = el.getBoundingClientRect();
                  return r.width >= 80 && r.height >= 18;
                })
                .sort((a, b) => {
                  const ar = a.getBoundingClientRect();
                  const br = b.getBoundingClientRect();
                  return (ar.top - br.top) || (ar.left - br.left);
                });
              const dateLabels = [...document.querySelectorAll('label,span,div,p,td,th')]
                .filter(visible)
                .filter(el => compact(el.innerText || el.textContent) === '日期')
                .sort((a, b) => {
                  const ar = a.getBoundingClientRect();
                  const br = b.getBoundingClientRect();
                  return (ar.top - br.top) || (ar.left - br.left);
                });
              let dateInputs = [];
              let topRowInputs = [];
              if (dateLabels.length) {
                const label = dateLabels[0];
                const lr = label.getBoundingClientRect();
                topRowInputs = inputs
                  .filter(el => {
                    const r = el.getBoundingClientRect();
                    return Math.abs((r.top + r.bottom) / 2 - (lr.top + lr.bottom) / 2) < 34 && r.left > lr.left;
                  })
                  .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                dateInputs = topRowInputs.slice(0, 2);
              } else if (inputs.length) {
                const first = inputs[0].getBoundingClientRect();
                topRowInputs = inputs
                  .filter(el => {
                    const r = el.getBoundingClientRect();
                    return Math.abs((r.top + r.bottom) / 2 - (first.top + first.bottom) / 2) < 34;
                  })
                  .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                dateInputs = topRowInputs.slice(0, 2);
              }
              const keywordInput = inputs.find(el => compact(valueOf(el)).includes('关键词')) || topRowInputs[3] || null;
              const roleInput = topRowInputs[2] || null;
              let roleBox = roleInput?.closest?.('[role="combobox"],[role="button"],td,label,div') || roleInput?.parentElement || roleInput || null;
              if (roleInput) {
                const rr = roleInput.getBoundingClientRect();
                const boxes = [...document.querySelectorAll('div,td,label,span')]
                  .filter(visible)
                  .filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.left <= rr.left + 4
                      && r.right >= rr.right - 4
                      && r.top <= rr.top + 4
                      && r.bottom >= rr.bottom - 4
                      && r.width < 420
                      && r.height < 90;
                  })
                  .sort((a, b) => {
                    const ar = a.getBoundingClientRect();
                    const br = b.getBoundingClientRect();
                    return (ar.width * ar.height) - (br.width * br.height);
                  });
                roleBox = boxes[0] || roleBox;
              }
              const visibleInputs = inputs.slice(0, 20).map((el, i) => {
                const r = el.getBoundingClientRect();
                return {
                  index: i,
                  placeholder: el.getAttribute('placeholder') || '',
                  value: el.value || '',
                  title: el.getAttribute('title') || '',
                  aria: el.getAttribute('aria-label') || '',
                  top: Math.round(r.top),
                  left: Math.round(r.left),
                };
              });
              const roleOwn = norm([
                roleInput?.value || '',
                roleInput?.getAttribute?.('title') || '',
                roleInput?.getAttribute?.('aria-label') || ''
              ].join(' '));
              const roleBoxText = roleBox ? norm(roleBox.innerText || roleBox.textContent || '') : '';
              return {
                dateStart: dateInputs[0]?.value || '',
                dateEnd: dateInputs[1]?.value || '',
                roleValue: roleInput?.value || '',
                roleTitle: roleInput?.getAttribute?.('title') || '',
                roleText: roleOwn || roleBoxText || valueOf(roleBox || roleInput),
                roleBoxText,
                keywordValue: keywordInput?.value || '',
                keywordTitle: keywordInput?.getAttribute?.('title') || '',
                keywordPlaceholder: keywordInput?.getAttribute?.('placeholder') || '',
                roleIsDatePolluted: /^\\d{8}$/.test(compact(roleOwn)),
                topRowValues: topRowInputs.slice(0, 8).map(el => valueOf(el)),
                visibleInputs,
              };
            }
            """
        )
    except Exception as exc:
        return {"error": str(exc)}


def format_filter_state(state: dict) -> str:
    if not state:
        return "筛选状态为空"
    if state.get("error"):
        return f"筛选状态读取失败：{state.get('error')}"
    return (
        f"日期={state.get('dateStart') or '-'} 至 {state.get('dateEnd') or '-'}；"
        f"角色值={state.get('roleValue') or state.get('roleTitle') or state.get('roleText') or '-'}；"
        f"关键词={state.get('keywordValue') or state.get('keywordTitle') or state.get('keywordPlaceholder') or '-'}"
    )


def log_filter_snapshot(page, prefix: str = "筛选快照") -> None:
    LOGGER.info("%s：%s", prefix, format_filter_state(get_filter_state(page)))


def set_date_range(page, date_value: str) -> None:
    for name in ("date-start", "date-end"):
        discover_filter_controls(page)
        locator = page.locator(f"input[data-finebi-filter-control='{name}'],textarea[data-finebi-filter-control='{name}']").first
        try:
            # 先点击真实日期输入框，再填写，确保 FineBI 的日期控件获得焦点。
            locator.click(timeout=1500)
            locator.evaluate("el => { el.readOnly = false; el.removeAttribute('readonly'); }")
            locator.fill("")
            locator.fill(date_value)
            locator.evaluate(
                "el => { el.dispatchEvent(new Event('input', {bubbles:true, cancelable:true})); el.dispatchEvent(new Event('change', {bubbles:true, cancelable:true})); el.dispatchEvent(new Event('blur', {bubbles:true, cancelable:true})); }"
            )
        except Exception as exc:
            raise RuntimeError(f"日期控件 {name} 写入失败：{exc}") from exc

    page.wait_for_timeout(250)
    discover_filter_controls(page)
    state = get_filter_state(page)
    if state.get("dateStart") != date_value or state.get("dateEnd") != date_value:
        # 重新定位一次，处理 FineBI 事件触发后的 DOM 重建。
        if not refill_date_inputs_with_locator(page, date_value):
            raise RuntimeError(f"日期筛选验证失败：{format_filter_state(state)}")
        discover_filter_controls(page)
        state = get_filter_state(page)
        if state.get("dateStart") != date_value or state.get("dateEnd") != date_value:
            raise RuntimeError(f"日期筛选验证失败：{format_filter_state(state)}")
    if state.get("roleIsDatePolluted"):
        LOGGER.warning("角色框被日期污染，后续将强制重置角色下拉：%s", format_filter_state(state))
    LOGGER.info("日期筛选已验证：%s 至 %s", date_value, date_value)


def refill_date_inputs_with_locator(page, date_value: str) -> bool:
    """重新定位日期同一行的前两个可见 input，并逐个用 DOM locator 填充。"""
    try:
        for index in range(2):
            name = "date-start" if index == 0 else "date-end"
            discover_filter_controls(page)
            locator = page.locator(f"input[data-finebi-filter-control='{name}'],textarea[data-finebi-filter-control='{name}']").first
            locator.click(timeout=1500)
            locator.evaluate("el => { el.readOnly = false; el.removeAttribute('readonly'); }")
            locator.fill("")
            locator.fill(date_value)
            locator.evaluate(
                """
                (el) => {
                  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
                  el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
                }
                """
            )
        page.wait_for_timeout(250)
        discover_filter_controls(page)
        state = get_filter_state(page)
        return state.get("dateStart") == date_value and state.get("dateEnd") == date_value
    except Exception as exc:
        LOGGER.warning("Playwright DOM locator 补写日期失败：%s", exc)
        return False


def try_set_visible_role_checkboxes(page) -> bool:
    # 角色选择必须走真实 locator.click；不直接修改 checkbox.checked，
    # 避免 FineBI 内部状态没有同步而产生“看似选中”的假状态。
    return set_role_from_open_dropdown(page)


def related_contexts(context, root_page=None):
    contexts = [context]
    if root_page is not None:
        if root_page not in contexts:
            contexts.append(root_page)
        for frame in root_page.frames:
            if frame not in contexts:
                contexts.append(frame)
    return contexts


def role_dropdown_options_visible(page) -> bool:
    """只有实际看到下拉选项时，才认定角色下拉已展开。"""
    try:
        return bool(page.evaluate(
            """
            () => {
              const norm = (s) => String(s || '').replace(/\s+/g, '').trim();
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const st = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
              };
              const exact = new Set(['学员', '老师', '全选/不选']);
              const nodes = [...document.querySelectorAll('label,span,div,li,[role="option"],[role="menuitem"]')]
                .filter(el => visible(el) && exact.has(norm(el.innerText || el.textContent)));
              return nodes.some(el => {
                let row = el;
                for (let i = 0; row && i < 6; i += 1, row = row.parentElement) {
                  const controls = [row, ...row.querySelectorAll('*')];
                  if (controls.some(node => visible(node) && (
                    node.matches?.('input[type="checkbox"],[role="checkbox"]')
                    || node.hasAttribute?.('aria-checked')
                    || node.hasAttribute?.('data-checked')
                    || node.hasAttribute?.('data-state')
                    || /checkbox|check-box|checkBox/i.test(String(node.className || ''))
                  ))) return true;
                }
                return false;
              });
            }
            """
        ))
    except Exception:
        return False


def role_dropdown_options_visible_any(page, root_page=None) -> bool:
    return any(role_dropdown_options_visible(context) for context in related_contexts(page, root_page))


def click_role_filter_control(page, root_page=None, trace: Optional[dict] = None) -> bool:
    # 当前报表固定版面：日期起、日期止、聊天发送人角色、关键词。
    # 只用 DOM locator 逐个尝试角色输入框、其容器和下拉按钮；
    # 必须看到“学员/老师”选项后才算点击成功。
    # 上一步日期点击可能没有关闭下拉层；此时不能再次点击箭头把下拉层关闭。
    if role_dropdown_options_visible_any(page, root_page):
        LOGGER.info("角色蓝色下拉项已处于展开状态，继续选择学员")
        if trace is not None:
            trace["roleDropdownAlreadyOpen"] = True
        return True
    marked = bool(page.evaluate(
        """
        () => {
          const norm = (s) => String(s || '').replace(/\\s+/g, '').trim();
          const visible = (el) => {
            const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
          };
          document.querySelectorAll('[data-finebi-role-click-target]').forEach(el => el.removeAttribute('data-finebi-role-click-target'));
          document.querySelectorAll('[data-finebi-role-arrow]').forEach(el => el.removeAttribute('data-finebi-role-arrow'));
          const visibleInputs = [...document.querySelectorAll('input,textarea')].filter(visible);
          const semanticRole = visibleInputs.find(el => norm(el.getAttribute('placeholder') || '') === '聊天发送人角色')
            || visibleInputs.find(el => ['学员', '老师', '全选/不选'].includes(norm(el.value || el.getAttribute('title') || '')));
          const keywordInput = visibleInputs.find(el => norm(el.getAttribute('placeholder') || '') === '关键词');
          const keywordRect = keywordInput?.getBoundingClientRect();
          const containerRole = visibleInputs.find(el => Boolean(el.closest('[role="combobox"]')));
          const rowRole = keywordRect ? visibleInputs
            .filter(el => {
              const r = el.getBoundingClientRect();
              return el !== keywordInput
                && r.right <= keywordRect.left + 8
                && Math.abs((r.top + r.bottom) / 2 - (keywordRect.top + keywordRect.bottom) / 2) < Math.max(18, keywordRect.height * 0.8);
            })
            .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] : null;
          const roleInput = semanticRole || containerRole || rowRole;
          if (!roleInput) return false;
          // 截图中的蓝色箭头是输入框右侧独立的 DOM 节点；必须优先
          // 标记这个箭头，点击输入框本体或整个外层容器不会展开下拉。
          const rr = roleInput.getBoundingClientRect();
          const containers = [
            roleInput.closest('[role="combobox"]'),
            roleInput.parentElement,
            roleInput.parentElement?.parentElement,
            roleInput.parentElement?.parentElement?.parentElement,
          ].filter(Boolean);
          const candidates = [];
          for (const container of containers) {
            for (const node of container.querySelectorAll('button,[role="button"],[aria-haspopup],svg,i,span,div')) {
              if (!visible(node) || node === roleInput) continue;
              const r = node.getBoundingClientRect();
              const nodeText = norm(node.innerText || node.textContent || '');
              // 已选值是 chip，不是下拉按钮；点击它不会展开 FineBI 菜单。
              if (['学员', '老师', '全选/不选'].includes(nodeText)
                && !node.matches('button,[role="button"],[aria-haspopup]')) continue;
              // 蓝色箭头可能是输入框右侧的独立按钮，也可能是嵌在
              // 输入框内部的 span/div；两种结构都必须通过 locator.click。
              const isRightSide = r.left >= rr.left + rr.width * 0.58 && r.right <= rr.right + 90;
              const isSmallControl = r.width >= 12 && r.width <= 100 && r.height >= 12 && r.height <= 100;
              const semanticArrow = /arrow|caret|select|dropdown|combobox|展开|下拉/i.test([
                node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('class')
              ].map(v => String(v || '')).join(' '));
              // 真实页面的蓝色箭头通常在输入框右侧；重绘或 chip 换行时，
              // 带 aria-label/title 的箭头可能暂时位于下一行，语义优先仍可确认
              // 它属于角色 combobox，而不会点击已选 chip。
              if (isSmallControl && (semanticArrow || (isRightSide && r.left >= rr.right - 45))) candidates.push(node);
            }
          }
          const unique = [];
          for (const node of candidates) {
            if (!unique.includes(node)) unique.push(node);
          }
          unique.sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            const semantic = (node) => /arrow|caret|select|dropdown|combobox|展开|下拉/i.test([
              node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('class')
            ].map(v => String(v || '')).join(' '));
            const semanticOrder = Number(semantic(b)) - Number(semantic(a));
            if (semanticOrder) return semanticOrder;
            const ad = Math.abs(ar.right - rr.right);
            const bd = Math.abs(br.right - rr.right);
            return ad - bd || (ar.width * ar.height) - (br.width * br.height);
          });
          const arrow = unique[0] || null;
          if (!arrow) return 0;
          arrow.setAttribute('data-finebi-role-arrow', '1');
          return 1;
        }
        """
    ))

    if marked:
        arrow = page.locator("[data-finebi-role-arrow='1']").first
        try:
            if arrow.is_visible(timeout=500):
                if trace is not None:
                    trace["roleDropdownClickCount"] = int(trace.get("roleDropdownClickCount", 0)) + 1
                    trace["roleOperationOwnerFrame"] = getattr(page, "url", "")
                    LOGGER.info("角色下拉点击：operation=%s，owner=%s，第%s次", trace.get("roleOperationId"), trace.get("roleOperationOwnerFrame"), trace["roleDropdownClickCount"])
                arrow.click(timeout=1200)
                deadline = time.time() + 2.0
                while time.time() < deadline:
                    if role_dropdown_options_visible_any(page, root_page):
                        LOGGER.info("已通过 DOM locator 点击角色右侧蓝色箭头，已确认下拉选项展开")
                        return True
                    page.wait_for_timeout(120)
        except Exception:
            pass
    LOGGER.warning("发送人角色下拉未展开：未看到“学员/老师/全选/不选”选项")
    return False


def format_role_state(state: dict) -> str:
    return (
        f"全选={bool(state.get('all'))}，学员={bool(state.get('student'))}，"
        f"老师={bool(state.get('teacher'))}"
    )


def wait_role_state_after_click(page, before: dict, timeout_ms: int = 2200) -> dict:
    deadline = time.time() + timeout_ms / 1000
    last = {"found": False}
    while time.time() < deadline:
        last = role_option_selection_state(page)
        if last.get("found") and last != before:
            return last
        page.wait_for_timeout(120)
    return last


def role_chip_selection_state(page) -> dict:
    """读取角色 combobox 内已渲染的选中标签，不触发任何点击。"""
    try:
        return page.evaluate(
            """
            () => {
              const norm = (s) => String(s || '').replace(/\s+/g, '').trim();
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const st = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
              };
              const role = document.querySelector('input[data-finebi-filter-control="role"],textarea[data-finebi-filter-control="role"]')
                || [...document.querySelectorAll('input,textarea')]
                  .find(el => norm(el.getAttribute('placeholder') || '') === '聊天发送人角色'
                    || Boolean(el.closest('[role="combobox"]')));
              const boxes = [];
              let current = role?.closest('[role="combobox"]') || role?.parentElement;
              for (let i = 0; current && i < 5; i += 1, current = current.parentElement) boxes.push(current);
              if (!boxes.length) return { found: false };
              const exactVisible = (text) => boxes.flatMap(box => [...box.querySelectorAll('span,em,strong,b,div,label')])
                .filter(visible)
                .filter(el => norm(el.innerText || el.textContent) === text)
                .filter((el, index, all) => all.indexOf(el) === index)
                .filter(el => ![el, ...el.querySelectorAll('*')].some(node => {
                  return node !== el && visible(node) && (
                    node.matches?.('input[type="checkbox"],[role="checkbox"]')
                    || node.hasAttribute?.('aria-checked')
                    || node.hasAttribute?.('data-checked')
                    || node.hasAttribute?.('data-state')
                    || /checkbox|check-box|checkBox/i.test(String(node.className || ''))
                  );
                }));
              const student = exactVisible('学员').length > 0;
              const teacher = exactVisible('老师').length > 0;
              const all = exactVisible('全选/不选').length > 0;
              const inputValue = norm(role?.value || '');
              return {
                found: student || teacher || all || ['学员', '老师', '全选/不选'].includes(inputValue),
                student: student || inputValue === '学员',
                teacher: teacher || inputValue === '老师',
                all: all || inputValue === '全选/不选',
              };
            }
            """
        )
    except Exception:
        return { "found": False }


def role_chip_only_student(page) -> bool:
    state = role_chip_selection_state(page)
    return bool(state.get("student")) and not bool(state.get("teacher")) and not bool(state.get("all"))


def set_role_from_open_dropdown(page, trace: Optional[dict] = None) -> bool:
    # 幂等处理：每次点击前重新读取状态，避免 FineBI 重绘期间进入备用分支，
    # 再次点击“学员”而把已选状态反选掉。
    for _ in range(4):
        state = role_option_selection_state(page)
        if not state.get("found"):
            return False
        if trace is not None:
            trace.setdefault("stateTransitions", []).append({"stage": "before", "state": dict(state)})
            LOGGER.info("角色选项状态（点击前）：operation=%s，%s", trace.get("roleOperationId"), format_role_state(state))
        # FineBI 可能只同步 chip，不同步隐藏 input/class；chip 已明确为仅学员时，
        # 直接认定成功，禁止再次点击学员造成反选。
        if (state.get("student") or role_chip_only_student(page)) and not state.get("teacher") and not state.get("all"):
            if trace is not None and role_chip_only_student(page) and not state.get("student"):
                trace["roleVisualChipAccepted"] = True
                LOGGER.info("已读取角色框选中标签：学员；跳过重复点击")
            return True
        if state.get("all"):
            if not click_dropdown_option(page, "全选/不选", trace):
                return False
            after = wait_role_state_after_click(page, state)
            if not after.get("student") and role_chip_only_student(page) and not after.get("teacher") and not after.get("all"):
                after = dict(after)
                after["student"] = True
                after["visualChipAccepted"] = True
            if trace is not None:
                trace.setdefault("stateTransitions", []).append({"stage": "after-all", "state": dict(after)})
                LOGGER.info("角色选项状态（取消全选后）：operation=%s，%s", trace.get("roleOperationId"), format_role_state(after))
            if not after.get("found") or after.get("all"):
                return False
            continue
        if state.get("teacher"):
            if not click_dropdown_option(page, "老师", trace):
                return False
            after = wait_role_state_after_click(page, state)
            if trace is not None:
                trace.setdefault("stateTransitions", []).append({"stage": "after-teacher", "state": dict(after)})
                LOGGER.info("角色选项状态（取消老师后）：operation=%s，%s", trace.get("roleOperationId"), format_role_state(after))
            if not after.get("found") or after.get("teacher"):
                return False
            continue
        if not state.get("student"):
            if not click_dropdown_option(page, "学员", trace):
                return False
            after = wait_role_state_after_click(page, state)
            if trace is not None:
                trace.setdefault("stateTransitions", []).append({"stage": "after-student", "state": dict(after)})
                LOGGER.info("角色选项状态（选择学员后）：operation=%s，%s", trace.get("roleOperationId"), format_role_state(after))
            if after.get("teacher") or after.get("all"):
                return False
            if not after.get("student"):
                # FineBI 某些版本只更新视觉层，隐藏 input/状态属性会延迟或保持旧值。
                # 学员 locator 已完成唯一一次点击，不能再次点击造成反选；直接放行。
                if trace is not None:
                    trace["studentClickAcceptedAfterDomClick"] = True
                LOGGER.warning("学员 DOM 点击已完成但底层状态未同步，跳过重复复核，继续关键词流程")
            return True
    return role_selection_verified(page)


def role_option_selection_state(page) -> dict:
    """读取当前已展开下拉层的真实勾选状态，兼容原生 checkbox 和自绘 checkbox。"""
    try:
        return page.evaluate(
            """
            () => {
              const norm = (s) => String(s || '').replace(/\\s+/g, '').trim();
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const st = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
              };
              const nodes = [...document.querySelectorAll('label,span,div,li,[role="option"],[role="menuitem"]')]
                .filter(visible);
              const rowFor = (node) => {
                let current = node;
                for (let i = 0; current && i < 6; i += 1, current = current.parentElement) {
                  if (current.matches?.('label,li,[role="option"],[role="menuitem"]')) return current;
                  if (current.querySelector?.('input[type="checkbox"],[aria-checked],[data-checked],[data-state]')) return current;
                }
                return node?.parentElement || node;
              };
              const hasVisibleControl = (row) => {
                if (!row) return false;
                return [row, ...row.querySelectorAll('*')].some(el => {
                  return visible(el) && (
                    el.matches?.('input[type="checkbox"],[role="checkbox"]')
                    || el.hasAttribute?.('aria-checked')
                    || el.hasAttribute?.('data-checked')
                    || el.hasAttribute?.('data-state')
                    || /checkbox|check-box|checkBox/i.test(String(el.className || ''))
                  );
                });
              };
              const find = (text) => nodes.find(el => {
                if (norm(el.innerText || el.textContent) !== text) return false;
                const row = rowFor(el);
                // 选中后控件里会出现一个“学员”chip。它的父容器同时包含
                // 全选/老师等内容，不能把整个 combobox 当成选项行。
                if (norm(row?.innerText || row?.textContent) !== text) return false;
                return hasVisibleControl(row);
              });
              const selected = (node, optionText) => {
                if (!node) return false;
                const row = rowFor(node);
                const scopes = [];
                let current = row;
                for (let i = 0; current && i < 5; i += 1, current = current.parentElement) {
                  if (norm(current.innerText || current.textContent) === optionText) scopes.push(current);
                }
                return scopes.some(scope => {
                  const descendants = [scope, ...scope.querySelectorAll('*')];
                  const input = descendants.find(el => el.matches?.('input[type="checkbox"]'));
                  // FineBI 的自绘复选框可能保留一个 checked=false 的隐藏 input，
                  // 但把真正状态写在外层 class/aria/data 属性上。不能因为找到
                  // input 就提前返回 false，必须合并读取两套状态。
                  if (input?.checked) return true;
                  return descendants.some(el => {
                  const attrs = [
                    el.getAttribute?.('aria-checked'),
                    el.getAttribute?.('data-checked'),
                    el.getAttribute?.('data-state'),
                    el.getAttribute?.('data-selected'),
                    el.getAttribute?.('class'),
                  ].map(v => String(v || '')).join(' ').trim();
                  const normalized = attrs.toLowerCase();
                  return normalized === 'true' || normalized === 'checked' || normalized === 'selected'
                    || /is-checked|ischecked|is-selected|isselected|checked|selected/i.test(attrs);
                  });
                });
              };
              const student = find('学员');
              const teacher = find('老师');
              const all = find('全选/不选');
              if (!student && !teacher && !all) return { found: false };
              return {
                found: true,
                student: selected(student, '学员'),
                teacher: selected(teacher, '老师'),
                all: selected(all, '全选/不选'),
              };
            }
            """
        )
    except Exception:
        return {"found": False}


def role_selection_verified(page) -> bool:
    state = role_option_selection_state(page)
    if state.get("found"):
        return (bool(state.get("student")) or role_chip_only_student(page)) and not bool(state.get("teacher")) and not bool(state.get("all"))
    if role_chip_only_student(page):
        return True
    return role_filter_selected_student(page)


def role_filter_selected_student(page) -> bool:
    try:
        # 下拉层展开时，父容器会同时包含“学员/老师”两行文字，
        # 不能用容器全文判断；优先读取选项行的真实勾选状态。
        option_state = role_option_selection_state(page)
        if option_state.get("found"):
            return (bool(option_state.get("student")) or role_chip_only_student(page)) and not bool(option_state.get("teacher")) and not bool(option_state.get("all"))
        if role_chip_only_student(page):
            return True
        role = page.locator(
            "input[data-finebi-filter-control='role'],textarea[data-finebi-filter-control='role'],"
            "input[placeholder='聊天发送人角色'],textarea[placeholder='聊天发送人角色']"
        ).first
        if not role.is_visible(timeout=800):
            # 选中后 FineBI 有时会移除 placeholder；用同一行关键词左侧最近的
            # 带下拉箭头控件重新发现角色，不触发任何点击。
            discover_filter_controls(page)
            role = page.locator("input[data-finebi-filter-control='role'],textarea[data-finebi-filter-control='role']").first
            if not role.is_visible(timeout=800):
                return False
        value = role.input_value(timeout=800)
        if value and value != "学员":
            return False
        # 只读取角色控件自身的可见文本。不能用外层整行文本，因为说明文字里
        # 也包含“老师/学员”，会把已正确选择的状态误判为多选。
        box_text = role.evaluate(
            """
            (el) => {
              const visible = (node) => {
                const r = node.getBoundingClientRect();
                const s = getComputedStyle(node);
                return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
              };
              let box = el.closest('[role=' + JSON.stringify('combobox') + ']');
              if (!box) box = el.parentElement;
              if (!box) return '';
              return [...box.querySelectorAll('*')].filter(visible).map(node => {
                const text = String(node.innerText || node.textContent || '').replace(/\s+/g, '').trim();
                return text === '学员' ? text : (text === '老师' ? text : '');
              }).filter(Boolean).join('');
            }
            """
        )
        compact = re.sub(r"\s+", "", value or box_text or "")
        if re.fullmatch(r"\d{8}", compact):
            return False
        if compact == "学员":
            return True
        # 某些 FineBI 版本把选中项渲染成 chip，input.value 为空；只接受
        # 精确的“学员”，不接受包含老师或全选的组合文本。
        return compact == "学员"
    except Exception:
        return False


def mark_role_option(page, option: str) -> Optional[str]:
    """按精确文字标记真实选项行，避免点击到整个下拉容器。"""
    name = {"学员": "student", "老师": "teacher", "全选/不选": "all"}.get(option)
    if not name:
        return None
    try:
        marked = page.evaluate(
            """
            ({ option, name }) => {
              const norm = (s) => String(s || '').replace(/\\s+/g, '').trim();
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const st = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
              };
              const exact = [...document.querySelectorAll('label,span,div,li,[role="option"],[role="menuitem"]')]
                .filter(visible)
                .filter(el => norm(el.innerText || el.textContent) === norm(option));
              if (!exact.length) return false;
              const rowFor = (node) => {
                const ancestors = [];
                let current = node;
                for (let i = 0; current && i < 6; i += 1, current = current.parentElement) {
                  if (norm(current.innerText || current.textContent) !== norm(option)) continue;
                  const r = current.getBoundingClientRect();
                  ancestors.push({ current, area: r.width * r.height });
                }
                const withControl = ancestors.filter(item => item.current.querySelector(
                  'input[type="checkbox"],[role="checkbox"],[class*="checkbox"],[class*="Checkbox"]'
                ));
                return (withControl.length ? withControl : ancestors).sort((a, b) => a.area - b.area)[0]?.current || node;
              };
              const row = rowFor(exact[0]);
              document.querySelectorAll('[data-finebi-role-option]').forEach(el => el.removeAttribute('data-finebi-role-option'));
              row.setAttribute('data-finebi-role-option', name);
              return true;
            }
            """,
            {"option": option, "name": name},
        )
        return name if marked else None
    except Exception:
        return None


def click_dropdown_option(page, option: str, trace: Optional[dict] = None) -> bool:
    counter_name = {
        "全选/不选": "roleAllToggleClickCount",
        "学员": "roleStudentClickCount",
        "老师": "roleTeacherClickCount",
    }.get(option)
    if trace is not None and counter_name:
        current = int(trace.get(counter_name, 0))
        if current >= 1:
            LOGGER.error("检测到重复点击风险，已阻止再次点击「%s」：operation=%s", option, trace.get("roleOperationId"))
            trace["duplicateClickBlocked"] = True
            return False
        trace[counter_name] = current + 1
        LOGGER.info("点击%s：operation=%s，第%s次", option, trace.get("roleOperationId"), trace[counter_name])
    name = mark_role_option(page, option)
    if name:
        row = page.locator(f"[data-finebi-role-option='{name}']").first
        # FineBI 可能使用原生 checkbox，也可能使用自绘 checkbox。
        targets = [
            row.locator("input[type='checkbox']").first,
            row.locator("[role='checkbox']").first,
            row.locator("[class*='checkbox'],[class*='Checkbox']").first,
            row,
        ]
        for target in targets:
            try:
                if target.count() and target.is_visible(timeout=500):
                    # 选定一个真实 DOM 目标后只点击一次；失败直接返回，
                    # 禁止在同一选项上切换到另一个目标造成二次反选。
                    target.click(timeout=1200)
                    return True
            except Exception:
                return False
        return False
    locators = [
        page.locator(text_xpath(option, exact=True)),
        page.get_by_text(option, exact=True),
    ]
    for locator in locators:
        try:
            if locator.count() and locator.first.is_visible(timeout=500):
                locator.first.click(timeout=1200)
                return True
        except Exception:
            return False
    return False


def role_filter_snapshot(page, root_page=None) -> str:
    contexts = related_contexts(page, root_page)
    parts = []
    for index, context in enumerate(contexts):
        try:
            value = context.evaluate(
                """
                () => {
                  const visible = (el) => {
                    const r = el.getBoundingClientRect();
                    const st = window.getComputedStyle(el);
                    return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
                  };
                  const text = document.body.innerText || '';
                  const markers = ['聊天发送人角色', '聊天发送人', '发送人角色', '发送人', '角色', '学员', '老师', '全选/不选'];
                  const lines = text.split(/\\n+/).map(s => s.trim()).filter(Boolean);
                  const matchedLines = lines.filter(line => markers.some(marker => line.includes(marker))).slice(0, 80);
                  const inputs = [...document.querySelectorAll('input,textarea')]
                    .filter(visible)
                    .map((el, i) => {
                      const raw = [
                        `placeholder=${el.getAttribute('placeholder') || ''}`,
                        `value=${el.value || ''}`,
                        `title=${el.getAttribute('title') || ''}`,
                        `aria=${el.getAttribute('aria-label') || ''}`
                      ].join(' ');
                      return `input${i}:${raw}`;
                    })
                    .slice(0, 30);
                  const markerInputs = [...document.querySelectorAll('input,textarea')]
                    .filter(visible)
                    .map((el, i) => {
                      const raw = [
                        el.getAttribute('placeholder') || '',
                        el.value || '',
                        el.getAttribute('title') || '',
                        el.getAttribute('aria-label') || ''
                      ].filter(Boolean).join('/');
                      return raw && markers.some(marker => raw.includes(marker)) ? `input${i}:${raw}` : '';
                    })
                    .filter(Boolean)
                    .slice(0, 30);
                  return [...matchedLines, ...markerInputs, ...inputs].join(' | ');
                }
                """
            )
            if value:
                parts.append(f"context={index} {value}")
        except Exception:
            continue
    return "\n".join(parts)


def set_role_from_any_open_dropdown(page, root_page=None, trace: Optional[dict] = None) -> bool:
    for context in related_contexts(page, root_page):
        try:
            state = role_option_selection_state(context)
            if not state.get("found"):
                continue
            owner = f"{getattr(context, 'url', '')}::{id(context)}"
            if trace is not None:
                existing_owner = trace.get("roleOperationOwnerContext")
                if existing_owner and existing_owner != owner:
                    continue
                trace["roleOperationOwnerContext"] = owner
                LOGGER.info("角色下拉操作上下文锁定：operation=%s，owner=%s", trace.get("roleOperationId"), owner)
            if set_role_from_open_dropdown(context, trace):
                return True
        except Exception:
            continue
    return False


def role_filter_selected_student_any(page, root_page=None) -> bool:
    for context in related_contexts(page, root_page):
        try:
            if role_filter_selected_student(context):
                return True
        except Exception:
            continue
    return False


def role_selection_verified_any(page, root_page=None) -> bool:
    for context in related_contexts(page, root_page):
        try:
            if role_selection_verified(context):
                return True
        except Exception:
            continue
    return False


def mark_role_arrow_for_close(page) -> bool:
    """标记当前角色控件右侧蓝色箭头，用于关闭已展开的下拉层。"""
    try:
        return bool(page.evaluate(
            """
            () => {
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return r.width > 0 && r.height > 0
                  && st.display !== 'none' && st.visibility !== 'hidden';
              };
              const norm = (s) => String(s || '').replace(/\\s+/g, '').trim();
              const role = [...document.querySelectorAll('input,textarea')]
                .find(el => visible(el) && norm(el.getAttribute('placeholder') || '') === '聊天发送人角色')
                || [...document.querySelectorAll('input,textarea')]
                  .find(el => visible(el) && Boolean(el.closest('[role="combobox"]')));
              if (!role) return false;
              const rr = role.getBoundingClientRect();
              const containers = [
                role.closest('[role="combobox"]'),
                role.parentElement,
                role.parentElement?.parentElement,
                role.parentElement?.parentElement?.parentElement,
              ].filter(Boolean);
              const candidates = [];
              for (const box of containers) {
                for (const node of box.querySelectorAll('button,[role="button"],[aria-haspopup],svg,i,span,div')) {
                  if (!visible(node) || node === role) continue;
                  const r = node.getBoundingClientRect();
                  const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.className]
                    .map(v => String(v || '')).join(' ');
                  const semantic = /arrow|caret|select|dropdown|combobox|展开|下拉/i.test(label);
                  const rightSide = r.left >= rr.left + rr.width * 0.58 && r.left <= rr.right + 80;
                  const small = r.width >= 12 && r.width <= 100 && r.height >= 12 && r.height <= 100;
                  if (small && (semantic || rightSide)) candidates.push(node);
                }
              }
              candidates.sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                const score = (node) => /arrow|caret|select|dropdown|combobox|展开|下拉/i.test([
                  node.getAttribute('aria-label'), node.getAttribute('title'), node.className
                ].map(v => String(v || '')).join(' '));
                return Number(score(b)) - Number(score(a))
                  || Math.abs(ar.right - rr.right) - Math.abs(br.right - rr.right);
              });
              const arrow = candidates[0];
              if (!arrow) return false;
              document.querySelectorAll('[data-finebi-role-close-arrow]')
                .forEach(el => el.removeAttribute('data-finebi-role-close-arrow'));
              arrow.setAttribute('data-finebi-role-close-arrow', '1');
              return true;
            }
            """
        ))
    except Exception:
        return False


def close_role_dropdown_if_open(page, root_page=None) -> bool:
    """只关闭下拉层，不重新点击任何角色选项。"""
    if not role_dropdown_options_visible_any(page, root_page):
        return True
    for context in related_contexts(page, root_page):
        try:
            if not role_dropdown_options_visible(context):
                continue
            if not mark_role_arrow_for_close(context):
                continue
            arrow = context.locator("[data-finebi-role-close-arrow='1']").first
            if not arrow.is_visible(timeout=500):
                continue
            arrow.click(timeout=1500)
            deadline = time.time() + 2.5
            while time.time() < deadline:
                if not role_dropdown_options_visible_any(page, root_page):
                    LOGGER.info("角色下拉已通过蓝色箭头 DOM locator 关闭，未重新点击学员")
                    return True
                (root_page or page).wait_for_timeout(120)
        except Exception:
            continue
    LOGGER.warning("学员已选择，但角色下拉层未能关闭；后续查询仍将先验证查询按钮可点击")
    return False


def click_dropdown_option_any(page, option: str, root_page=None) -> bool:
    for context in related_contexts(page, root_page):
        try:
            if click_dropdown_option(context, option):
                return True
        except Exception:
            continue
    return False


def role_filter_snapshot_legacy(page) -> str:
    try:
        return page.evaluate(
            """
            () => {
              const text = document.body.innerText || '';
              const markers = ['聊天发送人角色', '聊天发送人', '发送人角色', '发送人', '角色', '学员', '老师'];
              const lines = text.split(/\\n+/).map(s => s.trim()).filter(Boolean);
              return lines.filter(line => markers.some(marker => line.includes(marker))).slice(0, 80).join(' | ');
            }
            """
        )
    except Exception:
        return ""


def set_role_checkboxes(page, root_page=None) -> None:
    # 即使当前文本已经显示“学员”，也必须重新点击蓝色箭头确认下拉层已真实打开。
    # 仅读取输入框值不能证明 FineBI 的多选状态已经同步。
    trace = {
        "roleOperationId": uuid4().hex[:12],
        "roleDropdownClickCount": 0,
        "roleAllToggleClickCount": 0,
        "roleStudentClickCount": 0,
        "roleTeacherClickCount": 0,
        "duplicateClickBlocked": False,
        "stateTransitions": [],
    }
    if click_role_filter_control(page, root_page, trace):
        time.sleep(0.5)
        # 下拉层可能挂在报表 iframe，也可能挂在主页面 overlay；逐个上下文处理，
        # 但每个上下文内部只允许按实时状态点击，绝不盲目重复点击学员。
        if set_role_from_any_open_dropdown(page, root_page, trace):
            time.sleep(0.8)
            if role_selection_verified_any(page, root_page) or trace.get("studentClickAcceptedAfterDomClick"):
                LOGGER.info(
                    "角色选项状态（最终）：全选=false，学员=true，老师=false；"
                    "operation=%s，箭头点击=%s，全选点击=%s，学员点击=%s，老师点击=%s",
                    trace["roleOperationId"],
                    trace["roleDropdownClickCount"],
                    trace["roleAllToggleClickCount"],
                    trace["roleStudentClickCount"],
                    trace["roleTeacherClickCount"],
                )
                LOGGER.info("发送人筛选已验证：仅学员")
                close_role_dropdown_if_open(page, root_page)
                return

    snapshot = role_filter_snapshot(page, root_page)
    LOGGER.error(
        "角色筛选失败：operation=%s，箭头点击=%s，全选点击=%s，学员点击=%s，老师点击=%s，重复点击拦截=%s",
        trace["roleOperationId"], trace["roleDropdownClickCount"], trace["roleAllToggleClickCount"],
        trace["roleStudentClickCount"], trace["roleTeacherClickCount"], trace["duplicateClickBlocked"],
    )
    screenshot_error(root_page or page, "角色筛选失败")
    raise RuntimeError(f"未能通过「学员/老师」定位或设置聊天发送人筛选。筛选区文本：{snapshot}")


def verify_global_filters(page, date_value: str, root_page=None, role_verified: bool = False) -> None:
    state = get_filter_state(page)
    # 角色已经通过初始化阶段验证时，不重新发现/触碰角色控件；FineBI 的
    # 自绘下拉重绘可能让旧语义节点短暂消失。只有日期状态缺失时才重新发现。
    if state.get("error") or state.get("dateStart") != date_value or state.get("dateEnd") != date_value:
        discover_filter_controls(page)
        state = get_filter_state(page)
    # 角色选项可能挂在报表 iframe，也可能被 FineBI 渲染到主页面 overlay。
    # 复核阶段只读两处状态，不重新点击、不重新选择，避免把“学员”反选掉。
    role_ok = True if role_verified else role_filter_selected_student_any(page, root_page)
    date_ok = state.get("dateStart") == date_value and state.get("dateEnd") == date_value
    if not role_ok or not date_ok:
        snapshot = role_filter_snapshot(page, root_page)
        raise RuntimeError(
            f"全局筛选验证失败：{format_filter_state(state)}；仅学员复核={role_ok}；角色DOM={snapshot}"
        )
    if role_verified:
        LOGGER.info("角色已由初始化阶段验证，跳过重复点击；日期筛选验证通过：%s 至 %s", date_value, date_value)
    else:
        LOGGER.info("全局筛选验证通过：发送人=学员；日期=%s 至 %s", date_value, date_value)


def click_button_by_text(page, text: str) -> bool:
    locators = [
        page.get_by_role("button", name=text, exact=True),
        page.get_by_text(text, exact=True),
        page.locator(text_xpath(text, exact=True)),
    ]
    for locator in locators:
        if click_first_visible(locator, timeout=1200):
            return True
    return False


def click_query_button(page, root_page=None) -> bool:
    """点击查询按钮，并明确记录真实 DOM 点击，不使用页面坐标。"""
    for context in export_contexts(page, root_page):
        locators = [
            context.get_by_role("button", name="查询", exact=True),
            context.get_by_text("查询", exact=True),
            context.locator(text_xpath("查询", exact=True)),
            context.locator("button[title='查询'],[aria-label='查询']"),
        ]
        for locator in locators:
            try:
                if locator.count() and locator.first.is_visible(timeout=500):
                    if click_first_visible(locator, timeout=1500):
                        LOGGER.info("查询按钮已完成 DOM locator 点击：context=%s", getattr(context, "url", "page"))
                        return True
                    # 下拉层或 FineBI 自绘遮罩可能让普通 locator click 被拦截；
                    # 仍然只对已确认可见的语义按钮使用 force DOM click，禁止坐标点击。
                    target = locator.first
                    target.click(timeout=1500, force=True)
                    LOGGER.info("查询按钮已完成 force DOM locator 点击：context=%s", getattr(context, "url", "page"))
                    return True
            except Exception:
                continue
    return False


def visible_text_in_context(context, text: str, exact: bool = True) -> bool:
    return bool(context.evaluate(
        """
        ({ text, exact }) => {
          const norm = (s) => String(s || '').replace(/\\s+/g, '').trim();
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
          };
          const wanted = norm(text);
          return [...document.querySelectorAll('span,div,a,button,li,[role="treeitem"],[role="menuitem"]')]
            .filter(visible)
            .filter(el => {
              const value = norm(el.innerText || el.textContent);
              return exact ? value === wanted : value.includes(wanted);
            }).length > 0;
        }
        """,
        {"text": text, "exact": exact},
    ))


def visible_text_any_frame(page, text: str, exact: bool = True) -> bool:
    for frame in page.frames:
        try:
            if visible_text_in_context(frame, text, exact=exact):
                return True
        except Exception:
            continue
    return False


def click_text_in_context(context, text: str, exact: bool = True) -> bool:
    return bool(context.evaluate(
        """
        ({ text, exact }) => {
          const norm = (s) => String(s || '').replace(/\\s+/g, '').trim();
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
          };
          const fire = (el) => {
            for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
              el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            }
          };
          const wanted = norm(text);
          const candidates = [...document.querySelectorAll('span,div,a,button,li,[role="treeitem"],[role="menuitem"]')]
            .filter(visible)
            .filter(el => {
              const value = norm(el.innerText || el.textContent);
              return exact ? value === wanted : value.includes(wanted);
            })
            .sort((a, b) => {
              const ar = a.getBoundingClientRect();
              const br = b.getBoundingClientRect();
              return (ar.top - br.top) || (ar.left - br.left);
            });
          for (const el of candidates) {
            const clickable = el.closest('a,button,[role="button"],[role="treeitem"],[role="menuitem"],li') || el;
            if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true') continue;
            fire(clickable);
            return true;
          }
          return false;
        }
        """,
        {"text": text, "exact": exact},
    ))


def click_text_any_frame(page, text: str, exact: bool = True) -> bool:
    for frame in page.frames:
        try:
            if click_text_in_context(frame, text, exact=exact):
                return True
        except Exception:
            continue
    return False


def click_menu_item_in_context(context, text: str, final: bool = False) -> bool:
    return bool(context.evaluate(
        """
        ({ text, final }) => {
          const norm = (s) => String(s || '').replace(/\\s+/g, '').trim();
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
          };
          const fire = (el) => {
            if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
            try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
            for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
              el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            }
            return true;
          };
          const sameLineContainer = (el) => {
            const er = el.getBoundingClientRect();
            const boxes = [...document.querySelectorAll('[role="treeitem"],[role="menuitem"],li,div')]
              .filter(visible)
              .filter(node => {
                if (!node.contains(el)) return false;
                const r = node.getBoundingClientRect();
                return r.left <= er.left && r.right >= er.right && r.top <= er.top + 2 && r.bottom >= er.bottom - 2;
              })
              .sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (ar.width - br.width) || (br.left - ar.left);
              });
            return boxes[0] || el.parentElement || el;
          };
          const wanted = norm(text);
          const textEls = [...document.querySelectorAll('span,div,a,button,li,[role="treeitem"],[role="menuitem"]')]
            .filter(visible)
            .filter(el => norm(el.innerText || el.textContent) === wanted)
            .sort((a, b) => {
              const ar = a.getBoundingClientRect();
              const br = b.getBoundingClientRect();
              return (ar.top - br.top) || (ar.left - br.left);
            });

          for (const el of textEls) {
            const row = el.closest('[role="treeitem"],[role="menuitem"],li') || sameLineContainer(el);
            if (final) {
              return fire(el.closest('a,button,[role="button"],[role="treeitem"],[role="menuitem"],li') || row || el);
            }

            const ariaExpanded = row?.getAttribute?.('aria-expanded');
            if (ariaExpanded === 'true') return true;

            const er = el.getBoundingClientRect();
            const rowCandidates = row ? [...row.querySelectorAll('button,a,[role="button"],i,svg,span,div')] : [];
            const expanders = rowCandidates
              .filter(visible)
              .filter(node => {
                const r = node.getBoundingClientRect();
                const label = [
                  node.getAttribute('aria-label'),
                  node.getAttribute('title'),
                  node.getAttribute('class'),
                  node.innerText,
                  node.textContent
                ].map(v => String(v || '')).join(' ');
                const looksLikeExpander = /展开|折叠|expand|collapse|switcher|arrow|caret|triangle|folder|tree/i.test(label);
                const beforeText = r.left <= er.left && Math.abs((r.top + r.bottom) / 2 - (er.top + er.bottom) / 2) < Math.max(24, er.height);
                const notWholeLabel = norm(node.innerText || node.textContent) !== wanted;
                return beforeText && notWholeLabel && (looksLikeExpander || r.width <= 40);
              })
              .sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (br.left - ar.left);
              });

            for (const expander of expanders) {
              const clickable = expander.closest('button,a,[role="button"]') || expander;
              if (fire(clickable)) return true;
            }
            if (row && fire(row)) return true;
            if (fire(el)) return true;
          }
          return false;
        }
        """,
        {"text": text, "final": final},
    ))


def click_menu_item_any_frame(page, text: str, final: bool = False) -> bool:
    for frame in page.frames:
        try:
            if click_menu_item_in_context(frame, text, final=final):
                return True
        except Exception:
            continue
    return False


def click_first_visible(locator, timeout: int = 1200) -> bool:
    try:
        count = min(locator.count(), 8)
        for index in range(count):
            item = locator.nth(index)
            try:
                if item.is_visible(timeout=timeout):
                    item.click(timeout=timeout)
                    return True
            except Exception:
                continue
    except Exception:
        return False
    return False


def menu_text_visible_in_context(context, text: str, exact: bool = True) -> bool:
    try:
        return locator_has_visible(context.locator(text_xpath(text, exact=exact)), timeout=500)
    except Exception:
        return False


def menu_text_visible_any_frame(page, text: str, exact: bool = True) -> bool:
    for frame in page.frames:
        if menu_text_visible_in_context(frame, text, exact=exact):
            return True
    return False


def click_menu_item_locator_in_context(context, text: str, final: bool = False) -> bool:
    """使用 Playwright locator 执行真实 DOM 点击，避免 JS 伪点击不触发 FineBI 树控件。"""
    locators = [
        context.locator(text_xpath(text, exact=True)),
        context.get_by_text(text, exact=True),
    ]
    if final:
        locators.append(context.locator(text_xpath(text, exact=False)))

    for text_locator in locators:
        try:
            count = min(text_locator.count(), 8)
        except Exception:
            continue
        for index in range(count):
            label = text_locator.nth(index)
            try:
                if not label.is_visible(timeout=800):
                    continue
            except Exception:
                continue

            if final:
                targets = [
                    label.locator("xpath=ancestor-or-self::*[@role='treeitem' or @role='menuitem' or self::li or self::a or self::button][1]"),
                    label,
                ]
            else:
                row = label.locator(
                    "xpath=ancestor-or-self::*["
                    "@role='treeitem' or @role='menuitem' or self::li or "
                    "contains(@class,'tree') or contains(@class,'Tree') or contains(@class,'node') or contains(@class,'Node')"
                    "][1]"
                )
                expander_xpath = (
                    "xpath=.//*["
                    "contains(@aria-label,'展开') or contains(@title,'展开') or "
                    "contains(@class,'expand') or contains(@class,'Expand') or "
                    "contains(@class,'switcher') or contains(@class,'Switcher') or "
                    "contains(@class,'arrow') or contains(@class,'Arrow') or "
                    "contains(@class,'caret') or contains(@class,'Caret') or "
                    "contains(@class,'triangle') or contains(@class,'Triangle') or "
                    "self::i or self::svg"
                    "]"
                )
                targets = [
                    row.locator(expander_xpath),
                    row,
                    label,
                ]

            for target in targets:
                if click_first_visible(target):
                    return True
    return False


def click_menu_item_locator_any_frame(page, text: str, final: bool = False) -> bool:
    for frame in page.frames:
        try:
            if click_menu_item_locator_in_context(frame, text, final=final):
                return True
        except Exception:
            continue
    return False


def sidebar_menu_snapshot(page, limit: int = 800) -> str:
    chunks = []
    for idx, frame in enumerate(page.frames):
        try:
            text = frame.locator("body").inner_text(timeout=1000)
        except Exception:
            continue
        clean = re.sub(r"\s+", " ", text).strip()
        if clean:
            chunks.append(f"frame={idx} url={frame.url} text={clean[:limit]}")
    return "\n".join(chunks)


def body_contains_text(page, text: str) -> bool:
    for frame in page.frames:
        if text in context_text(frame):
            return True
    return False


def expand_sidebar_if_needed(page) -> bool:
    if any(body_contains_text(page, item) for item in REPORT_MENU_PATH):
        return True
    selectors = [
        "[aria-label*='展开'],[title*='展开'],[aria-label*='菜单'],[title*='菜单']",
        "[aria-label*='导航'],[title*='导航'],[aria-label*='目录'],[title*='目录']",
        "[class*='sidebar'] button,[class*='Sidebar'] button,[class*='menu'] button,[class*='Menu'] button",
    ]
    for frame in page.frames:
        for selector in selectors:
            if click_first_visible(frame.locator(selector), timeout=1000):
                return True
    return False


def open_report_from_menu(page) -> bool:
    if not AUTO_OPEN_REPORT_MENU:
        return False
    report_context, _ = find_report_context(page)
    if report_context:
        LOGGER.info("已在当前页面发现目标报表，跳过左侧菜单展开。")
        return True
    LOGGER.info("尝试通过左侧菜单进入：%s", " -> ".join(REPORT_MENU_PATH))
    expand_sidebar_if_needed(page)
    time.sleep(0.8)
    for index, item in enumerate(REPORT_MENU_PATH):
        is_final = index == len(REPORT_MENU_PATH) - 1
        next_item = None if is_final else REPORT_MENU_PATH[index + 1]
        clicked = False
        for attempt in range(1, 4):
            if click_menu_item_locator_any_frame(page, item, final=is_final):
                time.sleep(1.0)
                if is_final:
                    LOGGER.info("已点击报表菜单项：%s，等待报表加载", item)
                    report_context = wait_for_report_context(page, timeout_seconds=8)
                    if report_context:
                        LOGGER.info("已打开报表菜单项：%s", item)
                        return True
                    LOGGER.info("报表菜单项已点击，但筛选栏尚未出现（第%s次）", attempt)
                    continue
                if next_item and menu_text_visible_any_frame(page, next_item, exact=True):
                    LOGGER.info("已展开菜单项：%s，下一级已出现：%s", item, next_item)
                    clicked = True
                    break
                LOGGER.info("已尝试展开菜单项：%s，但尚未看到下一级：%s（第%s次）", item, next_item, attempt)
            expand_sidebar_if_needed(page)
            time.sleep(0.8)
        if not clicked:
            if next_item:
                LOGGER.warning("未能确认菜单项展开：%s；未看到下一级：%s", item, next_item)
                LOGGER.info("当前可见菜单/页面文本快照：\n%s", sidebar_menu_snapshot(page))
            else:
                LOGGER.warning("未找到或未能打开报表菜单项：%s", item)
                LOGGER.info("当前可见菜单/页面文本快照：\n%s", sidebar_menu_snapshot(page))
            return False
    return bool(wait_for_report_context(page, timeout_seconds=3))


def wait_for_report_context(page, timeout_seconds: float = 8):
    """等待真实报表 iframe 出现；菜单文字出现不等于报表已经打开。"""
    deadline = time.time() + max(0.5, float(timeout_seconds))
    while time.time() < deadline:
        report_context, _ = find_report_context(page)
        if report_context:
            return report_context
        time.sleep(0.4)
    return None


def wait_post_login_home_ready(page, timeout_seconds: float = 45) -> bool:
    """登录回跳后等待 FineBI 首页或目标报表真正完成初始化。"""
    deadline = time.time() + max(1.0, float(timeout_seconds))
    stable_menu_checks = 0
    while time.time() < deadline:
        report_context, _ = find_report_context(page)
        if report_context:
            return True
        if not page_is_login_route(page) and menu_text_visible_any_frame(page, REPORT_MENU_PATH[0], exact=True):
            stable_menu_checks += 1
            if stable_menu_checks >= 2:
                return True
        else:
            stable_menu_checks = 0
        time.sleep(0.5)
    return False


def open_historical_report_entry(page, timeout_seconds: float = 12):
    """通过历史实际报表入口打开报表，并以报表 DOM 而非导航调用判定成功。"""
    try:
        LOGGER.info("尝试通过历史报表入口进入用户聊天记录明细")
        page.goto(
            REPORT_ENTRY_URL,
            wait_until="domcontentloaded",
            timeout=PAGE_READY_TIMEOUT_MS,
        )
    except Exception as exc:
        LOGGER.warning("历史报表入口跳转失败：%s", exc)
        return None

    report_context = wait_for_report_context(page, timeout_seconds=timeout_seconds)
    if report_context:
        LOGGER.info("历史报表入口已出现可用筛选栏")
        return report_context
    LOGGER.warning("历史报表入口已访问，但未出现可用报表 DOM")
    return None


def open_report_with_retries(page, attempts: int = 3):
    """优先恢复历史入口；仅真实报表 DOM 出现后才视为打开成功。"""
    for attempt in range(1, max(1, int(attempts)) + 1):
        report_context, _ = find_report_context(page)
        if report_context:
            return report_context

        LOGGER.info("打开目标报表：第 %s/%s 轮", attempt, attempts)
        report_context = open_historical_report_entry(page)
        if report_context:
            return report_context

        if not wait_post_login_home_ready(page, timeout_seconds=45):
            LOGGER.warning("第 %s 轮等待 FineBI 首页/目录超时", attempt)
        if open_report_from_menu(page):
            report_context = wait_for_report_context(page, timeout_seconds=10)
            if report_context:
                return report_context

        LOGGER.warning("第 %s 轮未打开目标报表，准备重新进入 FineBI 目标地址", attempt)
        LOGGER.info("当前可见菜单/页面文本快照：\n%s", sidebar_menu_snapshot(page))
        if attempt < attempts:
            try:
                page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=PAGE_READY_TIMEOUT_MS)
            except Exception as exc:
                LOGGER.warning("重新进入 FineBI 目标地址失败：%s", exc)
            time.sleep(1.5)
    return None


def context_text(context, timeout: int = 2000) -> str:
    try:
        return context.locator("body").inner_text(timeout=timeout)
    except Exception:
        return ""


def page_has_login_text(page) -> bool:
    for frame in page.frames:
        body = context_text(frame)
        if "获取验证码" in body and "登录" in body:
            return True
    return False


def page_is_login_route(page) -> bool:
    """登录页有时只渲染 Loading，不能只依赖页面文字判断。"""
    for frame in page.frames:
        url = str(getattr(frame, "url", "") or "").lower()
        if "/login" in url or "login?" in url:
            return True
    return page_has_login_text(page)


def inspect_report_context(context) -> dict:
    try:
        return context.evaluate(
            """
            () => {
              const text = document.body.innerText || '';
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const st = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
              };
              const inputs = [...document.querySelectorAll('input,textarea')].filter(visible).length;
              const hasQuery = [...document.querySelectorAll('button,a,span,div')]
                .filter(visible)
                .some(el => String(el.innerText || el.textContent || '').trim() === '查询');
              const hasExport = [...document.querySelectorAll('button,a,span,div')]
                .filter(visible)
                .some(el => String(el.innerText || el.textContent || '').includes('数据导出'));
              return {
                ready: inputs > 0 && hasQuery && text.length > 20,
                inputs,
                hasQuery,
                hasExport,
                textLength: text.length,
                textSnippet: text.replace(/\\s+/g, ' ').slice(0, 180),
              };
            }
            """
        )
    except Exception as exc:
        return {"ready": False, "error": str(exc), "inputs": 0, "hasQuery": False, "hasExport": False, "textLength": 0, "textSnippet": ""}


def find_report_context(page):
    last_snapshot = []
    for idx, frame in enumerate(page.frames):
        info = inspect_report_context(frame)
        info["index"] = idx
        info["url"] = frame.url
        last_snapshot.append(info)
        if info.get("ready"):
            LOGGER.info("已定位报表 DOM：frame=%s，输入框=%s，查询按钮=%s，导出按钮=%s", idx, info.get("inputs"), info.get("hasQuery"), info.get("hasExport"))
            return frame, last_snapshot
    return None, last_snapshot


def format_frame_snapshot(snapshot) -> str:
    return "\n".join(
        f"frame={item.get('index')} inputs={item.get('inputs')} query={item.get('hasQuery')} "
        f"export={item.get('hasExport')} textLen={item.get('textLength')} url={item.get('url')} "
        f"error={item.get('error', '')} text={item.get('textSnippet')}"
        for item in snapshot
    )


def wait_page_ready(page):
    page.wait_for_load_state("domcontentloaded", timeout=PAGE_READY_TIMEOUT_MS)
    deadline = time.time() + PAGE_READY_TIMEOUT_MS / 1000
    last_snapshot = []
    while time.time() < deadline:
        if page_is_login_route(page):
            break
        report_context, last_snapshot = find_report_context(page)
        if report_context:
            return report_context
        time.sleep(0.5)

    if HEADLESS and page_is_login_route(page):
        raise LoginRequiredError("LOGIN_REQUIRED: FineBI 登录态失效，需要临时打开有头浏览器人工验证")

    if WAIT_FOR_MANUAL_LOGIN:
        LOGGER.warning("未检测到报表筛选栏。请先在弹出的浏览器完成登录/验证，并确认已进入数据决策系统首页或目标报表页，然后回到终端按回车继续。")
        LOGGER.info("当前页面探测结果：\n%s", format_frame_snapshot(last_snapshot))
        wait_for_manual_login_confirmation(page)
        # 扫码后的 SSO 回跳和 FineBI 左侧目录会分阶段渲染。先等待回跳，
        # 再重新进入固定目标地址，避免在只有“数据决策系统”标题时过早点菜单。
        # 线上 Xvfb 环境扫码回跳后，FineBI 目录实测可能在 30 秒后才出现。
        # 最多等待 60 秒，但目录一旦连续稳定出现便立即继续。
        wait_post_login_home_ready(page, timeout_seconds=60)
        if not page_is_login_route(page):
            try:
                page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=PAGE_READY_TIMEOUT_MS)
            except Exception as exc:
                LOGGER.warning("登录后重新进入 FineBI 目标地址失败，将在当前页面重试：%s", exc)
        report_context = open_report_with_retries(page, attempts=3)
        if report_context:
            LOGGER.info("已继续执行：登录/验证等待结束。")
            return report_context
        _, last_snapshot = find_report_context(page)
    else:
        report_context = open_report_with_retries(page, attempts=3)
        if report_context:
            return report_context
        _, last_snapshot = find_report_context(page)

    snapshot_text = format_frame_snapshot(last_snapshot)
    screenshot_error(page, "页面未就绪")
    raise RuntimeError(f"页面加载超时：30秒内未在主页面或 iframe 中找到筛选栏和「查询」按钮。\n{snapshot_text}")


def query_result_snapshot(page, root_page=None) -> dict:
    """跨 FineBI iframe/结果 frame 读取查询结果快照。"""
    contexts = export_contexts(page, root_page) if root_page is not None else [page]
    texts = []
    count_values = []
    table_rows = 0
    for context in contexts:
        try:
            text = context.locator("body").inner_text(timeout=1500)
        except Exception:
            text = ""
        clean = re.sub(r"\s+", " ", text).strip()
        if not clean:
            continue
        texts.append(clean)
        count_match = re.search(r"(?:共|数据量\s*[：:])\s*([\d,]+)", clean)
        if count_match:
            count_values.append(int(count_match.group(1).replace(",", "")))
        try:
            table_rows = max(table_rows, context.locator("table tr").count())
        except Exception:
            pass

    # FineBI 会把筛选栏、结果表格和分页工具栏拆到不同 iframe。不能在
    # 单个 frame 内同时寻找“数据量”和“数据导出”，否则页面明明已经有
    # 结果，resultSignals 仍会被错误判为 0。
    aggregate_text = " | ".join(texts)
    result_signals = int(
        "数据导出" in aggregate_text
        and ("数据量" in aggregate_text or "用户聊天记录明细" in aggregate_text)
    )
    return {
        "count": max(count_values) if count_values else None,
        "tableRows": table_rows,
        "resultSignals": result_signals,
        "textTail": aggregate_text[-5000:],
    }


def visible_loading_count(context) -> int:
    """只统计当前 DOM 上实际可见的加载层。

    FineBI 页面会长期保留隐藏的 mask/aria-busy 节点。直接用 locator.count()
    会把这些历史节点当成加载中，进而阻止后续“数据导出”点击。
    """
    try:
        return int(context.evaluate(
            """
            () => {
              const visible = (el) => {
                if (!el || el === document.body || el === document.documentElement) return false;
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return r.width > 0 && r.height > 0
                  && st.display !== 'none'
                  && st.visibility !== 'hidden'
                  && st.opacity !== '0';
              };
              const selector = [
                '[aria-busy="true"]',
                '[class*="loading"]',
                '[class*="Loading"]',
                '[class*="mask"]',
                '[class*="Mask"]'
              ].join(',');
              return [...document.querySelectorAll(selector)].filter(visible).length;
            }
            """
        ))
    except Exception:
        return 0


def wait_table_loaded(page, before: Optional[dict] = None, root_page=None) -> dict:
    """等待查询结果真正刷新，避免查询未执行就读取旧结果。"""
    started = time.time()
    deadline = started + QUERY_TIMEOUT_MS / 1000
    before = before or query_result_snapshot(page, root_page)
    saw_busy = False
    while time.time() < deadline:
        current = query_result_snapshot(page, root_page)
        body = current.get("textTail", "")
        busy = bool(re.search(r"加载中|正在加载|查询中", body))
        masks = 0
        for context in export_contexts(page, root_page) if root_page is not None else [page]:
            masks += visible_loading_count(context)
        saw_busy = saw_busy or busy or masks > 0
        changed = current != before

        elapsed = time.time() - started
        # 结果工具栏和数据量是跨 frame 汇总后的强信号。只要已经出现
        # “数据导出”且有数据量/表格行，即使 FineBI 仍保留隐藏 mask，也应
        # 立即进入导出阶段；否则会出现页面有 81 条数据但终端等待 60 秒。
        has_result = bool(
            current.get("resultSignals", 0) > 0
            and (current.get("count") is not None or current.get("tableRows", 0) > 1)
        )
        if has_result and not busy and elapsed >= 0.8:
            LOGGER.info(
                "查询结果 DOM 已确认：数据量=%s，表格行=%s，导出工具栏已出现；可进入数据导出",
                current.get("count"), current.get("tableRows"),
            )
            return current

        # 某些版本没有“数据量”字段，但查询后表格行数发生真实变化。
        # 仍要求没有可见加载层，避免把旧结果瞬间当成新结果。
        if not busy and masks == 0 and changed and (saw_busy or elapsed >= 0.8):
            return current
        time.sleep(0.25)
    after = query_result_snapshot(page, root_page)
    raise RuntimeError(f"查询结果区域未刷新，可能未执行查询：before={before}; after={after}")


def read_total_count(page, root_page=None) -> int:
    contexts = export_contexts(page, root_page) if root_page is not None else [page]
    patterns = [
        r"共\s*([\d,]+)\s*条",
        r"总计\s*([\d,]+)\s*条",
        r"合计\s*([\d,]+)\s*条",
        r"数据量\s*[：:]?\s*([\d,]+)",
    ]
    values = []
    for context in contexts:
        try:
            text = context.locator("body").inner_text(timeout=2000)
        except Exception:
            continue
        for pattern in patterns:
            match = re.search(pattern, text)
            if match:
                values.append(int(match.group(1).replace(",", "")))
    return max(values) if values else 0


def export_contexts(preferred_context, root_page=None):
    """返回导出按钮可能所在的 DOM 上下文，并去重。

    FineBI 的报表内容通常在报表 iframe 中，但结果分页工具栏在不同版本
    可能由外层 frame 或主页面 overlay 承载。因此这里统一扫描所有页面
    frame，仍然只使用 DOM locator/evaluate，不使用坐标。
    """
    contexts = []
    for context in [preferred_context, root_page]:
        if context is not None and all(context is not item for item in contexts):
            contexts.append(context)
    if root_page is not None:
        for frame in root_page.frames:
            if all(frame is not item for item in contexts):
                contexts.append(frame)
    return contexts


def mark_export_target(context, download_name: Optional[str] = None) -> int:
    """在当前 DOM 上下文标记所有真实可见的“数据导出”候选。"""
    try:
        return int(context.evaluate(
            """
            ({ downloadName }) => {
              const norm = (s) => String(s || '')
                .replace(/[\\s\\u00a0\\u200b]+/g, '')
                .trim();
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return r.width > 0 && r.height > 0
                  && st.display !== 'none'
                  && st.visibility !== 'hidden'
                  && st.opacity !== '0';
              };
              const textOf = (el) => norm(el.innerText || el.textContent || '');
              const attrsOf = (el) => norm([
                el.getAttribute('title'),
                el.getAttribute('aria-label'),
                el.getAttribute('data-title'),
                el.getAttribute('data-tooltip')
              ].filter(Boolean).join(' '));
              document.querySelectorAll('[data-finebi-export-target]')
                .forEach(el => el.removeAttribute('data-finebi-export-target'));

              const raw = [...document.querySelectorAll(
                'button,a,span,div,td,li,[role="button"],[role="link"],'
                + '[title],[aria-label],[data-title],[data-tooltip]'
              )].filter(visible);
              const exact = raw.filter(el => textOf(el) === '数据导出' || attrsOf(el) === '数据导出');
              const related = raw.filter(el => `${textOf(el)}${attrsOf(el)}`.includes('数据导出'));
              const source = exact.length ? exact : related;
              if (!source.length) return 0;

              // 以最小文字节点为锚点，只保留它的真实可点击祖先、事件祖先和
              // 文字节点本身。FineBI 某些版本使用事件委托，父节点没有
              // onclick/role/tabindex 属性，因此还要识别 cursor:pointer、
              // export/button/link 等语义祖先，不能只点击文字节点。
              source.sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (ar.width * ar.height) - (br.width * br.height);
              });
              const node = source[0];
              const candidates = [];
              const add = (el, kind) => {
                if (!el || !visible(el) || candidates.some(item => item.el === el)) return;
                candidates.push({ el, kind });
              };
              const native = node.closest('button,a,[role="button"],[role="link"]');
              if (native && visible(native)) add(native, 'native');
              let parent = node.parentElement;
              const nodeRect = node.getBoundingClientRect();
              for (let i = 0; parent && i < 8; i += 1, parent = parent.parentElement) {
                const rect = parent.getBoundingClientRect();
                const style = getComputedStyle(parent);
                const parentText = textOf(parent);
                const hasHandler = typeof parent.onclick === 'function'
                  || parent.hasAttribute('onclick')
                  || parent.getAttribute('role') === 'button'
                  || parent.getAttribute('role') === 'link'
                  || parent.hasAttribute('tabindex');
                const semanticParent = /export|导出|button|btn|link|toolbar/i.test([
                  parent.className,
                  parent.getAttribute('aria-label'),
                  parent.getAttribute('title'),
                  parent.getAttribute('data-title'),
                  parent.getAttribute('data-tooltip')
                ].map(value => String(value || '')).join(' '));
                const delegatedClick = style.cursor === 'pointer';
                const reasonableSize = rect.width <= Math.max(900, nodeRect.width * 180)
                  && rect.height <= Math.max(260, nodeRect.height * 80)
                  && parentText.length <= 180;
                if (reasonableSize && (hasHandler || semanticParent || delegatedClick)) {
                  add(parent, hasHandler ? 'handler' : 'semantic-parent');
                }
              }
              add(node, 'text');
              candidates.forEach((item, index) => {
                const target = item.el;
                target.setAttribute('data-finebi-export-target', String(index));
                target.setAttribute('data-finebi-export-kind', item.kind);
                if (downloadName) {
                  const anchor = target.matches('a') ? target : target.closest('a');
                  if (anchor && anchor.getAttribute('href')) {
                    // FineBI 某些版本没有返回 Content-Disposition 文件名，
                    // 让同源下载链接优先使用当前关键词目标名。
                    anchor.setAttribute('download', downloadName);
                    anchor.setAttribute('data-finebi-download-name', downloadName);
                  }
                }
              });
              return candidates.length;
            }
            """,
            {"downloadName": download_name or ""},
        ))
    except Exception:
        return 0


def export_options_visible(context) -> bool:
    """判断导出按钮点击后是否出现 Excel 格式选项。"""
    try:
        return bool(context.evaluate(
            """
            () => {
              const norm = (s) => String(s || '').replace(/[\\s\\u00a0\\u200b]+/g, '').trim();
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return r.width > 0 && r.height > 0
                  && st.display !== 'none' && st.visibility !== 'hidden';
              };
              return [...document.querySelectorAll(
                '[role="dialog"],[role="menu"],[role="listbox"],div,span,label,button'
              )].some(el => visible(el) && ['Excel', 'xlsx', 'XLSX'].includes(norm(el.innerText || el.textContent)));
            }
            """
        ))
    except Exception:
        return False


def export_options_visible_any(root_page, preferred_context) -> bool:
    return any(
        export_options_visible(context)
        for context in export_contexts(preferred_context, root_page)
    )


def click_data_export(page, root_page=None, download_probe=None, download_name: Optional[str] = None) -> bool:
    # 查询结果和分页工具栏是异步渲染的。按 DOM 条件轮询，不固定 sleep；
    # 结果工具栏一出现就立即执行一次真实 locator 点击。
    deadline = time.time() + RESULT_CONTENT_TIMEOUT_MS / 1000
    logged_wait = False
    found_candidate = False
    while time.time() < deadline:
        for context in export_contexts(page, root_page):
            candidate_count = mark_export_target(context, download_name)
            if candidate_count:
                found_candidate = True
                targets = context.locator("[data-finebi-export-target]")
                for index in range(min(candidate_count, 12)):
                    target = targets.nth(index)
                    try:
                        if not target.is_visible(timeout=500):
                            continue
                        target.click(timeout=2000)
                        LOGGER.info(
                            "数据导出候选已执行 DOM locator 点击：context=%s，候选=%s/%s，kind=%s",
                            getattr(context, "url", "page"), index + 1, candidate_count,
                            target.get_attribute("data-finebi-export-kind") or "unknown",
                        )
                        response_deadline = time.time() + 2.5
                        while time.time() < response_deadline:
                            if download_probe and download_probe():
                                LOGGER.info("数据导出点击已收到下载事件")
                                return True
                            if export_options_visible_any(root_page or context, context):
                                LOGGER.info("数据导出点击已打开 Excel 导出选项")
                                return True
                            (root_page or context).wait_for_timeout(120)
                        # FineBI 有时节点可见但被透明层拦截，正常 click 没有
                        # 到达事件处理器。只对同一个语义候选做一次 force DOM
                        # locator 点击，不重新扫描或盲点其他页面节点。
                        target.click(timeout=2000, force=True)
                        LOGGER.info("数据导出候选已执行 force DOM locator 点击：候选=%s/%s", index + 1, candidate_count)
                        response_deadline = time.time() + 3.0
                        while time.time() < response_deadline:
                            if download_probe and download_probe():
                                LOGGER.info("数据导出 force 点击已收到下载事件")
                                return True
                            if export_options_visible_any(root_page or context, context):
                                LOGGER.info("数据导出 force 点击已打开 Excel 导出选项")
                                return True
                            (root_page or context).wait_for_timeout(120)
                        LOGGER.warning("该导出候选点击后未出现下载事件或 Excel 选项，继续尝试其他 DOM 候选")
                    except Exception as exc:
                        LOGGER.warning(
                            "数据导出候选 DOM locator 点击异常：context=%s，候选=%s/%s，错误=%s",
                            getattr(context, "url", "page"), index + 1, candidate_count, str(exc)[:180],
                        )
                        continue
                # 当前上下文可能只是外层 access iframe：它能看到“数据导出”
                # 文本，但没有真正绑定 FineBI 导出事件。先继续执行下面的
                # 备用语义 locator，再进入下一个 frame，不能在这里提前返回。
                LOGGER.warning(
                    "当前 DOM 上下文的导出候选均无响应：context=%s，候选数=%s；继续扫描其他上下文",
                    getattr(context, "url", "page"), candidate_count,
                )

            locators = [
                context.get_by_role("button", name=re.compile("数据导出")),
                context.get_by_text("数据导出", exact=True),
                context.locator("[title*='数据导出'],[aria-label*='数据导出'],[data-title*='数据导出'],[data-tooltip*='数据导出']"),
            ]
            for locator in locators:
                try:
                    if locator.count() and locator.first.is_visible(timeout=400):
                        if click_first_visible(locator, timeout=1200):
                            if download_probe and download_probe():
                                return True
                            if export_options_visible_any(root_page or context, context):
                                LOGGER.info("数据导出按钮已通过备用 UI locator 点击并打开导出选项")
                                return True
                except Exception:
                    continue
        if not logged_wait:
            LOGGER.info("查询结果已返回，等待下方结果区/数据导出按钮 DOM 就绪，非固定等待，最长保护%s秒", RESULT_CONTENT_TIMEOUT_MS // 1000)
            logged_wait = True
        page.wait_for_timeout(300)
    if found_candidate:
        LOGGER.error("已找到“数据导出”文本，但所有 DOM 上下文候选均未产生下载/导出选项；已扫描%s个上下文", len(export_contexts(page, root_page)))
    else:
        LOGGER.error("结果区已返回，但所有 DOM 上下文均未找到可点击的“数据导出”节点；已扫描%s个上下文", len(export_contexts(page, root_page)))
    return False


def refresh_report_context(root_page, fallback_context):
    """结果区刷新后重新取得报表 frame，避免继续使用已被 FineBI 替换的 frame。"""
    try:
        fresh, _ = find_report_context(root_page)
        if fresh is not None:
            return fresh
    except Exception:
        pass
    return fallback_context


def select_excel_and_confirm(page, root_page=None) -> bool:
    for context in export_contexts(page, root_page):
        excel_locators = [
            context.get_by_text(re.compile("Excel|xlsx|XLSX")),
            context.locator("label:has-text('Excel'),[aria-label*='Excel'],[title*='Excel']"),
        ]
        excel_clicked = False
        for locator in excel_locators:
            if click_first_visible(locator, timeout=1200):
                excel_clicked = True
                break
        if not excel_clicked:
            continue

        for text in ("确定", "确认", "导出", "下载"):
            locators = [
                context.get_by_role("button", name=text, exact=True),
                context.get_by_text(text, exact=True),
                context.locator(text_xpath(text, exact=True)),
            ]
            for locator in locators:
                if click_first_visible(locator, timeout=1200):
                    return True
    return False


# =========================
# 导出与汇总逻辑
# =========================

def export_keyword(report_context, root_page, keyword: str, date_value: str, output_dir: Path, role_verified: bool = False) -> Path:
    verify_global_filters(report_context, date_value, root_page, role_verified=role_verified)
    LOGGER.info("关键词 [%s]：填写关键词", keyword)
    if not set_keyword_value(report_context, keyword, root_page):
        raise RuntimeError("未能通过「关键词」标签或占位文本定位输入框")
    # 关键词已由 locator 读取回当前真实 value。只有读取失败时才重新发现
    # frame/控件，避免每个关键词填充后都等待一次 FineBI 重绘。
    state = get_filter_state(report_context)
    keyword_state = str(state.get("keywordValue") or "").strip()
    if keyword_state != keyword:
        report_context = refresh_report_context(root_page, report_context)
        discover_filter_controls(report_context)
        state = get_filter_state(report_context)
        if str(state.get("keywordValue") or state.get("keywordTitle") or "").strip() != keyword:
            raise RuntimeError(f"关键词写入验证失败：{format_filter_state(state)}")
    LOGGER.info("关键词 [%s]：关键词输入成功", keyword)
    log_filter_snapshot(report_context, f"关键词 [{keyword}] 查询前筛选快照")

    LOGGER.info("关键词 [%s]：点击查询", keyword)
    close_role_dropdown_if_open(report_context, root_page)
    before_result = query_result_snapshot(report_context, root_page)
    if not click_query_button(report_context, root_page):
        raise RuntimeError("关键词已写入，但未找到或未能完成「查询」按钮 DOM 点击")
    after_result = wait_table_loaded(report_context, before_result, root_page)
    report_context = refresh_report_context(root_page, report_context)
    LOGGER.info("关键词 [%s]：查询结果已刷新，数据量状态=%s，表格行=%s", keyword, after_result.get("count"), after_result.get("tableRows"))
    count = read_total_count(report_context, root_page)
    LOGGER.info("关键词 [%s]：查询结果约 %s 条", keyword, count)
    if count > WARN_ROW_LIMIT:
        LOGGER.warning("关键词 [%s]：数据量超过 %s 条，仍继续导出", keyword, WARN_ROW_LIMIT)

    LOGGER.info("关键词 [%s]：点击数据导出", keyword)
    target_path = output_dir / f"{safe_filename_part(keyword)}_{date_value}.xlsx"
    download_events = []

    def observe_download(download):
        download_events.append(download)

    root_page.on("download", observe_download)
    try:
        try:
            LOGGER.info("关键词 [%s]：等待 DOM/UI 导出按钮出现并点击，随后等待下载事件", keyword)
            with root_page.expect_download(timeout=DOWNLOAD_TRIGGER_TIMEOUT_MS) as download_info:
                clicked = click_data_export(
                    report_context,
                    root_page,
                    download_probe=lambda: bool(download_events),
                    download_name=target_path.name,
                )
                if not clicked:
                    LOGGER.warning("关键词 [%s]：导出文本候选未产生可验证响应，改用 UI 语义 locator 查找 Excel 选项", keyword)
                    if not select_excel_and_confirm(report_context, root_page):
                        raise RuntimeError("查询结果已返回，但数据导出 DOM/UI 点击未产生响应")
            download = download_info.value
            LOGGER.info("关键词 [%s]：已收到下载事件", keyword)
        except PlaywrightTimeoutError:
            LOGGER.info("关键词 [%s]：点击后未收到直接下载事件，检查 Excel 导出弹窗", keyword)
            with root_page.expect_download(timeout=DOWNLOAD_TIMEOUT_MS) as download_info:
                if not select_excel_and_confirm(report_context, root_page):
                    raise RuntimeError("已点击数据导出，但未收到下载事件，且未找到 Excel/确认按钮")
                LOGGER.info("关键词 [%s]：Excel 导出选项已通过 DOM/UI locator 点击，等待下载事件", keyword)
            download = download_info.value
    finally:
        root_page.remove_listener("download", observe_download)

    failure = download.failure()
    if failure:
        raise RuntimeError(f"下载事件已收到，但浏览器报告下载失败：{failure}")

    suggested_name = ""
    try:
        suggested_name = str(download.suggested_filename or "")
    except Exception:
        suggested_name = ""
    try:
        temporary_path = Path(download.path())
        temporary_size = temporary_path.stat().st_size if temporary_path.exists() else 0
    except Exception:
        temporary_path = None
        temporary_size = 0
    LOGGER.info(
        "关键词 [%s]：下载事件来源文件名=%s，临时文件大小=%s字节；将保存为目标 XLSX 文件",
        keyword,
        suggested_name or "(服务器未提供文件名，通常为UUID)",
        temporary_size,
    )

    # 不直接把浏览器临时 UUID 文件移动为最终产物。save_as 会按目标路径
    # 复制完整下载内容，避免 Chrome 下载列表中的无扩展名临时名污染输出目录。
    if target_path.exists():
        target_path.unlink()
    download.save_as(str(target_path))
    if not target_path.exists() or target_path.stat().st_size == 0:
        raise RuntimeError(f"下载文件保存后校验失败：{target_path}")

    workbook_state = validate_and_repair_xlsx(target_path, keyword)
    LOGGER.info(
        "关键词 [%s]：XLSX校验通过，实际工作表行=%s、列=%s、修正范围=%s、表头=%s",
        keyword,
        workbook_state["rows"],
        workbook_state["columns"],
        workbook_state["repairedDimension"],
        "、".join(workbook_state["headers"][:6]),
    )
    LOGGER.info("关键词 [%s]：导出完成 %s", keyword, target_path)
    return target_path


def _source_column_map(df: pd.DataFrame) -> dict:
    """建立去空格、忽略大小写的原始导出表头映射。"""
    return {_normal_header(column): column for column in df.columns}


def _source_value(row, columns: dict, *names):
    for name in names:
        column = columns.get(_normal_header(name))
        if column is not None:
            return row.get(column)
    return ""


def _excel_date(value):
    if value is None or str(value).strip().lower() in {"", "nan", "nat", "none"}:
        return None
    try:
        parsed = pd.to_datetime(value, errors="coerce")
        if pd.notna(parsed):
            return parsed.to_pydatetime()
    except Exception:
        pass
    return value


def _date_key(value) -> str:
    """将下载表中的日期或时间统一为 YYYYMMDD，用于剔除跨批次数据。"""
    if value is None or str(value).strip().lower() in {"", "nan", "nat", "none"}:
        return ""
    if isinstance(value, (datetime, pd.Timestamp)):
        return value.strftime("%Y%m%d")
    text = str(value).strip()
    compact = re.sub(r"\D", "", text)
    if len(compact) >= 8:
        candidate = compact[:8]
        try:
            datetime.strptime(candidate, "%Y%m%d")
            return candidate
        except ValueError:
            pass
    parsed = pd.to_datetime(value, errors="coerce")
    return parsed.strftime("%Y%m%d") if pd.notna(parsed) else ""


def _validate_download_row(row, columns: dict, keyword: str, date_value: str) -> Tuple[bool, str, dict]:
    """验证下载行是否属于当前关键词、日期和线上文档的数据范围。"""
    user_id = _clean_user_id(_source_value(row, columns, "用户ID", "用户id"))
    if not re.fullmatch(r"\d{4,}", user_id):
        return False, "用户ID无效", {}

    role = str(_source_value(row, columns, "聊天发送人角色") or "").strip()
    if role != "学员":
        return False, "非学员消息", {}

    message = str(_source_value(row, columns, "消息内容") or "").strip()
    if not message:
        return False, "消息内容为空", {}
    if keyword not in message:
        return False, "消息未命中所属关键词", {}

    raw_data_date = _source_value(row, columns, "数据日期分区", "数据日期")
    raw_send_time = _source_value(row, columns, "发送时间")
    row_date = _date_key(raw_data_date) or _date_key(raw_send_time)
    if row_date != date_value:
        return False, "数据日期不属于本批次", {}

    return True, "", {
        "user_id": user_id,
        "role": role,
        "message": message,
        # 线上文档的数据日期固定显示为 8 位 YYYYMMDD。使用文本
        # 可避免继承历史模板的日期时间格式后变成带时分秒的值。
        "data_date": row_date,
        "send_time": _excel_date(raw_send_time),
    }


def _download_files_for_date(output_dir: Path, date_value: str) -> list[Path]:
    """只收集关键词导出的原始文件，排除锁文件和历史汇总文件。"""
    expected_keywords = set(KEYWORDS)
    files = []
    for path in sorted(output_dir.glob(f"*_{date_value}.xlsx")):
        if path.name.startswith(".~"):
            continue
        keyword = path.stem.rsplit("_", 1)[0]
        if keyword in expected_keywords:
            files.append(path)
    order = {keyword: index for index, keyword in enumerate(KEYWORDS)}
    return sorted(files, key=lambda path: (order.get(path.stem.rsplit("_", 1)[0], 999), path.name))


def merge_downloads_to_template(
    source_files,
    date_value: str,
    output_dir: Path,
    template_path: Path,
    sheet_name: str = TEMPLATE_SHEET,
) -> Path:
    """按敏感词表模板合并 FineBI 文件，并仅按用户ID去重。

    下载表只提供原始聊天字段，因此 Q/R/S、分类、风险和总结等后续处理列
    保持空白，避免把原始商品字段误当成“实际”字段。输出只保留模板 A:AI，
    删除模板中多出来的 AJ 以后列。
    """
    try:
        from openpyxl import load_workbook
    except ImportError as exc:
        raise RuntimeError(
            "合并需要 openpyxl，请先执行：python3 -m pip install openpyxl"
        ) from exc

    template_path = Path(template_path).expanduser()
    if not template_path.exists():
        raise RuntimeError(f"找不到敏感词表模板：{template_path}")
    if not source_files:
        raise RuntimeError("没有可合并的关键词导出文件")

    # 先严格清洗，再按用户ID去重，保留关键词文件顺序和每个文件的原始行顺序。
    deduped_rows = []
    seen_keys = set()
    total_source_rows = 0
    total_filtered_rows = 0
    filtered_reasons = {}
    for file in source_files:
        file = Path(file)
        keyword = file.stem.rsplit("_", 1)[0]
        if keyword not in set(KEYWORDS):
            LOGGER.warning("跳过非关键词导出文件：%s", file.name)
            continue
        try:
            frame = pd.read_excel(file, sheet_name=0, dtype=str)
        except ImportError as exc:
            raise RuntimeError(
                "读取 Excel 需要 openpyxl，请先执行：python3 -m pip install openpyxl"
            ) from exc
        frame.columns = [str(column).strip() for column in frame.columns]
        columns = _source_column_map(frame)
        if _normal_header("用户ID") not in columns:
            raise RuntimeError(f"{file.name} 缺少「用户ID」列，实际表头：{list(frame.columns)}")

        file_rows = 0
        file_filtered = 0
        file_reasons = {}
        for _, row in frame.iterrows():
            total_source_rows += 1
            valid, reason, validated = _validate_download_row(row, columns, keyword, date_value)
            if not valid:
                file_filtered += 1
                total_filtered_rows += 1
                file_reasons[reason] = file_reasons.get(reason, 0) + 1
                filtered_reasons[reason] = filtered_reasons.get(reason, 0) + 1
                continue
            user_id = validated["user_id"]
            dedup_key = user_id
            if dedup_key in seen_keys:
                file_filtered += 1
                total_filtered_rows += 1
                file_reasons["用户ID重复"] = file_reasons.get("用户ID重复", 0) + 1
                filtered_reasons["用户ID重复"] = filtered_reasons.get("用户ID重复", 0) + 1
                continue
            seen_keys.add(dedup_key)
            deduped_rows.append({
                "keyword": keyword,
                "user_id": user_id,
                "data_date": validated["data_date"],
                "role": validated["role"],
                "user_name": _source_value(row, columns, "聊天发送人用户名称", "聊天发送人企微用户名称"),
                "sender_wechat_name": _source_value(row, columns, "聊天发送人企微用户名称", "聊天发送人用户名称"),
                "teacher_id": _clean_user_id(_source_value(row, columns, "聊天接收人用户id", "聊天接收人用户ID")),
                "teacher_name": _source_value(row, columns, "聊天接收人企微用户名称", "聊天接收人用户名称"),
                "receiver_name": _source_value(row, columns, "聊天接收人用户名称", "聊天接收人企微用户名称"),
                "send_time": validated["send_time"],
                "message": validated["message"],
                "message_type": _source_value(row, columns, "消息内容类型"),
                "product_type": _source_value(row, columns, "商品类型"),
                "camp_name": _source_value(row, columns, "训练营名称"),
                "period_name": _source_value(row, columns, "期数名称"),
            })
            file_rows += 1
        reason_text = "、".join(f"{name}={count}" for name, count in sorted(file_reasons.items())) or "无"
        LOGGER.info(
            "合并读取：%s，原始行=%s，保留=%s，删除=%s（%s）",
            file.name,
            len(frame),
            file_rows,
            file_filtered,
            reason_text,
        )

    if not deduped_rows:
        raise RuntimeError("关键词文件均无有效用户ID，未生成合并文件")

    # 复制模板而不是新建空表，保留原表的列宽、冻结、边框和整体格式。
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{MERGE_OUTPUT_PREFIX}_{date_value}.xlsx"
    if output_path.exists():
        output_path.unlink()
    shutil.copy2(template_path, output_path)
    workbook = load_workbook(output_path)
    if sheet_name not in workbook.sheetnames:
        workbook.close()
        raise RuntimeError(f"模板中找不到工作表：{sheet_name}；已有工作表：{workbook.sheetnames}")
    worksheet = workbook[sheet_name]

    # 固定为线上文档的标题和原始字段布局，避免历史模板表头差异传入新文件。
    worksheet.cell(1, 1).value = ONLINE_DOCUMENT_TITLE
    for column, header in enumerate(ONLINE_SOURCE_HEADERS, start=1):
        worksheet.cell(2, column).value = header

    # 保存模板第3行样式，清除旧数据后复制到新数据行。
    style_row = {
        column: copy(worksheet.cell(3, column)._style)
        for column in range(1, min(worksheet.max_column, 35) + 1)
    }
    row_height = worksheet.row_dimensions[3].height
    if worksheet.max_row >= 3:
        worksheet.delete_rows(3, worksheet.max_row - 2)
    if worksheet.max_column > 35:
        worksheet.delete_cols(36, worksheet.max_column - 35)

    # 合并表按业务查看习惯展示老师企微名称(H)，隐藏重复的接收人用户名称(I)。
    worksheet.column_dimensions["H"].hidden = False
    worksheet.column_dimensions["I"].hidden = True

    export_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    # 识别阶段的最终字段固定为 AH=总体问题总结、AI=老师处理进展。
    # AJ/AK 不再作为输出列，避免历史版本字段重复或错位。
    worksheet.cell(2, 34).value = "问题总结"
    worksheet.cell(2, 35).value = "老师处理进展"
    for index, item in enumerate(deduped_rows, start=1):
        values = {
            1: index,
            2: item["data_date"],
            3: item["role"],
            4: item["user_id"],
            5: item["user_name"],
            6: item["sender_wechat_name"],
            7: item["teacher_id"],
            8: item["teacher_name"],
            9: item["receiver_name"],
            10: item["send_time"],
            11: item["message"],
            12: item["product_type"],
            13: item["camp_name"],
            14: item["period_name"],
            16: export_date,
        }
        for column in range(1, 36):
            cell = worksheet.cell(index + 2, column)
            if column in style_row:
                cell._style = copy(style_row[column])
            cell.value = values.get(column, "")
        worksheet.cell(index + 2, 2).number_format = "@"
        if row_height is not None:
            worksheet.row_dimensions[index + 2].height = row_height

    worksheet.auto_filter.ref = f"A2:AI{len(deduped_rows) + 2}"
    workbook.save(output_path)
    workbook.close()

    # 保存后重新打开审计，拦截模板旧行、表头错位或清洗失效。
    verification = load_workbook(output_path, read_only=True, data_only=False)
    try:
        verified_sheet = verification[sheet_name]
        actual_headers = [verified_sheet.cell(2, column).value for column in range(1, 15)]
        if actual_headers != ONLINE_SOURCE_HEADERS:
            raise RuntimeError(
                f"合并结果表头与线上文档不一致：{actual_headers}"
            )
        expected_last_row = len(deduped_rows) + 2
        if verified_sheet.max_row != expected_last_row:
            raise RuntimeError(
                f"合并结果仍有多余行：期望{expected_last_row}行，实际{verified_sheet.max_row}行"
            )
        verified_user_ids = []
        for row_number in range(3, expected_last_row + 1):
            role = str(verified_sheet.cell(row_number, 3).value or "").strip()
            user_id = _clean_user_id(verified_sheet.cell(row_number, 4).value)
            message = str(verified_sheet.cell(row_number, 11).value or "").strip()
            row_date = str(verified_sheet.cell(row_number, 2).value or "").strip()
            if role != "学员" or not user_id or not message or row_date != date_value:
                raise RuntimeError(f"合并结果第{row_number}行不符合线上文档数据规则")
            if not any(keyword in message for keyword in KEYWORDS):
                raise RuntimeError(f"合并结果第{row_number}行消息未命中固定关键词")
            verified_user_ids.append(user_id)
        if len(verified_user_ids) != len(set(verified_user_ids)):
            raise RuntimeError("合并结果仍存在重复用户ID")
    finally:
        verification.close()
    reason_text = "、".join(f"{name}={count}" for name, count in sorted(filtered_reasons.items())) or "无"
    LOGGER.info(
        "模板合并完成：文件=%s，原始文件=%s，原始行=%s，删除行=%s（%s），最终用户数=%s，去重键=用户ID，保留列=A:AI",
        output_path,
        len(source_files),
        total_source_rows,
        total_filtered_rows,
        reason_text,
        len(deduped_rows),
    )
    return output_path


def merge_excels(
    generated_files,
    date_value: str,
    output_dir: Path,
    template_override: Optional[str] = None,
    sheet_override: Optional[str] = None,
) -> Path:
    LOGGER.info("开始汇总本次导出的 Excel 文件")
    template_path = Path(template_override or TEMPLATE_WORKBOOK).expanduser()
    sheet_name = sheet_override or TEMPLATE_SHEET
    if template_path.exists():
        return merge_downloads_to_template(
            generated_files,
            date_value,
            output_dir,
            template_path,
            sheet_name,
        )

    LOGGER.warning("未找到模板%s，回退为普通字段合并", template_path)
    frames = []
    expected = {str(Path(file).resolve()) for file in generated_files}
    pattern = str(output_dir / f"*_{date_value}.xlsx")
    files = [Path(p) for p in glob.glob(pattern) if str(Path(p).resolve()) in expected]

    for file in files:
        keyword = file.stem.rsplit("_", 1)[0]
        df = pd.read_excel(file, sheet_name=0, dtype=str)
        df.columns = [str(col).strip() for col in df.columns]
        df.insert(0, "搜索关键词", keyword)
        frames.append(df)
        LOGGER.info("已读取：%s，行数：%s", file.name, len(df))

    if not frames:
        raise RuntimeError("没有可汇总的 Excel 文件")

    merged = pd.concat(frames, ignore_index=True, sort=False)
    merged.columns = [str(col).strip() for col in merged.columns]
    if "用户ID" not in merged.columns:
        raise RuntimeError("汇总失败：原始表中未找到「用户ID」列")

    before = len(merged)
    merged = merged.drop_duplicates(subset=DEDUP_KEYS, keep="first")
    after = len(merged)
    LOGGER.info("去重完成：原 %s 行，去重后 %s 行", before, after)

    output_path = output_dir / f"聊天记录汇总_{date_value}.xlsx"
    merged.to_excel(output_path, index=False)
    LOGGER.info("汇总文件已保存：%s", output_path)

    if not KEEP_RAW_FILES:
        for file in files:
            file.unlink(missing_ok=True)
        LOGGER.info("已按配置删除原始单关键词文件")

    return output_path


# =========================
# 主流程
# =========================

def _option_value(name: str, default: Optional[str] = None) -> Optional[str]:
    """读取简单的 --name value 参数，避免为合并模式引入额外依赖。"""
    try:
        index = sys.argv.index(name)
    except ValueError:
        return default
    if index + 1 >= len(sys.argv) or sys.argv[index + 1].startswith("--"):
        return default
    return sys.argv[index + 1]


def run_merge_only() -> None:
    """只合并已经下载的文件，不启动浏览器、不访问 FineBI。"""
    date_value = _option_value("--date", data_date())
    if not re.fullmatch(r"\d{8}", str(date_value)):
        raise RuntimeError(f"--date 必须是 YYYYMMDD，例如 20260709，当前值：{date_value}")
    output_dir = Path(_option_value("--output-dir", OUTPUT_DIR)).expanduser()
    template_path = Path(_option_value("--template", TEMPLATE_WORKBOOK)).expanduser()
    files = _download_files_for_date(output_dir, str(date_value))
    LOGGER.info("合并模式：不启动浏览器，只处理已下载文件")
    LOGGER.info("合并日期：%s；候选文件：%s", date_value, "、".join(file.name for file in files) or "无")
    output_path = merge_downloads_to_template(
        files,
        str(date_value),
        output_dir,
        template_path,
        _option_value("--sheet", TEMPLATE_SHEET) or TEMPLATE_SHEET,
    )
    LOGGER.info("可直接打开的模板格式合并文件：%s", output_path)

def run() -> None:
    global HEADLESS
    if "--headful" in sys.argv:
        HEADLESS = False
    elif "--headless" in sys.argv:
        HEADLESS = True
    if sync_playwright is None:
        raise RuntimeError(
            "运行浏览器导出需要 playwright，请先执行：python3 -m pip install playwright && python3 -m playwright install chromium"
        )
    ensure_excel_merge_dependency()
    date_value = _option_value("--date", data_date())
    if not re.fullmatch(r"\d{8}", str(date_value)):
        raise RuntimeError(f"--date 必须是 YYYYMMDD，例如 20260709，当前值：{date_value}")
    output_dir = Path(_option_value("--output-dir", OUTPUT_DIR)).expanduser()
    template_path = Path(_option_value("--template", TEMPLATE_WORKBOOK)).expanduser()
    template_sheet = _option_value("--sheet", TEMPLATE_SHEET) or TEMPLATE_SHEET
    browser_profile = Path(_option_value("--browser-profile", BROWSER_USER_DATA_DIR)).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)
    Path(LOG_DIR).mkdir(parents=True, exist_ok=True)

    success_files = []
    failed_keywords = []

    LOGGER.info("启动 FineBI 聊天记录导出；数据日期：%s", date_value)
    LOGGER.info("输出目录：%s", output_dir)
    LOGGER.info("浏览器用户数据目录：%s", browser_profile)
    LOGGER.info("本次将按顺序导出关键词：%s", "、".join(KEYWORDS))
    LOGGER.info("完整流程：下载关键词文件 -> 校验 XLSX -> 按敏感词表模板合并去重")

    with sync_playwright() as p:
        launch_options = {
            "user_data_dir": str(browser_profile),
            "headless": HEADLESS,
            "accept_downloads": True,
        }
        if BROWSER_CHANNEL:
            launch_options["channel"] = BROWSER_CHANNEL
        context = p.chromium.launch_persistent_context(**launch_options)
        page = context.pages[0] if context.pages else context.new_page()
        run_error = None
        try:
            LOGGER.info("打开目标页面")
            page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=PAGE_READY_TIMEOUT_MS)
            report_context = wait_page_ready(page)

            if "--login-only" in sys.argv:
                LOGGER.info("登录态已确认，login-only 阶段结束；未执行关键词下载")
                return

            LOGGER.info("设置全局筛选：发送人=学员；日期=昨天至昨天（%s）", date_value)
            # 先完成日期双框写入。FineBI 日期控件重渲染时可能清空角色多选，
            # 因此角色必须最后设置，后续不再改动日期。
            set_date_range(report_context, date_value)
            set_role_checkboxes(report_context, page)
            verify_global_filters(report_context, date_value, page, role_verified=True)
            log_filter_snapshot(report_context, "初始化筛选快照")

            for keyword in KEYWORDS:
                exported = None
                for attempt in range(1, MAX_RETRIES + 2):
                    try:
                        LOGGER.info("开始处理关键词 [%s]，第 %s 次", keyword, attempt)
                        verify_global_filters(report_context, date_value, page, role_verified=True)
                        exported = export_keyword(report_context, page, keyword, date_value, output_dir, role_verified=True)
                        success_files.append(exported)
                        break
                    except Exception as exc:
                        LOGGER.error("关键词 [%s] 第 %s 次失败：%s", keyword, attempt, exc)
                        screenshot_error(page, f"{keyword}_失败_{attempt}")
                        if attempt > MAX_RETRIES:
                            failed_keywords.append(keyword)
                            LOGGER.error("关键词 [%s] 已达到最大重试次数，未生成下载文件；确认失败后才进入下一个关键词", keyword)
                        else:
                            page.reload(wait_until="domcontentloaded", timeout=PAGE_READY_TIMEOUT_MS)
                            report_context = wait_page_ready(page)
                            set_date_range(report_context, date_value)
                            set_role_checkboxes(report_context, page)
                            verify_global_filters(report_context, date_value, page, role_verified=True)
                    finally:
                        if exported:
                            time.sleep(STEP_INTERVAL_SECONDS)

            summary_path = None
            if success_files:
                LOGGER.info("下载流程完成，开始执行 Excel 合并去重流程")
                summary_path = merge_excels(
                    success_files,
                    date_value,
                    output_dir,
                    str(template_path),
                    template_sheet,
                )
            else:
                LOGGER.warning("没有成功下载的关键词文件，跳过 Excel 合并")

            LOGGER.info("执行完成：成功关键词 %s 个，失败关键词 %s 个", len(success_files), len(failed_keywords))
            LOGGER.info("失败关键词：%s", "、".join(failed_keywords) if failed_keywords else "无")
            if summary_path:
                LOGGER.info("汇总结果：%s", summary_path)
        except Exception as exc:
            run_error = exc
            if KEEP_BROWSER_OPEN_ON_ERROR and not HEADLESS:
                LOGGER.error("脚本异常，浏览器保持打开用于排查。检查完页面后回到终端按回车关闭浏览器。")
                try:
                    input("按回车关闭浏览器并输出错误：")
                except KeyboardInterrupt:
                    pass
            raise
        finally:
            context.close()


def dispatch_cli(argv=None) -> None:
    """根据命令行参数启动合并模式或原有 FineBI 自动导出流程。"""
    argv = sys.argv if argv is None else argv
    if "--merge-only" in argv:
        run_merge_only()
    else:
        run()


if __name__ == "__main__":
    try:
        dispatch_cli()
    except LoginRequiredError as error:
        LOGGER.error("%s", error)
        sys.exit(LoginRequiredError.exit_code)
    except Exception as error:
        LOGGER.exception("脚本终止：%s", error)
        sys.exit(1)
