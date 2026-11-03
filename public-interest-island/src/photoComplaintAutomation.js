import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatComplaintDetails, normalizeDateTime, scoreOrders, uniqueUserIds } from "./photoComplaintParser.js";
import {
  clearChanceAssDateRange,
  clickChanceAssQueryButton,
  ensureChanceAssIdentityFilter,
  extractMatchedUserIds,
  fillChanceAssIdentityValue,
  verifyChanceAssIdentityFilter
} from "./userOverviewService.js";

export class PhotoComplaintAutomation {
  constructor(config) { this.config = config; this.pages = new Map(); }

  async problemOptions(ownerId, selectedPath, browserClient) {
    await browserClient.activateUser(ownerId);
    const dashboard = await browserClient.ensurePage(this.config.browser.dashboardUrl);
    if (!(await browserClient.ensureReady(dashboard)).ready) return { loginRequired: true, options: [] };
    return browserClient.withIsolatedPage(this.config.browser.complaintWorkUrl, async (page) => {
      await clickText(page, "新建"); await page.waitForTimeout(400); await chooseOpen(page, "问题标签");
      for (const value of selectedPath || []) { await clickVisibleChoice(page, value); await page.waitForTimeout(120); }
      const options = (await page.locator("[role=menuitem]:visible,[role=option]:visible,.el-cascader-menu__item:visible,.el-cascader-node:visible").allTextContents())
        .map((item) => item.trim()).filter(Boolean);
      return { loginRequired: false, options: [...new Set(options)] };
    });
  }

