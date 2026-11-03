import { cleanText } from "./domUtils.js";

const OUTPUT_FIELDS = [
  "投诉订单ID",
  "订单ID",
  "渠道一级类型",
  "渠道二级类型",
  "渠道三级类型",
  "渠道名称",
  "所属品类",
  "商品名称",
  "用户ID"
];

export class IntentionOrderService {
  constructor({ config, browserClient, logger }) {
    this.config = config;
    this.browserClient = browserClient;
    this.logger = logger;
  }

  async checkLogin() {
    const page = await this.browserClient.ensurePage(this.config.browser.intentionOrderUrl);
    const readiness = await this.browserClient.ensureReady(page);
    return {
      ready: readiness.ready,
      loginRequired: !readiness.ready,
      message: readiness.ready ? "已检测到后台登录态，可以开始批量提取。" : readiness.message,
      url: page.url(),
      checkedAt: new Date().toISOString()
    };
  }

  async fetchByComplaintOrderId(complaintOrderId) {
    const id = String(complaintOrderId || "").trim();
    if (!id) return { complaintOrderId: id, found: false, rows: [], error: "投诉订单ID为空" };

    const page = await this.browserClient.ensurePage(this.config.browser.intentionOrderUrl);
    const ready = await this.browserClient.ensureReady(page);
    if (!ready.ready) {
      return { complaintOrderId: id, found: false, loginRequired: true, rows: [], error: ready.message || "未登录" };
    }

    return this.fetchDetailByPage(page, id);
  }

