#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键执行 FineBI 下载、Excel 合并去重与拟人工识别。"""

import argparse
import hashlib
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import zipfile
import xml.etree.ElementTree as ElementTree
from copy import copy
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple


REPO_ROOT = Path(__file__).resolve().parents[1]
FINEBI_SCRIPT = REPO_ROOT / "scripts" / "finebi_chat_export.py"
DEFAULT_OUTPUT_DIR = Path(os.path.expanduser("~/Downloads/chat_export"))
DEFAULT_TEMPLATE = Path(os.path.expanduser("~/敏感词跟进表【潜在风险】.classified 10.16.33.xlsx"))
DEFAULT_SHARED_BROWSER_PROFILE = Path(os.path.expanduser("~/.qlchat_unified_profile"))
DEFAULT_SHEET = "6.1-6.30"
KEYWORDS = [
    "投诉", "举报", "伪直播", "报警", "虚假宣传", "诱导",
    "12315", "黑猫", "维权", "市长热线", "曝光你", "消协",
]
# 与识别前完整性校验保持同一口径。不要在规范化和校验阶段各自维护
# 一份关键词列表，否则无关消息可能在前一阶段漏过、后一阶段又阻断整批。
RECOGNITION_VALIDATION_KEYWORDS = tuple(KEYWORDS)
MERGE_PREFIX = "敏感词跟进表_聊天合并"
ONLINE_DOCUMENT_TITLE = (
    "用户信息（投诉、举报、伪直播、报警、虚假宣传、诱导、12315、黑猫、维权、市长热线、曝光你、消协）"
)
ONLINE_SOURCE_HEADERS = [
    "序列", "数据日期", "聊天发送人角色", "用户ID", "用户企微名称",
    "聊天发送人企微用户名称", "老师id", "老师企微名称",
    "聊天接收人用户名称", "发送时间", "消息内容", "商品类型",
    "训练营名称", "期数名称",
]
ACTIVE_CHILD = None
INTERRUPT_REQUESTED = False
GRACEFUL_STOP_TIMEOUT_SECONDS = 20
XLSX_MAX_ENTRIES = 10_000
XLSX_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
XLSX_MAX_ENTRY_BYTES = 64 * 1024 * 1024
XLSX_MAX_COMPRESSION_RATIO = 200


@contextmanager
def pipeline_lock(path: Path):
    """防止多个流程同时抢占同一浏览器用户目录和 Excel 输出。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            handle.seek(0)
            owner = handle.read().strip() or "未知进程"
            raise PipelineError(f"已有一键流程正在运行：{owner}；请勿重复启动") from exc
        handle.seek(0)
        handle.truncate()
        handle.write(f"pid={os.getpid()} started={datetime.now().isoformat(timespec='seconds')}\n")
        handle.flush()
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()
        try:
            path.unlink()
        except OSError:
            pass


class PipelineError(RuntimeError):
    """可直接展示给用户的阶段错误。"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="一键执行 FineBI 下载、Excel 合并去重和拟人工识别")
    parser.add_argument(
        "--mode",
        choices=("full", "download", "recognize"),
        default="full",
        help="运行模式：完整流程、仅下载并合并、仅识别现有 Excel",
    )
    parser.add_argument("--workbook", help="仅识别模式使用的 Excel 路径")
    parser.add_argument("--date", help="数据日期 YYYYMMDD，默认执行日的前一天")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="下载和合并输出目录")
    parser.add_argument("--template", default=str(DEFAULT_TEMPLATE), help="敏感词跟进表模板路径")
    parser.add_argument("--sheet", default=DEFAULT_SHEET, help="模板目标工作表")
    parser.add_argument("--from-row", type=int, default=3, help="识别起始行，默认 3")
    parser.add_argument("--to-row", type=int, help="识别结束行，默认处理全部有效行")
    parser.add_argument("--allow-partial", action="store_true", help="允许部分关键词文件缺失时继续处理")
    parser.add_argument("--resume", help="从指定的一键状态 JSON 继续")
    parser.add_argument("--retry-failed", action="store_true", help="只重试最近识别日志中的失败行")
    parser.add_argument("--debug", action="store_true", help="保留兼容参数；登录验证时可使用有头浏览器")
    parser.add_argument("--offline", action="store_true", help="显式切换离线模式；必须同时提供 --offline-confirmed")
    parser.add_argument("--offline-confirmed", action="store_true", help="确认本次任务允许关闭 DOM 查询和大模型")
    parser.add_argument("--no-llm", action="store_true", help="本次任务关闭大模型分类；不改变 DOM 在线查询")
    parser.add_argument("--in-place", action="store_true", help="覆盖合并文件；默认生成带运行号的版本文件")
    parser.add_argument(
        "--shared-browser-profile",
        default=str(DEFAULT_SHARED_BROWSER_PROFILE),
        help="FineBI 与拟人工识别共用的持久化浏览器登录目录",
    )
    parser.add_argument("--python", default=sys.executable, help="Python 可执行文件")
    parser.add_argument("--node", default="node", help="Node.js 可执行文件")
    return parser.parse_args()


def resolve_date(value: Optional[str]) -> str:
    date_value = value or (datetime.now() + timedelta(days=-1)).strftime("%Y%m%d")
    if len(date_value) != 8 or not date_value.isdigit():
        raise PipelineError(f"--date 必须是 YYYYMMDD，例如 20260710，当前值：{date_value}")
    try:
        datetime.strptime(date_value, "%Y%m%d")
    except ValueError as exc:
        raise PipelineError(f"--date 不是有效日期：{date_value}") from exc
    return date_value