  async fill(task, { browserClient, screenshotDir }) {
    const existingPage = browserClient.getExistingPage();
    let authenticatedFromSharedProfile = false;
    if (task.loginScreenshotPath && existingPage && /login\.work\.weixin\.qq\.com/i.test(existingPage.url?.() || "")) {
      await existingPage.waitForURL((url) => !/login\.work\.weixin\.qq\.com/i.test(url.hostname), { timeout: 8000 }).catch(() => {});
      if (/login\.work\.weixin\.qq\.com/i.test(existingPage.url?.() || "")) {
        const readiness = browserClient.withIsolatedPage
          ? await browserClient.withIsolatedPage(resolveLoginProbeUrl(this.config), (probePage) =>
            browserClient.ensureReady(probePage, { waitMs: 2500 })).catch(() => null)
          : null;
        if (readiness?.ready) {
          authenticatedFromSharedProfile = true;
          await existingPage.close?.().catch(() => {});
        } else {
          const file = path.join(screenshotDir, `${task.id}-login.png`);
          fs.writeFileSync(file, await browserClient.captureScreenshot(existingPage), { mode: 0o600 });
          return { loginRequired: true, loginScreenshotPath: file };
        }
      }
    }

    const dashboard = authenticatedFromSharedProfile ? null : await browserClient.ensurePage(this.config.browser.dashboardUrl);
    if (!authenticatedFromSharedProfile && !(await browserClient.ensureReady(dashboard)).ready) {
      const qrReady = await browserClient.prepareQrLogin(dashboard);
      if (!qrReady) throw new Error("未能进入企业微信官方二维码页面，扫码会话未创建");
      const qrPage = browserClient.getExistingPage();
      if (!qrPage || !/login\.work\.weixin\.qq\.com/i.test(qrPage.url?.() || "")) {
        // 用户可能在二维码生成后的几秒内完成扫码，此时同一页面已回跳
        // 兴趣岛管理后台。这是登录成功，不应再按“二维码域名不符”报错。
        const redirectedReady = qrPage && await browserClient.ensureReady(qrPage, { waitMs: 2500 });
        if (!redirectedReady?.ready) {
          throw new Error("扫码截图来源校验失败：当前页面既不是企业微信官方二维码页，也未检测到兴趣岛登录态");
        }
      } else {
        const file = path.join(screenshotDir, `${task.id}-login.png`);
        fs.writeFileSync(file, await browserClient.captureScreenshot(qrPage), { mode: 0o600 });
        return { loginRequired: true, loginScreenshotPath: file };
      }
    }

    const data = { ...task.data };
    data.details = formatComplaintDetails(data.details);
    data.registeredAt = normalizeDateTime(data.registeredAt);
    const lookup = await lookupUserIdsWithFallback(data.phone, data.alternatePhone, (phone) =>
      browserClient.withIsolatedPage(this.config.browser.chanceAssUrl, (page) => lookupUser(page, phone)));
    const userIds = uniqueUserIds(lookup.rows);
    data.lookupPhoneUsed = lookup.phoneUsed;
    if (userIds.length === 1) {
      data.userId = userIds[0];
    } else if (data.userId && (userIds.length === 0 || [...userIds, ...(task.data.userCandidates || [])].includes(String(data.userId)))) {
      data.userId = String(data.userId);
    } else {
      const error = new Error(userIds.length ? "手机号对应多个不同用户ID，请人工确认" : "未查询到用户ID，请人工确认");
      error.statusCode = 409; error.reviewRequired = true; error.data = { userCandidates: userIds }; throw error;
    }

    const page = await browserClient.newPage(this.config.browser.complaintWorkUrl);
    this.pages.set(task.id, page);
    try {
      await clickText(page, "新建");
      await page.waitForTimeout(500);
      await ensureNearLabelChoice(page, "用户信息", "用户ID");
      await fillNearLabel(page, "用户信息", data.userId);
      await ensureNearLabelChoice(page, "关系", data.relationship || "本人");
      await ensureNearLabelChoice(page, "投诉订单类型", data.orderType || "正式营");

      const orderOptions = await readOptionsNearLabel(page, "主投诉订单ID");
      const orders = orderOptions.map((option) => parseOrderOption(option)).filter((order) => order.id);
      const ranked = scoreOrders(data, orders);
      if (!/^\d{6,}$/.test(String(data.mainOrderId || ""))) data.mainOrderId = "";
      data.relatedOrderId = "";
      if (!data.mainOrderId) {
        if (!orders.length) {
          const error = new Error("未读取到主投诉订单，请在复核页人工选择主订单");
          error.statusCode = 409; error.reviewRequired = true; error.data = { userId: data.userId, orderCandidates: [] }; throw error;
        }
        if (!complaintDetailsMentionOrder(data, orders)) {
          data.mainOrderId = orders[0].id;
          data.orderSelectionReason = "投诉详情未提及具体订单，已选择兴趣岛列表中的最新订单";
        } else if (!ranked.length || ranked[0].score < 40 || (ranked[1] && ranked[0].score - ranked[1].score < 15)) {
          const error = new Error("订单无法唯一高置信匹配，请在复核页人工选择主订单");
          error.statusCode = 409; error.reviewRequired = true; error.data = { userId: data.userId, orderCandidates: ranked.slice(0, 20) }; throw error;
        } else {
          data.mainOrderId = ranked[0].id;
          data.orderSelectionReason = "已根据投诉详情匹配订单";
        }
      }
      await chooseNearLabel(page, "主投诉订单ID", data.mainOrderId);
      if (data.externalNumber) await fillNearLabel(page, "第三方投诉单号", data.externalNumber);
      await chooseCascade(page, "问题标签", data.problemLabels || []);
      await fillNearLabel(page, "投诉详情", data.details);
      await fillDateNearLabel(page, "投诉时间", data.registeredAt);
      await chooseCascade(page, "投诉来源", ["工商", data.source]);
      await fillNearLabel(page, "备注", data.notes || "");
      await verifyComplaintTextFields(page, data);

      const values = await readFormValues(page);
      const formFingerprint = crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
      const formScreenshotPath = path.join(screenshotDir, `${task.id}-form.png`);
      await page.screenshot({ path: formScreenshotPath, type: "png", fullPage: true });
      fs.chmodSync(formScreenshotPath, 0o600);
      return { loginRequired: false, data: { ...data, orderCandidates: ranked.slice(0, 10) }, formFingerprint, formScreenshotPath };
    } catch (error) {
      error.data = { ...data, ...(error.data || {}) };
      const failurePath = path.join(screenshotDir, `${task.id}-failure.png`);
      await page.screenshot({ path: failurePath, type: "png", fullPage: true }).catch(() => {});
      if (fs.existsSync(failurePath)) {
        fs.chmodSync(failurePath, 0o600);
        error.formScreenshotPath = failurePath;
      }
      await page.close().catch(() => {});
      this.pages.delete(task.id);
      throw error;
    }
  }