  async debugDateDom(complaintOrderId = "") {
    const page = await this.browserClient.ensurePage(this.config.browser.intentionOrderUrl);
    await page.goto(this.config.browser.intentionOrderUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(this.config.ui.afterGotoWaitMs || 1000).catch(() => {});
    const ready = await this.browserClient.ensureReady(page);
    if (!ready.ready) return { ready: false, message: ready.message };

    const before = await readDateRangeDomState(page);
    await clearDateRange(page);
    const afterClear = await readDateRangeDomState(page);
    if (complaintOrderId) await fillComplaintOrderId(page, complaintOrderId);
    const mainOrderInput = await readMainOrderInputDomState(page);
    const afterFill = await readDateRangeDomState(page);
    return {
      ready: true,
      url: page.url(),
      before,
      afterClear,
      mainOrderInput,
      afterFill
    };
  }

  async fetchByPage(page, complaintOrderId) {
    await this.browserClient.closeForeignPages(this.config.browser.intentionOrderUrl);
    await ensureEduAdminPage(page, this.config.browser.intentionOrderUrl);
    const search = await searchComplaintOrder(page, complaintOrderId, this.config.browser.intentionOrderUrl, this.config.ui.afterQueryWaitMs);
    if (!search.ok) {
      const snapshot = await this.logger.pageSnapshot(page, "intention-page-fallback-prepare-failed", { userId: complaintOrderId });
      return {
        complaintOrderId,
        found: false,
        rows: [],
        error: `${search.error}${snapshot ? `，调试日志：${snapshot}` : ""}`
      };
    }
    return {
      complaintOrderId,
      found: search.rows.length > 0,
      rows: search.rows,
      error: search.rows.length ? "" : "未查询到已退款或已支付订单记录",
      searchStatus: search.status
    };
  }

  async fetchDetailByPage(page, complaintOrderId) {
    await this.browserClient.closeForeignPages(this.config.browser.intentionOrderUrl);
    await ensureEduAdminPage(page, this.config.browser.intentionOrderUrl);
    const search = await searchComplaintOrder(page, complaintOrderId, this.config.browser.intentionOrderUrl, this.config.ui.afterQueryWaitMs);
    if (!search.ok) {
      const snapshot = await this.logger.pageSnapshot(page, "intention-detail-prepare-failed", { userId: complaintOrderId });
      return {
        complaintOrderId,
        found: false,
        rows: [],
        error: `${search.error}${snapshot ? `，调试日志：${snapshot}` : ""}`
      };
    }

    const listRows = search.rows;
    if (!listRows.length) {
      const snapshot = await this.logger.pageSnapshot(page, "intention-detail-no-result", { userId: complaintOrderId });
      return {
        complaintOrderId,
        found: false,
        rows: [],
        error: `未查询到已退款或已支付订单记录${snapshot ? `，调试日志：${snapshot}` : ""}`
      };
    }

    const clicked = await clickDetailForOrder(page, complaintOrderId);
    await this.browserClient.closeForeignPages(this.config.browser.intentionOrderUrl);
    if (!clicked) {
      const snapshot = await this.logger.pageSnapshot(page, "intention-detail-button-not-found", { userId: complaintOrderId });
      return {
        complaintOrderId,
        found: true,
        rows: listRows,
        error: `详情按钮未找到，已保留列表字段${snapshot ? `，调试日志：${snapshot}` : ""}`
      };
    }

    const opened = await waitForDetailPage(page, complaintOrderId, this.config.browser.timeoutMs || 30000);
    if (!opened) {
      const snapshot = await this.logger.pageSnapshot(page, "intention-detail-not-opened", { userId: complaintOrderId });
      return {
        complaintOrderId,
        found: true,
        rows: listRows,
        error: `详情页未打开，已保留列表字段${snapshot ? `，调试日志：${snapshot}` : ""}`
      };
    }

    const detailText = await readDetailPageText(page, complaintOrderId);
    const detailRow = extractDetailFieldsFromText(complaintOrderId, detailText);
    return {
      complaintOrderId,
      found: true,
      rows: [{ ...listRows[0], ...detailRow }],
      error: ""
    };
  }
}

export { OUTPUT_FIELDS };

async function prepareComplaintSearch(page, complaintOrderId, targetUrl, orderStatus = "已退款") {
  await ensureEduAdminPage(page, targetUrl);
  const orderStatusSelected = await selectOrderStatus(page, orderStatus);
  await clearDateRange(page);
  const dateState = await readDateRangeDomState(page);
  if (dateState.dirty) return { ok: false, error: "日期范围清理失败" };
  const filled = await fillComplaintOrderId(page, complaintOrderId);
  if (!filled) return { ok: false, error: "主订单ID输入框未找到或未填入" };
  return { ok: true, orderStatusSelected };
}

async function searchComplaintOrder(page, complaintOrderId, targetUrl, afterQueryWaitMs) {
  for (const status of ["已退款", "已支付"]) {
    const prepared = await prepareComplaintSearch(page, complaintOrderId, targetUrl, status);
    if (!prepared.ok) return { ...prepared, rows: [], status };
    await clickQueryButton(page);
    await page.waitForTimeout(500).catch(() => {});
    await ensureEduAdminPage(page, targetUrl);
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(afterQueryWaitMs || 4000).catch(() => {});
    const rows = await readPageResultRows(page, complaintOrderId);
    if (rows.length) return { ok: true, rows, status };
  }
  return { ok: true, rows: [], status: "已退款/已支付" };
}

async function ensureEduAdminPage(page, targetUrl) {
  const currentUrl = page.url();
  const host = safeHost(currentUrl);
  const target = new URL(targetUrl);
  const wrongHost = host !== target.host;
  const wrongPath = !currentUrl.includes(target.pathname);
  if (!wrongHost && !wrongPath) return;
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(800).catch(() => {});
}

async function clearDateRange(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(100).catch(() => {});
  await page.locator("input[placeholder='开始日期'], input[placeholder='结束日期']").evaluateAll((inputs) => {
    for (const input of inputs) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }).catch(() => {});
  const clearPoints = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const ranges = [...document.body.querySelectorAll("input, div, span")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.value || el.innerText || el.textContent || "") }))
      .filter((item) => item.rect.top < 180 && /开始日期|结束日期|\d{4}[-./]\d{2}[-./]\d{2}/.test(item.text))
      .sort((a, b) => b.rect.width - a.rect.width);
    const range = ranges[0];
    if (!range) return [];
    const rect = range.rect;
    const iconPoints = [...document.body.querySelectorAll("i, svg, span, button, div")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || ""), cls: el.className?.baseVal || el.className || "", aria: el.getAttribute("aria-label") || "" }))
      .filter((item) => {
        const nearRange = item.rect.top >= rect.top - 12 && item.rect.bottom <= rect.bottom + 12 && item.rect.left >= rect.left && item.rect.left <= rect.right + 16;
        const looksClear = /close|clear|circle-close|el-icon-close|el-icon-circle-close|×|清空/i.test(`${item.text} ${item.cls} ${item.aria}`);
        return nearRange && looksClear;
      })
      .map((item) => ({ x: item.rect.left + item.rect.width / 2, y: item.rect.top + item.rect.height / 2 }));
    return [
      ...iconPoints,
      { x: rect.right - 18, y: rect.top + rect.height / 2 },
      { x: rect.right - 32, y: rect.top + rect.height / 2 },
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    ];
  }).catch(() => []);
  for (const point of clearPoints) {
    await page.mouse.move(point.x, point.y).catch(() => {});
    await page.waitForTimeout(80).catch(() => {});
    await page.mouse.click(point.x, point.y).catch(() => {});
    await page.waitForTimeout(120).catch(() => {});
  }
  await page.evaluate(() => {
    const inputs = [...document.body.querySelectorAll("input")]
      .filter((input) => {
        const rect = input.getBoundingClientRect();
        const text = `${input.placeholder || ""} ${input.value || ""}`;
        return rect.top < 180 && /开始日期|结束日期|\d{4}[-./]\d{2}[-./]\d{2}/.test(text);
      });
    for (const input of inputs) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await closeOpenDropdowns(page);
  await page.waitForTimeout(300).catch(() => {});
  await page.locator("input[placeholder='开始日期'], input[placeholder='结束日期']").evaluateAll((inputs) => {
    for (const input of inputs) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }).catch(() => {});
}

async function readDateRangeDomState(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const items = [...document.body.querySelectorAll("input, div, span")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(el.value || el.innerText || el.textContent || "");
        return {
          tag: el.tagName,
          className: String(el.className?.baseVal || el.className || "").slice(0, 120),
          placeholder: el.getAttribute("placeholder") || "",
          value: el.value || "",
          text: text.slice(0, 180),
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      })
      .filter((item) => item.rect.top < 190 && /开始日期|结束日期|\d{4}[-./]\d{2}[-./]\d{2}/.test(`${item.placeholder} ${item.value} ${item.text}`))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left || b.rect.width - a.rect.width);
    return {
      dirty: items.some((item) => /\d{4}[-./]\d{2}[-./]\d{2}/.test(`${item.value} ${item.text}`)),
      items: items.slice(0, 20)
    };
  }).catch((error) => ({ dirty: true, error: error.message || String(error), items: [] }));
}