def write_json(path: Path, payload: Dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def finalize_interrupted_state(state: Dict, started_at: float) -> Optional[Path]:
    """将用户中断统一归档为可恢复的取消状态，并暴露已存在的部分工作簿。"""
    ended_at = datetime.now().isoformat(timespec="seconds")
    recognition = state.get("stages", {}).get("recognition")
    partial_path: Optional[Path] = None
    if isinstance(recognition, dict):
        candidate = Path(str(recognition.get("path") or "")).expanduser()
        if candidate.suffix.lower() == ".xlsx" and candidate.exists() and candidate.is_file():
            # 不使用 resolve()：macOS 会把 /var 规范化为 /private/var，导致
            # 状态文件中的结果路径与任务原始路径不一致。下载白名单会在网页端
            # 单独做真实路径校验，这里只需保留任务创建时的绝对路径。
            partial_path = candidate if candidate.is_absolute() else candidate.absolute()
            recognition["status"] = "partial"
            recognition["partialResult"] = True
            recognition["endedAt"] = ended_at
        elif recognition.get("status") == "running":
            recognition["status"] = "interrupted"
            recognition["endedAt"] = ended_at

    for stage in state.get("stages", {}).values():
        if stage.get("status") == "running":
            stage["status"] = "interrupted"
            stage["endedAt"] = ended_at

    state["status"] = "cancelled"
    state["cancelReason"] = "用户终止"
    state["partialResult"] = bool(partial_path)
    state["endedAt"] = ended_at
    state["durationSeconds"] = round(max(0, time.time() - started_at), 1)
    state.pop("error", None)
    if partial_path:
        state["resultFile"] = str(partial_path)
    else:
        state.pop("resultFile", None)
    return partial_path


def latest_pipeline_state(log_dir: Path, date_value: str) -> Tuple[Optional[Path], Dict]:
    """找到同一数据日期最近一轮状态，供 --retry-failed 复用。"""
    candidates = []
    for path in log_dir.glob("full_pipeline_*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if str(payload.get("date")) != date_value:
            continue
        candidates.append((path.stat().st_mtime, path, payload))
    if not candidates:
        return None, {}
    _, path, payload = max(candidates, key=lambda item: item[0])
    return path, payload


def preflight(args: argparse.Namespace, template: Path) -> None:
    if not shutil.which(args.python):
        raise PipelineError(f"找不到 Python 可执行文件：{args.python}")

    needs_download = args.mode in ("full", "download")
    needs_recognition = args.mode in ("full", "recognize")
    if needs_recognition and not shutil.which(args.node):
        raise PipelineError(f"找不到 Node.js 可执行文件：{args.node}")
    if needs_download and not FINEBI_SCRIPT.exists():
        raise PipelineError(f"找不到 FineBI 下载脚本：{FINEBI_SCRIPT}")
    if needs_download and not template.exists():
        raise PipelineError(f"找不到敏感词跟进表模板：{template}")
    if args.mode == "recognize" and not args.workbook:
        raise PipelineError("--mode recognize 必须同时指定 --workbook")

    python_imports = "import openpyxl, pandas, playwright" if needs_download else "import openpyxl"
    python_check = subprocess.run(
        [args.python, "-c", python_imports],
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if python_check.returncode != 0:
        raise PipelineError(
            "Python 依赖不完整。下载流程需要 pandas、openpyxl、playwright。\n"
            f"检查详情：{python_check.stderr.strip()}"
        )

    if needs_recognition:
        node_check = subprocess.run(
            [args.node, "--version"],
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if node_check.returncode != 0:
            raise PipelineError("Node.js 不可用，无法执行本地识别")


def create_dom_config(shared_profile: Path, headless: bool = True) -> str:
    """为本次 Node DOM 阶段生成临时配置，不修改项目默认配置。"""
    config_path = REPO_ROOT / "config" / "default.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    browser = config.setdefault("browser", {})
    browser["userDataDir"] = str(shared_profile)
    browser["headless"] = bool(headless)
    browser["allowInteractiveLogin"] = not headless
    # 有头模式只用于人工登录验证；登录后 DOM 客户端不再调用 bringToFront，
    # 避免批量处理每一行时把浏览器窗口抢到前台。
    browser["suppressFocusStealing"] = not headless
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        suffix=".json",
        prefix="full-pipeline-dom-",
        delete=False,
    ) as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
        return handle.name


def stream_process(
    command: List[str],
    log_file,
    stage: str,
    env: Optional[Dict[str, str]] = None,
) -> Tuple[int, List[str]]:
    print(f"[{stage}] 执行：{' '.join(command)}")
    log_file.write(f"[{stage}] command={' '.join(command)}\n")
    log_file.flush()
    global ACTIVE_CHILD
    process = subprocess.Popen(
        command,
        cwd=str(REPO_ROOT),
        stdin=None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
        start_new_session=True,
    )
    ACTIVE_CHILD = process
    output: List[str] = []
    try:
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip("\n")
            output.append(line)
            print(line, flush=True)
            log_file.write(line + "\n")
            log_file.flush()
        return_code = process.wait()
    except KeyboardInterrupt:
        # 首次中断已经由信号处理器转发给 Node。先给 Node 时间关闭页面、
        # 将已完整完成的行写回 Excel；超时后才逐级强制结束。
        try:
            process.wait(timeout=GRACEFUL_STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=3)
        finally:
            # Node 退出后仍可能留下 Playwright/Chromium 子进程，清理整个会话组。
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        raise
    finally:
        ACTIVE_CHILD = None
    log_file.write(f"[{stage}] exit_code={return_code}\n")
    log_file.flush()
    return return_code, output


def run_finebi_download(args, date_value: str, output_dir: Path, template: Path, log_file):
    """执行历史可用的 FineBI 下载器；登录态失效时切换为有头验证。"""
    base_command = [
        args.python,
        str(FINEBI_SCRIPT),
        "--date", date_value,
        "--output-dir", str(output_dir),
        "--template", str(template),
        "--sheet", args.sheet,
        "--browser-profile", str(Path(args.shared_browser_profile).expanduser().resolve()),
    ]
    runtime_env = os.environ.copy()
    runtime_env.setdefault(
        "FINEBI_LOG_DIR",
        runtime_env.get("FULL_PIPELINE_LOG_DIR", str(output_dir / "logs")),
    )
    command = [*base_command, "--headful" if args.debug else "--headless"]
    code, output = stream_process(command, log_file, "finebi", env=runtime_env)
    login_required = any(
        "LOGIN_REQUIRED" in line or "WEB_LOGIN_REQUIRED=" in line
        for line in output
    )
    if code == 0 or args.debug or not login_required:
        return code, output

    print("FineBI 登录态失效，临时打开有头浏览器等待人工验证")
    return stream_process(
        [*base_command, "--headful"],
        log_file,
        "finebi-headful",
        env=runtime_env,
    )


def run_node_recognition(
    args,
    headless_config_path: str,
    headful_config_path: str,
    workbook: Path,
    log_file,
    resume_log: str = "",
    retry_log: str = "",
    chat_only: bool = False,
    row_list: Optional[List[int]] = None,
):
    """默认在线识别；离线模式必须由调用者显式确认。"""
    headless_command = build_node_recognition_command(
        args,
        headless_config_path,
        headful_config_path,
        workbook,
        headless=True,
        resume_log=resume_log,
        retry_log=retry_log,
        chat_only=chat_only,
        row_list=row_list,
    )
    code, output = stream_process(
        headless_command,
        log_file,
        "recognition-offline" if args.offline else "recognition",
    )

    # 只有在线首轮因登录态失效退出时才转为有头验证；不会自动改为离线。
    login_required = any("LOGIN_REQUIRED" in line or "WEB_LOGIN_REQUIRED=" in line for line in output)
    if code == 0 or args.offline or not login_required:
        return code, output

    print("企聊宝/chanceAss 登录态失效，临时打开有头浏览器等待人工验证")
    headful_command = build_node_recognition_command(
        args,
        headless_config_path,
        headful_config_path,
        workbook,
        headless=False,
        resume_log=resume_log,
        retry_log=retry_log,
        chat_only=chat_only,
        row_list=row_list,
    )
    return stream_process(headful_command, log_file, "recognition-headful")


def build_node_recognition_command(
    args,
    headless_config_path: str,
    headful_config_path: str,
    workbook: Path,
    *,
    headless: bool,
    resume_log: str = "",
    retry_log: str = "",
    chat_only: bool = False,
    row_list: Optional[List[int]] = None,
) -> List[str]:
    """构造 Node 命令，默认在线；离线需要双显式开关。"""
    if args.offline and not getattr(args, "offline_confirmed", False):
        raise PipelineError("离线模式需要显式确认：请同时传入 --offline-confirmed")

    values = [
        args.node, "src/index.js", "--config",
        headless_config_path if headless else headful_config_path,
        "--write", "--workbook", str(workbook),
        "--output", str(workbook), "--from-row", str(args.from_row),
    ]
    if args.offline:
        values.extend(["--offline", "--no-llm"])
    elif getattr(args, "no_llm", False):
        values.append("--no-llm")
    if args.to_row is not None:
        values.extend(["--to-row", str(args.to_row)])
    if row_list:
        values.extend(["--row-list", compact_row_list(row_list)])
    # retry 和 resume 是两种不同语义：retry 只保留失败集合，
    # 不能再同时传 --resume，否则 completedRowsFromLog 会把失败集合也过滤掉。
    if row_list:
        pass
    elif retry_log:
        values.extend(["--retry-failed", retry_log])
    elif args.retry_failed:
        values.extend(["--retry-failed", resume_log] if resume_log else ["--retry-failed"])
    if resume_log and not retry_log and not args.retry_failed and not row_list:
        values.extend(["--resume", resume_log])
    if chat_only:
        values.append("--chat-only")
    return values


def expected_raw_files(output_dir: Path, date_value: str) -> List[Path]:
    return [output_dir / f"{keyword}_{date_value}.xlsx" for keyword in KEYWORDS]


def discover_local_exports(input_dir: Path, date_value: str) -> List[Path]:
    """发现官方人工导出的关键词文件，不接受任意名称或历史汇总文件。"""
    input_dir = Path(input_dir).expanduser().resolve()
    order = {keyword: index for index, keyword in enumerate(KEYWORDS)}
    files = []
    for path in input_dir.glob(f"*_{date_value}.xlsx"):
        keyword = path.stem.rsplit("_", 1)[0]
        if (
            path.is_file()
            and not path.name.startswith(("~$", ".~"))
            and keyword in order
        ):
            files.append(path)
    return sorted(files, key=lambda path: (order[path.stem.rsplit("_", 1)[0]], path.name))


def build_local_manifest(
    files: Iterable[Path],
    date_value: str,
    source: str = "official_manual_export",
) -> Dict:
    """生成不含本机绝对路径的来源清单，便于审计和重复批次核验。"""
    entries = []
    for source_path in files:
        path = Path(source_path)
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        stat = path.stat()
        entries.append({
            "name": path.name,
            "keyword": path.stem.rsplit("_", 1)[0],
            "size": stat.st_size,
            "sha256": digest.hexdigest(),
            "modifiedAt": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        })
    return {
        "schemaVersion": 1,
        "source": source,
        "date": date_value,
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "fileCount": len(entries),
        "files": entries,
    }


def _normalized_header(value: object) -> str:
    return re.sub(r"\s+", "", str(value or "")).lower()


def _date_key(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y%m%d")
    compact = re.sub(r"\D", "", str(value).strip())
    if len(compact) < 8:
        return ""
    candidate = compact[:8]
    try:
        datetime.strptime(candidate, "%Y%m%d")
    except ValueError:
        return ""
    return candidate


def _clean_user_id(value: object) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"\d+\.0", text):
        text = text[:-2]
    return text


def _row_value(row: Tuple, columns: Dict[str, int], *names: str):
    for name in names:
        index = columns.get(_normalized_header(name))
        if index is not None and index < len(row):
            return row[index]
    return ""


def merge_local_exports(
    source_files: Iterable[Path],
    date_value: str,
    output_path: Path,
    template_path: Path,
    sheet_name: str,
) -> Dict:
    """把官方导出文件合并到标准模板，仅按用户 ID 去重。"""
    import openpyxl

    files = [Path(path) for path in source_files]
    if not files:
        raise PipelineError("没有发现官方人工导出的关键词 XLSX 文件")
    if not template_path.exists():
        raise PipelineError(f"找不到敏感词跟进表模板：{template_path}")

    rows = []
    seen_user_ids = set()
    filtered: Dict[str, int] = {}

    def reject(reason: str) -> None:
        filtered[reason] = filtered.get(reason, 0) + 1

    for source_path in files:
        keyword = source_path.stem.rsplit("_", 1)[0]
        inspect_xlsx(source_path)
        workbook = openpyxl.load_workbook(source_path, read_only=True, data_only=False)
        try:
            worksheet = workbook[workbook.sheetnames[0]]
            iterator = worksheet.iter_rows(values_only=True)
            headers = next(iterator, ())
            columns = {_normalized_header(value): index for index, value in enumerate(headers)}
            if _normalized_header("用户ID") not in columns:
                raise PipelineError(f"{source_path.name} 缺少「用户ID」列")
            for source_row in iterator:
                user_id = _clean_user_id(_row_value(source_row, columns, "用户ID", "用户id"))
                role = str(_row_value(source_row, columns, "聊天发送人角色") or "").strip()
                message = str(_row_value(source_row, columns, "消息内容") or "").strip()
                data_date = _date_key(
                    _row_value(source_row, columns, "数据日期分区", "数据日期")
                    or _row_value(source_row, columns, "发送时间")
                )
                if not re.fullmatch(r"\d{4,}", user_id):
                    reject("用户ID无效")
                    continue
                if role != "学员":
                    reject("非学员消息")
                    continue
                if not message:
                    reject("消息内容为空")
                    continue
                if keyword not in message:
                    reject("消息未命中所属关键词")
                    continue
                if data_date != date_value:
                    reject("数据日期不属于本批次")
                    continue
                if user_id in seen_user_ids:
                    reject("用户ID重复")
                    continue
                seen_user_ids.add(user_id)
                rows.append({
                    2: data_date,
                    3: role,
                    4: user_id,
                    5: _row_value(source_row, columns, "聊天发送人用户名称", "聊天发送人企微用户名称"),
                    6: _row_value(source_row, columns, "聊天发送人企微用户名称", "聊天发送人用户名称"),
                    7: _clean_user_id(_row_value(source_row, columns, "聊天接收人用户id", "聊天接收人用户ID")),
                    8: _row_value(source_row, columns, "聊天接收人企微用户名称", "聊天接收人用户名称"),
                    9: _row_value(source_row, columns, "聊天接收人用户名称", "聊天接收人企微用户名称"),
                    10: _row_value(source_row, columns, "发送时间"),
                    11: message,
                    12: _row_value(source_row, columns, "商品类型"),
                    13: _row_value(source_row, columns, "训练营名称"),
                    14: _row_value(source_row, columns, "期数名称"),
                })
        finally:
            workbook.close()

    if not rows:
        raise PipelineError("官方导出文件中没有符合日期、角色和关键词要求的有效数据")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(template_path, output_path)
    workbook = openpyxl.load_workbook(output_path)
    try:
        if sheet_name not in workbook.sheetnames:
            raise PipelineError(f"模板中不存在工作表：{sheet_name}")
        worksheet = workbook[sheet_name]
        styles = {
            column: copy(worksheet.cell(3, column)._style)
            for column in range(1, min(worksheet.max_column, 35) + 1)
        }
        row_height = worksheet.row_dimensions[3].height
        if worksheet.max_row >= 3:
            worksheet.delete_rows(3, worksheet.max_row - 2)
        if worksheet.max_column > 35:
            worksheet.delete_cols(36, worksheet.max_column - 35)
        worksheet.cell(1, 1, ONLINE_DOCUMENT_TITLE)
        for column, header in enumerate(ONLINE_SOURCE_HEADERS, start=1):
            worksheet.cell(2, column, header)
        worksheet.cell(2, 34, "问题总结")
        worksheet.cell(2, 35, "老师处理进展")
        export_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        for offset, values in enumerate(rows, start=3):
            values = {1: offset - 2, 16: export_date, **values}
            for column in range(1, 36):
                cell = worksheet.cell(offset, column)
                if column in styles:
                    cell._style = copy(styles[column])
                cell.value = values.get(column, "")
            worksheet.cell(offset, 2).number_format = "@"
            if row_height is not None:
                worksheet.row_dimensions[offset].height = row_height
        worksheet.auto_filter.ref = f"A2:AI{len(rows) + 2}"
        workbook.save(output_path)
    finally:
        workbook.close()

    return {
        "path": str(output_path),
        "sourceFiles": len(files),
        "uniqueUserIds": len(rows),
        "filtered": filtered,
    }


def validate_xlsx_archive(path: Path) -> None:
    """在 openpyxl 解析前拒绝压缩炸弹、路径穿越、宏、外链和公式载荷。"""
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if not entries or len(entries) > XLSX_MAX_ENTRIES:
                raise PipelineError(f"XLSX ZIP 条目数量异常：{path.name}")
            total_uncompressed = 0
            names = set()
            inspect_names = []
            for entry in entries:
                name = entry.filename.replace("\\", "/")
                lowered = name.lower()
                parts = Path(name).parts
                if not name or name.startswith("/") or ".." in parts or re.match(r"^[A-Za-z]:/", name):
                    raise PipelineError(f"XLSX 包含不安全路径：{path.name}")
                if entry.flag_bits & 0x1:
                    raise PipelineError(f"不支持加密的 XLSX：{path.name}")
                if entry.file_size > XLSX_MAX_ENTRY_BYTES:
                    raise PipelineError(f"XLSX 单个条目解压后过大：{path.name}")
                total_uncompressed += entry.file_size
                if total_uncompressed > XLSX_MAX_UNCOMPRESSED_BYTES:
                    raise PipelineError(f"XLSX 解压总大小超过限制：{path.name}")
                ratio = entry.file_size / max(entry.compress_size, 1)
                if ratio > XLSX_MAX_COMPRESSION_RATIO:
                    raise PipelineError(f"XLSX 压缩比异常，疑似压缩炸弹：{path.name}")
                if lowered.endswith("vbaproject.bin") or lowered.startswith("xl/externallinks/"):
                    raise PipelineError(f"XLSX 包含宏或外部链接：{path.name}")
                names.add(lowered)
                if lowered == "xl/workbook.xml" or re.fullmatch(r"xl/worksheets/[^/]+\.xml", lowered):
                    inspect_names.append(entry)
            if "[content_types].xml" not in names or "xl/workbook.xml" not in names:
                raise PipelineError(f"文件不是结构完整的 XLSX：{path.name}")
            for entry in inspect_names:
                xml = archive.read(entry).decode("utf-8", errors="replace")
                if entry.filename.lower() == "xl/workbook.xml" and re.search(
                    r"<externalReferences?\b", xml, re.IGNORECASE
                ):
                    raise PipelineError(f"XLSX 声明了外部数据链接：{path.name}")
                if entry.filename.lower().startswith("xl/worksheets/"):
                    try:
                        root = ElementTree.fromstring(xml)
                    except ElementTree.ParseError as exc:
                        raise PipelineError(f"XLSX 工作表 XML 损坏：{path.name}") from exc
                    for cell in root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"):
                        reference = str(cell.attrib.get("r") or "")
                        match = re.fullmatch(r"([A-Z]+)(\d+)", reference.upper())
                        if not match:
                            continue
                        column_number = 0
                        for letter in match.group(1):
                            column_number = column_number * 26 + ord(letter) - 64
                        row_number = int(match.group(2))
                        formula = cell.find(
                            "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}f"
                        )
                        if row_number >= 3 and 1 <= column_number <= 14 and formula is not None:
                            raise PipelineError(f"XLSX 原始数据列包含公式：{path.name}")
    except zipfile.BadZipFile as exc:
        raise PipelineError(f"文件不是有效的 XLSX ZIP：{path.name}") from exc


def inspect_xlsx(path: Path, expected_sheet: Optional[str] = None) -> Dict:
    if not path.exists():
        raise PipelineError(f"文件不存在：{path}")
    if path.suffix.lower() != ".xlsx":
        raise PipelineError(f"文件不是 XLSX：{path}")
    if path.stat().st_size <= 0:
        raise PipelineError(f"文件为空：{path}")
    validate_xlsx_archive(path)
    try:
        import openpyxl

        workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
    except Exception as exc:
        raise PipelineError(f"XLSX 无法打开：{path}；{exc}") from exc

    try:
        sheet_names = list(workbook.sheetnames)
        sheet_name = expected_sheet or sheet_names[0]
        if sheet_name not in sheet_names:
            raise PipelineError(f"文件缺少工作表「{sheet_name}」：{path}；已有：{sheet_names}")
        worksheet = workbook[sheet_name]
        header_values = [str(cell.value or "").strip() for cell in next(worksheet.iter_rows(min_row=1, max_row=1))]
        nonempty_rows = 0
        for values in worksheet.iter_rows(min_row=2, values_only=True):
            if any(value not in (None, "") for value in values):
                nonempty_rows += 1
        return {
            "path": str(path),
            "sheet": sheet_name,
            "sheetNames": sheet_names,
            "maxRow": worksheet.max_row,
            "maxColumn": worksheet.max_column,
            "headerValues": header_values,
            "nonemptyRows": nonempty_rows,
            "size": path.stat().st_size,
        }
    finally:
        workbook.close()


def validate_raw_files(output_dir: Path, date_value: str, stage_started: float, allow_partial: bool) -> Dict:
    valid: List[Path] = []
    no_data: List[str] = []
    failed: Dict[str, str] = {}
    for path in expected_raw_files(output_dir, date_value):
        try:
            if path.stat().st_mtime < stage_started - 1:
                raise PipelineError("文件时间早于本次流程，疑似复用旧文件")
            info = inspect_xlsx(path)
            valid.append(path)
            if info["nonemptyRows"] <= 0:
                no_data.append(path.stem.rsplit("_", 1)[0])
        except Exception as exc:
            failed[path.stem.rsplit("_", 1)[0]] = str(exc)

    if failed and not allow_partial:
        details = "；".join(f"{keyword}：{reason}" for keyword, reason in failed.items())
        raise PipelineError(f"本次下载未完整完成，未进入 Excel/识别阶段：{details}")
    if not valid:
        raise PipelineError("没有可用的本次关键词 XLSX 文件")
    return {
        "expectedCount": len(KEYWORDS),
        "validCount": len(valid),
        "validFiles": [str(path) for path in valid],
        "noDataKeywords": no_data,
        "noDataCount": len(no_data),
        "failed": failed,
        "partial": bool(failed),
    }


def extract_nested_msg_list_text(value) -> Optional[str]:
    """从导出器写入 K 列的 ``msg_list`` JSON 中提取真实文本。

    返回 ``None`` 表示输入不是可解析的 ``msg_list`` 载荷；返回空字符串
    表示载荷可解析但没有文本消息，这种情况必须由完整性校验阻断，不能静默
    当成无关消息过滤。
    """
    raw = str(value or "").strip()
    if not raw or raw[0] not in "[{":
        return None
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return None

    def has_msg_list(node) -> bool:
        if isinstance(node, dict):
            return "msg_list" in node or any(has_msg_list(item) for item in node.values())
        if isinstance(node, list):
            return any(has_msg_list(item) for item in node)
        return False

    if not has_msg_list(payload):
        return None

    text_parts: List[str] = []
    text_keys = {"text", "content", "message", "msg", "contenttext", "description"}

    def collect(node, key: str = "") -> None:
        if isinstance(node, dict):
            for child_key, child in node.items():
                collect(child, str(child_key).lower())
            return
        if isinstance(node, list):
            for child in node:
                collect(child, key)
            return
        if not isinstance(node, str) or key not in text_keys:
            return
        candidate = node.strip()
        if not candidate or re.match(r"^(?:https?|ftp)://", candidate, re.IGNORECASE):
            return
        if candidate[0:1] in ("{", "["):
            try:
                collect(json.loads(candidate), key)
                return
            except (TypeError, ValueError):
                pass
        text_parts.append(candidate)

    collect(payload)
    # 导出结构偶尔会同时携带同一条 text/content，保留出现顺序但去重。
    return "\n".join(dict.fromkeys(text_parts)).strip()


def looks_like_nested_msg_list(value) -> bool:
    """判断不可解析输入是否仍声称自己是嵌套消息载荷。"""
    return '"msg_list"' in str(value or "")


def recover_truncated_nested_msg_list_text(value) -> Optional[str]:
    """从被上游截断的 ``msg_list`` JSON 中恢复已完整落盘的文本项。

    导出端偶发将单元格截断在 JSON 中间。这里不尝试补全 JSON，也不猜测
    截断后的内容；只读取截断前仍有完整引号边界的 ``text`` 等文本字段。
    返回 ``None`` 表示没有可安全恢复的完整文本。
    """
    raw = str(value or "").strip()
    if not looks_like_nested_msg_list(raw):
        return None

    text_parts: List[str] = []
    text_pattern = re.compile(
        r'"(?:text|contenttext|message|msg|description)"\s*:\s*("(?:\\.|[^"\\])*")',
        re.IGNORECASE,
    )
    for matched in text_pattern.finditer(raw):
        try:
            candidate = json.loads(matched.group(1)).strip()
        except (TypeError, ValueError):
            continue
        if not candidate or re.match(r"^(?:https?|ftp)://", candidate, re.IGNORECASE):
            continue
        text_parts.append(candidate)
    return "\n".join(dict.fromkeys(text_parts)).strip() or None


def validate_merged_file(path: Path, sheet_name: str, stage_started: float) -> Dict:
    if path.exists() and path.stat().st_mtime < stage_started - 1:
        raise PipelineError(f"合并文件没有在本次流程中更新，疑似复用旧文件：{path}")
    info = inspect_xlsx(path, expected_sheet=sheet_name)
    import openpyxl

    workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
    try:
        worksheet = workbook[sheet_name]
        headers = {str(worksheet.cell(2, column).value or "").strip(): column for column in range(1, worksheet.max_column + 1)}
        required = {"用户ID": 4, "消息内容": 11, "商品类型": 12, "训练营名称": 13}
        missing = [name for name, column in required.items() if worksheet.cell(2, column).value in (None, "")]
        if missing:
            raise PipelineError(f"合并文件模板表头缺失：{','.join(missing)}")
        user_ids: List[str] = []
        invalid_rows: List[int] = []
        for row_number, values in enumerate(
            worksheet.iter_rows(min_row=3, values_only=True),
            start=3,
        ):
            user_id = str(values[3] or "").strip() if len(values) > 3 else ""
            if user_id:
                user_ids.append(user_id)
            role = str(values[2] or "").strip() if len(values) > 2 else ""
            message = str(values[10] or "").strip() if len(values) > 10 else ""
            if user_id and (
                role != "学员"
                or not message
                or not any(keyword in message for keyword in RECOGNITION_VALIDATION_KEYWORDS)
            ):
                invalid_rows.append(row_number)
        if not user_ids:
            raise PipelineError("合并文件没有有效用户 ID")
        if len(user_ids) != len(set(user_ids)):
            raise PipelineError("合并文件仍存在重复用户 ID，未进入拟人工识别")
        if invalid_rows:
            raise PipelineError(f"合并文件仍存在角色或消息不符合要求的数据行：{invalid_rows[:10]}")
        return {
            **info,
            "dataRows": len(user_ids),
            "uniqueUserIds": len(set(user_ids)),
            "requiredHeaders": required,
            "headers": headers,
        }
    finally:
        workbook.close()


def normalize_recognition_workbook(path: Path, sheet_name: str) -> Dict:
    """规范化上传文件：嵌套消息提取、无关行过滤、去重和角色补全。"""
    import openpyxl

    workbook = openpyxl.load_workbook(path)
    try:
        if sheet_name not in workbook.sheetnames:
            raise PipelineError(f"Excel 中不存在工作表：{sheet_name}")
        worksheet = workbook[sheet_name]
        normalized_nested_message_rows: List[int] = []
        recovered_truncated_nested_message_rows: List[int] = []
        filtered_no_keyword_rows: List[int] = []
        filtered_nested_message_rows: List[int] = []
        for row_number in range(3, worksheet.max_row + 1):
            user_id = str(worksheet.cell(row_number, 4).value or "").strip()
            role = str(worksheet.cell(row_number, 3).value or "").strip()
            raw_message = worksheet.cell(row_number, 11).value
            nested_message = extract_nested_msg_list_text(raw_message)
            if nested_message is None:
                nested_message = recover_truncated_nested_msg_list_text(raw_message)
                if nested_message is not None:
                    recovered_truncated_nested_message_rows.append(row_number)
            if nested_message is not None:
                worksheet.cell(row_number, 11, nested_message)
                normalized_nested_message_rows.append(row_number)
                message = nested_message
            else:
                message = str(raw_message or "").strip()

            # 非学员角色仍是数据完整性错误，不能因它恰好没有关键词而被过滤。
            # 可解析但无文本的嵌套载荷同样必须保留，让校验器明确阻断。
            if (
                user_id
                and role in ("", "学员")
                and message
                and not (nested_message is None and looks_like_nested_msg_list(raw_message))
                and not any(keyword in message for keyword in RECOGNITION_VALIDATION_KEYWORDS)
            ):
                filtered_no_keyword_rows.append(row_number)
                if nested_message is not None:
                    filtered_nested_message_rows.append(row_number)

        for row_number in reversed(filtered_no_keyword_rows):
            worksheet.delete_rows(row_number, 1)

        seen: Dict[str, int] = {}
        duplicate_user_ids = set()
        removed_rows: List[int] = []
        for row_number in range(3, worksheet.max_row + 1):
            user_id = str(worksheet.cell(row_number, 4).value or "").strip()
            if not user_id:
                continue
            if user_id in seen:
                duplicate_user_ids.add(user_id)
                removed_rows.append(row_number)
            else:
                seen[user_id] = row_number

        for row_number in reversed(removed_rows):
            worksheet.delete_rows(row_number, 1)

        filled_student_role_rows: List[int] = []
        for row_number in range(3, worksheet.max_row + 1):
            user_id = str(worksheet.cell(row_number, 4).value or "").strip()
            role = str(worksheet.cell(row_number, 3).value or "").strip()
            message = str(worksheet.cell(row_number, 11).value or "").strip()
            if user_id and not role and message and any(keyword in message for keyword in KEYWORDS):
                worksheet.cell(row_number, 3, "学员")
                filled_student_role_rows.append(row_number)

        if (
            normalized_nested_message_rows
            or filtered_no_keyword_rows
            or removed_rows
            or filled_student_role_rows
        ):
            if worksheet.auto_filter.ref and ":" in worksheet.auto_filter.ref:
                start_cell, end_cell = worksheet.auto_filter.ref.split(":", 1)
                end_column = re.match(r"[A-Z]+", end_cell.upper())
                if end_column:
                    worksheet.auto_filter.ref = f"{start_cell}:{end_column.group(0)}{worksheet.max_row}"
            workbook.save(path)

        return {
            "normalizedNestedMessages": len(normalized_nested_message_rows),
            "normalizedNestedMessageRows": normalized_nested_message_rows,
            "recoveredTruncatedNestedMessages": len(recovered_truncated_nested_message_rows),
            "recoveredTruncatedNestedMessageRows": recovered_truncated_nested_message_rows,
            "filteredNoKeywordRows": len(filtered_no_keyword_rows),
            "filteredNoKeywordRowNumbers": filtered_no_keyword_rows,
            "filteredNoKeywordNestedMessageRows": filtered_nested_message_rows,
            "duplicateUserCount": len(duplicate_user_ids),
            "removedDuplicateRows": len(removed_rows),
            "removedRowNumbers": removed_rows,
            "filledStudentRoles": len(filled_student_role_rows),
            "filledStudentRoleRows": filled_student_role_rows,
        }
    finally:
        workbook.close()


def count_written_fields(path: Path, sheet_name: str) -> Dict[str, int]:
    import openpyxl

    fields = {"Q": 17, "R": 18, "S": 19, "T": 20, "U": 21, "V": 22, "W": 23, "Y": 25, "AH": 34, "AI": 35}
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
    try:
        worksheet = workbook[sheet_name]
        counts = {}
        for field, column in fields.items():
            counts[field] = sum(
                1
                for row in range(3, worksheet.max_row + 1)
                if str(worksheet.cell(row, column).value or "").strip()
            )
        return counts
    finally:
        workbook.close()


REQUIRED_RECOGNITION_FIELDS = {
    "Q": 17,
    "R": 18,
    "S": 19,
    "T": 20,
    "U": 21,
    "V": 22,
    "W": 23,
    "Y": 25,
    "AH": 34,
    "AI": 35,
}


def scan_recognition_gaps(
    path: Path,
    sheet_name: str,
    from_row: int = 3,
    to_row: Optional[int] = None,
    completed_rows: Optional[Iterable[int]] = None,
    row_outcomes: Optional[Dict[int, Dict]] = None,
) -> Dict:
    """逐行核对最终工作簿与 Node 结果，区分合法空白和写回异常。

    ``completed_rows`` 只保留旧调用的兼容语义；一旦提供 ``row_outcomes``，
    不能再因为 JSONL 已有“完成”记录而跳过 Excel 核对。否则会把“日志已
    读取、最终工作簿却为空”的写回丢失误报为成功。
    """
    import openpyxl

    completed = {int(row) for row in (completed_rows or []) if int(row) > 0}
    outcomes = {
        int(row): outcome
        for row, outcome in (row_outcomes or {}).items()
        if int(row) > 0 and isinstance(outcome, dict)
    }
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
    try:
        worksheet = workbook[sheet_name]
        last_row = min(worksheet.max_row, to_row) if to_row else worksheet.max_row
        missing_rows: List[int] = []
        missing_by_field = {field: [] for field in REQUIRED_RECOGNITION_FIELDS}
        row_missing_fields: Dict[str, List[str]] = {}
        review_blocked_rows: List[int] = []
        dom_unavailable_rows: List[int] = []
        field_missing_rows: List[int] = []
        write_lost_rows: List[int] = []
        summary_failed_rows: List[int] = []
        row_audit: Dict[str, Dict] = {}
        data_rows = 0
        for row_number in range(max(3, from_row), last_row + 1):
            user_id = str(worksheet.cell(row_number, 4).value or "").strip()
            if not user_id:
                continue
            data_rows += 1
            outcome = outcomes.get(row_number)
            # 兼容历史调用：没有逐行日志时，已完成行维持不重跑；新审计必须
            # 逐格读取最终文件，不能用“完成”掩盖空白。
            if row_number in completed and outcome is None:
                continue
            missing = [
                field
                for field, column in REQUIRED_RECOGNITION_FIELDS.items()
                if not str(worksheet.cell(row_number, column).value or "").strip()
            ]
            if not missing:
                continue

            audit = {
                "missingFields": missing,
                "reviewBlockedFields": [],
                "domUnavailableFields": [],
                "fieldMissingFields": [],
                "writeLostFields": [],
                "summaryFailedFields": [],
            }
            if outcome:
                category_blocked = bool(outcome.get("needsReview")) and not bool(
                    outcome.get("categoryColumnsWritable")
                )
                risk_blocked = bool(outcome.get("needsReview")) and not bool(
                    outcome.get("riskLevelWritable")
                )
                if category_blocked:
                    audit["reviewBlockedFields"].extend(
                        field for field in ("U", "V", "W") if field in missing
                    )
                if risk_blocked and "T" in missing:
                    audit["reviewBlockedFields"].append("T")
                if audit["reviewBlockedFields"]:
                    review_blocked_rows.append(row_number)

                expected_profile_fields = {
                    field: str(outcome.get(key) or "").strip()
                    for field, key in (
                        ("Q", "actualProductType"),
                        ("R", "actualCampName"),
                        ("S", "actualCourseCategory"),
                    )
                }
                for field, value in expected_profile_fields.items():
                    if value and field in missing:
                        audit["writeLostFields"].append(field)
                if audit["writeLostFields"]:
                    write_lost_rows.append(row_number)

                profile_error = str(outcome.get("profileError") or "")
                profile_absent = outcome.get("profileFound") is False
                # 档案通道明确未打开时，Q/R 可能已经由 L/M 受限兜底写入，
                # 但 S 仍必须保留为空并归因于 DOM 不可用；不能把它误报为
                # “档案已打开后的字段缺失”。
                profile_unavailable = profile_absent and bool(profile_error)
                if profile_unavailable or (
                    not any(expected_profile_fields.values()) and (profile_absent or profile_error)
                ):
                    audit["domUnavailableFields"].extend(
                        field for field in ("Q", "R", "S") if field in missing
                    )
                    if audit["domUnavailableFields"]:
                        dom_unavailable_rows.append(row_number)

                if (
                    not profile_unavailable
                    and outcome.get("profileDetailHasCategory") is False
                    and "S" in missing
                ):
                    audit["fieldMissingFields"].append("S")
                    field_missing_rows.append(row_number)

                # Y/AH/AI 是识别任务的核心摘要结果。右侧上下文已经可靠打开、
                # 但模型请求失败时，这些空白不是“可选字段”，必须进入补跑集合。
                reliable_context = bool(outcome.get("contextOpened")) and not bool(
                    outcome.get("invalidContext")
                )
                if reliable_context:
                    if "Y" in missing and (
                        outcome.get("summaryError") or outcome.get("llmError")
                    ):
                        audit["summaryFailedFields"].append("Y")
                    if outcome.get("dialogSummaryError"):
                        audit["summaryFailedFields"].extend(
                            field for field in ("AH", "AI") if field in missing
                        )
                if audit["summaryFailedFields"]:
                    summary_failed_rows.append(row_number)

            explained = set(
                audit["reviewBlockedFields"]
                + audit["domUnavailableFields"]
                + audit["fieldMissingFields"]
            )
            actionable = set(audit["writeLostFields"] + audit["summaryFailedFields"])
            # 没有逐行日志时，仍沿用旧的“全字段缺失即修复”语义。已经有
            # 行日志时，不能把可选摘要/QRS 的合法空白再次当作失败；仅把
            # “日志已有明确值、工作簿仍为空”的写回丢失交给自动修复。
            if outcome is None:
                actionable.update(field for field in missing if field not in explained)
            if actionable:
                missing_rows.append(row_number)
                for field in sorted(actionable):
                    missing_by_field[field].append(row_number)
            if any(audit.values()):
                row_audit[str(row_number)] = audit
            if actionable:
                row_missing_fields[str(row_number)] = sorted(actionable)
        return {
            "dataRows": data_rows,
            "completeRows": data_rows - len(missing_rows),
            "missingRows": missing_rows,
            "missingCount": len(missing_rows),
            "missingByField": {field: rows for field, rows in missing_by_field.items() if rows},
            "rowMissingFields": row_missing_fields,
            "reviewBlockedRows": sorted(set(review_blocked_rows)),
            "domUnavailableRows": sorted(set(dom_unavailable_rows)),
            "fieldMissingRows": sorted(set(field_missing_rows)),
            "writeLostRows": sorted(set(write_lost_rows)),
            "summaryFailedRows": sorted(set(summary_failed_rows)),
            "rowAudit": row_audit,
        }
    finally:
        workbook.close()


def compact_row_list(rows: Iterable[int]) -> str:
    """将 [3,4,5,8] 压缩为 Node 可读的 3-5,8。"""
    ordered = sorted(set(int(row) for row in rows if int(row) > 0))
    if not ordered:
        return ""
    parts: List[str] = []
    start = previous = ordered[0]
    for row in ordered[1:]:
        if row == previous + 1:
            previous = row
            continue
        parts.append(str(start) if start == previous else f"{start}-{previous}")
        start = previous = row
    parts.append(str(start) if start == previous else f"{start}-{previous}")
    return ",".join(parts)


def extract_node_log(output: List[str]) -> str:
    for line in output:
        if "日志：" in line:
            return line.split("日志：", 1)[1].strip()
    return ""


def summarize_node_log(log_path: str) -> Dict:
    """读取识别 JSONL，生成一次失败集合兜底重跑所需的行号。"""
    summary = {
        "entryCount": 0,
        "failedRows": [],
        "reviewRows": 0,
        "nonRetryableReviewRows": [],
        "completedRows": [],
    }
    if not log_path:
        return summary
    path = Path(log_path).expanduser()
    if not path.exists():
        return summary
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        summary["entryCount"] += 1
        row_number = int(entry.get("rowNumber") or 0)
        if entry.get("needsReview"):
            summary["reviewRows"] += 1
        retryable = is_retryable_recognition_entry(entry)
        if retryable and row_number:
            summary["failedRows"].append(row_number)
        elif row_number:
            summary["completedRows"].append(row_number)
            if entry.get("needsReview"):
                summary["nonRetryableReviewRows"].append(row_number)
    summary["failedRows"] = sorted(set(summary["failedRows"]))
    summary["nonRetryableReviewRows"] = sorted(set(summary["nonRetryableReviewRows"]))
    summary["completedRows"] = sorted(set(summary["completedRows"]))
    # 同一日志如果后续重试已形成完整结论，以完成态为准。
    summary["failedRows"] = [
        row for row in summary["failedRows"] if row not in set(summary["completedRows"])
    ]
    return summary


def collect_node_row_outcomes(*log_paths: str) -> Dict[int, Dict]:
    """按行汇总 Node JSONL 中可用于最终工作簿核对的字段。

    同一行可能经历首轮、失败兜底和审计补跑。后续日志的空字段不能覆盖
    已验证的非空档案字段，否则会把真实写回丢失再次掩盖掉。
    """
    outcomes: Dict[int, Dict] = {}
    value_fields = {
        "actualProductType", "actualCampName", "actualCourseCategory",
        "profileError", "error", "classificationError", "llmError",
    }
    state_fields = {
        "needsReview", "categoryColumnsWritable", "riskLevelWritable",
        "profileFound", "profileDetailHasCategory", "profileSkipped",
    }
    for log_path in log_paths:
        if not log_path:
            continue
        path = Path(log_path).expanduser()
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            row_number = int(entry.get("rowNumber") or 0)
            if row_number <= 0:
                continue
            target = outcomes.setdefault(row_number, {})
            for field in value_fields:
                value = entry.get(field)
                if str(value or "").strip():
                    target[field] = value
            for field in state_fields:
                if field in entry:
                    target[field] = entry[field]
    return outcomes


def merge_recognition_summaries(*summaries: Dict) -> Dict:
    """保留首轮、兜底和审计补跑的完整运行结论，不能只展示最后一小段。"""
    merged = {
        "entryCount": 0,
        "failedRows": [],
        "reviewRows": 0,
        "nonRetryableReviewRows": [],
        "completedRows": [],
    }
    for summary in summaries:
        if not summary:
            continue
        merged["entryCount"] += int(summary.get("entryCount") or 0)
        merged["reviewRows"] += int(summary.get("reviewRows") or 0)
        for field in ("failedRows", "nonRetryableReviewRows", "completedRows"):
            merged[field].extend(summary.get(field, []))
    for field in ("failedRows", "nonRetryableReviewRows", "completedRows"):
        merged[field] = sorted({int(row) for row in merged[field] if int(row) > 0})
    completed = set(merged["completedRows"])
    merged["failedRows"] = [row for row in merged["failedRows"] if row not in completed]
    return merged


def has_incomplete_workbook_audit(audit: Optional[Dict]) -> bool:
    """判断最终文件是否仍有需要人工关注的非预期缺口。

    待复核的空白是写回策略，不应被标记成任务失败；DOM 未查询到和详情字段
    缺失则必须保留为 partial，避免页面把“处理结束”误解为“档案字段完整”。
    """
    if not audit:
        return False
    return bool(
        audit.get("missingRows")
        or audit.get("domUnavailableRows")
        or audit.get("fieldMissingRows")
    )


def format_workbook_audit(audit: Dict) -> str:
    """生成稳定、可读的逐行核对摘要，避免把合法空白说成完整成功。"""
    return (
        "工作簿逐行核对："
        f"待复核拦截 {len(audit.get('reviewBlockedRows', []))} 行，"
        f"DOM 未查询到 {len(audit.get('domUnavailableRows', []))} 行，"
        f"字段缺失 {len(audit.get('fieldMissingRows', []))} 行，"
        f"写回丢失 {len(audit.get('writeLostRows', []))} 行。"
    )


def is_retryable_recognition_entry(entry: Dict) -> bool:
    """只重跑可能因页面或模型瞬时状态失败的行，不重跑确定性空结果。"""
    transient_errors = [
        entry.get("error"),
        entry.get("llmError"),
        entry.get("classificationError"),
    ]
    if any(is_transient_recognition_error(value) for value in transient_errors if value):
        return True

    try:
        related_records = int(entry.get("relatedRecords") or 0)
    except (TypeError, ValueError):
        related_records = 0

    is_dom_entry = (
        entry.get("contextSource") == "dom"
        or "domPersonListRefreshed" in entry
        or isinstance(entry.get("domCandidateAttemptDetails"), list)
    )
    if is_dom_entry:
        if entry.get("invalidContext") is True:
            return True
        if entry.get("contextOpened") is True:
            identity_gates = (
                entry.get("domPersonListRefreshed") is True
                and entry.get("domPersonIdentityVerified") is True
                and entry.get("domSelectedPersonVerified") is True
                and entry.get("domConversationUserIdVerified") is True
                and entry.get("domQueryFormVerified") is True
                and entry.get("domQueryResultTerminal") is True
                and entry.get("domRightBubbleVerified") is True
            )
            if not identity_gates:
                return True
        elif related_records > 0 or not is_deterministic_dom_empty(entry):
            return True
    elif entry.get("contextOpened") is False:
        if related_records > 0:
            return True
        return True

    if not entry.get("profileSkipped") and entry.get("profileFound") is False:
        has_profile_fallback = any(
            str(entry.get(field) or "").strip()
            for field in ("actualProductType", "actualCampName", "actualCourseCategory")
        )
        profile_error = str(entry.get("profileError") or "")
        if not has_profile_fallback and re.search(r"超时|错误|未查询|未进入|未打开|点击|页面|登录", profile_error):
            return True

    dialog_error = str(entry.get("dialogSummaryError") or "")
    if re.search(r"超时|timeout|网络|连接|请求失败|限流|429|5\d\d", dialog_error, re.I):
        return True
    return False


def is_deterministic_dom_empty(entry: Dict) -> bool:
    """当前批次约定每行都应有记录，DOM 的 0 条永远不是确定性业务终态。"""
    return False


def is_transient_recognition_error(value: object) -> bool:
    return bool(re.search(
        r"超时|timeout|网络|连接|请求失败|限流|429|5\d\d|ECONN|ETIMEDOUT|socket|Target closed|Execution context|页面崩溃|导航失败|登录失效",
        str(value or ""),
        re.I,
    ))


def _current_process_ancestors(processes: List[tuple], current_pid: int) -> set:
    """返回当前进程的全部祖先进程，避免把 xvfb-run/sh 包装层误判为并发任务。"""
    parent_by_pid = {pid: ppid for pid, ppid, _command in processes}
    ancestors = set()
    cursor = current_pid
    while cursor in parent_by_pid:
        parent = parent_by_pid[cursor]
        if parent <= 0 or parent == cursor or parent in ancestors:
            break
        ancestors.add(parent)
        cursor = parent
    return ancestors


def detect_conflicting_processes() -> List[str]:
    """只检查独立启动的旧任务，不触碰当前任务包装层或普通 Chrome。"""
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,command="],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    processes = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split(None, 2)
        try:
            pid = int(parts[0])
            ppid = int(parts[1])
        except (ValueError, IndexError):
            continue
        command = parts[2] if len(parts) > 2 else ""
        processes.append((pid, ppid, command))

    own_process_tree = _current_process_ancestors(processes, os.getpid()) | {os.getpid()}
    conflicts = []
    for pid, ppid, command in processes:
        if pid in own_process_tree:
            continue
        is_pipeline = "scripts/run_full_pipeline.py" in command
        is_local_recognition = "src/index.js" in command and "--offline" in command
        if is_pipeline or is_local_recognition:
            conflicts.append(f"{pid} {command}")
    return conflicts


def main() -> int:
    global ACTIVE_CHILD, INTERRUPT_REQUESTED
    args = parse_args()
    try:
        date_value = resolve_date(args.date)
        if args.offline and not args.offline_confirmed:
            raise PipelineError("离线模式需要显式确认：请同时传入 --offline-confirmed")
        if args.from_row < 3:
            raise PipelineError("--from-row 不能小于 3")
        if args.to_row is not None and args.to_row < args.from_row:
            raise PipelineError("--to-row 不能小于 --from-row")
    except Exception as exc:
        print(f"流程终止：{exc}", file=sys.stderr)
        return 1

    output_dir = Path(args.output_dir).expanduser().resolve()
    template = Path(args.template).expanduser().resolve()
    shared_profile = Path(args.shared_browser_profile).expanduser().resolve()
    source_workbook = Path(args.workbook).expanduser().resolve() if args.workbook else None
    merge_path = source_workbook if args.mode == "recognize" else output_dir / f"{MERGE_PREFIX}_{date_value}.xlsx"
    prepared_recognition_path: Optional[Path] = None
    log_dir = Path(
        os.environ.get("FULL_PIPELINE_LOG_DIR", REPO_ROOT / "logs")
    ).expanduser().resolve()
    log_dir.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = log_dir / f"full_pipeline_{run_id}.log"
    state_path = log_dir / f"full_pipeline_{run_id}.json"
    # 生产部署通常将源码目录挂为只读；锁文件跟随输出目录，既可写又能
    # 对同一套流水线数据保持单实例约束。本地运行行为保持不变。
    lock_path = Path(
        os.environ.get("FULL_PIPELINE_LOCK", output_dir / ".full_pipeline.lock")
    ).expanduser().resolve()
    started_at = time.time()
    state: Dict = {
        "runId": run_id,
        "startedAt": datetime.now().isoformat(timespec="seconds"),
        "date": date_value,
        "mode": args.mode,
        "outputDir": str(output_dir),
        "template": str(template),
        "sheet": args.sheet,
        "contextMode": "offline" if args.offline else "dom",
        "dataSource": "finebi_automated_export",
        "allowPartial": bool(args.allow_partial),
        "headlessDefault": not args.debug,
        "stages": {},
        "status": "running",
    }

    def on_signal(signum, _frame):
        global ACTIVE_CHILD, INTERRUPT_REQUESTED
        signal_name = signal.Signals(signum).name
        if INTERRUPT_REQUESTED:
            if ACTIVE_CHILD is not None:
                try:
                    os.killpg(ACTIVE_CHILD.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            raise KeyboardInterrupt()
        INTERRUPT_REQUESTED = True
        print(f"收到{signal_name}，正在保存已经完成的识别结果...", file=sys.stderr, flush=True)
        if ACTIVE_CHILD is not None:
            try:
                os.killpg(ACTIVE_CHILD.pid, signal.SIGINT)
            except ProcessLookupError:
                pass
        raise KeyboardInterrupt()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    try:
        preflight(args, template)
        conflicts = detect_conflicting_processes()
        if conflicts:
            raise PipelineError("检测到其他本项目浏览器流程正在运行，请先结束后再启动：\n" + "\n".join(conflicts[:5]))
        output_dir.mkdir(parents=True, exist_ok=True)
        with pipeline_lock(lock_path), log_path.open("w", encoding="utf-8") as log_file:
            log_file.write(json.dumps(state, ensure_ascii=False) + "\n")
            log_file.flush()
            print(f"统一流程开始：模式 {args.mode}，数据日期 {date_value}")

            resume_state = {}
            if args.resume:
                resume_state = json.loads(Path(args.resume).expanduser().read_text(encoding="utf-8"))
                if str(resume_state.get("date")) != date_value:
                    raise PipelineError("--resume 状态文件的数据日期与本次日期不一致")
                print(f"断点续跑：读取状态 {args.resume}")
            elif args.retry_failed:
                resume_path, resume_state = latest_pipeline_state(log_dir, date_value)
                if not resume_path:
                    raise PipelineError("--retry-failed 未找到同一数据日期的历史状态文件，请先完成一轮完整流程")
                print(f"失败重跑：自动复用最近状态 {resume_path}")

            finebi_done = (
                resume_state.get("stages", {}).get("finebi", {}).get("status") == "completed"
                or resume_state.get("stages", {}).get("handoff", {}).get("status") == "completed"
            )
            merge_done = resume_state.get("stages", {}).get("merge", {}).get("status") == "completed"
            if args.mode == "recognize":
                if merge_path is None:
                    raise PipelineError("仅识别模式缺少工作簿路径")
                source_path = merge_path
                prepared_recognition_path = (
                    source_path
                    if args.in_place
                    else output_dir / f"{source_path.stem}_run{run_id}.xlsx"
                )
                if prepared_recognition_path.resolve() != source_path.resolve():
                    shutil.copy2(source_path, prepared_recognition_path)
                normalization = normalize_recognition_workbook(prepared_recognition_path, args.sheet)
                merge_path = prepared_recognition_path
                # 完整性校验可能在此处终止。先持久化规范化统计，保证失败状态
                # 也能说明哪些行被嵌套消息恢复、过滤或补全。
                state["stages"]["inputWorkbook"] = {
                    "status": "validating",
                    "sourcePath": str(source_path),
                    "path": str(merge_path),
                    "normalization": normalization,
                }
                write_json(state_path, state)
                merge_info = validate_merged_file(merge_path, args.sheet, 0)
                state["stages"]["inputWorkbook"] = {
                    "status": "completed",
                    "sourcePath": str(source_path),
                    "path": str(merge_path),
                    "normalization": normalization,
                    **merge_info,
                }
                write_json(state_path, state)
                if normalization["normalizedNestedMessages"]:
                    print(
                        "[1/1] 待识别 Excel 嵌套消息规范化："
                        f"已从 msg_list 提取文本 {normalization['normalizedNestedMessages']} 行"
                    )
                if normalization["filteredNoKeywordNestedMessageRows"]:
                    print(
                        "[1/1] 已过滤无关键词嵌套消息："
                        f"{len(normalization['filteredNoKeywordNestedMessageRows'])} 行"
                    )
                direct_no_keyword_rows = (
                    normalization["filteredNoKeywordRows"]
                    - len(normalization["filteredNoKeywordNestedMessageRows"])
                )
                if direct_no_keyword_rows:
                    print(
                        "[1/1] 已过滤无关键词消息："
                        f"{direct_no_keyword_rows} 行"
                    )
                if normalization["removedDuplicateRows"]:
                    print(
                        "[1/1] 待识别 Excel 自动去重："
                        f"重复用户 {normalization['duplicateUserCount']} 个，"
                        f"删除后续重复行 {normalization['removedDuplicateRows']} 行，保留首次出现记录"
                    )
                if normalization["filledStudentRoles"]:
                    print(
                        "[1/1] 待识别 Excel 自动补全："
                        f"{normalization['filledStudentRoles']} 行缺失角色已按有效敏感词消息补为“学员”"
                    )
                print(f"[1/1] 已校验待识别 Excel：{merge_path}")
            elif finebi_done and merge_done and Path(resume_state.get("stages", {}).get("merge", {}).get("path", merge_path)).exists():
                merge_path = Path(resume_state["stages"]["merge"].get("path", merge_path))
                state["stages"]["finebi"] = (
                    resume_state.get("stages", {}).get("finebi")
                    or resume_state.get("stages", {}).get("handoff", {})
                )
                state["stages"]["merge"] = resume_state.get("stages", {}).get("merge", {})
                print("[1/3] FineBI 下载已由断点状态确认，跳过")
                print("[2/3] Excel 合并已由断点状态确认，跳过")
            else:
                stage_started = time.time()
                state["stages"]["finebi"] = {"status": "running", "startedAt": datetime.now().isoformat(timespec="seconds")}
                write_json(state_path, state)
                print("[1/3] FineBI 下载开始")
                code, _ = run_finebi_download(
                    args,
                    date_value,
                    output_dir,
                    template,
                    log_file,
                )
                if code != 0:
                    raise PipelineError(f"FineBI 下载阶段失败，退出码：{code}")
                raw_info = validate_raw_files(
                    output_dir,
                    date_value,
                    stage_started,
                    args.allow_partial,
                )
                local_files = discover_local_exports(output_dir, date_value)
                missing_keywords = [
                    keyword for keyword in KEYWORDS
                    if not any(path.stem == f"{keyword}_{date_value}" for path in local_files)
                ]
                if missing_keywords and not args.allow_partial:
                    raise PipelineError(
                        "FineBI 下载文件不完整，缺少："
                        + "、".join(missing_keywords)
                        + "；如已确认这些关键词当天无数据，可使用 --allow-partial"
                    )
                if not local_files:
                    raise PipelineError(
                        f"FineBI 下载完成后，目录 {output_dir} 中没有发现命名为「关键词_{date_value}.xlsx」的文件"
                    )
                manifest = build_local_manifest(local_files, date_value)
                manifest_path = output_dir / f"finebi_download_{date_value}_{run_id}.json"
                write_json(manifest_path, manifest)
                state["stages"]["finebi"] = {
                    "status": "completed",
                    "endedAt": datetime.now().isoformat(timespec="seconds"),
                    "durationSeconds": round(time.time() - stage_started, 1),
                    "source": "finebi_automated_export",
                    "manifest": str(manifest_path),
                    **raw_info,
                    "missingKeywords": missing_keywords,
                }
                write_json(state_path, state)
                print(
                    f"[1/3] FineBI 下载完成：有效文件 {raw_info['validCount']} 个，"
                    f"来源清单：{manifest_path}"
                )

                merge_started = time.time()
                state["stages"]["merge"] = {"status": "running", "startedAt": datetime.now().isoformat(timespec="seconds")}
                write_json(state_path, state)
                print("[2/3] Excel 合并去重开始")
                local_merge = merge_local_exports(
                    local_files,
                    date_value,
                    merge_path,
                    template,
                    args.sheet,
                )
                merge_info = validate_merged_file(merge_path, args.sheet, stage_started)
                state["stages"]["merge"] = {
                    "status": "completed",
                    "endedAt": datetime.now().isoformat(timespec="seconds"),
                    "durationSeconds": round(time.time() - merge_started, 1),
                    "path": str(merge_path),
                    "downloadManifest": str(manifest_path),
                    "filtered": local_merge["filtered"],
                    **merge_info,
                }
                write_json(state_path, state)
                print(
                    f"[2/3] Excel 合并去重完成：{merge_path}，"
                    f"用户数 {merge_info['uniqueUserIds']}，"
                    f"耗时 {state['stages']['merge']['durationSeconds']} 秒"
                )

            if args.mode == "download":
                validate_merged_file(merge_path, args.sheet, 0)
                state["status"] = "completed"
                state["resultPath"] = str(merge_path)
                state["endedAt"] = datetime.now().isoformat(timespec="seconds")
                state["durationSeconds"] = round(time.time() - started_at, 1)
                write_json(state_path, state)
                print(f"FineBI 下载与合并完成：{merge_path}")
                print(f"WEB_PIPELINE_RESULT={merge_path}")
                print(f"WEB_PIPELINE_STATE={state_path}")
                return 0

            validate_merged_file(merge_path, args.sheet, 0)
            resume_result = resume_state.get("stages", {}).get("recognition", {}).get("path", "") if resume_state else ""
            result_path = Path(resume_result).expanduser() if resume_result else None
            if result_path is None or not result_path.exists():
                if prepared_recognition_path is not None:
                    result_path = prepared_recognition_path
                elif args.in_place:
                    result_path = merge_path
                elif args.mode == "recognize":
                    result_path = output_dir / f"{merge_path.stem}_run{run_id}.xlsx"
                else:
                    result_path = output_dir / f"{MERGE_PREFIX}_{date_value}_run{run_id}.xlsx"
            if result_path.resolve() != merge_path.resolve():
                shutil.copy2(merge_path, result_path)

            recognition_started = time.time()
            state["stages"]["recognition"] = {"status": "running", "startedAt": datetime.now().isoformat(timespec="seconds"), "path": str(result_path)}
            write_json(state_path, state)
            recognition_label = "[1/1]" if args.mode == "recognize" else "[3/3]"
            print(f"{recognition_label} 拟人工识别开始")
            headless_config = create_dom_config(shared_profile, headless=True)
            headful_config = create_dom_config(shared_profile, headless=False)
            previous_node_log = resume_state.get("stages", {}).get("recognition", {}).get("nodeLog", "")
            if args.retry_failed and not previous_node_log:
                raise PipelineError("--retry-failed 找不到上一轮 Node 识别日志，无法可靠筛选失败行")
            try:
                code, node_output = run_node_recognition(
                    args,
                    headless_config,
                    headful_config,
                    result_path,
                    log_file,
                    resume_log=previous_node_log,
                    retry_log=previous_node_log if args.retry_failed else "",
                )
                if code != 0:
                    raise PipelineError(f"拟人工 DOM 识别阶段失败，退出码：{code}")
                if not result_path.exists():
                    raise PipelineError("拟人工识别结束，但最终 Excel 不存在，未确认写回成功")

                first_node_log = extract_node_log(node_output)
                first_summary = summarize_node_log(first_node_log)
                fallback_node_log = ""
                fallback_summary = {"entryCount": 0, "failedRows": [], "reviewRows": 0, "completedRows": []}
                fallback_error = ""
                audit_node_log = ""
                audit_summary = {"entryCount": 0, "failedRows": [], "reviewRows": 0, "completedRows": []}
                audit_error = ""
                workbook_audit_before = {}
                workbook_audit_after = {}

                # 首轮完成后只对失败集合再跑一次，避免重新下载、重新合并，
                # 也避免全量重复消耗登录态和模型额度。
                if first_summary["failedRows"]:
                    print(
                        f"识别兜底开始：首轮发现 {len(first_summary['failedRows'])} 行待重跑，"
                        "仅重试一次失败集合"
                    )
                    state["stages"]["recognition"] = {
                        "status": "running",
                        "startedAt": state["stages"]["recognition"]["startedAt"],
                        "firstPassNodeLog": first_node_log,
                        "firstPassRetryableRows": first_summary["failedRows"],
                        "fallback": "pending",
                        "path": str(result_path),
                    }
                    write_json(state_path, state)
                    fallback_code, fallback_output = run_node_recognition(
                        args,
                        headless_config,
                        headful_config,
                        result_path,
                        log_file,
                        retry_log=first_node_log,
                        chat_only=True,
                    )
                    if fallback_code == 0:
                        fallback_node_log = extract_node_log(fallback_output)
                        fallback_summary = summarize_node_log(fallback_node_log)
                    else:
                        fallback_error = f"失败集合兜底退出码：{fallback_code}"
                        print(f"识别兜底未完成：{fallback_error}，保留首轮已写回结果")
                else:
                    print("首轮识别无失败集合，跳过兜底重跑")

                # 线上统一流程必须与本地 Node 终端保持相同的完结语义：
                # JSONL 已产生非瞬时失败的行结论即视为完成。Q/R/S 查无档案、
                # 待复核不写 T/U/V/W 都是合法结果，不得因列为空整行重跑。
                completed_rows = set(first_summary.get("completedRows", []))
                completed_rows.update(fallback_summary.get("completedRows", []))
                row_outcomes = collect_node_row_outcomes(first_node_log, fallback_node_log)
                workbook_audit_before = scan_recognition_gaps(
                    result_path,
                    args.sheet,
                    args.from_row,
                    args.to_row,
                    completed_rows=completed_rows,
                    row_outcomes=row_outcomes,
                )
                print(format_workbook_audit(workbook_audit_before))
                missing_rows = workbook_audit_before["missingRows"]
                if missing_rows:
                    print(
                        f"识别日志完整性补跑开始：发现 {len(missing_rows)} 行未形成完整结论，"
                        f"行集合={compact_row_list(missing_rows)}"
                    )
                    state["stages"]["recognition"]["workbookAuditBeforeRepair"] = workbook_audit_before
                    write_json(state_path, state)
                    audit_code, audit_output = run_node_recognition(
                        args,
                        headless_config,
                        headful_config,
                        result_path,
                        log_file,
                        row_list=missing_rows,
                    )
                    if audit_code == 0:
                        audit_node_log = extract_node_log(audit_output)
                        audit_summary = summarize_node_log(audit_node_log)
                        completed_rows.update(audit_summary.get("completedRows", []))
                        row_outcomes = collect_node_row_outcomes(
                            first_node_log, fallback_node_log, audit_node_log
                        )
                    else:
                        audit_error = f"Excel 空白字段补跑退出码：{audit_code}"
                        print(f"Excel 完整性补跑未完成：{audit_error}")
                else:
                    print("识别日志完整性审计通过：所有目标行均已形成结论，跳过补跑")

                workbook_audit_after = scan_recognition_gaps(
                    result_path,
                    args.sheet,
                    args.from_row,
                    args.to_row,
                    completed_rows=completed_rows,
                    row_outcomes=row_outcomes,
                )
                print(format_workbook_audit(workbook_audit_after))
                if workbook_audit_after["missingRows"]:
                    print(
                        f"识别日志完整性审计仍有 {workbook_audit_after['missingCount']} 行未形成结论："
                        f"{compact_row_list(workbook_audit_after['missingRows'])}"
                    )
                elif has_incomplete_workbook_audit(workbook_audit_after):
                    print("识别日志完整性审计结束：工作簿存在非写回类缺口，请按逐行核对结果复核")
                else:
                    print("识别日志完整性审计完成：所有目标行均已形成结论")
            finally:
                for config_path in (headless_config, headful_config):
                    try:
                        Path(config_path).unlink()
                    except OSError:
                        pass
            if not result_path.exists():
                raise PipelineError("拟人工识别结束，但最终 Excel 不存在，未确认写回成功")
            node_log = audit_node_log or fallback_node_log or first_node_log
            write_counts = count_written_fields(result_path, args.sheet)
            recognition_summary = merge_recognition_summaries(
                first_summary, fallback_summary, audit_summary
            )
            remaining_missing_rows = workbook_audit_after.get("missingRows", [])
            recognition_partial = bool(
                recognition_summary["failedRows"]
                or fallback_error
                or audit_error
                or has_incomplete_workbook_audit(workbook_audit_after)
            )
            state["stages"]["recognition"] = {
                "status": "partial" if recognition_partial else "completed",
                "endedAt": datetime.now().isoformat(timespec="seconds"),
                "durationSeconds": round(time.time() - recognition_started, 1),
                "path": str(result_path),
                "nodeLog": node_log,
                "writtenFieldCounts": write_counts,
                "firstPassNodeLog": first_node_log,
                "firstPassRetryableRows": first_summary["failedRows"],
                "fallbackNodeLog": fallback_node_log,
                "fallbackRetryableRows": fallback_summary["failedRows"],
                "fallbackAttempted": bool(first_summary["failedRows"]),
                "fallbackError": fallback_error,
                "workbookAuditBeforeRepair": workbook_audit_before,
                "auditRepairNodeLog": audit_node_log,
                "auditRepairSummary": audit_summary,
                "auditRepairError": audit_error,
                "workbookAuditAfterRepair": workbook_audit_after,
                **recognition_summary,
            }
            state["status"] = "partial" if recognition_partial else "completed"
            state["endedAt"] = datetime.now().isoformat(timespec="seconds")
            state["durationSeconds"] = round(time.time() - started_at, 1)
            write_json(state_path, state)
            print(
                f"{recognition_label} 拟人工识别完成：{result_path}，"
                f"耗时 {state['stages']['recognition']['durationSeconds']} 秒"
            )
            print(f"写回统计：{write_counts}")
            print(f"统一流程日志：{log_path}")
            print(f"统一流程状态：{state_path}")
            if state["status"] == "partial":
                print(
                    "流程完成，但仍有待修复行："
                    f"日志失败={recognition_summary['failedRows']}；"
                    f"Excel缺字段={remaining_missing_rows}；可用 --retry-failed 重试"
                )
            else:
                print("流程全部完成")
            print(f"WEB_PIPELINE_RESULT={result_path}")
            print(f"WEB_PIPELINE_STATE={state_path}")
        return 0
    except KeyboardInterrupt:
        partial_path = finalize_interrupted_state(state, started_at)
        write_json(state_path, state)
        if partial_path:
            print(f"流程已终止，当前识别进度已保存：{partial_path}", file=sys.stderr)
            print(f"WEB_PIPELINE_RESULT={partial_path}")
        else:
            print("流程已终止，当前阶段尚无可下载结果", file=sys.stderr)
        print(f"WEB_PIPELINE_STATE={state_path}")
        return 130
    except Exception as exc:
        for stage in state.get("stages", {}).values():
            if stage.get("status") in {"running", "validating"}:
                stage["status"] = "failed"
                stage["error"] = str(exc)
                stage["endedAt"] = datetime.now().isoformat(timespec="seconds")
        recognition = state.get("stages", {}).get("recognition")
        partial_path = None
        if isinstance(recognition, dict):
            candidate = Path(str(recognition.get("path") or "")).expanduser()
            if candidate.suffix.lower() == ".xlsx" and candidate.exists() and candidate.is_file():
                partial_path = candidate if candidate.is_absolute() else candidate.absolute()
                recognition["partialResult"] = True
        state["status"] = "failed"
        state["error"] = str(exc)
        state["partialResult"] = bool(partial_path)
        if partial_path:
            state["resultFile"] = str(partial_path)
        state["endedAt"] = datetime.now().isoformat(timespec="seconds")
        write_json(state_path, state)
        print(f"流程终止：{exc}", file=sys.stderr)
        if partial_path:
            print(f"当前识别进度已保存：{partial_path}", file=sys.stderr)
            print(f"WEB_PIPELINE_RESULT={partial_path}")
        print(f"状态文件：{state_path}", file=sys.stderr)
        print(f"WEB_PIPELINE_STATE={state_path}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
