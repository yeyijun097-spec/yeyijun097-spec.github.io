import { cleanText } from "./domUtils.js";

const DETAIL_FIELDS = ["投诉来源", "投诉时间", "第三方投诉单号", "投诉详情"];

export async function queryComplaintRecords({ page, config, query, trace = [], logger }) {
  trace.push("投诉工单");
  // 全部识别从学员档案页切到独立投诉页时，必须重新取得浏览器焦点。
  // 否则 headful 模式下输入动作可能发给仍在前台的档案页。
  await page.bringToFront().catch(() => {});
  const diagnostics = createComplaintDiagnostics();
  diagnostics.complaintPageIsolated = true;
  const pageReady = await openComplaintWorkPage(
    page,
    config.browser.complaintWorkUrl,
    config.ui.afterGotoWaitMs
  );
  if (!pageReady.opened) {
    const snapshot = await logger.pageSnapshot(page, "complaint-page-open-failed", query);
    const probe = logger.writeJson("complaint-page-open-probe", pageReady);
    return complaintFailure(
      `投诉工单页面未打开或未完成加载${snapshot ? `，调试日志：${snapshot}` : ""}${probe ? `，DOM探针：${probe}` : ""}`,
      null,
      markComplaintTechnicalFailure(diagnostics, "投诉工单页面未打开或未完成加载")
    );
  }
  trace.push("投诉工单页已验证");

  const readiness = await clearComplaintDateRange(page);
  trace.push("清投诉日期");
  if (!readiness.cleared) {
    const snapshot = await logger.pageSnapshot(page, "complaint-date-clear-failed", query);
    return complaintFailure(
      `投诉日期范围清理失败${snapshot ? `，调试日志：${snapshot}` : ""}`,
      readiness,
      markComplaintTechnicalFailure(diagnostics, "投诉日期范围清理失败")
    );
  }

  diagnostics.complaintAllTabVerified = await activateComplaintAllTab(page);
  trace.push("投诉状态全部");
  if (!diagnostics.complaintAllTabVerified) {
    const snapshot = await logger.pageSnapshot(page, "complaint-all-tab-verify-failed", query);
    return complaintFailure(
      `投诉工单“全部”状态未能确认${snapshot ? `，调试日志：${snapshot}` : ""}`,
      readiness,
      markComplaintTechnicalFailure(diagnostics, "投诉工单“全部”状态未能确认")
    );
  }
  await expandComplaintFilters(page);

  const prepared = await prepareComplaintUserIdFilter(page, query.userId, diagnostics);
  trace.push("填投诉用户ID");
  logger.writeJson("complaint-user-id-after-fill", {
    diagnostics,
    filter: await probeComplaintUserIdDom(page)
  });
  if (!prepared.ok) {
    const snapshot = await logger.pageSnapshot(page, "complaint-user-id-fill-failed", query);
    const probe = logger.writeJson("complaint-user-id-dom-probe", await probeComplaintUserIdDom(page));
    return complaintFailure(
      `${prepared.error}${snapshot ? `，调试日志：${snapshot}` : ""}${probe ? `，DOM探针：${probe}` : ""}`,
      readiness,
      markComplaintTechnicalFailure(diagnostics, prepared.error)
    );
  }

  const beforeQuery = await readComplaintResultState(page, query.userId);
  diagnostics.queryStateBefore = beforeQuery;
  const verifiedBeforeClick = await verifyComplaintFilterBeforeQuery(page, query.userId);
  if (!verifiedBeforeClick.ok) {
    const snapshot = await logger.pageSnapshot(page, "complaint-filter-before-query-invalid", query);
    return complaintFailure(
      `${verifiedBeforeClick.error}${snapshot ? `，调试日志：${snapshot}` : ""}`,
      readiness,
      markComplaintTechnicalFailure(diagnostics, verifiedBeforeClick.error)
    );
  }
  const clicked = await clickComplaintQuery(page);
  diagnostics.complaintQueryClicked = clicked;
  trace.push("查询投诉工单");
  if (!clicked) {
    const snapshot = await logger.pageSnapshot(page, "complaint-query-click-failed", query);
    return complaintFailure(
      `投诉查询按钮未点击${snapshot ? `，调试日志：${snapshot}` : ""}`,
      readiness,
      markComplaintTechnicalFailure(diagnostics, "投诉查询按钮未点击")
    );
  }

  const resultState = await waitForComplaintQueryResult(page, query.userId, beforeQuery, 12000);
  diagnostics.complaintResultChanged = resultState.changed;
  diagnostics.complaintResultUserIdMatched = resultState.userIdMatched;
  diagnostics.queryStateAfter = resultState.state;
  logger.writeJson("complaint-user-id-after-query", {
    diagnostics,
    filter: await probeComplaintUserIdDom(page),
    resultState
  });
  if (!resultState.ok) {
    const snapshot = await logger.pageSnapshot(page, "complaint-query-result-invalid", query);
    return complaintFailure(
      `${resultState.error}${snapshot ? `，调试日志：${snapshot}` : ""}`,
      readiness,
      markComplaintTechnicalFailure(diagnostics, resultState.error)
    );
  }

  const tabs = await readComplaintTabs(page);
  const collected = await collectComplaintDetails(page, query, trace, logger);
  trace.push(`投诉记录${collected.records.length}条`);

  return {
    found: collected.records.length > 0,
    records: collected.records,
    tabs,
    error: collected.error || "",
    evidence: [
      {
        source: "投诉工单",
        type: "summary",
        text: tabs.map((item) => `${item.label}${item.count === null ? "" : `(${item.count})`}`).join("、") || "未读取到状态计数"
      }
    ],
    dateRange: readiness,
    diagnostics
  };
}

async function openComplaintWorkPage(page, url, afterGotoWaitMs) {
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(Math.max(500, Number(afterGotoWaitMs || 1200))).catch(() => {});
    const inspected = await waitForComplaintWorkPage(page, 8000);
    attempts.push({ attempt, source: "direct-url", ...inspected });
    if (inspected.ready) return { opened: true, attempts, final: inspected };
  }

  const menuOpened = await openComplaintWorkFromMenu(page);
  const inspected = await waitForComplaintWorkPage(page, 8000);
  attempts.push({ attempt: 3, source: "menu", menuOpened, ...inspected });
  return { opened: inspected.ready, attempts, final: inspected };
}

async function waitForComplaintWorkPage(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let inspected = await inspectComplaintWorkPage(page);
  while (!inspected.ready && Date.now() < deadline) {
    await page.waitForTimeout(250).catch(() => {});
    inspected = await inspectComplaintWorkPage(page);
  }
  return inspected;
}

async function inspectComplaintWorkPage(page) {
  return await page.evaluate(() => {
    const normalize = (text) => String(text || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 8 && rect.height > 8
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const bodyText = normalize(document.body?.innerText || "");
    const exactTexts = [...document.querySelectorAll("span,div,a,button")]
      .filter(visible)
      .map((el) => normalize(el.innerText || el.textContent));
    const hasTitle = exactTexts.includes("投诉工单");
    const hasQuery = [...document.querySelectorAll("button,a,[role='button']")]
      .filter(visible)
      .some((el) => normalize(el.innerText || el.textContent) === "查询");
    const markers = ["投诉来源", "投诉品类", "投诉部门", "主投诉订单ID", "待认领", "处理中"]
      .filter((text) => bodyText.includes(text));
    const loginLike = bodyText.includes("获取验证码") && bodyText.includes("登录");
    return {
      ready: !loginLike && hasTitle && hasQuery && markers.length >= 2,
      href: location.href,
      hasTitle,
      hasQuery,
      markers,
      loginLike,
      bodySnippet: String(document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 800)
    };
  }).catch(() => ({
    ready: false,
    href: page.url(),
    hasTitle: false,
    hasQuery: false,
    markers: [],
    loginLike: false,
    bodySnippet: ""
  }));
}

async function openComplaintWorkFromMenu(page) {
  await clickVisibleExactText(page, "投诉管理").catch(() => false);
  await page.waitForTimeout(500).catch(() => {});
  const clicked = await clickVisibleExactText(page, "投诉工单").catch(() => false);
  if (clicked) await page.waitForTimeout(800).catch(() => {});
  return clicked;
}

async function clickVisibleExactText(page, text) {
  const candidates = page.getByText(text, { exact: true });
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const clickable = candidate.locator("xpath=ancestor-or-self::*[self::a or self::button or @role='button' or contains(@class,'menu')][1]");
    const target = await clickable.count().catch(() => 0) ? clickable.first() : candidate;
    if (await target.click({ timeout: 2500 }).then(() => true).catch(() => false)) return true;
  }
  return false;
}

function createComplaintDiagnostics() {
  return {
    complaintPageIsolated: false,
    complaintFilterPairFound: false,
    complaintFilterModeVerified: false,
    complaintUserIdFilled: false,
    complaintUserIdStable: false,
    complaintFillMethod: "",
    complaintFillAttempts: [],
    complaintInputRebound: false,
    complaintStableReadValues: [],
    complaintInputClearedAfterMs: null,
    complaintQueryClicked: false,
    complaintResultChanged: false,
    complaintResultUserIdMatched: false,
    complaintAllTabVerified: false,
    complaintRetryReason: "",
    filterPrepareAttempts: 0,
    queryStateBefore: null,
    queryStateAfter: null,
    technicalFailure: false,
    technicalFailureReason: ""
  };
}