async function readMainOrderInputDomState(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const items = [...document.body.querySelectorAll("input")]
      .filter(visible)
      .map((input) => {
        const rect = input.getBoundingClientRect();
        return {
          marked: input.getAttribute("data-codex-main-order-id") === "1",
          placeholder: input.getAttribute("placeholder") || "",
          value: input.value || "",
          label: normalize(input.closest(".el-form-item, .ant-form-item, div")?.innerText || "").slice(0, 120),
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      })
      .filter((item) => item.marked || item.placeholder.includes("主订单ID") || item.label.includes("主订单ID"))
      .sort((a, b) => Number(b.marked) - Number(a.marked) || a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    return {
      filled: items.some((item) => item.marked && item.value),
      items: items.slice(0, 10)
    };
  }).catch((error) => ({ filled: false, error: error.message || String(error), items: [] }));
}

async function selectOrderStatus(page, statusText) {
  const point = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 12 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const nodes = [...document.body.querySelectorAll("div, span, input")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.value || el.innerText || el.textContent || "") }))
      .filter((item) => item.rect.top < 180 && (/订单状态/.test(item.text) || /已退款|已支付/.test(item.text)))
      .sort((a, b) => b.rect.left - a.rect.left);
    const target = nodes[0];
    return target ? { x: target.rect.left + target.rect.width / 2, y: target.rect.top + target.rect.height / 2 } : null;
  }).catch(() => null);
  if (!point) return false;
  await page.mouse.click(point.x, point.y).catch(() => {});
  await page.waitForTimeout(250).catch(() => {});
  const option = await page.evaluate((statusText) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 12 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const items = [...document.body.querySelectorAll("li, div, span")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === statusText)
      .sort((a, b) => a.rect.top - b.rect.top);
    const target = items[0];
    return target ? { x: target.rect.left + target.rect.width / 2, y: target.rect.top + target.rect.height / 2 } : null;
  }, statusText).catch(() => null);
  if (option) {
    await page.mouse.click(option.x, option.y).catch(() => {});
    await page.waitForTimeout(250).catch(() => {});
  }
  return true;
}