  async submit(task, { browserClient }) {
    const page = this.pages.get(task.id);
    let submissionAttempted = false;
    try {
      if (!page || page.isClosed()) throw submissionPreconditionError("已填写的浏览器表单已失效，请重新执行自动填表");
      const submitButton = await officialComplaintSubmitButton(page, this.config.browser?.complaintWorkUrl);
      const before = await readFormValues(page);
      if (!before.length) throw submissionPreconditionError("投诉新建表单结构校验失败，请重新执行自动填表");
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify(before)).digest("hex");
      if (fingerprint !== task.formFingerprint) throw submissionPreconditionError("表单内容已变化，请重新截图确认");
      const previousNotices = await visibleComplaintSubmitNotices(page);
      // 先用 trial 完成所有可逆的可点击性检查。真实 click 一旦开始调用，
      // 即使 Playwright 随后因导航、页面关闭或超时抛错，也不能再安全重试。
      await submitButton.click({ trial: true });
      submissionAttempted = true;
      await submitButton.click();
      await confirmComplaintSubmissionIfNeeded(page);
      const verified = await Promise.any([
        page.waitForURL((url) => isVerifiedComplaintSubmissionDestination(url, this.config.browser?.complaintWorkUrl), { timeout: 10000 }).then(() => true),
        waitForNewComplaintSubmitNotice(page, previousNotices).then(() => true)
      ]).catch(() => false);
      if (verified) { await page.close().catch(() => {}); this.pages.delete(task.id); }
      if (verified) return { verified };

      // 填表截图是在点击提交前生成的，不能作为“提交失败现场”。验证不明时
      // 重新截取当前页面，便于确认是停在确认框、校验提示还是已经回到列表页。
      const previousPath = String(task.formScreenshotPath || "");
      const screenshotDir = submissionScreenshotDir(previousPath, this.config);
      const formScreenshotPath = path.join(screenshotDir, `${task.id}-submit-unverified.png`);
      try {
        fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
        await page.screenshot({ path: formScreenshotPath, type: "png", fullPage: true });
        if (!fs.existsSync(formScreenshotPath)) throw new Error("截图文件未生成");
        fs.chmodSync(formScreenshotPath, 0o600);
      } catch (cause) {
        throw new Error(`提交结果无法验证且现场截图保存失败：${cause.message}`);
      }
      return { verified: false, formScreenshotPath };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      error.submissionAttempted ??= submissionAttempted;
      throw error;
    }
  }

  async adjustMainOrder(task, mainOrderId, { screenshotDir }) {
    const page = this.pages.get(task.id);
    if (!page || page.isClosed()) {
      const error = new Error("云端已填写表单页已失效，不能只修改记录；请重新执行自动填表后再调整");
      error.statusCode = 409;
      throw error;
    }
    await chooseNearLabel(page, "主投诉订单ID", mainOrderId);
    const selectedValue = await readNearLabelControlValue(page, "主投诉订单ID");
    if (!selectedValue.includes(String(mainOrderId))) throw new Error("主投诉订单ID调整后校验失败，已保留原确认状态");
    const data = { ...task.data, mainOrderId: String(mainOrderId), relatedOrderId: "", orderSelectionReason: "用户人工调整" };
    const values = await readFormValues(page);
    const formFingerprint = crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
    const formScreenshotPath = path.join(screenshotDir, `${task.id}-form.png`);
    await page.screenshot({ path: formScreenshotPath, type: "png", fullPage: true });
    fs.chmodSync(formScreenshotPath, 0o600);
    return { data, formFingerprint, formScreenshotPath };
  }
}

function resolveLoginProbeUrl(config) {
  return config.browser?.chanceAssUrl
    || config.browser?.complaintWorkUrl
    || config.browser?.dashboardUrl
    || "https://edu-admin.qlchat.com/saleAssign/chanceAss";
}

function isVerifiedComplaintSubmissionDestination(url, configuredUrl) {
  const destination = new URL(url);
  const official = new URL(configuredUrl || "https://edu-admin.qlchat.com/complaint/complaintWork");
  if (destination.protocol !== "https:" || destination.origin !== official.origin) return false;
  return /^\/complaint\/(?:complaint(?:detail|view)|detail)(?:\/|$)/i.test(destination.pathname);
}

function submissionPreconditionError(message) {
  const error = new Error(message);
  error.submissionAttempted = false;
  return error;
}

async function officialComplaintSubmitButton(page, configuredUrl) {
  const current = new URL(page.url());
  const official = new URL(configuredUrl || "https://edu-admin.qlchat.com/complaint/complaintWork");
  const currentPath = current.pathname.replace(/\/$/, "");
  const officialPath = official.pathname.replace(/\/$/, "");
  if (current.protocol !== "https:" || current.origin !== "https://edu-admin.qlchat.com" || current.origin !== official.origin || currentPath !== officialPath) {
    throw submissionPreconditionError("当前页面不是兴趣岛官方投诉新建页，请重新执行自动填表");
  }
  const submitButton = page.getByRole("button", { name: "提交", exact: true }).first();
  if (!await submitButton.count() || !await submitButton.isVisible().catch(() => false)) {
    throw submissionPreconditionError("未找到兴趣岛官方投诉提交按钮，请重新执行自动填表");
  }
  return submitButton;
}