function markComplaintTechnicalFailure(diagnostics, reason) {
  diagnostics.technicalFailure = true;
  diagnostics.technicalFailureReason = reason;
  return diagnostics;
}

function complaintFailure(error, dateRange = null, diagnostics = createComplaintDiagnostics()) {
  return {
    found: false,
    records: [],
    tabs: [],
    evidence: [],
    error,
    dateRange,
    diagnostics
  };
}

async function clearComplaintDateRange(page) {
  await clickTopButton(page, "重置").catch(() => false);
  await page.waitForTimeout(250).catch(() => {});
  const expanded = await expandComplaintFilters(page);
  await page.waitForTimeout(250).catch(() => {});
  const range = await findComplaintDateRange(page);
  if (!range) {
    return {
      cleared: false,
      expanded,
      before: [],
      remaining: [],
      touched: 0,
      clearButtons: 0,
      reason: "投诉时间范围控件未找到"
    };
  }

  const inputs = range.locator("input");
  const inputCount = await inputs.count();
  const before = [];
  for (let index = 0; index < inputCount; index += 1) {
    before.push(await inputs.nth(index).inputValue().catch(() => ""));
  }

  await range.hover().catch(() => {});
  const clearButtons = range.locator(".el-range__close-icon, .el-input__clear, .ant-picker-clear");
  const clearButtonCount = await clearButtons.count();
  let clearClicked = false;
  for (let index = 0; index < clearButtonCount; index += 1) {
    const button = clearButtons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    await button.click({ force: true }).catch(() => {});
    clearClicked = true;
    break;
  }
  await page.waitForTimeout(250).catch(() => {});

  let remaining = [];
  for (let index = 0; index < inputCount; index += 1) {
    const input = inputs.nth(index);
    let value = await input.inputValue().catch(() => "");
    if (value) {
      await input.fill("").catch(() => {});
      await input.dispatchEvent("change").catch(() => {});
      value = await input.inputValue().catch(() => "");
    }
    if (value) remaining.push(value);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200).catch(() => {});

  return {
    cleared: remaining.length === 0,
    expanded,
    before,
    remaining,
    touched: inputCount,
    clearButtons: clearButtonCount,
    clearClicked
  };
}

async function expandComplaintFilters(page) {
  if ((await discoverComplaintFilterPairs(page)).selected) return true;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const expand = page.getByText("展开", { exact: true });
    const count = await expand.count().catch(() => 0);
    let clicked = false;
    for (let index = 0; index < count; index += 1) {
      const candidate = expand.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      clicked = await candidate.click({ force: true, timeout: 2500 }).then(() => true).catch(() => false);
      if (clicked) break;
    }
    if (!clicked) return false;
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      if ((await discoverComplaintFilterPairs(page)).selected) return true;
      await page.waitForTimeout(200).catch(() => {});
    }
  }
  return false;
}

export function selectComplaintUserIdPair(pairs = []) {
  const normalized = pairs.map((pair) => {
    const selectorText = String(pair.pairSelectorText || "").replace(/\s+/g, "").trim();
    const selectorValue = String(pair.pairSelectorValue || "").replace(/\s+/g, "").trim();
    const selectorInputValue = String(pair.pairSelectorInputValue || "").replace(/\s+/g, "").trim();
    const exactUserId = [selectorText, selectorValue, selectorInputValue]
      .some((value) => /^用户id$/i.test(value));
    const internalId = [selectorText, selectorValue].some((value) => /^id$/i.test(value));
    return {
      ...pair,
      score: (exactUserId ? 10000 : 0)
        + (internalId ? 1000 : 0)
        + (pair.inputEditable ? 300 : 0)
        + (pair.sameContainer ? 200 : 0)
        + (pair.domBinding === "user-id-label-ancestor" ? 800 : 0)
        - Math.abs(Number(pair.verticalDelta || 0)) * 20
        - Math.max(0, Number(pair.horizontalGap || 0))
    };
  });
  return normalized
    .filter((pair) => pair.inputEditable && (pair.score >= 1000))
    .sort((a, b) => b.score - a.score || a.pairIndex - b.pairIndex)[0] || null;
}

function complaintPairHasUserIdMode(pair) {
  if (!pair) return false;
  return [pair.pairSelectorText, pair.pairSelectorValue, pair.pairSelectorInputValue]
    .some((value) => /^用户id$/i.test(String(value || "").replace(/\s+/g, "").trim()));
}