async function fillComplaintOrderId(page, complaintOrderId) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(100).catch(() => {});
  const selector = "input[data-codex-main-order-id='1']";
  const found = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 60 && rect.height > 18 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    document.querySelectorAll("input[data-codex-main-order-id]").forEach((el) => el.removeAttribute("data-codex-main-order-id"));
    const queryButton = [...document.body.querySelectorAll("button, .el-button, .ant-btn, span, div")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "查询" && item.rect.top < 260)
      .sort((a, b) => b.rect.left - a.rect.left)[0];
    const queryTop = queryButton?.rect.top || 260;
    const inputs = [...document.body.querySelectorAll("input")]
      .filter(visible)
      .filter((input) => !input.disabled && !input.readOnly)
      .map((input) => ({
        input,
        rect: input.getBoundingClientRect(),
        value: input.value || "",
        placeholder: normalize(input.placeholder || ""),
        label: normalize(input.closest(".el-form-item, .ant-form-item, div")?.innerText || "")
      }))
      .filter((item) => item.rect.top < queryTop + 10);

    const target = inputs
      .filter((item) => item.placeholder === "主订单ID" || item.placeholder.includes("主订单ID"))
      .filter((item) => !/手机号|请输入内容|体验营|开始日期|结束日期/.test(item.placeholder))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0];
    if (!target) return null;
    target.input.setAttribute("data-codex-main-order-id", "1");
    return {
      x: target.rect.left + target.rect.width / 2,
      y: target.rect.top + target.rect.height / 2,
      placeholder: target.placeholder,
      label: target.label
    };
  }).catch(() => null);
  if (!found) return false;
  const locator = page.locator(selector).first();
  await locator.click({ force: true }).catch(() => {});
  await locator.fill("").catch(() => {});
  await locator.fill(String(complaintOrderId)).catch(async () => {
    await page.mouse.click(found.x, found.y).catch(() => {});
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(String(complaintOrderId), { delay: 10 }).catch(() => {});
  });
  await closeOpenDropdowns(page);
  await page.waitForTimeout(150).catch(() => {});
  return page.evaluate((expected) => {
    const input = document.querySelector("input[data-codex-main-order-id='1']");
    return Boolean(input && String(input.value || "").includes(String(expected)));
  }, String(complaintOrderId)).catch(() => false);
}

async function clickQueryButton(page) {
  await closeOpenDropdowns(page);
  await page.waitForTimeout(100).catch(() => {});
  const point = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 12 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const target = [...document.body.querySelectorAll("button, .el-button, .ant-btn, span, div")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "查询" && item.rect.top < 260)
      .sort((a, b) => b.rect.left - a.rect.left)[0];
    return target ? { x: target.rect.left + target.rect.width / 2, y: target.rect.top + target.rect.height / 2 } : null;
  }).catch(() => null);
  if (!point) return false;
  await page.mouse.click(point.x, point.y).catch(() => {});
  return true;
}

async function closeOpenDropdowns(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(80).catch(() => {});
  await page.mouse.click(8, 8).catch(() => {});
  await page.waitForTimeout(80).catch(() => {});
}