function submissionScreenshotDir(previousPath, config) {
  if (previousPath) return path.dirname(previousPath);
  const tempDir = config.photoComplaints?.tempDir
    || path.join(config.storage?.dataDir || ".data", "photo-complaints");
  return path.join(tempDir, "screenshots");
}

export const COMPLAINT_SUBMIT_SUCCESS_TEXT = /提交成功|创建成功|新增成功|操作成功|保存成功|工单创建成功/;
const COMPLAINT_SUBMIT_NOTICE_SELECTOR = "[role=alert]:visible,[role=status]:visible,.el-message:visible,.el-notification:visible";

async function visibleComplaintSubmitNotices(page) {
  const texts = await page.locator(COMPLAINT_SUBMIT_NOTICE_SELECTOR).evaluateAll((nodes) =>
    nodes.map((node) => String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean));
  return texts.filter((text) => COMPLAINT_SUBMIT_SUCCESS_TEXT.test(text));
}

async function waitForNewComplaintSubmitNotice(page, previousNotices) {
  await page.waitForFunction(({ previousNotices, successPattern, selector }) => {
    const previous = new Map();
    for (const text of previousNotices) previous.set(text, (previous.get(text) || 0) + 1);
    const success = new RegExp(successPattern);
    for (const node of document.querySelectorAll(selector)) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || !node.getClientRects().length) continue;
      const text = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      if (!success.test(text)) continue;
      const remaining = previous.get(text) || 0;
      if (!remaining) return true;
      previous.set(text, remaining - 1);
    }
    return false;
  }, {
    previousNotices,
    successPattern: COMPLAINT_SUBMIT_SUCCESS_TEXT.source,
    selector: COMPLAINT_SUBMIT_NOTICE_SELECTOR.replace(/:visible/g, "")
  }, { timeout: 10000 });
}

export async function confirmComplaintSubmissionIfNeeded(page) {
  // 部分版本点击“提交”后会再出现一次站内确认框。网站用户已经在本站完成
  // 二次确认，因此这里可以继续确认，但只点击可见对话框中的明确确认按钮。
  await page.waitForTimeout(250);
  const dialog = page.getByRole("dialog").filter({ hasText: /确认|提交|创建工单/ }).last();
  if (!await dialog.count() || !await dialog.isVisible().catch(() => false)) return false;
  const confirmButton = dialog.getByRole("button", { name: /^(确定|确认|提交|确认提交)$/ }).last();
  if (!await confirmButton.count() || !await confirmButton.isVisible().catch(() => false)) return false;
  await confirmButton.click();
  return true;
}

export async function lookupUserIdsWithFallback(primaryPhone, alternatePhone, query) {
  const primary = String(primaryPhone || "").trim();
  const alternate = String(alternatePhone || "").trim();
  const first = await query(primary);
  if (uniqueUserIds(first?.rows).length || !/^1\d{10}$/.test(alternate) || alternate === primary) {
    return { rows: first?.rows || [], phoneUsed: primary, fallbackUsed: false };
  }
  const second = await query(alternate);
  return { rows: second?.rows || [], phoneUsed: alternate, fallbackUsed: true };
}

async function lookupUser(page, phone) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  const dateRange = await clearChanceAssDateRange(page);
  if (!dateRange.cleared) {
    const detail = dateRange.error || dateRange.after || dateRange.before;
    throw new Error(`机会管理开始日期、结束日期未能清空，已阻止查询${detail ? `：${detail}` : ""}`);
  }

  const lookup = { type: "phone", label: "手机号", value: String(phone) };
  const identity = await ensureChanceAssIdentityFilter(page, lookup);
  if (!identity.confirmed) throw new Error(`机会管理筛选条件未能切换为手机号${identity.reason ? `：${identity.reason}` : ""}`);
  if (!await fillChanceAssIdentityValue(page, lookup.value)) throw new Error("未找到手机号查询输入框或手机号未能填入");
  const verified = await verifyChanceAssIdentityFilter(page, lookup);
  if (!verified.confirmed) throw new Error(`手机号筛选条件校验失败${verified.reason ? `：${verified.reason}` : ""}`);
  if (!await clickChanceAssQueryButton(page, lookup)) throw new Error("查询按钮未找到，或未发出包含本次手机号的查询请求");
  await page.waitForTimeout(1800);
  const matchedUserIds = await extractMatchedUserIds(page, lookup);
  const rows = matchedUserIds.length
    ? matchedUserIds.map((userId) => ({ userId, text: `用户ID ${userId}` }))
    : await readChanceAssUserIdRows(page);
  return { rows };
}