async function discoverComplaintFilterPairs(page) {
  const pairs = await page.evaluate(() => {
    const normalize = (text) => String(text || "").replace(/\s+/g, "").trim();
    const readable = (el) => {
      if (!el) return "";
      const ownText = [...el.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join("");
      return normalize(ownText || el.innerText || el.textContent || "");
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 6 && rect.height > 6
        && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden"
        && Number(style.opacity || 1) !== 0;
    };
    const domInputs = [...document.querySelectorAll("input")];
    const allInputs = domInputs
      .filter(visible)
      .filter((el) => !el.disabled && String(el.type || "").toLowerCase() !== "hidden")
      .map((el) => ({
        el,
        domIndex: domInputs.indexOf(el),
        rect: el.getBoundingClientRect(),
        editable: !el.readOnly,
        placeholder: normalize(el.placeholder),
        value: normalize(el.value),
        title: normalize(el.title),
        ariaLabel: normalize(el.getAttribute("aria-label"))
      }));
    const allNodes = [...document.querySelectorAll("*")];
    const selectorTexts = new Set(["用户ID", "用户id", "手机号", "订单号", "用户名称"]);
    const selectorCandidates = allNodes
      .filter(visible)
      .map((el) => {
        const text = readable(el);
        const aria = normalize(el.getAttribute("aria-label"));
        const role = String(el.getAttribute("role") || "").toLowerCase();
        const cls = String(el.className || "").toLowerCase();
        const isInput = String(el.tagName || "").toUpperCase() === "INPUT";
        const inputValue = isInput ? normalize(el.value) : "";
        const exactText = selectorTexts.has(text) || selectorTexts.has(inputValue);
        const selectorLike = exactText || role === "combobox" || el.hasAttribute("aria-haspopup")
          || /select|dropdown|combobox/.test(cls);
        return {
          el,
          nodeIndex: allNodes.indexOf(el),
          domIndex: isInput ? domInputs.indexOf(el) : -1,
          text,
          inputValue,
          aria,
          rect: el.getBoundingClientRect(),
          selectorLike,
          exactText
        };
      })
      .filter((item) => item.selectorLike && (item.exactText || item.text.length <= 36));
    const editableInputs = allInputs.filter((item) => item.editable);
    const findContainer = (left, right) => {
      let node = left.parentElement;
      for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
        if (!node.contains(right)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 1200 && rect.height <= 180) return node;
      }
      return null;
    };
    const findClickableTarget = (node) => {
      let target = node;
      for (let depth = 0; target && depth < 5; depth += 1, target = target.parentElement) {
        const role = String(target.getAttribute("role") || "").toLowerCase();
        const cls = String(target.className || "").toLowerCase();
        if (target.tagName === "BUTTON" || role === "combobox" || role === "button"
          || target.hasAttribute("aria-haspopup") || /select|dropdown|combobox/.test(cls)) {
          return target;
        }
      }
      return node;
    };
    const result = [];
    for (const selector of selectorCandidates) {
      for (const input of editableInputs) {
        if (input.el === selector.el) continue;
        const selectorY = selector.rect.top + selector.rect.height / 2;
        const inputY = input.rect.top + input.rect.height / 2;
        const verticalDelta = Math.abs(selectorY - inputY);
        const horizontalGap = input.rect.left - selector.rect.right;
        if (verticalDelta > 38 || horizontalGap < -30 || horizontalGap > 560) continue;
        const container = findContainer(selector.el, input.el);
        const clickable = findClickableTarget(selector.el);
        const selectorText = selector.text || selector.aria;
        const selectorValue = normalize(
          selector.inputValue || selector.el.getAttribute("data-value")
            || selector.el.getAttribute("title") || selector.aria || selectorText
        );
        result.push({
          pairIndex: result.length,
          selectorDomIndex: selector.domIndex ?? -1,
          selectorNodeIndex: selector.nodeIndex,
          selectorTargetNodeIndex: allNodes.indexOf(clickable),
          inputDomIndex: input.domIndex,
          pairSelectorText: selectorText,
          pairSelectorValue: selectorValue,
          pairSelectorInputValue: selector.inputValue,
          pairInputValue: input.value,
          pairInputPlaceholder: input.placeholder,
          pairContainerText: normalize(container?.innerText || container?.textContent).slice(0, 300),
          inputEditable: input.editable,
          sameContainer: Boolean(container),
          verticalDelta: Math.round(verticalDelta),
          horizontalGap: Math.round(horizontalGap),
          selectorRect: { x: Math.round(selector.rect.x), y: Math.round(selector.rect.y), width: Math.round(selector.rect.width), height: Math.round(selector.rect.height) },
          inputRect: { x: Math.round(input.rect.x), y: Math.round(input.rect.y), width: Math.round(input.rect.width), height: Math.round(input.rect.height) }
        });
      }
    }

    // 云端“全部查询”返回的投诉页经常包含两组筛选控件，且右侧输入框
    // 可能被包在同一表单项的更深层节点中。几何距离配对在重绘后会失效，
    // 这里再按“用户ID文本 -> 最近可编辑输入框”的 DOM 祖先关系补一次。
    const exactUserIdNodes = allNodes.filter((el) => visible(el) && (
      normalize(readable(el)) === "用户ID"
      || normalize(el.getAttribute("aria-label")) === "用户ID"
      || normalize(el.getAttribute("title")) === "用户ID"
      || (String(el.tagName || "").toUpperCase() === "INPUT" && normalize(el.value) === "用户ID")
    ));
    for (const selector of exactUserIdNodes) {
      let current = selector;
      let fallback = null;
      for (let depth = 0; current && depth < 9; depth += 1, current = current.parentElement) {
        const localInputs = editableInputs.filter((item) => current.contains(item.el) && item.el !== selector);
        if (!localInputs.length) continue;
        const selectorRect = selector.getBoundingClientRect();
        const rightInputs = localInputs
          .filter((item) => item.rect.left >= selectorRect.right - 4)
          .sort((a, b) => {
            const da = Math.abs((a.rect.top + a.rect.height / 2) - (selectorRect.top + selectorRect.height / 2));
            const db = Math.abs((b.rect.top + b.rect.height / 2) - (selectorRect.top + selectorRect.height / 2));
            return da - db || a.rect.left - b.rect.left;
          });
        fallback = rightInputs[0] || localInputs
          .filter((item) => !item.el.closest("[role='combobox'], [role='button'], button"))
          .sort((a, b) => a.rect.left - b.rect.left)[0];
        if (fallback) break;
      }
      if (!fallback) continue;
      const clickable = findClickableTarget(selector);
      const selectorRect = selector.getBoundingClientRect();
      const inputRect = fallback.rect;
      result.push({
        pairIndex: result.length,
        selectorDomIndex: selector.tagName === "INPUT" ? domInputs.indexOf(selector) : -1,
        selectorNodeIndex: allNodes.indexOf(selector),
        selectorTargetNodeIndex: allNodes.indexOf(clickable),
        inputDomIndex: fallback.domIndex,
        pairSelectorText: "用户ID",
        pairSelectorValue: normalize(selector.getAttribute("data-value") || selector.getAttribute("title") || "用户ID"),
        pairSelectorInputValue: selector.tagName === "INPUT" ? normalize(selector.value) : "",
        pairInputValue: fallback.value,
        pairInputPlaceholder: fallback.placeholder,
        pairContainerText: normalize(selector.parentElement?.innerText || selector.parentElement?.textContent).slice(0, 300),
        inputEditable: fallback.editable,
        sameContainer: true,
        verticalDelta: Math.round(Math.abs((selectorRect.top + selectorRect.height / 2) - (inputRect.top + inputRect.height / 2))),
        horizontalGap: Math.round(inputRect.left - selectorRect.right),
        selectorRect: { x: Math.round(selectorRect.x), y: Math.round(selectorRect.y), width: Math.round(selectorRect.width), height: Math.round(selectorRect.height) },
        inputRect: { x: Math.round(inputRect.x), y: Math.round(inputRect.y), width: Math.round(inputRect.width), height: Math.round(inputRect.height) },
        domBinding: "user-id-label-ancestor"
      });
    }

    // 某些云端版本只把“用户ID”渲染在筛选行的 aria-label/祖先文本中，
    // 页面上没有可单独读取的“用户ID”节点。此时从可编辑输入框反向沿
    // DOM 祖先查找同一表单项，再绑定该行的选择器，避免退回全页面猜测。
    for (const input of editableInputs) {
      let current = input.el.parentElement;
      let binding = null;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const text = normalize(current.innerText || current.textContent || "");
        if (!text.includes("用户ID") || text.length > 360) continue;
        const candidates = [...current.querySelectorAll("[role='combobox'], [role='button'], button, input, [aria-haspopup], [data-value]")]
          .filter((el) => el !== input.el && visible(el))
          .filter((el) => {
            const value = normalize(el.value || el.getAttribute("data-value") || el.getAttribute("aria-label") || readable(el));
            return value === "用户ID" || value === "用户id" || value === "ID";
          });
        if (candidates.length) {
          binding = { ancestor: current, selector: candidates[0] };
          break;
        }
      }
      if (!binding) continue;
      const selector = binding.selector;
      const selectorRect = selector.getBoundingClientRect();
      const inputRect = input.rect;
      result.push({
        pairIndex: result.length,
        selectorDomIndex: selector.tagName === "INPUT" ? domInputs.indexOf(selector) : -1,
        selectorNodeIndex: allNodes.indexOf(selector),
        selectorTargetNodeIndex: allNodes.indexOf(findClickableTarget(selector)),
        inputDomIndex: input.domIndex,
        pairSelectorText: "用户ID",
        pairSelectorValue: "用户ID",
        pairSelectorInputValue: selector.tagName === "INPUT" ? normalize(selector.value) : "",
        pairInputValue: input.value,
        pairInputPlaceholder: input.placeholder,
        pairContainerText: normalize(binding.ancestor.innerText || binding.ancestor.textContent).slice(0, 300),
        inputEditable: input.editable,
        sameContainer: true,
        verticalDelta: Math.round(Math.abs((selectorRect.top + selectorRect.height / 2) - (inputRect.top + inputRect.height / 2))),
        horizontalGap: Math.round(inputRect.left - selectorRect.right),
        selectorRect: { x: Math.round(selectorRect.x), y: Math.round(selectorRect.y), width: Math.round(selectorRect.width), height: Math.round(selectorRect.height) },
        inputRect: { x: Math.round(inputRect.x), y: Math.round(inputRect.y), width: Math.round(inputRect.width), height: Math.round(inputRect.height) },
        domBinding: "user-id-row-ancestor"
      });
    }
    return result;
  }).catch(() => []);

  const selected = selectComplaintUserIdPair(pairs);
  if (selected) {
    const pairId = `complaint-userid-${selected.selectorNodeIndex}-${selected.inputDomIndex}`;
    const marked = await page.evaluate(({ selectorDomIndex, selectorNodeIndex, selectorTargetNodeIndex, inputDomIndex, pairId: id }) => {
      document.querySelectorAll("[data-codex-complaint-pair-id]").forEach((el) => {
        el.removeAttribute("data-codex-complaint-pair-id");
        el.removeAttribute("data-codex-complaint-pair-role");
        el.removeAttribute("data-codex-complaint-userid");
      });
      const inputs = [...document.querySelectorAll("input")];
      const allNodes = [...document.querySelectorAll("*")];
      const selector = inputs[Number(selectorDomIndex)] || allNodes[Number(selectorNodeIndex)];
      const target = allNodes[Number(selectorTargetNodeIndex)] || selector;
      const input = inputs[inputDomIndex];
      if (!selector || !target || !input || input.readOnly || input.disabled) return false;
      selector.setAttribute("data-codex-complaint-pair-id", id);
      selector.setAttribute("data-codex-complaint-pair-role", "selector");
      if (target !== selector) {
        target.setAttribute("data-codex-complaint-pair-id", id);
        target.setAttribute("data-codex-complaint-pair-role", "target");
      }
      input.setAttribute("data-codex-complaint-pair-id", id);
      input.setAttribute("data-codex-complaint-pair-role", "input");
      input.setAttribute("data-codex-complaint-userid", "1");
      return true;
    }, {
      selectorDomIndex: selected.selectorDomIndex,
      selectorNodeIndex: selected.selectorNodeIndex,
      selectorTargetNodeIndex: selected.selectorTargetNodeIndex,
      inputDomIndex: selected.inputDomIndex,
      pairId
    }).catch(() => false);
    if (marked) return { pairs, selected: { ...selected, pairId } };
  }
  return { pairs, selected: null };
}

async function probeComplaintUserIdDom(page) {
  const discovered = await discoverComplaintFilterPairs(page);
  const snapshot = await page.evaluate(() => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const safeValue = (value) => {
      const normalized = normalize(value);
      return /^\d{5,}$/.test(normalized) ? `[digits:${normalized.length}]` : normalized.slice(0, 120);
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 6 && rect.height > 6
        && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden"
        && Number(style.opacity || 1) !== 0;
    };
    return {
      href: location.href,
      titleCount: [...document.querySelectorAll("span,div,a")]
        .filter(visible)
        .filter((el) => normalize(el.innerText || el.textContent) === "投诉工单").length,
      inputs: [...document.querySelectorAll("input")]
        .filter(visible)
        .slice(0, 80)
        .map((el, index) => {
          const rect = el.getBoundingClientRect();
          return {
            index,
            placeholder: normalize(el.placeholder),
            value: safeValue(el.value),
            title: normalize(el.title),
            ariaLabel: normalize(el.getAttribute("aria-label")),
            readOnly: Boolean(el.readOnly),
            disabled: Boolean(el.disabled),
            marked: el.getAttribute("data-codex-complaint-userid") === "1",
            pairId: el.getAttribute("data-codex-complaint-pair-id") || "",
            pairRole: el.getAttribute("data-codex-complaint-pair-role") || "",
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
          };
        }),
      userIdTexts: [...document.querySelectorAll("label,span,div")]
        .filter(visible)
        .filter((el) => /^用户id$/i.test(normalize(el.innerText || el.textContent).replace(/\s+/g, "")))
        .slice(0, 30)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            className: String(el.className || "").slice(0, 180),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
          };
        })
    };
  }).catch(() => ({ href: page.url(), titleCount: 0, inputs: [], userIdTexts: [] }));
  return {
    ...snapshot,
    pairs: discovered.pairs,
    selectedPair: discovered.selected
  };
}