async function clickDetailForOrder(page, complaintOrderId) {
  const clickedOnlyDetail = await clickSingleVisibleDetail(page);
  if (clickedOnlyDetail) return true;

  const target = await page.evaluate((complaintOrderId) => {
    const normalizedTarget = normalizeId(complaintOrderId);
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 6 && rect.height > 6 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const textOf = (el) => String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    document.querySelectorAll("[data-codex-detail-button]").forEach((el) => el.removeAttribute("data-codex-detail-button"));
    const rows = [...document.body.querySelectorAll("tbody tr, .el-table__row, .ant-table-row, [role='row']")]
      .filter(visible)
      .filter((row) => normalizeId(textOf(row)).includes(normalizedTarget));
    const targetRow = rows[0];
    if (targetRow) {
      const rowRect = targetRow.getBoundingClientRect();
      const rowCenterY = rowRect.top + rowRect.height / 2;
      const detail = [...targetRow.querySelectorAll("a, button, span")]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { el, rect, text: textOf(el).replace(/\s+/g, ""), area: rect.width * rect.height, tag: el.tagName.toLowerCase() };
        })
        .filter((item) => item.text === "详情")
        .sort(sortDetailCandidates)[0];
      if (detail) return mark(detail.el, detail.rect);

      const fixedColumnDetail = [...document.body.querySelectorAll("a, button, span")]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { el, rect, text: textOf(el).replace(/\s+/g, ""), area: rect.width * rect.height, tag: el.tagName.toLowerCase() };
        })
        .filter((item) => item.text === "详情")
        .filter((item) => {
          const detailCenterY = item.rect.top + item.rect.height / 2;
          return Math.abs(detailCenterY - rowCenterY) <= Math.max(24, rowRect.height / 2 + 8);
        })
        .sort((a, b) => Math.abs((a.rect.top + a.rect.height / 2) - rowCenterY) - Math.abs((b.rect.top + b.rect.height / 2) - rowCenterY)
          || sortDetailCandidates(a, b))[0];
      if (fixedColumnDetail) return mark(fixedColumnDetail.el, fixedColumnDetail.rect);

      const allVisibleDetails = [...document.body.querySelectorAll("button, a, span")]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { el, rect, text: textOf(el).replace(/\s+/g, ""), area: rect.width * rect.height, tag: el.tagName.toLowerCase() };
        })
        .filter((item) => item.text === "详情" && item.rect.top > rowRect.top - 20)
        .sort(sortDetailCandidates);
      if (rows.length === 1 && allVisibleDetails.length === 1) return mark(allVisibleDetails[0].el, allVisibleDetails[0].rect);
    }
    return null;

    function mark(el, rect) {
      el.setAttribute("data-codex-detail-button", "1");
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: el.tagName, text: textOf(el) };
    }

    function sortDetailCandidates(a, b) {
      return detailPriority(a) - detailPriority(b) || a.area - b.area || b.rect.left - a.rect.left;
    }

    function detailPriority(item) {
      if (item.tag === "a" || item.tag === "button") return 0;
      if (item.tag === "span") return 1;
      return 2;
    }

    function normalizeId(value) {
      return String(value || "").replace(/\D/g, "");
    }
  }, String(complaintOrderId)).catch(() => null);
  if (!target) return false;
  const marked = page.locator("[data-codex-detail-button='1']").first();
  const clickedByLocator = await marked.click({ force: true, timeout: 2000 }).then(() => true).catch(() => false);
  if (!clickedByLocator) {
    const clickedByDom = await page.evaluate(() => {
      const el = document.querySelector("[data-codex-detail-button='1']");
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "center" });
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }).catch(() => false);
    if (!clickedByDom) await page.mouse.click(target.x, target.y).catch(() => {});
  }
  await page.waitForTimeout(500).catch(() => {});
  return true;
}

async function clickSingleVisibleDetail(page) {
  const count = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 6 && rect.height > 6 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const textOf = (el) => String(el.innerText || el.textContent || "").replace(/\s+/g, "").trim();
    document.querySelectorAll("[data-codex-single-detail]").forEach((el) => el.removeAttribute("data-codex-single-detail"));
    const details = [...document.body.querySelectorAll("a, button, span")]
      .filter(visible)
      .filter((el) => textOf(el) === "详情")
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, rect, area: rect.width * rect.height, tag: el.tagName.toLowerCase() };
      })
      .sort((a, b) => priority(a) - priority(b) || a.area - b.area || b.rect.left - a.rect.left);
    if (details.length === 1) details[0].el.setAttribute("data-codex-single-detail", "1");
    return details.length;

    function priority(item) {
      if (item.tag === "a" || item.tag === "button") return 0;
      return 1;
    }
  }).catch(() => 0);
  if (count !== 1) return false;
  const locator = page.locator("[data-codex-single-detail='1']").first();
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const clicked = await locator.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
  if (clicked) {
    await page.waitForTimeout(500).catch(() => {});
    return true;
  }
  return page.evaluate(() => {
    const el = document.querySelector("[data-codex-single-detail='1']");
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) || el;
    const clickable = target.closest("a, button, span, .el-button, [role='button']") || target;
    clickable.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }).catch(() => false);
}