async function readChanceAssUserIdRows(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const tables = [...document.querySelectorAll("table")];
    for (const table of tables) {
      const headers = [...table.querySelectorAll("thead th")].map((cell) => clean(cell.innerText || cell.textContent));
      const userIdIndex = headers.findIndex((header) => /^用户\s*ID$/i.test(header));
      if (userIdIndex < 0) continue;
      const rows = [...table.querySelectorAll("tbody tr")].map((row) => {
        const cells = [...row.querySelectorAll("td")].map((cell) => clean(cell.innerText || cell.textContent));
        const raw = cells[userIdIndex] || "";
        const userId = raw.match(/(?<!\d)\d{6,20}(?!\d)/)?.[0] || "";
        return { userId, text: cells.join(" | ") };
      }).filter((row) => row.userId);
      if (rows.length) return rows;
    }
    return [];
  });
}

async function fieldContainer(page, label) {
  const labelNode = page.getByText(new RegExp(`^\\s*${escapeRegex(label)}[：:]?\\s*$`)).first();
  if (!await labelNode.count()) throw new Error(`未找到表单字段：${label}`);
  return labelNode.locator("xpath=ancestor::*[self::div or self::label][.//input or .//textarea][1]");
}
export async function fillNearLabel(page, label, value) {
  const placeholders = { "投诉详情": "投诉详情", "备注": "备注信息" };
  let input;
  if (placeholders[label]) {
    input = page.locator(`textarea[placeholder*="${placeholders[label]}"]:visible`).first();
    if (!await input.count()) throw new Error(`未找到${label}文本框`);
  } else {
    const box = await fieldContainer(page, label);
    input = box.locator("input:visible,textarea:visible").last();
  }
  await input.fill(String(value || ""));
  await input.dispatchEvent("input");
  await input.dispatchEvent("change");
}
async function verifyComplaintTextFields(page, data) {
  const details = page.locator('textarea[placeholder*="投诉详情"]:visible').first();
  const notes = page.locator('textarea[placeholder*="备注信息"]:visible').first();
  const actualDetails = await details.inputValue().catch(() => "");
  const actualNotes = await notes.inputValue().catch(() => "");
  if (actualDetails !== String(data.details || "")) throw new Error("投诉详情写入校验失败，已阻止进入提交确认");
  if (actualNotes !== String(data.notes || "")) throw new Error("备注字段写入校验失败，已阻止进入提交确认");
}
async function fillDateNearLabel(page, label, value) {
  const expected = normalizeDateTime(value);
  if (!expected) throw new Error(`${label}日期无法识别`);
  const input = page.locator(`input[placeholder*="${label}"]:visible,input[placeholder*="选择${label}"]:visible`).first();
  if (!await input.count()) throw new Error(`未找到${label}日期输入框`);
  if (await input.isEditable().catch(() => false)) {
    await input.fill(expected);
  } else {
    await input.evaluate((element, nextValue) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(element, nextValue);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, expected);
  }
  await input.dispatchEvent("input");
  await input.dispatchEvent("change");
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(150);
  const actual = await input.inputValue().catch(() => "");
  if (actual.slice(0, 16) !== expected.slice(0, 16)) throw new Error(`${label}写入校验失败，已阻止进入提交确认`);
}
async function chooseNearLabel(page, label, value) {
  await closeOpenChoices(page);
  const node = page.getByText(new RegExp(`^\\s*${escapeRegex(label)}[：:]?\\s*$`)).first();
  const box = node.locator("xpath=ancestor::*[self::div or self::label][1]");
  await box.locator("input,[role=combobox],.el-select").last().click(); await page.waitForTimeout(150);
  await clickVisibleChoice(page, value);
}
async function readNearLabelControlValue(page, label) {
  const node = page.getByText(new RegExp(`^\\s*${escapeRegex(label)}[：:]?\\s*$`)).first();
  const box = node.locator("xpath=ancestor::*[self::div or self::label][.//input][1]");
  const text = await box.innerText().catch(() => "");
  const values = await box.locator("input:visible,[role=combobox]:visible").evaluateAll((items) =>
    items.map((item) => `${item.value || ""} ${item.getAttribute("title") || ""}`).join(" "));
  return `${text} ${values}`.replace(/\s+/g, " ").trim();
}
async function ensureNearLabelChoice(page, label, value) {
  const node = page.getByText(new RegExp(`^\\s*${escapeRegex(label)}[：:]?\\s*$`)).first();
  if (!await node.count()) throw new Error(`未找到表单字段：${label}`);
  const box = node.locator("xpath=ancestor::*[self::div or self::label][.//input][1]");
  const visibleText = String(await box.innerText().catch(() => "")).replace(/\s+/g, "");
  const controlValues = await box.locator("input:visible,[role=combobox]:visible").evaluateAll((items) => items.map((item) => `${item.value || ""} ${item.getAttribute("placeholder") || ""}`).join(" "));
  if (`${visibleText} ${controlValues}`.includes(String(value).replace(/\s+/g, ""))) return;
  await chooseNearLabel(page, label, value);
}
async function readOptionsNearLabel(page, label) { await chooseOpen(page, label); return page.locator("[role=option]:visible,.el-select-dropdown__item:visible").allTextContents(); }
async function chooseOpen(page, label) { await closeOpenChoices(page); const node = page.getByText(new RegExp(`^\\s*${escapeRegex(label)}[：:]?\\s*$`)).first(); const box = node.locator("xpath=ancestor::*[self::div or self::label][.//input][1]"); await box.locator("input,[role=combobox],.el-select").last().click(); await page.waitForTimeout(200); }
async function chooseCascade(page, label, values) { await chooseOpen(page, label); for (const value of values) { await clickVisibleChoice(page, value); await page.waitForTimeout(120); } }
async function clickVisibleChoice(page, value) {
  const raw = String(value).trim();
  const expected = /^\d{6,}$/.test(raw)
    ? new RegExp(`(?:^|\\D)${escapeRegex(raw)}(?:\\D|$)`)
    : new RegExp(`^\\s*${escapeRegex(raw)}\\s*$`);
  const choices = page.locator([
    "[role=option]:visible",
    "[role=menuitem]:visible",
    ".el-select-dropdown__item:visible",
    ".el-dropdown-menu__item:visible",
    ".el-cascader-menu__item:visible",
    ".el-cascader-node:visible"
  ].join(",")).filter({ hasText: expected });
  const count = await choices.count();
  if (!count) throw new Error(`未找到可见下拉选项：${value}`);
  const choice = choices.last();
  await choice.waitFor({ state: "visible", timeout: 5000 });
  await choice.click({ timeout: 5000 });
  await page.waitForTimeout(150);
}
async function closeOpenChoices(page) {
  const open = page.locator("[role=option]:visible,.el-select-dropdown__item:visible,.el-cascader-node:visible");
  if (await open.count()) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(120);
  }
}
async function clickText(page, text) { const button = page.getByRole("button", { name: text, exact: true }).first(); if (await button.count()) return button.click(); return page.getByText(text, { exact: true }).last().click(); }
async function readFormValues(page) { return page.locator("input:visible,textarea:visible").evaluateAll((items) => items.map((el) => ({ name: el.name || el.placeholder || "", value: el.value || "" }))); }
export function parseOrderOption(text) { const value = String(text).trim(); return { id: value.match(/\b\d{6,}\b/)?.[0] || "", name: value, amount: Number(value.match(/(?:¥|￥|金额[:：]?\s*)([\d,.]+)/)?.[1]?.replace(/,/g, "") || 0), paidAt: value.match(/20\d{2}-\d{2}-\d{2}/)?.[0] || "", type: /体验/.test(value) ? "体验营" : /轻课/.test(value) ? "轻课" : "正式营" }; }
export function complaintDetailsMentionOrder(data, orders) {
  const details = String(data?.details || "").replace(/\s+/g, "").toLowerCase();
  if (!details) return false;
  for (const order of orders || []) {
    const id = String(order.id || "").trim();
    if (/^\d{6,}$/.test(id) && details.includes(id)) return true;
    const name = String(order.name || "").replace(/[\s()（）\d]/g, "").toLowerCase();
    if (name.length >= 4 && details.includes(name)) return true;
    const amount = Number(order.amount || 0);
    if (amount > 0 && new RegExp(`(?:￥|¥|金额|费用|学费)?\\s*${escapeRegex(String(amount))}(?:\\.0+)?(?:元)?`).test(details)) return true;
  }
  return false;
}
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