async function findComplaintDateRange(page) {
  const selectors = [
    ".el-date-editor--datetimerange",
    ".el-date-editor.el-range-editor",
    ".ant-picker-range"
  ];
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const box = await candidate.boundingBox().catch(() => null);
      if (!box || box.y > 500 || box.width < 260) continue;
      if (await candidate.locator("input").count().catch(() => 0) < 2) continue;
      return candidate;
    }
  }
  return null;
}

async function prepareComplaintUserIdFilter(page, userId, diagnostics) {
  const expected = String(userId || "").replace(/\s+/g, "").trim();
  if (!expected) return { ok: false, error: "投诉查询缺少用户ID" };
  if (!/^\d{6,20}$/.test(expected)) {
    diagnostics.complaintRetryReason = "投诉查询取得的用户ID不是有效数字";
    return { ok: false, error: diagnostics.complaintRetryReason };
  }

  const fillMethods = ["playwright-fill", "locator-sequential", "vue-model", "dom-native"];
  for (let attempt = 1; attempt <= fillMethods.length; attempt += 1) {
    diagnostics.filterPrepareAttempts = attempt;
    if (!await expandComplaintFilters(page)) {
      diagnostics.complaintRetryReason = "投诉用户ID条件选择器未找到";
      continue;
    }

    const stablePair = await waitForStableComplaintFilterPair(page, 5200);
    if (!stablePair) {
      diagnostics.complaintRetryReason = "投诉用户ID右侧输入框未找到";
      continue;
    }
    diagnostics.complaintFilterPairFound = true;

    if (!complaintPairHasUserIdMode(stablePair)) {
      const switched = await switchComplaintPairToUserId(page, stablePair);
      if (!switched) {
        diagnostics.complaintRetryReason = "投诉用户ID条件选择器未找到";
        continue;
      }
    }
    diagnostics.complaintFilterModeVerified = true;

    const rebound = await discoverComplaintFilterPairs(page);
    const pair = rebound.selected;
    if (!pair?.pairId || !complaintPairHasUserIdMode(pair)) {
      diagnostics.complaintRetryReason = "投诉用户ID条件选择器未找到";
      continue;
    }
    let input = await resolveComplaintPairInput(page, pair);
    if (!input) {
      diagnostics.complaintRetryReason = "投诉用户ID右侧输入框未找到";
      continue;
    }
    if (!await waitForComplaintInputReady(page, input)) {
      diagnostics.complaintRetryReason = "投诉用户ID右侧输入框未找到";
      continue;
    }

    const fillMethod = fillMethods[attempt - 1];
    diagnostics.complaintFillMethod = fillMethod;
    diagnostics.complaintStableReadValues = [];
    diagnostics.complaintInputClearedAfterMs = null;
    if (attempt > 1) diagnostics.complaintInputRebound = true;

    // 等待可编辑期间筛选行仍可能重绘。提交前再绑定一次当前可见节点，
    // 不能把值写进已经脱离页面或隐藏的旧 input。
    const freshPairs = await discoverComplaintFilterPairs(page);
    const freshPair = freshPairs.selected;
    const freshInput = await resolveComplaintPairInput(page, freshPair);
    if (!freshPair?.pairId || !complaintPairHasUserIdMode(freshPair) || !freshInput) {
      diagnostics.complaintRetryReason = "投诉用户ID右侧输入框未找到";
      continue;
    }
    input = freshInput;

    // 页面可能在等待筛选行稳定期间被前一个档案页抢回焦点；提交前再切回
    // 当前投诉页并滚入输入框，避免键盘事件落到旧页面。
    await page.bringToFront().catch(() => {});
    await input.scrollIntoViewIfNeeded().catch(() => {});
    const committed = await commitComplaintUserIdValue(page, input, expected, fillMethod);
    diagnostics.complaintFillAttempts.push({
      attempt,
      method: fillMethod,
      ok: committed.ok,
      immediateValueState: committed.immediateValueState,
      componentNames: committed.componentNames || [],
      eventDetails: committed.eventDetails || "",
      errorDetails: committed.errorDetails || ""
    });
    diagnostics.complaintUserIdFilled = committed.ok;
    if (!committed.ok) {
      diagnostics.complaintRetryReason = "投诉用户ID写入动作未生效";
      continue;
    }

    const stable = await waitForStableComplaintUserIdValue(page, expected, 3, 200, freshPair.pairId);
    diagnostics.complaintStableReadValues = stable.reads;
    diagnostics.complaintInputClearedAfterMs = stable.clearedAfterMs;
    if (stable.ok) {
      diagnostics.complaintUserIdStable = true;
      diagnostics.complaintRetryReason = "";
      return { ok: true };
    }
    const wasEverFilled = stable.reads.some((item) => item.valueState === "expected");
    diagnostics.complaintRetryReason = wasEverFilled
      ? "投诉用户ID已填入但被页面重绘清空"
      : "投诉用户ID写入动作未生效";
    await page.waitForTimeout(350).catch(() => {});
  }

  return {
    ok: false,
    error: diagnostics.complaintRetryReason || "投诉用户ID写入动作未生效"
  };
}

async function commitComplaintUserIdValue(page, input, expected, method) {
  const readImmediateValue = async () => {
    const value = String(await input.inputValue().catch(() => "")).replace(/\s+/g, "").trim();
    return {
      ok: value === expected,
      immediateValueState: value === expected ? "expected" : value ? "other" : "empty"
    };
  };

  if (method === "playwright-fill") {
    // Playwright fill 已会触发 input。这里不再手工触发 change/blur，
    // 避免 FineBI 在组件模型尚未接收新值时立即重绘并清空。
    let fillError = "";
    const filled = await input.fill(expected, { force: true, timeout: 2500 })
      .then(() => true)
      .catch((error) => {
        fillError = String(error?.message || error || "").slice(0, 500);
        return false;
      });
    if (!filled) return { ok: false, immediateValueState: "fill-error", errorDetails: fillError };
    return await readImmediateValue();
  }

  if (method === "locator-sequential") {
    // 使用 locator 自身发送键盘事件，避免 page.keyboard 在页面重绘后把内容发给错误元素。
    let focusError = "";
    const focused = await input.click({ timeout: 2500 })
      .then(() => true)
      .catch((error) => {
        focusError = String(error?.message || error || "").slice(0, 500);
        return false;
      });
    if (!focused) return { ok: false, immediateValueState: "focus-error", errorDetails: focusError };
    await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await input.press("Backspace").catch(() => {});
    let typeError = "";
    const typed = await input.pressSequentially(expected, { delay: 35 })
      .then(() => true)
      .catch((error) => {
        typeError = String(error?.message || error || "").slice(0, 500);
        return false;
      });
    if (!typed) return { ok: false, immediateValueState: "type-error", errorDetails: typeError };
    return await readImmediateValue();
  }

  if (method === "vue-model") {
    const committed = await input.evaluate(async (element, value) => {
      const componentNames = [];
      const eventDetails = [];
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      const setNativeValue = () => {
        element.focus();
        if (descriptor?.set) descriptor.set.call(element, value);
        else element.value = value;
      };

      setNativeValue();
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      eventDetails.push("native-input");

      const visited = new Set();
      let node = element;
      for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
        let vm = node.__vue__;
        for (let parentDepth = 0; vm && parentDepth < 5; parentDepth += 1, vm = vm.$parent) {
          if (visited.has(vm)) continue;
          visited.add(vm);
          const name = vm.$options?.name || vm.$options?._componentTag || `vue-depth-${depth}-${parentDepth}`;
          componentNames.push(String(name));

          const modelCallback = vm.$vnode?.data?.model?.callback;
          if (typeof modelCallback === "function") {
            modelCallback(value);
            eventDetails.push(`${name}:model-callback`);
          }
          const inputListeners = vm.$vnode?.componentOptions?.listeners?.input;
          const listeners = Array.isArray(inputListeners) ? inputListeners : [inputListeners];
          for (const listener of listeners) {
            if (typeof listener !== "function") continue;
            listener(value);
            eventDetails.push(`${name}:input-listener`);
          }
          if (typeof vm.handleInput === "function") {
            vm.handleInput({ target: element });
            eventDetails.push(`${name}:handleInput`);
          }
          if (typeof vm.$emit === "function") {
            vm.$emit("input", value);
            eventDetails.push(`${name}:emit-input`);
          }
          if (Object.prototype.hasOwnProperty.call(vm, "currentValue")) {
            vm.currentValue = value;
            eventDetails.push(`${name}:currentValue`);
          }
        }
      }

      await new Promise((resolve) => {
        const rootVm = [...visited][0];
        if (rootVm && typeof rootVm.$nextTick === "function") rootVm.$nextTick(resolve);
        else setTimeout(resolve, 0);
      });
      setNativeValue();
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      return {
        immediateValue: String(element.value || ""),
        componentNames,
        eventDetails: eventDetails.join(",")
      };
    }, expected).catch(() => null);
    if (!committed) return { ok: false, immediateValueState: "vue-model-error" };
    await page.waitForTimeout(80).catch(() => {});
    const immediate = await readImmediateValue();
    return {
      ...immediate,
      componentNames: committed.componentNames,
      eventDetails: committed.eventDetails
    };
  }

  // Element/Vue 输入框可能会在原生输入后立即按组件模型重绘。
  // 这里同时调用原生 value setter、派发 input，并向最近的 Vue 组件提交 input 事件。
  const componentResult = await input.evaluate((element, value) => {
    const componentNames = [];
    const eventDetails = [];
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    element.focus();
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;

    const inputEvent = typeof InputEvent === "function"
      ? new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: value,
        inputType: "insertText"
      })
      : new Event("input", { bubbles: true, composed: true });
    element.dispatchEvent(inputEvent);
    eventDetails.push("native-input");

    let node = element;
    let emitted = false;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      const vm = node.__vue__;
      if (!vm) continue;
      const name = vm.$options?.name || vm.$options?._componentTag || `vue-depth-${depth}`;
      componentNames.push(String(name));
      if (!emitted && typeof vm.$emit === "function") {
        vm.$emit("input", value);
        emitted = true;
        eventDetails.push("vue-input");
      }
    }

    return {
      immediateValue: String(element.value || ""),
      componentNames,
      eventDetails: eventDetails.join(",")
    };
  }, expected).catch(() => null);
  if (!componentResult) return { ok: false, immediateValueState: "component-error" };
  await page.waitForTimeout(50).catch(() => {});
  const immediate = await readImmediateValue();
  return {
    ...immediate,
    componentNames: componentResult.componentNames,
    eventDetails: componentResult.eventDetails
  };
}