async function waitForDetailPage(page, complaintOrderId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const target = String(complaintOrderId || "").replace(/\D/g, "");
  while (Date.now() < deadline) {
    const state = await page.evaluate((target) => {
      const detail = findDetailRoot(target);
      if (!detail) return { hasDetail: false, hasOrder: false };
      const text = normalize(detail.innerText || detail.textContent || "");
      return {
        hasDetail: /订单信息/.test(text) && /渠道信息/.test(text) && /商品信息/.test(text) && /用户信息/.test(text),
        hasOrder: !target || text.replace(/\D/g, "").includes(target)
      };

      function findDetailRoot(target) {
        const candidates = [...document.body.querySelectorAll("main, section, article, div, [role='dialog'], body")]
          .filter(visible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const text = normalize(el.innerText || el.textContent || "");
            let score = 0;
            if (/订单信息/.test(text)) score += 30;
            if (/渠道信息/.test(text)) score += 30;
            if (/商品信息/.test(text)) score += 30;
            if (/用户信息/.test(text)) score += 20;
            if (target && text.replace(/\D/g, "").includes(target)) score += 80;
            if (/退款申请/.test(text)) score += 10;
            if (/主订单ID\s*所属品类\s*投放计划ID/.test(text)) score -= 80;
            const area = rect.width * rect.height;
            return { el, rect, text, score, area };
          })
          .filter((item) => item.score >= 130)
          .sort((a, b) => b.score - a.score || a.area - b.area);
        return candidates[0]?.el || null;
      }

      function visible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.top < window.innerHeight * 1.2
          && rect.right > 0 && rect.left < window.innerWidth
          && style.display !== "none" && style.visibility !== "hidden";
      }

      function normalize(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }
    }, target).catch(() => ({ hasDetail: false, hasOrder: false }));
    if (state.hasDetail && state.hasOrder) return true;
    await page.waitForTimeout(300).catch(() => {});
  }
  return false;
}

async function readDetailPageText(page, complaintOrderId) {
  const target = String(complaintOrderId || "").replace(/\D/g, "");
  return page.evaluate((target) => {
    const root = findDetailRoot(target);
    return normalize((root || document.body).innerText || (root || document.body).textContent || "");

    function findDetailRoot(target) {
      const candidates = [...document.body.querySelectorAll("main, section, article, div, [role='dialog'], body")]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = normalize(el.innerText || el.textContent || "");
          let score = 0;
          if (/订单信息/.test(text)) score += 30;
          if (/渠道信息/.test(text)) score += 30;
          if (/商品信息/.test(text)) score += 30;
          if (/用户信息/.test(text)) score += 20;
          if (target && text.replace(/\D/g, "").includes(target)) score += 80;
          if (/退款申请/.test(text)) score += 10;
          if (/主订单ID\s*所属品类\s*投放计划ID/.test(text)) score -= 80;
          const area = rect.width * rect.height;
          return { el, score, area };
        })
        .filter((item) => item.score >= 130)
        .sort((a, b) => b.score - a.score || a.area - b.area);
      return candidates[0]?.el || null;
    }

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.top < window.innerHeight * 1.2
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    }

    function normalize(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
  }, target).catch(async () => page.locator("body").innerText({ timeout: 3000 }).catch(() => ""));
}

function extractDetailFieldsFromText(complaintOrderId, detailText) {
  const text = cleanText(detailText || "");
  const orderInfo = extractSection(text, "订单信息", ["渠道信息", "商品信息", "用户信息"]);
  const channelInfo = extractSection(text, "渠道信息", ["商品信息", "用户信息", "订单信息"]);
  const productInfo = extractSection(text, "商品信息", ["用户信息", "渠道信息", "订单信息"]);
  const userInfo = extractSection(text, "用户信息", ["订单信息", "渠道信息", "商品信息"]);
  return {
    "投诉订单ID": complaintOrderId,
    "订单ID": extractValue(orderInfo || text, "订单ID", ["下单时间", "支付金额", "支付方式", "订单状态", "销售归属人", "渠道信息"]),
    "渠道一级类型": extractValue(channelInfo || text, "渠道一级类型", ["渠道二级类型", "渠道三级类型", "渠道名称", "商品信息"]),
    "渠道二级类型": extractValue(channelInfo || text, "渠道二级类型", ["渠道三级类型", "渠道名称", "商品信息"]),
    "渠道三级类型": extractValue(channelInfo || text, "渠道三级类型", ["渠道名称", "商品信息"]),
    "渠道名称": extractValue(channelInfo || text, "渠道名称", ["商品信息", "所属品类", "商品ID", "商品名称"]),
    "所属品类": extractValue(productInfo || text, "所属品类", ["商品ID", "商品名称", "所在期数", "开营时间", "训练营名称", "用户信息"]),
    "商品名称": extractValue(productInfo || text, "商品名称", ["所在期数", "开营时间", "训练营名称", "用户信息"]),
    "用户ID": extractValue(userInfo || text, "用户ID", ["用户昵称", "手机号", "微信昵称", "用户信息"])
  };
}

function extractSection(text, sectionLabel, nextSections = []) {
  const source = String(text || "");
  const start = source.indexOf(sectionLabel);
  if (start < 0) return "";
  let end = source.length;
  for (const next of nextSections) {
    const index = source.indexOf(next, start + sectionLabel.length);
    if (index >= 0 && index < end) end = index;
  }
  return cleanText(source.slice(start, end));
}

function extractValue(text, label, stops = []) {
  const source = String(text || "");
  const labelPattern = escapeRegExp(label);
  const stopPattern = stops.map(escapeRegExp).join("|");
  const pattern = stopPattern
    ? new RegExp(`${labelPattern}\\s*[:：]\\s*([\\s\\S]*?)(?=\\s*(?:${stopPattern})\\s*[:：]|$)`)
    : new RegExp(`${labelPattern}\\s*[:：]\\s*([^\\n\\r]+)`);
  const value = cleanText(pattern.exec(source)?.[1] || "");
  return value.replace(/^[-：:\s]+/, "").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

async function readPageResultRows(page, complaintOrderId) {
  return page.evaluate((complaintOrderId) => {
    const normalizedTarget = normalizeId(complaintOrderId);
    const tables = [...document.body.querySelectorAll("table, .el-table, .ant-table, [role='table'], [role='grid']")];
    const rows = [];
    for (const table of tables.length ? tables : [document.body]) {
      const headers = readHeaders(table);
      const rowNodes = [...table.querySelectorAll("tbody tr, .el-table__row, .ant-table-row, [role='row']")]
        .filter(visible)
        .filter((row) => normalizeId(row.innerText || row.textContent || "").includes(normalizedTarget));
      for (const row of rowNodes) {
        const values = readCells(row);
        const mapped = {};
        for (let index = 0; index < values.length; index += 1) {
          const header = headers[index] || "";
          if (header) mapped[header] = values[index];
        }
        const text = normalize(row.innerText || row.textContent || "");
        rows.push(normalizeOutput(mapped, text, complaintOrderId));
      }
    }
    return dedupe(rows);

    function readHeaders(root) {
      const headerNodes = [...root.querySelectorAll("thead th, .el-table__header-wrapper th, .ant-table-thead th, [role='columnheader']")]
        .filter(visible);
      return headerNodes.map((node) => normalize(node.innerText || node.textContent || ""));
    }

    function readCells(row) {
      const cells = [...row.querySelectorAll("td, .cell, [role='cell'], [role='gridcell']")]
        .filter(visible)
        .map((cell) => normalize(cell.innerText || cell.textContent || ""))
        .filter(Boolean);
      if (cells.length) return cells;
      return normalize(row.innerText || row.textContent || "").split(/\s{2,}|\t+/).map(normalize).filter(Boolean);
    }

    function normalizeOutput(mapped, text, id) {
      return {
        "投诉订单ID": id,
        "订单ID": pick(mapped, ["主订单ID", "订单ID"]) || text.match(/\b[0-9]{10,}\b/)?.[0] || "",
        "渠道一级类型": pick(mapped, ["渠道一级类型"]),
        "渠道二级类型": pick(mapped, ["渠道二级类型"]),
        "渠道三级类型": pick(mapped, ["渠道三级类型"]),
        "渠道名称": pick(mapped, ["渠道名称", "渠道"]),
        "所属品类": pick(mapped, ["所属品类", "品类"]),
        "商品名称": pick(mapped, ["商品名称"]),
        "用户ID": pick(mapped, ["用户id", "用户ID", "用户Id"]) || extractAfterText(text, ["用户id", "用户ID"])
      };
    }

    function pick(mapped, labels) {
      for (const label of labels) {
        if (mapped[label]) return mapped[label];
      }
      return "";
    }

    function extractAfterText(text, labels) {
      for (const label of labels) {
        const match = new RegExp(`${escapeRegExp(label)}\\s*[:：]?\\s*([0-9]{5,})`).exec(text);
        if (match) return match[1];
      }
      return "";
    }

    function dedupe(items) {
      const seen = new Set();
      const result = [];
      for (const item of items) {
        const key = `${item["投诉订单ID"]}|${item["订单ID"]}|${item["用户ID"]}|${item["商品名称"]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
      }
      return result;
    }

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 6 && rect.height > 6 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    }

    function normalize(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function normalizeId(value) {
      return String(value || "").replace(/\D/g, "");
    }

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }, String(complaintOrderId)).catch(() => []);
}