async function resolveComplaintPairInput(page, pair) {
  if (!pair?.pairId) return null;
  const marked = page.locator(
    `[data-codex-complaint-pair-id='${pair.pairId}'][data-codex-complaint-pair-role='input']`
  ).first();
  if (await complaintInputIsUsable(marked)) return marked;

  // Element/FineBI 会在下拉切换或输入后替换整行节点。旧 data 标记仍可能
  // 短暂留在隐藏节点上，因此每次都重新发现当前可见的“用户ID + 右侧输入框”对。
  const discovered = await discoverComplaintFilterPairs(page);
  const currentPair = discovered.selected;
  if (!currentPair?.pairId || !complaintPairHasUserIdMode(currentPair)) return null;
  const currentMarked = page.locator(
    `[data-codex-complaint-pair-id='${currentPair.pairId}'][data-codex-complaint-pair-role='input']`
  ).first();
  if (await complaintInputIsUsable(currentMarked)) return currentMarked;

  // FineBI 会重绘筛选行并替换 input 节点。DOM 下标和几何位置仍稳定时，
  // 重新绑定原筛选对，避免把同一行另一组“请输入”误当作用户 ID。
  const fallback = page.locator("input").nth(Number(currentPair.inputDomIndex));
  if (!await fallback.count().catch(() => 0)) return null;
  const rebound = await fallback.evaluate((element, expectedPair) => {
    const rect = element.getBoundingClientRect();
    const inputs = [...document.querySelectorAll("input")];
    const allNodes = [...document.querySelectorAll("*")];
    const selector = inputs[Number(expectedPair.selectorDomIndex)]
      || allNodes[Number(expectedPair.selectorNodeIndex)];
    const selectorText = String(
      selector?.value || selector?.getAttribute("data-value") || selector?.getAttribute("placeholder")
        || selector?.innerText || selector?.textContent || selector?.parentElement?.innerText || ""
    ).replace(/\s+/g, "");
    const placeholder = String(element.getAttribute("placeholder") || "").replace(/\s+/g, "");
    const expectedRect = expectedPair.inputRect || {};
    const samePosition = Math.abs(rect.left - Number(expectedRect.x || rect.left)) <= 28
      && Math.abs(rect.top - Number(expectedRect.y || rect.top)) <= 28;
    const valid = !element.disabled && !element.readOnly
      && rect.width > 20 && rect.height > 15
      && /用户ID/i.test(selectorText)
      && /请输入/.test(placeholder)
      && samePosition;
    if (!valid) return false;
    element.setAttribute("data-codex-complaint-pair-id", expectedPair.pairId);
    element.setAttribute("data-codex-complaint-pair-role", "input");
    element.setAttribute("data-codex-complaint-userid", "1");
    return true;
  }, currentPair).catch(() => false);
  return rebound && await complaintInputIsUsable(fallback) ? fallback : null;
}

async function complaintInputIsUsable(input) {
  if (!input || !await input.count().catch(() => 0)) return false;
  if (!await input.isVisible().catch(() => false)) return false;
  if (!await input.isEditable().catch(() => false)) return false;
  return await input.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const placeholder = String(element.getAttribute("placeholder") || "").replace(/\s+/g, "");
    return !element.disabled && !element.readOnly
      && rect.width > 20 && rect.height > 15
      && style.display !== "none" && style.visibility !== "hidden"
      && Number(style.opacity || 1) !== 0
      && /请输入/.test(placeholder);
  }).catch(() => false);
}

async function waitForComplaintInputReady(page, input, maxWaitMs = 2600) {
  const startedAt = Date.now();
  let stableReads = 0;
  let previousSignature = "";
  while (Date.now() - startedAt < maxWaitMs) {
    const visible = await input.isVisible().catch(() => false);
    const editable = await input.isEditable().catch(() => false);
    const state = await input.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        ready: rect.width > 20 && rect.height > 15
          && style.display !== "none" && style.visibility !== "hidden"
          && Number(style.opacity || 1) !== 0
          && !element.disabled && !element.readOnly,
        signature: `${Math.round(rect.left)}|${Math.round(rect.top)}|${Math.round(rect.width)}|${Math.round(rect.height)}`
      };
    }).catch(() => ({ ready: false, signature: "" }));
    const ready = visible && editable && state.ready;
    stableReads = ready && state.signature === previousSignature ? stableReads + 1 : (ready ? 1 : 0);
    previousSignature = state.signature;
    if (stableReads >= 2) return true;
    await page.waitForTimeout(160).catch(() => {});
  }
  return false;
}

async function waitForStableComplaintFilterPair(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previousSignature = "";
  let stableCount = 0;
  while (Date.now() < deadline) {
    const { selected } = await discoverComplaintFilterPairs(page);
    if (selected?.pairId) {
      const signature = [
        selected.pairSelectorText,
        selected.pairSelectorValue,
        selected.selectorRect?.x,
        selected.inputRect?.x,
        selected.pairInputPlaceholder
      ].join("|");
      stableCount = signature === previousSignature ? stableCount + 1 : 1;
      previousSignature = signature;
      if (stableCount >= 3) return selected;
    } else {
      previousSignature = "";
      stableCount = 0;
    }
    await page.waitForTimeout(200).catch(() => {});
  }
  return null;
}

async function switchComplaintPairToUserId(page, pair) {
  if (complaintPairHasUserIdMode(pair)) return true;
  const selector = page.locator(`[data-codex-complaint-pair-id='${pair.pairId}'][data-codex-complaint-pair-role='selector']`).first();
  if (!await selector.isVisible().catch(() => false)) return false;
  await selector.click({ force: true, timeout: 2500 }).catch(() => {});

  // FineBI/Element 的下拉层通常在点击后异步挂载到 body，不能立即按
  // getByText 取第一个“用户ID”，否则很容易点回当前条件框或隐藏节点。
  const optionReadyUntil = Date.now() + 3500;
  let option = null;
  while (Date.now() < optionReadyUntil) {
    const marked = await page.evaluate((pairId) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < innerHeight
          && rect.right > 0 && rect.left < innerWidth
          && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
      };
      document.querySelectorAll("[data-codex-complaint-userid-option]").forEach((el) => el.removeAttribute("data-codex-complaint-userid-option"));
      const candidates = [...document.querySelectorAll("[role='option'], [role='menuitem'], li, label, td, span, div")]
        .filter((el) => visible(el) && normalize(el.innerText || el.textContent || "") === "用户ID")
        .filter((el) => {
          // 下拉选项通常挂在 body 的浮层中，不一定和“手机号/订单号”同父节点。
          // 但必须排除当前筛选对本身，避免把输入框里的“用户ID”再次当成选项。
          const owner = el.closest("[data-codex-complaint-pair-id]");
          if (owner && owner.getAttribute("data-codex-complaint-pair-id") === pairId) return false;
          const popup = el.closest("[role='listbox'], [role='menu'], .el-select-dropdown, .el-popper, .ant-select-dropdown, .arco-select-popup, [class*='dropdown'], [class*='select']");
          const parent = el.parentElement;
          const parentText = normalize(parent?.innerText || parent?.textContent || "");
          const siblingTexts = parent ? [...parent.children].map((child) => normalize(child.innerText || child.textContent || "")).filter(Boolean) : [];
          const hasSiblingOptions = siblingTexts.length >= 2 && siblingTexts.some((text) => ["手机号", "订单号", "用户名称", "用户ID"].includes(text));
          const optionRole = ["option", "menuitem"].includes(String(el.getAttribute("role") || "").toLowerCase()) || ["LI", "LABEL"].includes(String(el.tagName || "").toUpperCase());
          return Boolean(popup || hasSiblingOptions || (optionRole && parentText.includes("用户ID")));
        })
        .map((el) => {
          const popup = el.closest("[role='listbox'], [role='menu'], .el-select-dropdown, .el-popper, .ant-select-dropdown, .arco-select-popup, [class*='dropdown'], [class*='select']");
          const role = String(el.getAttribute("role") || "").toLowerCase();
          const score = (popup ? 1000 : 0) + (["option", "menuitem"].includes(role) ? 300 : 0)
            + (["LI", "LABEL"].includes(String(el.tagName || "").toUpperCase()) ? 100 : 0)
            + (el.parentElement?.children.length || 0);
          return { el, score };
        })
        .sort((a, b) => b.score - a.score || b.el.getBoundingClientRect().width * b.el.getBoundingClientRect().height - a.el.getBoundingClientRect().width * a.el.getBoundingClientRect().height)
        .map(({ el }) => el);
      const target = candidates[0];
      if (!target) return false;
      target.setAttribute("data-codex-complaint-userid-option", "1");
      return true;
    }, pair.pairId).catch(() => false);
    if (marked) {
      option = page.locator("[data-codex-complaint-userid-option='1']").first();
      if (await option.isVisible().catch(() => false)) break;
      option = null;
    }
    await page.waitForTimeout(180).catch(() => {});
  }
  if (!option) return false;
  const clicked = await option.click({ force: true, timeout: 2500 }).then(() => true).catch(() => false);
  if (!clicked) return false;

  const switchedUntil = Date.now() + 3500;
  while (Date.now() < switchedUntil) {
    const fresh = (await discoverComplaintFilterPairs(page)).selected;
    if (complaintPairHasUserIdMode(fresh)) return true;
    await page.waitForTimeout(220).catch(() => {});
  }
  return false;
}

async function waitForStableComplaintUserIdValue(page, expected, requiredReads, intervalMs, pairId = "") {
  const startedAt = Date.now();
  const reads = [];
  let stableCount = 0;
  let activePairId = pairId;
  for (let read = 0; read < requiredReads + 5; read += 1) {
    let current = "";
    let modeOk = false;
    let source = "marker";
    if (activePairId) {
      const input = page.locator(`[data-codex-complaint-pair-id='${activePairId}'][data-codex-complaint-pair-role='input']`).first();
      const selector = page.locator(`[data-codex-complaint-pair-id='${activePairId}'][data-codex-complaint-pair-role='selector']`).first();
      const inputUsable = await input.isVisible().catch(() => false);
      if (inputUsable) {
        current = String(await input.inputValue().catch(() => "")).replace(/\s+/g, "").trim();
        const selectorText = String(await selector.textContent().catch(() => "")).replace(/\s+/g, "").trim();
        const selectorValue = String(await selector.getAttribute("value").catch(() => "") || "").replace(/\s+/g, "").trim();
        const selectorInputValue = String(await selector.inputValue().catch(() => "")).replace(/\s+/g, "").trim();
        modeOk = [selectorText, selectorValue, selectorInputValue].some((value) => /^用户id$/i.test(value));
      } else {
        activePairId = "";
      }
    }
    if (!activePairId) {
      source = "rediscovered";
      const { selected } = await discoverComplaintFilterPairs(page);
      current = String(selected?.pairInputValue || "").replace(/\s+/g, "").trim();
      modeOk = complaintPairHasUserIdMode(selected);
      activePairId = selected?.pairId || "";
    }
    reads.push({
      elapsedMs: Date.now() - startedAt,
      modeOk,
      source,
      valueState: current === expected ? "expected" : current ? "other" : "empty"
    });
    stableCount = modeOk && current === expected ? stableCount + 1 : 0;
    if (stableCount >= requiredReads) {
      return { ok: true, reads, clearedAfterMs: null };
    }
    await page.waitForTimeout(intervalMs).catch(() => {});
  }
  const firstExpected = reads.find((item) => item.valueState === "expected");
  const cleared = firstExpected
    ? reads.find((item) => item.elapsedMs > firstExpected.elapsedMs && item.valueState === "empty")
    : null;
  return {
    ok: false,
    reads,
    clearedAfterMs: cleared?.elapsedMs ?? null
  };
}

async function verifyComplaintFilterBeforeQuery(page, userId) {
  const expected = String(userId || "").replace(/\s+/g, "").trim();
  const { selected } = await discoverComplaintFilterPairs(page);
  if (!selected) return { ok: false, error: "投诉用户ID右侧输入框未找到" };
  if (!complaintPairHasUserIdMode(selected)) return { ok: false, error: "投诉用户ID条件选择器未找到" };
  const value = String(selected.pairInputValue || "").replace(/\s+/g, "").trim();
  if (value !== expected) return {
    ok: false,
    error: value ? "投诉用户ID输入值与当前用户不一致" : "投诉用户ID输入值为空"
  };
  const queryButtons = page.getByText("查询", { exact: true });
  const count = await queryButtons.count().catch(() => 0);
  let clickable = false;
  for (let index = 0; index < count; index += 1) {
    const candidate = queryButtons.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    if (!await candidate.isEnabled().catch(() => false)) continue;
    clickable = true;
    break;
  }
  return clickable
    ? { ok: true }
    : { ok: false, error: "投诉查询按钮未点击" };
}

async function readComplaintResultState(page, userId) {
  const expected = String(userId || "").replace(/\s+/g, "").trim();
  const { selected } = await discoverComplaintFilterPairs(page);
  return await page.evaluate(({ expectedUserId, filterMode, filterValue }) => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const compact = (text) => normalize(text).replace(/\s+/g, "");
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 8 && rect.height > 8
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const rows = [...document.querySelectorAll("tbody tr,.el-table__row,.ant-table-row")]
      .filter(visible)
      .filter((row) => [...row.querySelectorAll("button,a,span")]
        .some((el) => compact(el.innerText || el.textContent) === "查看详情"))
      .map((row) => normalize(row.innerText || row.textContent))
      .filter(Boolean);
    const matchingRows = rows.filter((text) => compact(text).includes(expectedUserId));
    const bodyText = normalize(document.body?.innerText || "");
    const explicitEmpty = /暂无数据|暂无记录|无数据|共\s*0\s*条|全部\s*\(0\)/.test(bodyText);
    const loading = [...document.querySelectorAll(".el-loading-mask,.ant-spin-spinning,[aria-busy='true']")]
      .some(visible);
    const summary = rows.slice(0, 12).join("||").slice(0, 5000);
    return {
      filterMode,
      filterValue,
      rowCount: rows.length,
      matchedRowCount: matchingRows.length,
      explicitEmpty,
      loading,
      rows: rows.slice(0, 12),
      signature: `${filterMode}|${filterValue}|${rows.length}|${compact(summary)}|${explicitEmpty}`
    };
  }, {
    expectedUserId: expected,
    filterMode: complaintPairHasUserIdMode(selected) ? "用户ID" : "",
    filterValue: String(selected?.pairInputValue || "").replace(/\s+/g, "").trim()
  }).catch(() => ({
    filterMode: "",
    filterValue: "",
    rowCount: 0,
    matchedRowCount: 0,
    explicitEmpty: false,
    loading: false,
    rows: [],
    signature: ""
  }));
}

async function waitForComplaintQueryResult(page, userId, before, timeoutMs) {
  const expected = String(userId || "").replace(/\s+/g, "").trim();
  const deadline = Date.now() + timeoutMs;
  let sawLoading = false;
  let mismatchStable = 0;
  let filterInvalidSince = null;
  let emptySince = null;
  let latest = before;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250).catch(() => {});
    latest = await readComplaintResultState(page, expected);
    sawLoading ||= latest.loading;
    const filterValid = latest.filterMode === "用户ID" && latest.filterValue === expected;
    const changed = sawLoading || latest.signature !== before.signature;
    if (!filterValid) {
      filterInvalidSince ??= Date.now();
      if (Date.now() - filterInvalidSince < 1800) continue;
      return { ok: false, changed, userIdMatched: false, state: latest, error: "投诉用户ID已填入但被页面重绘清空" };
    }
    filterInvalidSince = null;
    if (!latest.loading && latest.matchedRowCount > 0) {
      return { ok: true, changed, userIdMatched: true, state: latest };
    }
    if (!latest.loading && latest.rowCount > 0 && latest.matchedRowCount === 0) {
      mismatchStable += 1;
      if (mismatchStable >= 3) {
        return { ok: false, changed, userIdMatched: false, state: latest, error: "投诉结果未按当前用户ID过滤" };
      }
    } else {
      mismatchStable = 0;
    }
    if (!latest.loading && latest.explicitEmpty && latest.rowCount === 0 && changed) {
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= 1200) {
        return { ok: true, changed: true, userIdMatched: true, empty: true, state: latest };
      }
    } else {
      emptySince = null;
    }
  }
  return {
    ok: false,
    changed: sawLoading || latest.signature !== before.signature,
    userIdMatched: false,
    state: latest,
    error: "投诉查询结果未刷新"
  };
}

async function clickComplaintQuery(page) {
  return clickTopButton(page, "查询");
}

async function clickTopButton(page, label) {
  const marked = await page.evaluate((expected) => {
    const normalize = (text) => String(text || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.top < 450
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = [...document.querySelectorAll("button,a,[role='button']")]
      .filter(visible)
      .filter((el) => normalize(el.innerText || el.textContent) === expected)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    document.querySelectorAll("[data-codex-complaint-top-action]")
      .forEach((el) => el.removeAttribute("data-codex-complaint-top-action"));
    if (!candidates[0]) return false;
    candidates[0].setAttribute("data-codex-complaint-top-action", "1");
    return true;
  }, label).catch(() => false);
  if (!marked) return false;
  return await page.locator("[data-codex-complaint-top-action='1']").first()
    .click({ force: true, timeout: 2500 }).then(() => true).catch(() => false);
}

async function readComplaintTabs(page) {
  return await page.evaluate(() => {
    const labels = ["全部", "草稿", "待认领", "待回复", "处理中", "已完结"];
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const result = [];
    for (const label of labels) {
      const matches = [...document.querySelectorAll("div,span,button")]
        .map((el) => normalize(el.innerText || el.textContent))
        .filter((text) => text === label || text.startsWith(`${label} (`) || text.startsWith(`${label}(`));
      const text = matches.sort((a, b) => a.length - b.length)[0];
      if (!text) continue;
      const count = text.match(/\((\d+)\)/)?.[1];
      result.push({ label, count: count === undefined ? null : Number(count) });
    }
    return result;
  }).catch(() => []);
}

async function activateComplaintAllTab(page) {
  const marked = await inspectComplaintAllTab(page, true);
  if (!marked.found) return false;
  if (!marked.active) {
    const tab = page.locator("[data-codex-complaint-all-tab='1']").first();
    const clicked = await tab.click({ force: true, timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) return false;
  }
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    // FineBI 会在点击后整体重绘 Tab，旧 locator/临时标记会失效，因此每轮重新发现。
    const state = await inspectComplaintAllTab(page, false);
    if (state.found && state.active) return true;
    await page.waitForTimeout(150).catch(() => {});
  }
  return false;
}

async function inspectComplaintAllTab(page, markTarget) {
  return await page.evaluate(({ shouldMark }) => {
    const labels = ["全部", "草稿", "待认领", "待回复", "处理中", "已完结"];
    const normalize = (text) => String(text || "").replace(/\s+/g, "").trim();
    const exactLabel = (el) => {
      const text = normalize(el.innerText || el.textContent);
      return labels.find((label) => text === label || text.startsWith(`${label}(`)) || "";
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 12 && rect.height > 12 && rect.top > 120 && rect.top < 750
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const activeLike = (el) => {
      if (!el) return false;
      const attrs = [
        el.getAttribute("aria-selected"),
        el.getAttribute("aria-checked"),
        el.getAttribute("data-active"),
        el.getAttribute("data-selected")
      ];
      const classText = String(el.className || "");
      return attrs.some((value) => value === "true")
        || /(^|[\s_-])(is-active|active|selected|current)([\s_-]|$)/i.test(classText);
    };
    const clickableFor = (el) => el.closest([
      "[role='tab']",
      "button",
      "a",
      ".el-tabs__item",
      ".ant-tabs-tab",
      "[class*='tab-item']",
      "[class*='tabItem']"
    ].join(",")) || el;
    const scoreCandidate = (el) => {
      const clickable = clickableFor(el);
      const rect = clickable.getBoundingClientRect();
      let container = clickable.parentElement;
      let nearbyLabels = 0;
      for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
        const found = new Set([...container.querySelectorAll("div,span,button,a,[role='tab']")]
          .filter(visible)
          .map(exactLabel)
          .filter(Boolean));
        nearbyLabels = Math.max(nearbyLabels, found.size);
      }
      return { clickable, score: nearbyLabels * 10000 - rect.top - rect.width * rect.height / 100000 };
    };
    const candidates = [...document.querySelectorAll("button,a,div,span,[role='tab']")]
      .filter(visible)
      .filter((el) => exactLabel(el) === "全部")
      .map(scoreCandidate)
      .sort((a, b) => b.score - a.score);
    if (shouldMark) {
      document.querySelectorAll("[data-codex-complaint-all-tab]")
        .forEach((el) => el.removeAttribute("data-codex-complaint-all-tab"));
    }
    const clickable = candidates[0]?.clickable;
    if (!clickable) return { found: false, active: false, selectedLabel: "" };
    if (shouldMark) clickable.setAttribute("data-codex-complaint-all-tab", "1");

    const ancestry = [];
    let current = clickable;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) ancestry.push(current);
    let active = ancestry.some(activeLike)
      || [...clickable.querySelectorAll("*")].some(activeLike);
    let selectedLabel = active ? "全部" : "";

    if (!active) {
      let container = clickable.parentElement;
      for (let depth = 0; container && depth < 4 && !selectedLabel; depth += 1, container = container.parentElement) {
        const peers = [...container.querySelectorAll("[role='tab'],.el-tabs__item,.ant-tabs-tab,[class*='tab-item'],[class*='tabItem']")]
          .filter(visible);
        const selected = peers.find((peer) => activeLike(peer) || [...peer.querySelectorAll("*")].some(activeLike));
        if (selected) selectedLabel = exactLabel(selected);
      }
      active = selectedLabel === "全部";
    }
    return {
      found: true,
      active,
      selectedLabel,
      className: String(clickable.className || ""),
      ariaSelected: clickable.getAttribute("aria-selected") || ""
    };
  }, { shouldMark: Boolean(markTarget) }).catch(() => ({ found: false, active: false, selectedLabel: "" }));
}

async function collectComplaintDetails(page, query, trace, logger) {
  const records = [];
  const seen = new Set();
  let pageNumber = 1;
  let error = "";

  while (pageNumber <= 100) {
    const rows = await listComplaintRows(page, query.userId);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      trace.push(`投诉详情#${records.length + 1}`);
      const clicked = await clickComplaintDetail(page, row);
      const opened = clicked ? await waitForComplaintDetail(page, 8000, query.userId) : false;
      if (!opened) {
        records.push(createComplaintRecord(row, { detailOpened: false, error: "查看详情未打开" }));
        continue;
      }
      const detail = await extractComplaintDetail(page);
      if (complaintDetailIsEmpty(detail)) {
        await logger.pageSnapshot(page, `complaint-detail-fields-empty-${records.length + 1}`, query);
        logger.writeJson(`complaint-detail-dom-${records.length + 1}`, await probeComplaintDetailDom(page));
      }
      records.push(createComplaintRecord(row, { ...detail, detailOpened: true }));
      const closed = await closeComplaintDetail(page);
      if (!closed) {
        error = "部分投诉详情关闭失败，已停止继续翻页。";
        const snapshot = await logger.pageSnapshot(page, "complaint-detail-close-failed", query);
        if (snapshot) error += ` 调试日志：${snapshot}`;
        return { records, error };
      }
      await page.waitForTimeout(250).catch(() => {});
    }

    const advanced = await goToNextComplaintPage(page);
    if (!advanced) break;
    pageNumber += 1;
    trace.push(`投诉列表第${pageNumber}页`);
    await page.waitForTimeout(900).catch(() => {});
  }
  return { records, error };
}

function complaintDetailIsEmpty(detail) {
  return [detail.source, detail.complaintTime, detail.thirdPartyComplaintId, detail.details]
    .every((value) => !cleanText(value) || cleanText(value) === "-");
}

async function probeComplaintDetailDom(page) {
  return await page.evaluate((fieldNames) => {
    const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const compact = (text) => clean(text).replace(/\s+/g, "").replace(/[：:]$/, "");
    return fieldNames.map((field) => ({
      field,
      candidates: [...document.querySelectorAll("label,dt,th,td,div,span,p")]
        .filter((el) => compact(el.innerText || el.textContent) === field)
        .slice(0, 12)
        .map((el) => {
          const ancestors = [];
          let node = el;
          for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
            ancestors.push({
              tag: node.tagName,
              className: String(node.className || "").slice(0, 300),
              text: clean(node.innerText || node.textContent).slice(0, 1200),
              childTexts: [...node.children].map((child) => clean(child.innerText || child.textContent).slice(0, 500))
            });
          }
          return { ancestors };
        })
    }));
  }, DETAIL_FIELDS).catch(() => []);
}

async function listComplaintRows(page, userId) {
  return await page.evaluate((expectedUserId) => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
    };
    const rows = [...document.querySelectorAll("tr, .el-table__row, .ant-table-row")]
      .filter(visible)
      .filter((row) => normalize(row.innerText || row.textContent).replace(/\s+/g, "").includes(expectedUserId))
      .filter((row) => [...row.querySelectorAll("button,a,span")].some((el) => normalize(el.innerText || el.textContent) === "查看详情"));
    const deduped = new Map();
    for (const row of rows) {
      const text = normalize(row.innerText || row.textContent);
      const identifiers = text.match(/\d{8,}/g) || [];
      const key = text;
      if (!deduped.has(key)) deduped.set(key, { key, text, identifiers });
    }
    return [...deduped.values()];
  }, String(userId || "").replace(/\s+/g, "")).catch(() => []);
}

async function inspectComplaintRows(page, userId) {
  return await page.evaluate((expectedUserId) => {
    const normalize = (text) => String(text || "").replace(/\s+/g, "").trim();
    const rows = [...document.querySelectorAll("tr, .el-table__row, .ant-table-row")]
      .filter((row) => [...row.querySelectorAll("button,a,span")]
        .some((el) => normalize(el.innerText || el.textContent) === "查看详情"));
    return {
      totalRows: rows.length,
      matchedRows: rows.filter((row) => normalize(row.innerText || row.textContent).includes(expectedUserId)).length
    };
  }, String(userId || "").replace(/\s+/g, "")).catch(() => ({ totalRows: 0, matchedRows: 0 }));
}

async function clickComplaintDetail(page, row) {
  const marked = await page.evaluate((selected) => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
    document.querySelectorAll("[data-codex-complaint-detail]")
      .forEach((el) => el.removeAttribute("data-codex-complaint-detail"));
    const rows = [...document.querySelectorAll("tr, .el-table__row, .ant-table-row")];
    const target = rows.find((item) => {
      const text = normalize(item.innerText || item.textContent);
      if (text === selected.text) return true;
      return selected.identifiers?.length > 0 && selected.identifiers.every((id) => text.includes(id));
    });
    const action = target && [...target.querySelectorAll("button,a,span")]
      .find((el) => normalize(el.innerText || el.textContent) === "查看详情");
    if (!action) return false;
    action.setAttribute("data-codex-complaint-detail", "1");
    return true;
  }, row).catch(() => false);
  if (!marked) return false;
  return await page.locator("[data-codex-complaint-detail='1']").first()
    .click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
}

async function waitForComplaintDetail(page, timeoutMs, expectedUserId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const opened = await page.evaluate((userId) => {
      const normalize = (text) => String(text || "").replace(/\s+/g, "").trim();
      const roots = [...document.querySelectorAll(".el-drawer, .ant-drawer-content, .el-dialog, .ant-modal-content, [role='dialog'], main, section, article, div")];
      const detailReady = roots.some((root) => {
        const rect = root.getBoundingClientRect();
        const text = normalize(root.innerText || root.textContent);
        return rect.width > 300 && rect.height > 160
          && text.includes("投诉来源") && text.includes("第三方投诉单号") && text.includes("投诉详情");
      });
      if (!detailReady) return false;
      const items = [...document.querySelectorAll(".complaint-info .info-item, .info-section .info-item")]
        .map((item) => normalize(item.innerText || item.textContent));
      if (userId && items.some((text) => text.startsWith("用户ID") && text.includes(userId))) return true;
      const targetLabels = ["投诉来源", "投诉时间", "第三方投诉单号", "投诉详情"];
      return items.some((text) => targetLabels.some((label) => text.startsWith(label) && !text.endsWith("-") && text.length > label.length));
    }, String(expectedUserId || "").replace(/\s+/g, "")).catch(() => false);
    if (opened) return true;
    await page.waitForTimeout(200).catch(() => {});
  }
  return false;
}

async function extractComplaintDetail(page) {
  return await page.evaluate((fieldNames) => {
    const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const compact = (text) => clean(text).replace(/\s+/g, "").replace(/[：:]$/, "");
    const panels = [...document.querySelectorAll(".el-drawer, .ant-drawer-content, .el-dialog, .ant-modal-content, [role='dialog'], main, section, article, div")]
      .filter((root) => {
        const rect = root.getBoundingClientRect();
        const text = compact(root.innerText || root.textContent);
        return rect.width > 300 && rect.height > 200 && text.includes("投诉来源") && text.includes("投诉详情");
      });
    const panel = panels.sort((a, b) => {
      const aText = clean(a.innerText || a.textContent).length;
      const bText = clean(b.innerText || b.textContent).length;
      return aText - bText;
    })[0];
    if (!panel) return { matched: false };

    const readField = (field) => {
      const labels = [...panel.querySelectorAll("label,dt,th,div,span")]
        .filter((el) => compact(el.innerText || el.textContent) === field)
        .sort((a, b) => (a.innerText || a.textContent || "").length - (b.innerText || b.textContent || "").length);
      for (const label of labels) {
        const direct = label.nextElementSibling;
        if (direct && clean(direct.innerText || direct.textContent)) return clean(direct.innerText || direct.textContent);
        let node = label.parentElement;
        for (let depth = 0; node && node !== panel && depth < 4; depth += 1, node = node.parentElement) {
          const children = [...node.children];
          const labelIndex = children.findIndex((child) => child === label || child.contains(label));
          const siblingText = children.slice(labelIndex + 1).map((child) => clean(child.innerText || child.textContent)).find(Boolean);
          if (labelIndex >= 0 && siblingText) return siblingText;
          const text = clean(node.innerText || node.textContent);
          const stripped = clean(text.replace(new RegExp(`^${field}[：:]?\\s*`), ""));
          const otherCount = fieldNames.filter((name) => compact(stripped).includes(name)).length;
          if (stripped && stripped !== text && otherCount === 0 && stripped.length < 2000) return stripped;
        }
      }
      return "";
    };

    return {
      matched: true,
      source: readField("投诉来源"),
      complaintTime: readField("投诉时间"),
      thirdPartyComplaintId: readField("第三方投诉单号"),
      details: readField("投诉详情")
    };
  }, DETAIL_FIELDS).catch(() => ({ matched: false }));
}

async function closeComplaintDetail(page) {
  const closeMarked = await page.evaluate(() => {
    document.querySelectorAll("[data-codex-complaint-close]")
      .forEach((el) => el.removeAttribute("data-codex-complaint-close"));
    const panels = [...document.querySelectorAll(".el-drawer, .ant-drawer-content, .el-dialog, .ant-modal-content, [role='dialog']")]
      .filter((panel) => {
        const rect = panel.getBoundingClientRect();
        return rect.width > 300 && rect.height > 200 && /投诉来源/.test(panel.innerText || panel.textContent || "");
      });
    const panel = panels[0];
    if (!panel) return false;
    const close = panel.querySelector(".el-drawer__close-btn, .ant-drawer-close, .el-dialog__headerbtn, .ant-modal-close, [aria-label='Close'], [aria-label='关闭']");
    if (!close) return false;
    close.setAttribute("data-codex-complaint-close", "1");
    return true;
  }).catch(() => false);
  const closedOverlay = closeMarked
    ? await page.locator("[data-codex-complaint-close='1']").first()
      .click({ force: true, timeout: 3000 }).then(() => true).catch(() => false)
    : false;
  if (closedOverlay) {
    await page.waitForTimeout(350).catch(() => {});
    return true;
  }

  const tabMarked = await page.evaluate(() => {
    const normalize = (text) => String(text || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.top < 180
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const tabs = [...document.querySelectorAll("div,span,a")]
      .filter(visible)
      .filter((el) => normalize(el.innerText || el.textContent) === "投诉工单")
      .sort((a, b) => (a.innerText || a.textContent || "").length - (b.innerText || b.textContent || "").length);
    if (!tabs[0]) return false;
    const clickable = tabs[0].closest("a,button,[role='tab'],[class*='tab']") || tabs[0];
    document.querySelectorAll("[data-codex-complaint-tab]")
      .forEach((el) => el.removeAttribute("data-codex-complaint-tab"));
    clickable.setAttribute("data-codex-complaint-tab", "1");
    return true;
  }).catch(() => false);
  const returnedByTab = tabMarked
    ? await page.locator("[data-codex-complaint-tab='1']").first()
      .click({ force: true, timeout: 3000 }).then(() => true).catch(() => false)
    : false;
  if (!returnedByTab) return false;
  await page.waitForTimeout(500).catch(() => {});
  return true;
}

async function goToNextComplaintPage(page) {
  const marked = await page.evaluate(() => {
    document.querySelectorAll("[data-codex-complaint-next]")
      .forEach((el) => el.removeAttribute("data-codex-complaint-next"));
    const candidates = [...document.querySelectorAll(".el-pagination .btn-next, .ant-pagination-next button, button[aria-label*='下一'], button[title*='下一']")];
    const next = candidates.find((button) => {
      const wrapper = button.closest(".ant-pagination-next, .btn-next") || button;
      return !button.disabled && !wrapper.classList.contains("disabled") && !wrapper.classList.contains("is-disabled")
        && !wrapper.classList.contains("ant-pagination-disabled");
    });
    if (!next) return false;
    next.setAttribute("data-codex-complaint-next", "1");
    return true;
  }).catch(() => false);
  if (!marked) return false;
  return await page.locator("[data-codex-complaint-next='1']").first()
    .click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
}

function createComplaintRecord(row, detail) {
  return {
    key: row.key,
    source: cleanText(detail.source || ""),
    complaintTime: cleanText(detail.complaintTime || ""),
    thirdPartyComplaintId: cleanText(detail.thirdPartyComplaintId || ""),
    details: cleanText(detail.details || ""),
    detailOpened: Boolean(detail.detailOpened),
    error: detail.error || ""
  };
}
