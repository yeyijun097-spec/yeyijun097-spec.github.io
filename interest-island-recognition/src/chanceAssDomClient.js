import fs from "node:fs";
import path from "node:path";
import { waitForInteractiveLogin } from "./interactiveLogin.js";
import { resolveDetailTrainingCampName } from "./orderDetailTrainingCampDom.js";
import { resolveChanceSearchControls } from "./chanceAssSearchControls.js";

const DEFAULT_CHANCE_URL = "about:blank";

export async function createChanceAssDomClient(config, sharedClient = null, disabled = false) {
  if (disabled || config.chance?.enabled === false) return new OfflineChanceDomClient();
  if (!sharedClient?.context) {
    throw new Error("DOM 档案流程需要复用已打开的浏览器上下文。");
  }
  const page = await sharedClient.context.newPage();
  page.setDefaultTimeout(config.browser?.timeoutMs || 30000);
  await page.goto(config.chance?.url || DEFAULT_CHANCE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  return new ChanceAssDomClient(page, config);
}

class OfflineChanceDomClient {
  async ensureReady() {
    return { ready: true, waitedForLogin: false };
  }

  async fetchProfile() {
    return emptyProfile("offline mode");
  }

  async close() {}
}

class ChanceAssDomClient {
  constructor(page, config) {
    this.page = page;
    this.config = config;
    this.cache = new Map();
    // 仅人工登录阶段允许前台；批量订单查询保持后台运行。
    this.loginConfirmed = false;
    this.lastReadinessDiagnosticAt = 0;
  }

  async ensureReady(waitForLogin = true) {
    if (await this.isReady()) {
      this.loginConfirmed = true;
      return { ready: true, waitedForLogin: false };
    }
    if (!waitForLogin) return { ready: false, waitedForLogin: false };

    if (this.config.browser?.headless && this.config.browser?.allowInteractiveLogin !== true) {
      throw new Error("LOGIN_REQUIRED: chanceAss 登录态失效，需要临时打开有头浏览器人工验证");
    }

    const result = await waitForInteractiveLogin({
      kind: "chanceAss",
      label: "chanceAss 机会管理",
      page: this.page,
      targetUrl: this.config.chance?.url || DEFAULT_CHANCE_URL,
      isReady: () => this.isReady(),
      timeoutMs: this.config.browser?.loginTimeoutMs || 300000
    });
    this.loginConfirmed = result.ready;
    if (result.ready && !this.config.browser?.headless) {
      console.log("chanceAss 登录验证完成：后续订单批处理保持后台，不主动抢前台焦点。");
    }
    return result;
  }

  async isReady() {
    const context = this.page?.context?.();
    const pages = [this.page, ...(context?.pages?.() || [])]
      .filter((candidate, index, items) => candidate && !candidate.isClosed?.() && items.indexOf(candidate) === index);
    const readyPage = await findReadyChancePage(pages);
    if (readyPage) {
      if (readyPage !== this.page) {
        this.page = readyPage;
        console.log(`chanceAss 已自动切换到登录成功的机会管理页：${readyPage.url?.() || ""}`);
      }
      return true;
    }
    if (Date.now() - this.lastReadinessDiagnosticAt >= 10000) {
      this.lastReadinessDiagnosticAt = Date.now();
      const urls = pages.map((candidate) => candidate.url?.() || "about:blank").join(" | ");
      console.warn(`chanceAss 登录检测尚未命中机会管理页，当前标签：${urls || "无"}`);
    }
    return false;
  }

  async fetchProfile(row) {
    const key = `${row.userId || ""}|${row.docProductType || row.existing?.L || ""}|${row.docCampName || row.existing?.M || ""}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const promise = this.fetchProfileUncached(row);
    this.cache.set(key, promise);
    return promise;
  }

  async fetchProfileUncached(row) {
    const startedAt = Date.now();
    const profilePageReset = {
      broughtToFront: false,
      navigated: false,
      resetClicked: false,
      searchReady: false,
      rowNumber: row?.rowNumber || 0
    };
    let dateRange = { verified: false };
    const withCommon = (profile) => ({
      ...profile,
      profilePageReset,
      profileDateCleared: Boolean(dateRange?.verified)
    });
    // L/M 文档值的兜底必须统一在双通道合并阶段处理：仅当档案通道失败时写 Q/R，
    // 绝不能在 DOM 客户端伪造档案字段，更不能从 M 列推断 S。
    const withDocNameFallback = () => null;
    try {
      // 不在每行订单查询前调用 bringToFront，避免 chanceAss 窗口反复弹到前台。
      profilePageReset.focusSuppressed = !this.config.browser?.headless;
      await this.page.goto(this.config.chance?.url || DEFAULT_CHANCE_URL, { waitUntil: "domcontentloaded" }).then(() => {
        profilePageReset.navigated = true;
      }).catch(() => {});
      await this.page.waitForTimeout(600);
      profilePageReset.resetClicked = await clickButtonByText(this.page, "重置").catch(() => false);
      await this.page.waitForTimeout(300).catch(() => {});
      // 先清理日期。日期控件可能触发 FineBI 重绘，必须避免把刚填入的 D 列 ID 清掉。
      dateRange = await clearChanceDateRangeForSearch(this.page);
      let userIdFilled = await fillChanceUserId(this.page, String(row.userId || ""));
      if (!userIdFilled) {
        const userIdState = await readChanceSearchState(this.page);
        const reason = "chanceAss DOM 未选择用户ID查询类型或未填入D列用户ID，未执行查询";
        return withTiming(withCommon({
          ...emptyProfile(reason, "identity-input-not-ready"),
          profileDomUserIdFilled: false,
          profileDomUserIdVerified: false,
          profileDomUserIdTypeSelected: Boolean(userIdState.userIdMode === "用户ID"),
          profileDomUserIdMode: userIdState.userIdMode || "",
          profileDomUserIdInputPlaceholder: userIdState.userIdInputPlaceholder || "",
          profileSelectedReason: reason
        }), startedAt);
      }
      profilePageReset.searchReady = await isChanceSearchPage(this.page);
      // 用户 ID 已写入并完成读回校验后，不能因为页面“就绪”文本检测偶发失败
      // 再次进入机会管理：FineBI 重载会清空已验证的筛选条件，最终表现为
      // “重新进入后未选择用户ID”。仅在尚未写入身份条件的初始化阶段允许恢复页面。
      if (shouldReenterChanceSearchPage({ userIdFilled, searchReady: profilePageReset.searchReady })) {
        await this.page.goto(this.config.chance?.url || DEFAULT_CHANCE_URL, { waitUntil: "domcontentloaded" }).then(() => {
          profilePageReset.navigated = true;
        }).catch(() => {});
        await this.page.waitForTimeout(800).catch(() => {});
        profilePageReset.resetClicked = await clickButtonByText(this.page, "重置").catch(() => false) || profilePageReset.resetClicked;
        await this.page.waitForTimeout(300).catch(() => {});
        dateRange = await clearChanceDateRangeForSearch(this.page);
        userIdFilled = await fillChanceUserId(this.page, String(row.userId || ""));
        if (!userIdFilled) {
          const userIdState = await readChanceSearchState(this.page);
          const reason = "chanceAss DOM 重新进入机会管理后未选择用户ID或未填入D列用户ID，未执行查询";
          return withTiming(withCommon({
            ...emptyProfile(reason, "identity-input-not-ready"),
            profileDomUserIdFilled: false,
            profileDomUserIdVerified: false,
            profileDomUserIdTypeSelected: Boolean(userIdState.userIdMode === "用户ID"),
            profileDomUserIdMode: userIdState.userIdMode || "",
            profileDomUserIdInputPlaceholder: userIdState.userIdInputPlaceholder || "",
            profileSelectedReason: reason
          }), startedAt);
        }
        profilePageReset.searchReady = await isChanceSearchPage(this.page);
      }
      const searchState = await readChanceSearchState(this.page);
      const queryClicked = await clickChanceIdentityQueryButton(this.page, String(row.userId || ""));
      if (!queryClicked) {
        const fallback = withDocNameFallback("chanceAss DOM 查询按钮未点击", {
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange
        });
        if (fallback) return fallback;
        return withTiming(withCommon({
          ...emptyProfile("chanceAss DOM 查询按钮未点击", "query-button-not-clicked"),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange
        }), startedAt);
      }
      if (!dateRange.verified) {
        const textAfterDateClear = await this.page.locator("body").innerText().catch(() => "");
        await writeChanceDebug(this.config, row, "chance-date-clear-failed", textAfterDateClear);
      }
      let queryResultFound = await waitForChanceQueryResult(this.page, row, 5000);

      let tableText = await this.page.locator("body").innerText().catch(() => "");
      await writeChanceDebug(this.config, row, "chance-after-query-no-date", tableText);
      await writeChanceDebug(this.config, row, "chance-after-query", tableText);
      if (!queryResultFound && !tableText.includes(String(row.userId || ""))) {
        const fallback = withDocNameFallback("chanceAss DOM 未查询到用户档案", {
          profileDomQueryResultFound: false,
          profileDomQueryTextSnippet: cleanText(tableText.slice(0, 2500)),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange,
          profileSelectedReason: userIdFilled ? "已输入用户ID并点击查询，但页面未出现该用户ID；启用M列兜底" : "用户ID输入框未可靠填入；启用M列兜底"
        });
        if (fallback) return fallback;
        return withTiming(withCommon({
          ...emptyProfile("chanceAss DOM 未查询到用户档案", "query-result-not-found"),
          profileDomQueryResultFound: false,
          profileDomQueryTextSnippet: cleanText(tableText.slice(0, 2500)),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange,
          profileSelectedReason: userIdFilled ? "已输入用户ID并点击查询，但页面未出现该用户ID" : "用户ID输入框未可靠填入"
        }), startedAt);
      }
      if (!queryResultFound && tableText.includes(String(row.userId || ""))) {
        const fallback = withDocNameFallback("chanceAss DOM 查询结果未出现学员档案入口", {
          profileDomQueryResultFound: false,
          profileDomQueryTextSnippet: cleanText(tableText.slice(0, 2500)),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange,
          profileSelectedReason: "页面出现当前用户ID，但未出现学员档案按钮；启用M列兜底"
        });
        if (fallback) return fallback;
        return withTiming(withCommon({
          ...emptyProfile("chanceAss DOM 查询结果未出现学员档案入口", "archive-entry-not-found"),
          profileDomQueryResultFound: false,
          profileDomQueryTextSnippet: cleanText(tableText.slice(0, 2500)),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange,
          profileSelectedReason: "页面出现当前用户ID，但未出现学员档案按钮"
        }), startedAt);
      }

      const archiveAttempt = await clickStudentProfile(this.page, row);
      if (!archiveAttempt.page) {
        const archiveState = await getStudentArchiveState(this.page, row, 800);
        const fallback = withDocNameFallback("chanceAss DOM 未找到或未点击学员档案", {
          profileDomQueryResultFound: Boolean(queryResultFound || tableText.includes(String(row.userId || ""))),
          profileDomQueryTextSnippet: cleanText(tableText.slice(0, 2500)),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange,
          profileDomStudentArchiveButtonFound: Boolean(archiveAttempt.buttonFound),
          profileDomStudentArchiveClickStrategy: archiveAttempt.strategy || "",
          profileDomArchiveVerifyText: archiveState.textSnippet || "",
          profileDomStillOnChanceList: Boolean(archiveState.stillOnChanceList),
          profileDomArchiveVerifyFailedReason: archiveState.reason || ""
        });
        if (fallback) return fallback;
        return withTiming(withCommon({
          ...emptyProfile("chanceAss DOM 未找到或未点击学员档案", "archive-not-opened"),
          profileDomQueryResultFound: Boolean(queryResultFound || tableText.includes(String(row.userId || ""))),
          profileDomQueryTextSnippet: cleanText(tableText.slice(0, 2500)),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange,
          profileDomStudentArchiveButtonFound: Boolean(archiveAttempt.buttonFound),
          profileDomStudentArchiveClickStrategy: archiveAttempt.strategy || "",
          profileDomArchiveVerifyText: archiveState.textSnippet || "",
          profileDomStillOnChanceList: Boolean(archiveState.stillOnChanceList),
          profileDomArchiveVerifyFailedReason: archiveState.reason || ""
        }), startedAt);
      }
      this.page = archiveAttempt.page;
      await this.page.waitForTimeout(1200);
      const afterArchiveText = await this.page.locator("body").innerText().catch(() => "");
      await writeChanceDebug(this.config, row, "chance-after-archive-click", afterArchiveText);
      const archiveState = await getStudentArchiveState(this.page, row);
      if (!archiveState.ready) {
        const archiveError = archiveState.stillOnChanceList
          ? "chanceAss DOM 点击学员档案后仍停留机会管理列表页，未进入订单信息页"
          : "chanceAss DOM 点击学员档案后未进入学员档案页面";
        const fallback = withDocNameFallback(archiveError, {
          profileDomQueryResultFound: Boolean(queryResultFound || tableText.includes(String(row.userId || ""))),
          profileDomQueryTextSnippet: cleanText(tableText.slice(0, 2500)),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange,
          profileDomStudentArchiveButtonFound: Boolean(archiveAttempt.buttonFound),
          profileDomStudentArchiveClickStrategy: archiveAttempt.strategy || "",
          profileDomArchiveOpened: false,
          profileDomArchiveVerifyText: archiveState.textSnippet || cleanText(afterArchiveText.slice(0, 2500)),
          profileDomStillOnChanceList: Boolean(archiveState.stillOnChanceList),
          profileDomArchiveVerifyFailedReason: archiveState.reason || ""
        });
        if (fallback) return fallback;
        return withTiming(withCommon({
          ...emptyProfile(archiveError, "archive-not-opened"),
          profileDomQueryResultFound: Boolean(queryResultFound || tableText.includes(String(row.userId || ""))),
          profileDomQueryTextSnippet: cleanText(tableText.slice(0, 2500)),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange,
          profileDomStudentArchiveButtonFound: Boolean(archiveAttempt.buttonFound),
          profileDomStudentArchiveClickStrategy: archiveAttempt.strategy || "",
          profileDomArchiveOpened: false,
          profileDomArchiveVerifyText: archiveState.textSnippet || cleanText(afterArchiveText.slice(0, 2500)),
          profileDomStillOnChanceList: Boolean(archiveState.stillOnChanceList),
          profileDomArchiveVerifyFailedReason: archiveState.reason || ""
        }), startedAt);
      }
      await clickTabByText(this.page, "订单信息");
      const orderState = await getOrderPageState(this.page);
      const orderTabOpened = orderState.ready;
      if (!orderTabOpened) {
        await writeChanceDebug(this.config, row, "chance-order-page-not-opened", orderState.textSnippet || await this.page.locator("body").innerText().catch(() => ""));
        const orderError = orderState.stillOnChanceList
          ? "chanceAss DOM 未进入学员档案页，不能读取订单信息"
          : "chanceAss DOM 已进入档案页，但订单信息 Tab 未打开";
        const fallback = withDocNameFallback(orderError, {
          profileDomQueryResultFound: Boolean(queryResultFound || tableText.includes(String(row.userId || ""))),
          profileDomQueryTextSnippet: cleanText(tableText.slice(0, 2500)),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange,
          profileDomStudentArchiveButtonFound: Boolean(archiveAttempt.buttonFound),
          profileDomStudentArchiveClickStrategy: archiveAttempt.strategy || "",
          profileDomArchiveOpened: !orderState.stillOnChanceList,
          profileDomArchiveVerifyText: archiveState.textSnippet || "",
          profileDomStillOnChanceList: Boolean(orderState.stillOnChanceList),
          profileDomOrderTabOpened: false,
          profileDomWrongPageForOrderParse: orderState.stillOnChanceList ? "chanceList" : "notOrderPage",
          profileDomOrderTextSnippet: orderState.textSnippet || "",
          profileSelectedReason: `${orderState.reason || orderError}；启用M列兜底`
        });
        if (fallback) return fallback;
        return withTiming(withCommon({
          ...emptyProfile(orderError, "order-tab-not-opened"),
          profileDomQueryResultFound: Boolean(queryResultFound || tableText.includes(String(row.userId || ""))),
          profileDomQueryTextSnippet: cleanText(tableText.slice(0, 2500)),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange,
          profileDomStudentArchiveButtonFound: Boolean(archiveAttempt.buttonFound),
          profileDomStudentArchiveClickStrategy: archiveAttempt.strategy || "",
          profileDomArchiveOpened: !orderState.stillOnChanceList,
          profileDomArchiveVerifyText: archiveState.textSnippet || "",
          profileDomStillOnChanceList: Boolean(orderState.stillOnChanceList),
          profileDomOrderTabOpened: false,
          profileDomWrongPageForOrderParse: orderState.stillOnChanceList ? "chanceList" : "notOrderPage",
          profileDomOrderTextSnippet: orderState.textSnippet || "",
          profileSelectedReason: orderState.reason || ""
        }), startedAt);
      }

      const orderScan = await collectDomOrdersAcrossScroll(this.page);
      const orders = orderScan.orders;
      const orderTextSnippet = await collectOrderPageText(this.page);
      await writeChanceDebug(this.config, row, "chance-order-page", orderTextSnippet);
      const selected = selectOrderForRow(orders, row);
      if (!selected || selected.isNullSelection) {
        return withTiming(withCommon({
          ...emptyProfile(selected?.selectionReason || "chanceAss DOM 未可靠选中订单", "order-not-selected"),
          profileCandidateCount: orders.length,
          profileDomQueryResultFound: Boolean(queryResultFound || tableText.includes(String(row.userId || ""))),
          profileDomQueryTextSnippet: cleanText(tableText.slice(0, 2500)),
          profileDomUserIdFilled: Boolean(userIdFilled),
          profileDomUserIdVerified: Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || ""))),
          profileDomSearchDateRange: dateRange,
          profileDomStudentArchiveButtonFound: Boolean(archiveAttempt.buttonFound),
          profileDomStudentArchiveClickStrategy: archiveAttempt.strategy || "",
          profileDomArchiveOpened: true,
          profileDomArchiveVerifyText: archiveState.textSnippet || "",
          profileDomStillOnChanceList: false,
          profileDomOrderTabOpened: Boolean(orderTabOpened),
          profileDomWrongPageForOrderParse: orderScan.summary?.wrongPage || "",
          profileDomOrderCount: orders.length,
          profileOrderScrollCompleted: orderScan.summary,
          profileOrderMatchScore: selected?.nameScore || 0,
          profileFormalOrderFound: Boolean(selected?.formalOrderFound),
          profileOrderSelectionReason: selected?.selectionReason || "",
          profileDomOrderTextSnippet: orderTextSnippet
        }), startedAt);
      }

      const detailClickSucceeded = await clickOrderDetail(this.page, selected);
      const detailWaitSucceeded = detailClickSucceeded
        ? await waitForOrderDetail(this.page, selected.orderId)
        : false;
      const detail = detailClickSucceeded ? await extractOrderDetail(this.page, selected) : {};
      const detailReadiness = resolveOrderDetailReadiness({
        expectedOrderId: selected.orderId,
        clickSucceeded: detailClickSucceeded,
        waitSucceeded: detailWaitSucceeded,
        detail
      });
      await writeChanceDebug(this.config, row, "chance-detail", JSON.stringify({
        ...detailReadiness,
        panelOrderId: detail.panelOrderId || "",
        trainingName: detail.trainingName || "",
        category: detail.category || "",
        failureReason: detail.failureReason || ""
      }));
      const merged = mergeProfileFromDom({ row, selected, detail, detailReadiness, orderTextSnippet });
      merged.profileDomQueryResultFound = Boolean(queryResultFound || tableText.includes(String(row.userId || "")));
      merged.profileDomQueryTextSnippet = cleanText(tableText.slice(0, 2500));
      merged.profileDomUserIdFilled = Boolean(userIdFilled);
      merged.profileDomUserIdVerified = Boolean(searchState.userId && String(searchState.userId).includes(String(row.userId || "")));
      merged.profileDomSearchDateRange = dateRange;
      merged.profileDomStudentArchiveButtonFound = Boolean(archiveAttempt.buttonFound);
      merged.profileDomStudentArchiveClickStrategy = archiveAttempt.strategy || "";
      merged.profileDomArchiveOpened = true;
      merged.profileDomArchiveVerifyText = archiveState.textSnippet || "";
      merged.profileDomStillOnChanceList = false;
      merged.profileDomOrderTabOpened = Boolean(orderTabOpened);
      merged.profileDomWrongPageForOrderParse = "";
      merged.profileOrderScrollCompleted = orderScan.summary;
      merged.profileOrderMatchScore = selected.nameScore || 0;
      return withTiming(withCommon(merged), startedAt);
    } catch (error) {
      const fallback = withDocNameFallback(`chanceAss DOM 异常：${error.message}`, {
        profileDomException: error.message,
        profileSelectedReason: `chanceAss DOM 异常：${error.message}；启用M列兜底`
      });
      if (fallback) return fallback;
      return withTiming(withCommon(emptyProfile(`chanceAss DOM 异常：${error.message}`, "unexpected-error")), startedAt);
    }
  }

  async close() {
    await this.page.close().catch(() => {});
  }
}

async function fillChanceUserId(page, userId) {
  if (!userId) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let controls = await waitForChanceSearchControls({
      findControls: () => locateChanceSearchControls(page),
      acceptControls: (candidate) => ensureChanceUserIdMode(page, candidate),
      sleep: (ms) => page.waitForTimeout(ms)
    });
    if (!controls) continue;

    // 切换下拉框会触发 FineBI 重绘；每次都重新定位同一输入组，绝不复用旧节点。
    controls = await waitForChanceSearchControls({
      findControls: () => locateChanceSearchControls(page),
      acceptControls: async (candidate) => Boolean(candidate?.inputId)
        && (await readChanceUserIdMode(page)) === "用户ID",
      sleep: (ms) => page.waitForTimeout(ms),
      attempts: 6,
      delayMs: 250
    });
    if (!controls?.inputId) continue;
    const input = page.locator(`[data-chance-search-control-id="${controls.inputId}"]`);
    if ((await input.count().catch(() => 0)) !== 1 || !(await input.isVisible().catch(() => false))) continue;
    await input.click({ force: true }).catch(() => {});
    await input.fill("").catch(() => {});
    await input.fill(userId).catch(() => {});
    await input.evaluate((element, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, userId).catch(() => {});
    await input.press("Tab").catch(() => {});
    await page.waitForTimeout(250).catch(() => {});

    const relocated = await locateChanceSearchControls(page);
    const verifiedInput = relocated?.inputId
      ? page.locator(`[data-chance-search-control-id="${relocated.inputId}"]`)
      : null;
    const verified = verifiedInput ? await verifiedInput.inputValue().catch(() => "") : "";
    if (verified.trim().split(/[,，\s]+/).includes(String(userId).trim())) {
      console.log("chanceAss 用户ID写入校验通过");
      return true;
    }
  }
  return false;
}

// FineBI 在跳转机会管理页后会先渲染外框、再异步重绘筛选条件。此时立即
// 扫描会得到“没有唯一用户ID输入组”的假失败；等待短暂稳定窗口后再判定。
export async function waitForChanceSearchControls({
  findControls,
  acceptControls = async () => true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 20,
  delayMs = 400
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controls = await findControls?.();
    if (controls && await acceptControls(controls)) return controls;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return null;
}

async function ensureChanceUserIdMode(page, controls = null) {
  const current = normalizeChanceIdentityMode(controls?.modeText || await readChanceUserIdMode(page));
  if (current === "用户ID") return true;
  if (!controls?.modeId) return false;

  const modeLocator = page.locator(`[data-chance-search-control-id="${controls.modeId}"]`);
  await modeLocator.evaluate((element) => {
    document.querySelectorAll("[data-chance-user-id-mode]").forEach((item) => item.removeAttribute("data-chance-user-id-mode"));
    element.setAttribute("data-chance-user-id-mode", "1");
  }).catch(() => {});
  // Element UI 的下拉层挂在 body 下。必须只使用本次点击新打开的面板，
  // 不可在所有可见下拉层里按页面位置挑一个，否则会误点其它筛选器。
  await page.evaluate(() => {
    document.querySelectorAll("[data-chance-preexisting-listbox]")
      .forEach((element) => element.removeAttribute("data-chance-preexisting-listbox"));
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 20 && rect.height > 14
        && style.visibility !== "hidden" && style.display !== "none";
    };
    document.querySelectorAll("[role='listbox'], .el-select-dropdown, .el-popper, .el-dropdown-menu")
      .forEach((element) => {
        if (visible(element)) element.setAttribute("data-chance-preexisting-listbox", "1");
      });
  }).catch(() => {});

  await modeLocator.click({ force: true }).catch(() => {});
  await page.waitForTimeout(300).catch(() => {});

  const optionMarked = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 14 && rect.top >= 0 && rect.top < window.innerHeight
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const mode = document.querySelector("[data-chance-user-id-mode]");
    const popupId = mode?.getAttribute("aria-controls") || mode?.getAttribute("aria-owns") || "";
    const popup = popupId ? document.getElementById(popupId) : null;
    const listboxes = [...document.querySelectorAll("[role='listbox'], .el-select-dropdown, .el-popper, .el-dropdown-menu")]
      .filter(visible);
    const opened = listboxes.filter((element) => !element.hasAttribute("data-chance-preexisting-listbox"));
    const elementUiPopup = opened.filter((element) => element.matches(".el-select-dropdown, .el-popper"));
    const optionRoot = popup || (opened.length === 1 ? opened[0]
      : (elementUiPopup.length === 1 ? elementUiPopup[0] : null));
    if (!optionRoot) return false;
    const candidates = [...optionRoot.querySelectorAll("[role='option'], .el-select-dropdown__item, li, label, button, div, span")]
      .filter((el) => el !== mode && visible(el))
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter(({ text }) => text === "用户ID")
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const option = candidates[0]?.el;
    if (!option) return false;
    document.querySelectorAll("[data-chance-user-id-option]").forEach((el) => el.removeAttribute("data-chance-user-id-option"));
    option.setAttribute("data-chance-user-id-option", "1");
    return true;
  }).catch(() => false);
  if (!optionMarked) {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }

  await page.locator("[data-chance-user-id-option]").first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(250).catch(() => {});
  return (await readChanceUserIdMode(page)) === "用户ID";
}

async function readChanceUserIdMode(page) {
  const controls = await locateChanceSearchControls(page);
  return normalizeChanceIdentityMode(controls?.modeText || "");
}

function normalizeChanceIdentityMode(value) {
  const compact = String(value || "").replace(/\s+/g, "").trim();
  if (/^(用户ID|用户id|UID|uid|id)$/i.test(compact)) return "用户ID";
  if (/^(手机号|微信昵称)$/.test(compact)) return compact;
  return "";
}

export function shouldReenterChanceSearchPage({ userIdFilled, searchReady }) {
  // 一旦用户 ID 写入且读回成功，页面是否通过文本就绪检测不再构成重进条件。
  // 重进会销毁 FineBI 当前筛选状态，造成“已填入后又未选择用户ID”的假失败。
  return !userIdFilled && !searchReady;
}

async function locateChanceSearchControls(page) {
  const candidates = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (input) => {
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      return rect.width > 12 && rect.height > 12 && rect.bottom > 0 && rect.top < window.innerHeight
        && style.visibility !== "hidden" && style.display !== "none";
    };
    document.querySelectorAll("[data-chance-search-control-id], [data-chance-search-container-id]")
      .forEach((element) => {
        element.removeAttribute("data-chance-search-control-id");
        element.removeAttribute("data-chance-search-container-id");
      });
    let sequence = 0;
    const idFor = (element) => {
      if (!element.dataset.chanceSearchControlId) {
        element.dataset.chanceSearchControlId = `chance-control-${sequence += 1}`;
      }
      return element.dataset.chanceSearchControlId;
    };
    const inputs = [...document.querySelectorAll("input")]
      .filter(visible)
      .filter((input) => !input.disabled && !input.readOnly)
      .filter((input) => !/开始日期|结束日期/.test(input.placeholder || ""));
    const output = [];
    const readModeText = (mode) => {
      const modeValues = [
        mode?.value,
        mode?.getAttribute("value"),
        mode?.getAttribute("title"),
        mode?.getAttribute("aria-label"),
        mode?.innerText,
        mode?.textContent,
        ...[...(mode?.querySelectorAll("input, [aria-selected='true'], .el-select__selected-item, .el-select__tags-text") || [])]
          .map((element) => element.value || element.getAttribute("value") || element.getAttribute("title") || element.innerText || element.textContent || "")
      ];
      return modeValues.map(normalize).find(Boolean) || "";
    };
    const visibleQueryButtons = [...document.querySelectorAll("button, [role='button']")]
      .filter(visible)
      .filter((button) => normalize(button.innerText || button.textContent) === "查询");
    const nearestQueryButton = (input, mode) => {
      const inputRect = input.getBoundingClientRect();
      const modeRect = mode.getBoundingClientRect();
      const centerY = (Math.min(inputRect.top, modeRect.top) + Math.max(inputRect.bottom, modeRect.bottom)) / 2;
      const rightEdge = Math.max(inputRect.right, modeRect.right);
      const ranked = visibleQueryButtons.map((button) => {
        const rect = button.getBoundingClientRect();
        // 该距离只用于把已经锁定的历史 Element UI 输入组绑定到其最近“查询”按钮；
        // 不参与输入框或身份类型的选择，避免回退为全页坐标猜测。
        const score = Math.abs(((rect.top + rect.bottom) / 2) - centerY)
          + Math.max(0, rightEdge - rect.left) * 4
          + Math.max(0, rect.left - rightEdge) * 0.05;
        return { button, score, rect };
      }).sort((a, b) => a.score - b.score || a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      if (!ranked[0] || (ranked[1] && Math.abs(ranked[0].score - ranked[1].score) < 1)) return null;
      return ranked[0].button;
    };

    // 历史已跑通的路径是同一 Element UI 输入组中的“前置身份下拉 + 值输入框”。
    // FineBI 重绘会清空输入框 placeholder，不能再把 placeholder 当作唯一条件；但也不能
    // 在全页 49 个输入框中猜测。只有同一输入组内存在真实身份下拉，且能从占位符、模式
    // 或其 DOM 结构取得身份证据时，才将该输入框标记为可写入的用户 ID 输入框。
    const groups = new Map();
    for (const input of inputs) {
      const inputGroup = input.closest(".el-input-group.el-input-group--prepend, .el-input-group--prepend");
      const prepend = inputGroup?.querySelector(".el-input-group__prepend");
      if (!inputGroup || !prepend || !visible(prepend)) continue;
      const modeCandidates = [...prepend.querySelectorAll([
        "[role='combobox']",
        "[aria-haspopup='listbox']",
        ".el-select",
        ".el-input",
        "input",
        "button"
      ].join(","))]
        .filter(visible)
        .sort((a, b) => {
          const aSelect = Number(a.matches("[role='combobox'], [aria-haspopup='listbox'], .el-select"));
          const bSelect = Number(b.matches("[role='combobox'], [aria-haspopup='listbox'], .el-select"));
          return bSelect - aSelect || a.getBoundingClientRect().width - b.getBoundingClientRect().width;
        });
      const mode = modeCandidates[0] || null;
      if (!mode) continue;
      const modeText = readModeText(mode) || readModeText(prepend);
      const exactPlaceholder = /可用逗号分隔多选/.test(input.placeholder || "");
      const hintedPlaceholder = /逗号|分隔|多选|用户ID/.test(input.placeholder || "");
      const knownIdentityMode = /^(用户ID|用户id|UID|uid|id|手机号|微信昵称)$/i.test(modeText.replace(/\s+/g, ""));
      // filter-item 是历史真实查询器的结构标识，但不能单独证明它就是用户 ID 输入框。
      // 它必须与下拉的已选身份或输入框提示共同出现，才允许进入候选集合。
      if (!exactPlaceholder && !hintedPlaceholder && !knownIdentityMode) continue;
      const filterItem = input.closest(".el-autocomplete.filter-item");
      let score = 0;
      if (filterItem) score += 1200;
      if (exactPlaceholder) score += 1000;
      else if (hintedPlaceholder) score += 600;
      if (mode !== prepend) score += 300;
      if (/^(用户ID|用户id|UID|uid|id)$/i.test(modeText.replace(/\s+/g, ""))) score += 180;
      else if (/^(手机号|微信昵称)$/.test(modeText.replace(/\s+/g, ""))) score += 120;
      const previous = groups.get(inputGroup);
      if (!previous || score > previous.score) groups.set(inputGroup, { input, mode, modeText, score });
    }
    const rankedGroups = [...groups.values()]
      .sort((a, b) => b.score - a.score
        || a.input.getBoundingClientRect().top - b.input.getBoundingClientRect().top
        || a.input.getBoundingClientRect().left - b.input.getBoundingClientRect().left);
    const selected = rankedGroups[0];
    // 等分候选代表无法确认身份输入组，必须显式失败，绝不能写入相邻筛选字段。
    if (!selected || (rankedGroups[1] && rankedGroups[1].score === selected.score)) return output;
    const query = nearestQueryButton(selected.input, selected.mode);
    if (!query) return output;
    const containerId = `chance-historical-container-${sequence += 1}`;
    selected.input.closest(".el-input-group.el-input-group--prepend, .el-input-group--prepend")
      .dataset.chanceSearchContainerId = containerId;
    output.push(
      {
        id: idFor(selected.input),
        containerId,
        kind: "input",
        placeholder: selected.input.placeholder || "",
        identityInput: true,
        visible: true,
        disabled: selected.input.disabled,
        readOnly: selected.input.readOnly,
        stable: true
      },
      {
        id: idFor(selected.mode),
        containerId,
        kind: selected.mode.matches("[role='combobox'], [aria-haspopup='listbox'], .el-select") ? "combobox" : "select",
        selectedText: selected.modeText,
        text: selected.modeText,
        visible: true,
        stable: true
      },
      { id: idFor(query), containerId, kind: "button", text: "查询", visible: true, stable: true }
    );
    return output;
  }).catch(() => []);
  return resolveChanceSearchControls(candidates);
}

async function clickChanceIdentityQueryButton(page, expectedUserId) {
  const controls = await locateChanceSearchControls(page);
  if (!controls?.queryId || (await readChanceUserIdMode(page)) !== "用户ID") return false;
  const input = controls.inputId ? page.locator(`[data-chance-search-control-id="${controls.inputId}"]`) : null;
  if (!input || (await input.count().catch(() => 0)) !== 1) return false;
  const value = await input.inputValue().catch(() => "");
  if (!value.trim().split(/[,，\s]+/).includes(String(expectedUserId || "").trim())) return false;
  const query = page.locator(`[data-chance-search-control-id="${controls.queryId}"]`);
  if ((await query.count().catch(() => 0)) !== 1 || !(await query.isVisible().catch(() => false))) return false;
  await query.click({ force: true }).catch(() => {});
  return true;
}

export async function isChanceSearchPage(page) {
  if (!page || page.isClosed?.()) return false;
  const url = String(page.url?.() || "");
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!/(^|\.)qlchat\.com$/i.test(host) || !/\/saleAssign\/chanceAss/.test(url)) return false;

  // 机会管理列表数据量很大，innerText 会触发布局计算，线上偶发连续
  // 3 秒超时；截图中页面已经可用，检测却一直得到空字符串。优先保留
  // 可见文本判断，再用不触发布局的 textContent 兜底。
  let text = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
  if (!text) {
    text = await page.locator("body").evaluate((element) => element.textContent || "").catch(() => "");
  }
  const normalized = String(text || "").replace(/\s+/g, "");
  const textReady = /机会管理/.test(normalized)
    && /用户ID/.test(normalized)
    && /查询/.test(normalized)
    && /所属品类|付费类型|推广类型|销售归属人/.test(normalized);
  if (textReady) return true;

  // FineBI 重绘期间 body 文本可能暂时不可读，但关键控件已经存在。
  // 用小范围定位器确认页面，不再依赖整页文本的布局计算。
  const [chanceTitle, userIdMarker, queryMarker] = await Promise.all([
    page.getByText("机会管理", { exact: true }).count().catch(() => 0),
    page.getByText("用户ID", { exact: true }).count().catch(() => 0),
    page.getByText("查询", { exact: true }).count().catch(() => 0)
  ]);
  return chanceTitle > 0 && userIdMarker > 0 && queryMarker > 0;
}

export async function findReadyChancePage(pages = []) {
  for (const candidate of pages) {
    if (await isChanceSearchPage(candidate)) return candidate;
  }
  return null;
}

async function clearChanceDateRange(page) {
  const points = await page.evaluate(() => {
    const inputs = [...document.body.querySelectorAll("input")].filter((input) => {
      const rect = input.getBoundingClientRect();
      return rect.width > 100 && rect.height > 20 && rect.top < 170 && /开始日期|结束日期|\d{4}-\d{2}-\d{2}/.test(input.placeholder || input.value || "");
    });
    if (!inputs.length) return [];
    const sorted = inputs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return sorted.slice(0, 2).map((input) => {
      const rect = input.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
  }).catch(() => []);
  for (const point of points) {
    await page.mouse.click(point.x, point.y).catch(() => {});
    await page.keyboard.press("Meta+A").catch(async () => page.keyboard.press("Control+A").catch(() => {}));
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
  return points.length > 0;
}

async function clearChanceDateRangeForSearch(page) {
  const target = await findChanceDateRangeTarget(page);

  let cleared = { applied: false, values: [], placeholders: [], verified: false };

  if (target) {
    const directClear = await clearDateRangeByVisibleClearIcon(page, target);
    if (directClear.verified) {
      return {
        source: "no-date",
        start: "",
        end: "",
        applied: Boolean(directClear.applied),
        verified: true,
        visibleValues: directClear.values || [],
        placeholders: directClear.placeholders || [],
        clearStrategy: directClear.strategy || "visible-clear-icon",
        clearTarget: target.debug || {}
      };
    }

    for (const point of target.hoverPoints || []) {
      await page.mouse.move(point.x, point.y).catch(() => {});
      await page.waitForTimeout(220).catch(() => {});
      for (const clearPoint of target.clearPoints || []) {
        await page.mouse.move(clearPoint.x, clearPoint.y).catch(() => {});
        await page.waitForTimeout(80).catch(() => {});
        await page.mouse.click(clearPoint.x, clearPoint.y).catch(() => {});
        await page.waitForTimeout(220).catch(() => {});
        const quickCheck = await readChanceDateRangeValues(page, target);
        if (quickCheck.verified) {
          return {
            source: "no-date",
            start: "",
            end: "",
            applied: Boolean(quickCheck.applied),
            verified: true,
            visibleValues: quickCheck.values || [],
            placeholders: quickCheck.placeholders || [],
            clearStrategy: "hover-clear-icon",
            clearTarget: target.debug || {}
          };
        }
      }
    }

    for (const point of target.inputPoints || []) {
      await page.mouse.click(point.x, point.y).catch(() => {});
      await page.keyboard.press("Meta+A").catch(async () => page.keyboard.press("Control+A").catch(() => {}));
      await page.keyboard.press("Backspace").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      await page.keyboard.press("Tab").catch(() => {});
      await page.waitForTimeout(100).catch(() => {});
    }
  }

  if (!target) {
    for (const placeholder of ["开始日期", "结束日期"]) {
      const locator = page.locator(`input[placeholder='${placeholder}']`).first();
      if (await locator.count().catch(() => 0)) {
        await locator.click({ force: true }).catch(() => {});
        await page.keyboard.press("Meta+A").catch(async () => page.keyboard.press("Control+A").catch(() => {}));
        await page.keyboard.press("Backspace").catch(() => {});
        await page.keyboard.press("Delete").catch(() => {});
        await page.keyboard.press("Tab").catch(() => {});
        await page.waitForTimeout(120).catch(() => {});
      }
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200).catch(() => {});
  cleared = await readChanceDateRangeValues(page, target);

  if (!cleared.verified && target) {
    await forceClearChanceDateInputs(page, target);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200).catch(() => {});
    cleared = await readChanceDateRangeValues(page, target);
  }

  if (!target && !cleared?.applied) {
    await clearChanceDateRange(page);
    cleared = await readChanceDateRangeValues(page, target);
  }

  return {
    source: "no-date",
    start: "",
    end: "",
    applied: Boolean(cleared?.applied),
    verified: Boolean(cleared?.verified),
    visibleValues: cleared?.values || [],
    placeholders: cleared?.placeholders || [],
    clearStrategy: cleared?.verified ? "input-or-dom-clear" : "failed",
    clearTarget: target?.debug || {}
  };
}

async function clearDateRangeByVisibleClearIcon(page, target) {
  const triggerPoints = [
    ...(target.inputPoints || []),
    ...(target.hoverPoints || []),
    { x: Math.max(target.left + 8, target.right - 20), y: (target.top + target.bottom) / 2 }
  ];
  const clearPoints = [
    { x: Math.max(target.left + 8, target.right - 18), y: (target.top + target.bottom) / 2 },
    { x: Math.max(target.left + 8, target.right - 28), y: (target.top + target.bottom) / 2 },
    { x: Math.max(target.left + 8, target.right - 38), y: (target.top + target.bottom) / 2 },
    ...(target.clearPoints || [])
  ];

  for (const trigger of triggerPoints) {
    await page.mouse.move(trigger.x, trigger.y).catch(() => {});
    await page.waitForTimeout(120).catch(() => {});
    await page.mouse.click(trigger.x, trigger.y).catch(() => {});
    await page.waitForTimeout(120).catch(() => {});
    for (const point of clearPoints) {
      await page.mouse.move(point.x, point.y).catch(() => {});
      await page.waitForTimeout(80).catch(() => {});
      await page.mouse.click(point.x, point.y).catch(() => {});
      await page.waitForTimeout(180).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      const check = await readChanceDateRangeValues(page, target);
      if (check.verified) return { ...check, strategy: "focus-hover-clear-icon" };
    }
  }
  return await readChanceDateRangeValues(page, target);
}

async function findChanceDateRangeTarget(page) {
  return await page.evaluate(() => {
    const visible = (input) => {
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      return rect.width > 80 && rect.height > 18 && rect.top >= 0 && rect.top < 220
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const dateLike = (input) => /开始日期|结束日期|\d{4}[-./]\d{2}[-./]\d{2}/.test(input.placeholder || input.value || "");
    const inputs = [...document.body.querySelectorAll("input")]
      .filter((input) => visible(input) && dateLike(input))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const pair = findBestPair(inputs);
    if (!pair) return null;
    const rects = pair.map((input) => input.getBoundingClientRect());
    const inputLeft = Math.min(...rects.map((rect) => rect.left));
    const inputRight = Math.max(...rects.map((rect) => rect.right));
    const inputTop = Math.min(...rects.map((rect) => rect.top));
    const inputBottom = Math.max(...rects.map((rect) => rect.bottom));
    const wrapper = findRangeWrapper(pair, { left: inputLeft, right: inputRight, top: inputTop, bottom: inputBottom });
    const rangeRect = wrapper?.rect || { left: inputLeft, right: inputRight, top: inputTop, bottom: inputBottom, width: inputRight - inputLeft, height: inputBottom - inputTop };
    const left = rangeRect.left;
    const right = rangeRect.right;
    const top = rangeRect.top;
    const bottom = rangeRect.bottom;
    const centerY = (top + bottom) / 2;
    return {
      left,
      right,
      top,
      bottom,
      inputPoints: pair.map((input) => {
        const rect = input.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }),
      hoverPoints: [
        { x: Math.max(left + 8, right - 28), y: centerY },
        { x: Math.max(left + 8, right - 44), y: centerY },
        { x: Math.min(right - 8, left + Math.max(24, (right - left) / 2)), y: centerY }
      ],
      clearPoints: [
        { x: Math.max(left + 8, right - 17), y: centerY },
        { x: Math.max(left + 8, right - 28), y: centerY },
        { x: Math.max(left + 8, right - 40), y: centerY },
        { x: Math.max(left + 8, right - 54), y: centerY },
        { x: Math.max(left + 8, right - 8), y: centerY }
      ],
      values: pair.map((input) => input.value || ""),
      placeholders: pair.map((input) => input.placeholder || ""),
      debug: {
        wrapperClass: wrapper?.className || "",
        wrapperText: (wrapper?.text || "").slice(0, 80),
        inputLeft,
        inputRight,
        inputTop,
        inputBottom,
        wrapperLeft: left,
        wrapperRight: right,
        wrapperTop: top,
        wrapperBottom: bottom
      }
    };

    function findBestPair(items) {
      if (items.length < 2) return null;
      const byPlaceholder = [
        items.find((input) => /开始日期/.test(input.placeholder || "")),
        items.find((input) => /结束日期/.test(input.placeholder || ""))
      ];
      if (byPlaceholder[0] && byPlaceholder[1]) return byPlaceholder;
      for (let i = 0; i < items.length - 1; i += 1) {
        const a = items[i].getBoundingClientRect();
        const b = items[i + 1].getBoundingClientRect();
        if (Math.abs(a.top - b.top) < 16 && b.left > a.left) return [items[i], items[i + 1]];
      }
      return items.slice(0, 2);
    }

    function findRangeWrapper(pair, inputRect) {
      const common = commonAncestor(pair[0], pair[1]);
      const candidates = [];
      let el = common;
      while (el && el !== document.body && el !== document.documentElement) {
        const rect = el.getBoundingClientRect();
        const className = String(el.className || "");
        const text = String(el.innerText || el.textContent || "");
        const containsInputs = pair.every((input) => el.contains(input));
        const plausibleSize = rect.width >= (inputRect.right - inputRect.left) - 4
          && rect.width < Math.max(900, window.innerWidth * 0.7)
          && rect.height >= 26
          && rect.height < 88
          && rect.top >= 0
          && rect.top < 220;
        if (containsInputs && plausibleSize) {
          const classScore = /date|picker|range|editor|input|time/i.test(className) ? 0 : 80;
          const textScore = /至/.test(text) ? 0 : 30;
          const clearRoomScore = rect.right > inputRect.right + 8 ? 0 : 50;
          const areaScore = rect.width * rect.height / 1000;
          candidates.push({ el, rect, className, text, score: classScore + textScore + clearRoomScore + areaScore });
        }
        el = el.parentElement;
      }
      const best = candidates.sort((a, b) => a.score - b.score)[0];
      if (best) return best;

      const expanded = {
        left: inputRect.left,
        right: Math.min(window.innerWidth - 4, inputRect.right + 54),
        top: inputRect.top - 4,
        bottom: inputRect.bottom + 4,
        width: Math.min(window.innerWidth - 4, inputRect.right + 54) - inputRect.left,
        height: inputRect.bottom - inputRect.top + 8
      };
      return { rect: expanded, className: "expanded-input-range", text: "" };
    }

    function commonAncestor(a, b) {
      const seen = new Set();
      let current = a;
      while (current) {
        seen.add(current);
        current = current.parentElement;
      }
      current = b;
      while (current) {
        if (seen.has(current)) return current;
        current = current.parentElement;
      }
      return a.parentElement || b.parentElement;
    }
  }).catch(() => null);
}

async function readChanceDateRangeValues(page, target) {
  return await page.evaluate((target) => {
    const inputs = [...document.body.querySelectorAll("input")]
      .map((input) => ({ input, rect: input.getBoundingClientRect() }))
      .filter(({ input, rect }) => {
        const text = `${input.placeholder || ""} ${input.value || ""}`;
        const byTarget = target && rect.left >= target.left - 12 && rect.right <= target.right + 12 && rect.top >= target.top - 16 && rect.bottom <= target.bottom + 16;
        return byTarget || (/开始日期|结束日期|\d{4}[-./]\d{2}[-./]\d{2}/.test(text) && rect.top >= 0 && rect.top < 220);
      })
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
      .map(({ input }) => input);
    const values = inputs.map((input) => input.value || "");
    return {
      applied: inputs.length > 0,
      values,
      placeholders: inputs.map((input) => input.placeholder || ""),
      verified: values.every((value) => !String(value || "").trim())
    };
  }, target).catch(() => ({ applied: false, values: [], placeholders: [], verified: false }));
}

async function forceClearChanceDateInputs(page, target) {
  return await page.evaluate((target) => {
    const inputs = [...document.body.querySelectorAll("input")]
      .filter((input) => {
        const rect = input.getBoundingClientRect();
        const text = `${input.placeholder || ""} ${input.value || ""}`;
        const byTarget = target && rect.left >= target.left - 12 && rect.right <= target.right + 12 && rect.top >= target.top - 16 && rect.bottom <= target.bottom + 16;
        return byTarget || (/开始日期|结束日期|\d{4}[-./]\d{2}[-./]\d{2}/.test(text) && rect.top >= 0 && rect.top < 220);
      });
    for (const input of inputs) setInputValue(input, "");
    return inputs.length;

    function setInputValue(input, value) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }, target).catch(() => 0);
}

async function setChanceDateRange(page, row, config, overrideRange = null) {
  const range = overrideRange || buildChanceSearchDateRange(row, config);
  const applied = await page.evaluate((range) => {
    const visible = (input) => {
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      return rect.width > 80 && rect.height > 18 && rect.top >= 0 && rect.top < 220
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const dateLike = (input) => /开始日期|结束日期|\d{4}[-./]\d{2}[-./]\d{2}/.test(input.placeholder || input.value || "");
    const inputs = [...document.body.querySelectorAll("input")]
      .filter((input) => visible(input) && dateLike(input))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);

    const pair = findBestPair(inputs);
    if (!pair) return { applied: false, values: [] };
    setInputValue(pair[0], range.start);
    setInputValue(pair[1], range.end);
    return {
      applied: true,
      values: pair.map((input) => input.value || ""),
      placeholders: pair.map((input) => input.placeholder || "")
    };

    function findBestPair(items) {
      if (items.length < 2) return null;
      const byPlaceholder = [
        items.find((input) => /开始日期/.test(input.placeholder || "")),
        items.find((input) => /结束日期/.test(input.placeholder || ""))
      ];
      if (byPlaceholder[0] && byPlaceholder[1]) return byPlaceholder;
      for (let i = 0; i < items.length - 1; i += 1) {
        const a = items[i].getBoundingClientRect();
        const b = items[i + 1].getBoundingClientRect();
        if (Math.abs(a.top - b.top) < 16 && b.left > a.left) return [items[i], items[i + 1]];
      }
      return items.slice(0, 2);
    }

    function setInputValue(input, value) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }, range).catch(() => ({ applied: false, values: [] }));

  if (!applied?.applied) {
    await clearChanceDateRange(page);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200).catch(() => {});
  return {
    ...range,
    applied: Boolean(applied?.applied),
    visibleValues: applied?.values || [],
    placeholders: applied?.placeholders || []
  };
}

async function readChanceSearchState(page) {
  const controls = await locateChanceSearchControls(page);
  if (!controls?.inputId) return { userId: "", userIdMode: "", userIdInputPlaceholder: "", dates: [] };
  const input = page.locator(`[data-chance-search-control-id="${controls.inputId}"]`);
  return {
    userId: await input.inputValue().catch(() => ""),
    userIdMode: controls.modeText || "",
    userIdInputPlaceholder: await input.getAttribute("placeholder").catch(() => "") || "",
    dates: []
  };
}

async function waitForChanceQueryResult(page, row, maxWaitMs = 5000) {
  const userId = String(row.userId || "");
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (userId && text.includes(userId) && /学员档案/.test(text)) return true;
    if (!userId && /共\s*[1-9]\d*\s*条/.test(text) && /学员档案/.test(text)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function clickButtonByText(page, text) {
  const button = page.getByRole("button", { name: text }).first();
  if (await button.count().catch(() => 0)) {
    await button.click({ force: true }).catch(() => {});
    return true;
  }
  const locator = page.getByText(text, { exact: true }).first();
  if (await locator.count().catch(() => 0)) {
    await locator.click({ force: true }).catch(() => {});
    return true;
  }
  return false;
}

async function clickStudentProfile(page, row) {
  const targets = await page.evaluate((userId) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight + 200
        && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const rows = [...document.body.querySelectorAll("tr, .el-table__row, [class*='row'], div")]
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter(({ rect, text }) => rect.width > 120 && rect.height > 20 && text.includes(userId))
      .sort((a, b) => a.rect.top - b.rect.top || b.rect.width - a.rect.width);
    const row = rows[0] || null;
    const rowY = row ? row.rect.top + row.rect.height / 2 : null;

    const buttons = [...document.body.querySelectorAll("a, button, span, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "").replace(/\s+/g, "") }))
      .filter(({ text }) => text === "学员档案")
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    const candidates = [];
    if (row && buttons.length) {
      const sameRowButtons = buttons
        .filter(({ rect }) => Math.abs((rect.top + rect.height / 2) - rowY) < Math.max(28, row.rect.height * 0.8))
        .sort((a, b) => b.rect.left - a.rect.left);
      for (const item of sameRowButtons) candidates.push(...points(item.rect, "same-row-button", true));
    }

    const rightButtons = buttons
      .filter(({ rect }) => rect.left > width * 0.62)
      .sort((a, b) => {
        if (rowY !== null) return Math.abs((a.rect.top + a.rect.height / 2) - rowY) - Math.abs((b.rect.top + b.rect.height / 2) - rowY);
        return a.rect.top - b.rect.top;
      });
    for (const item of rightButtons) candidates.push(...points(item.rect, "right-operation-button", true));

    for (const item of buttons.slice(0, 8)) candidates.push(...points(item.rect, "first-visible-button", true));

    if (row) {
      const fallbackX = [
        Math.min(width - 92, Math.max(width * 0.86, row.rect.right - 92)),
        Math.min(width - 150, Math.max(width * 0.78, row.rect.right - 150)),
        Math.min(width - 48, Math.max(width * 0.92, row.rect.right - 48))
      ];
      for (const x of fallbackX) candidates.push({ x, y: rowY, strategy: "row-coordinate-fallback", buttonFound: false });
    }
    const deduped = [];
    const seen = new Set();
    for (const candidate of candidates) {
      if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) continue;
      if (candidate.x < 0 || candidate.x > width || candidate.y < 0 || candidate.y > window.innerHeight + 60) continue;
      const key = `${Math.round(candidate.x)}:${Math.round(candidate.y)}:${candidate.strategy}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(candidate);
    }
    return deduped.slice(0, 24);

    function points(rect, strategy, buttonFound) {
      const y = rect.top + rect.height / 2;
      return [
        { x: rect.left + rect.width / 2, y, strategy, buttonFound },
        { x: rect.left + Math.min(rect.width - 4, 8), y, strategy: `${strategy}-left`, buttonFound },
        { x: rect.right - Math.min(rect.width - 4, 8), y, strategy: `${strategy}-right`, buttonFound }
      ];
    }
  }, String(row.userId || "")).catch(() => false);
  if (!Array.isArray(targets) || !targets.length) return { page: null, buttonFound: false, strategy: "" };

  const tried = [];
  for (const target of targets) {
    tried.push(target.strategy || "unknown");
    const pagePromise = page.context().waitForEvent("page", { timeout: 1800 }).catch(() => null);
    await page.mouse.move(target.x, target.y).catch(() => {});
    await page.waitForTimeout(80).catch(() => {});
    await page.mouse.click(target.x, target.y).catch(() => {});
    const openedPage = await pagePromise;
    if (openedPage) {
      await openedPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      if (await waitForStudentArchive(openedPage, row, 4500)) {
        return { page: openedPage, buttonFound: Boolean(target.buttonFound), strategy: `${target.strategy || "new-page"}->archive`, tried };
      }
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 1200 }).catch(() => {});
    await page.waitForTimeout(450).catch(() => {});
    if (await waitForStudentArchive(page, row, 2200)) {
      return { page, buttonFound: Boolean(target.buttonFound), strategy: `${target.strategy || "same-page"}->archive`, tried };
    }
  }

  return { page, buttonFound: targets.some((target) => target.buttonFound), strategy: `tried-no-archive:${[...new Set(tried)].join(",")}` };
}

async function waitForStudentArchive(page, row, maxWaitMs = 8000) {
  const state = await getStudentArchiveState(page, row, maxWaitMs);
  return state.ready;
}

async function getStudentArchiveState(page, row, maxWaitMs = 8000) {
  const userId = String(row.userId || "");
  const startedAt = Date.now();
  let lastState = {
    ready: false,
    stillOnChanceList: false,
    reason: "等待学员档案页超时",
    textSnippet: ""
  };
  while (Date.now() - startedAt < maxWaitMs) {
    const text = await page.locator("body").innerText().catch(() => "");
    lastState = inspectStudentArchiveText(text, userId);
    if (lastState.ready) return lastState;
    await page.waitForTimeout(300);
  }
  return lastState;
}

function inspectStudentArchiveText(text, userId = "") {
  const normalized = cleanText(text);
  const stillOnChanceList = isChanceListText(normalized);
  const hasArchiveTitle = /学员档案/.test(normalized);
  const hasTopIdentity = /(微信昵称|用户ID|手机号)\s*[：:]/.test(normalized);
  const archiveTabCount = ["学员问卷", "听课明细", "订单信息", "审核记录", "学员动态", "投诉反馈"]
    .filter((label) => normalized.includes(label)).length;
  const hasArchiveTabs = archiveTabCount >= 2;
  const userMatched = !userId || normalized.includes(userId);
  const ready = hasArchiveTitle && hasTopIdentity && hasArchiveTabs && userMatched;
  let reason = "";
  if (ready) {
    reason = "已进入学员档案页";
  } else if (stillOnChanceList) {
    reason = "仍停留机会管理列表页";
  } else if (!hasArchiveTitle) {
    reason = "未出现学员档案标题";
  } else if (!hasTopIdentity) {
    reason = "未出现档案页顶部身份信息";
  } else if (!hasArchiveTabs) {
    reason = "未出现档案页Tab";
  } else if (!userMatched) {
    reason = "档案页未匹配当前用户ID";
  } else {
    reason = "学员档案页验证失败";
  }
  return {
    ready,
    stillOnChanceList,
    reason,
    textSnippet: normalized.slice(0, 2500)
  };
}

function isChanceListText(text) {
  const normalized = cleanText(text);
  const hasChanceTitle = /机会管理/.test(normalized);
  const hasSearchFilters = /所属品类/.test(normalized) && /用户ID/.test(normalized) && /查询/.test(normalized)
    && /(付费类型|推广类型|销售归属人|渠道一级类型|是否退款)/.test(normalized);
  const hasListTabs = /全部\s*\(\d+\)|未加好友\s*\(\d+\)|已加好友\s*\(\d+\)|已进群\s*\(\d+\)|已到课\s*\(\d+\)|已报名\s*\(\d+\)|申请退款\s*\(\d+\)/.test(normalized);
  const hasOperationArchive = /操作/.test(normalized) && /学员档案/.test(normalized) && /当前线索等级|原始线索等级|开营时线索等级/.test(normalized);
  return (hasChanceTitle && (hasSearchFilters || hasListTabs || hasOperationArchive))
    || (hasSearchFilters && (hasListTabs || hasOperationArchive));
}

async function clickTabByText(page, text) {
  const point = await page.evaluate((targetText) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    };
    const candidates = [...document.body.querySelectorAll("[role='tab'], a, button, span, div, li")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(el.innerText || el.textContent || "");
        const className = String(el.className || "");
        let score = 0;
        if (text === targetText) score += 80;
        if (rect.top < window.innerHeight * 0.42) score += 20;
        if (rect.width >= 28 && rect.width <= 220 && rect.height >= 20 && rect.height <= 90) score += 15;
        if (/tab|tabs|nav|menu|item/i.test(className) || el.getAttribute("role") === "tab") score += 12;
        if (rect.left > 0 && rect.left < window.innerWidth - 20) score += 3;
        if (text.length > targetText.length + 8) score -= 30;
        return { rect, text, score };
      })
      .filter((item) => item.text === targetText)
      .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const best = candidates[0];
    if (!best) return null;
    return {
      x: best.rect.left + best.rect.width / 2,
      y: best.rect.top + best.rect.height / 2
    };
  }, text).catch(() => null);
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    await page.mouse.move(point.x, point.y).catch(() => {});
    await page.waitForTimeout(80).catch(() => {});
    await page.mouse.click(point.x, point.y).catch(() => {});
    await page.waitForTimeout(500).catch(() => {});
    return true;
  }

  const locator = page.getByText(text, { exact: true }).first();
  if (await locator.count().catch(() => 0)) {
    await locator.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500).catch(() => {});
    return true;
  }
  return false;
}

async function waitForOrderPage(page, maxWaitMs = 5000) {
  const state = await getOrderPageState(page, maxWaitMs);
  return state.ready;
}

async function getOrderPageState(page, maxWaitMs = 5000) {
  const startedAt = Date.now();
  let lastState = {
    ready: false,
    stillOnChanceList: false,
    reason: "等待订单信息页超时",
    textSnippet: ""
  };
  while (Date.now() - startedAt < maxWaitMs) {
    const text = await page.locator("body").innerText().catch(() => "");
    lastState = inspectOrderPageText(text);
    if (lastState.ready) return lastState;
    await page.waitForTimeout(250);
  }
  return lastState;
}

function inspectOrderPageText(text) {
  const normalized = cleanText(text);
  const stillOnChanceList = isChanceListText(normalized);
  const hasOrderTab = /订单信息/.test(normalized);
  const hasCourseOrder = /课程订单/.test(normalized);
  const hasOrderCards = /购买\s*(体验营|正式营)|主订单ID|商品名称/.test(normalized);
  const hasDetailButton = /查看详情/.test(normalized);
  const ready = hasOrderTab && hasCourseOrder && hasOrderCards && hasDetailButton;
  let reason = "";
  if (ready) {
    reason = "订单信息页已打开";
  } else if (stillOnChanceList) {
    reason = "仍停留机会管理列表页";
  } else if (!hasOrderTab) {
    reason = "未出现订单信息Tab";
  } else if (!hasCourseOrder) {
    reason = "未出现课程订单";
  } else if (!hasOrderCards) {
    reason = "未出现课程订单卡片";
  } else if (!hasDetailButton) {
    reason = "未出现查看详情按钮";
  } else {
    reason = "订单信息页验证失败";
  }
  return {
    ready,
    stillOnChanceList,
    reason,
    textSnippet: normalized.slice(0, 2500)
  };
}

async function waitForOrderDetail(page, expectedOrderId, maxWaitMs = 5000) {
  const expected = normalizeExactOrderId(expectedOrderId);
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const ready = await page.evaluate((orderId) => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 20 && rect.height > 14
          && style.display !== "none" && style.visibility !== "hidden";
      };
      const exactText = (element) => String(element?.innerText || element?.textContent || "")
        .replace(/\s+/g, " ").trim();
      const labels = [...document.body.querySelectorAll("div, section, article, li, p, span, label")]
        .filter(visible)
        .filter((element) => /^(主订单ID|订单ID)[:：]?$/.test(exactText(element)));
      return labels.some((label) => {
        let current = label.parentElement;
        for (let depth = 0; current && current !== document.body && depth < 7; depth += 1, current = current.parentElement) {
          const text = exactText(current);
          const orderIdPattern = new RegExp(`(?:主订单ID|订单ID)\\s*[:：]?\\s*${escapeRegExp(orderId)}`);
          const orderIds = [...text.matchAll(/(?:主订单ID|订单ID)\s*[:：]?\s*(\d+)/g)]
            .map((match) => match[1]);
          const onlyExpectedOrder = orderIds.length === 1 && orderIds[0] === orderId;
          if (onlyExpectedOrder && orderIdPattern.test(text) && /(所属品类|课程品类|品类名称)/.test(text)) return true;
        }
        return false;
      });

      function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }, expected).catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function waitForOrderDetailPanel(page, expectedOrderId, maxWaitMs = 5000) {
  const expected = normalizeExactOrderId(expectedOrderId);
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const ready = await page.evaluate((orderId) => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 20 && rect.height > 14
          && style.display !== "none" && style.visibility !== "hidden";
      };
      const exactText = (element) => String(element?.innerText || element?.textContent || "")
        .replace(/\s+/g, " ").trim();
      const escaped = String(orderId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const exactOrder = new RegExp(`(?:主订单ID|订单ID)\\s*[:：]?\\s*${escaped}`);
      const orderIdsIn = (text) => [...String(text).matchAll(/(?:主订单ID|订单ID)\s*[:：]?\s*(\d+)/g)]
        .map((match) => match[1]);
      const anchors = [...document.body.querySelectorAll("div, section, article, li, p, span, label")]
        .filter(visible)
        .filter((element) => exactOrder.test(exactText(element)));
      return anchors.some((anchor) => {
        let current = anchor;
        for (let depth = 0; current && current !== document.body && depth < 8; depth += 1, current = current.parentElement) {
          const text = exactText(current);
          const orderIds = orderIdsIn(text);
          if (exactOrder.test(text) && orderIds.length === 1 && orderIds[0] === orderId) return true;
        }
        return false;
      });
    }, expected).catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function collectOrderPageText(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  const start = Math.max(0, text.indexOf("课程订单"));
  return cleanText(text.slice(start || 0, start + 2500));
}

async function extractDomOrders(page) {
  return await page.evaluate(() => {
    const visible = document.body.innerText || "";
    const start = Math.max(0, visible.indexOf("课程订单"));
    const endCandidates = ["审核记录", "礼品配送", "投诉反馈", "录屏能力"]
      .map((label) => visible.indexOf(label, start + 4))
      .filter((index) => index > start);
    const end = endCandidates.length ? Math.min(...endCandidates) : visible.length;
    const orderArea = visible.slice(start, end);
    const parseArea = /购买\s*(体验营|正式营)/.test(orderArea) ? orderArea : visible.slice(start || 0);
    const chunks = splitOrderChunks(orderArea)
      .concat(splitOrderChunks(parseArea))
      .map((chunk) => chunk.replace(/[ \t]+/g, " ").trim())
      .filter((chunk) => /购买\s*(体验营|正式营)/.test(chunk) && /查看详情|主订单ID|商品名称/.test(chunk));
    const uniqueChunks = [];
    const seen = new Set();
    for (const chunk of chunks) {
      const key = chunk.match(/主订单ID[:：]\s*([0-9]+)/)?.[1] || chunk.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueChunks.push(chunk);
    }
    return uniqueChunks.slice(0, 20).map((text, index) => {
      const type = text.match(/购买\s*(体验营|正式营)/)?.[1] || "";
      const orderId = text.match(/主订单ID[:：]\s*([0-9]+)/)?.[1] || "";
      const productName = extractValue(text, "商品名称", ["支付方式", "分销人ID", "所属部门", "所在期数", "开营时间", "主订单ID", "订单金额", "订单类型"]) ||
        extractTitleProductName(text);
      const time = text.match(/([0-9]{4}[.-][0-9]{2}[.-][0-9]{2}(?:\s+[0-9:]{5,8})?)/)?.[1] || "";
      return {
        index,
        productType: type,
        productName: cleanText(productName),
        orderId,
        time,
        rawText: text.slice(0, 1200)
      };
    });

    function splitOrderChunks(text) {
      const matches = [...text.matchAll(/[0-9]{4}[.-][0-9]{2}[.-][0-9]{2}[^\n]{0,80}购买\s*(?:体验营|正式营)|购买\s*(?:体验营|正式营)/g)];
      if (!matches.length) return [];
      const chunks = [];
      for (let i = 0; i < matches.length; i += 1) {
        const start = matches[i].index;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        chunks.push(text.slice(start, end));
      }
      return chunks;
    }

    function extractTitleProductName(text) {
      const line = text.split(/\n+/).map((item) => item.trim()).find((item) => /购买\s*(体验营|正式营)/.test(item)) || "";
      return line
        .replace(/[0-9]{4}[.-][0-9]{2}[.-][0-9]{2}(?:\s+[0-9:]{5,8})?/, "")
        .replace(/购买\s*(体验营|正式营)/, "")
        .replace(/查看详情|复制发票链接/g, "")
        .trim();
    }

    function extractValue(text, label, stops) {
      const zh = text.indexOf(`${label}：`);
      const en = text.indexOf(`${label}:`);
      if (zh < 0 && en < 0) return "";
      const start = (zh >= 0 ? zh : en) + label.length + 1;
      let end = text.length;
      for (const stop of stops) {
        const index = text.indexOf(`${stop}：`, start);
        const index2 = text.indexOf(`${stop}:`, start);
        const candidate = [index, index2].filter((value) => value >= 0).sort((a, b) => a - b)[0];
        if (candidate !== undefined && candidate < end) end = candidate;
      }
      return cleanText(text.slice(start, end));
    }

    function cleanText(value) {
      return String(value || "").replace(/\s+/g, " ").replace(/[，,。；;]+$/, "").trim();
    }
  }).catch(() => []);
}

async function collectDomOrdersAcrossScroll(page) {
  const orderState = await getOrderPageState(page, 800);
  if (!orderState.ready) {
    return {
      orders: [],
      summary: {
        completed: false,
        wrongPage: orderState.stillOnChanceList ? "chanceList" : "notOrderPage",
        reason: orderState.reason || "",
        foundOrders: 0,
        scanSteps: 0,
        textSnippet: orderState.textSnippet || ""
      }
    };
  }

  const seen = new Map();
  const samples = [];
  let stableFullSnapshotSteps = 0;
  let stopReason = "max-steps";
  await setOrderScrollTop(page, 0);
  await page.waitForTimeout(250).catch(() => {});

  for (let step = 0; step < 14; step += 1) {
    const orders = await extractDomOrders(page);
    const beforeCount = seen.size;
    for (const order of orders) {
      const key = order.orderId || `${order.productType || ""}|${order.productName || ""}|${order.time || ""}`;
      if (!key || seen.has(key)) continue;
      seen.set(key, {
        ...order,
        index: seen.size
      });
    }
    const newOrders = seen.size - beforeCount;

    // 非虚拟列表通常每次都会返回完整订单集合。如果连续三屏既没有新增
    // 订单、当前快照又已覆盖累计集合，继续滚动不会获得新信息，直接结束。
    // 虚拟列表的当前快照会小于累计集合，因此仍会继续滚到页面底部。
    stableFullSnapshotSteps = newOrders === 0 && orders.length >= seen.size && seen.size > 0
      ? stableFullSnapshotSteps + 1
      : 0;

    const before = await getOrderScrollInfo(page);
    samples.push({
      step,
      visibleOrders: orders.length,
      newOrders,
      totalOrders: seen.size,
      scrollTop: before.scrollTop,
      scrollHeight: before.scrollHeight,
      clientHeight: before.clientHeight
    });
    if (stableFullSnapshotSteps >= 3) {
      stopReason = "stable-full-snapshot";
      break;
    }
    if (!before.canScrollMore) {
      stopReason = "reached-bottom";
      break;
    }

    const moved = await scrollOrderPageBy(page, Math.max(520, Math.floor((before.clientHeight || 700) * 0.78)));
    await page.waitForTimeout(320).catch(() => {});
    const after = await getOrderScrollInfo(page);
    if (!moved || Math.abs((after.scrollTop || 0) - (before.scrollTop || 0)) < 8) {
      stopReason = "scroll-not-moved";
      break;
    }
  }

  const summary = {
    completed: true,
    scanSteps: samples.length,
    foundOrders: seen.size,
    stopReason,
    samples: samples.slice(0, 8)
  };
  return { orders: [...seen.values()], summary };
}

async function setOrderScrollTop(page, top = 0) {
  await page.evaluate((nextTop) => {
    const target = findOrderScrollElement();
    if (target) target.scrollTop = nextTop;
    const doc = document.scrollingElement || document.documentElement;
    if (doc) doc.scrollTop = nextTop;

    function findOrderScrollElement() {
      const elements = [...document.body.querySelectorAll("*")];
      return elements
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 300 || rect.height < 220) return false;
          if (el.scrollHeight <= el.clientHeight + 80) return false;
          const text = String(el.innerText || el.textContent || "");
          return /课程订单|购买\s*(体验营|正式营)|主订单ID|查看详情/.test(text);
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const aScore = score(a, ar);
          const bScore = score(b, br);
          return bScore - aScore;
        })[0] || null;
    }

    function score(el, rect) {
      const text = String(el.innerText || el.textContent || "");
      let value = 0;
      if (/课程订单/.test(text)) value += 30;
      if (/购买\s*(体验营|正式营)/.test(text)) value += 40;
      if (/查看详情/.test(text)) value += 20;
      value += Math.min(20, Math.max(0, rect.height / 80));
      return value;
    }
  }, top).catch(() => {});
}

async function getOrderScrollInfo(page) {
  return await page.evaluate(() => {
    const target = findOrderScrollElement() || document.scrollingElement || document.documentElement;
    const scrollTop = Number(target?.scrollTop || 0);
    const scrollHeight = Number(target?.scrollHeight || 0);
    const clientHeight = Number(target?.clientHeight || window.innerHeight || 0);
    return {
      scrollTop,
      scrollHeight,
      clientHeight,
      canScrollMore: scrollTop + clientHeight < scrollHeight - 12
    };

    function findOrderScrollElement() {
      const elements = [...document.body.querySelectorAll("*")];
      return elements
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 300 || rect.height < 220) return false;
          if (el.scrollHeight <= el.clientHeight + 80) return false;
          const text = String(el.innerText || el.textContent || "");
          return /课程订单|购买\s*(体验营|正式营)|主订单ID|查看详情/.test(text);
        })
        .sort((a, b) => score(b) - score(a))[0] || null;
    }

    function score(el) {
      const text = String(el.innerText || el.textContent || "");
      let value = 0;
      if (/课程订单/.test(text)) value += 30;
      if (/购买\s*(体验营|正式营)/.test(text)) value += 40;
      if (/查看详情/.test(text)) value += 20;
      return value;
    }
  }).catch(() => ({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    canScrollMore: false
  }));
}

async function scrollOrderPageBy(page, deltaY) {
  return await page.evaluate((delta) => {
    const target = findOrderScrollElement() || document.scrollingElement || document.documentElement;
    if (!target) return false;
    const before = Number(target.scrollTop || 0);
    target.scrollTop = Math.min(target.scrollHeight - target.clientHeight, before + delta);
    if (target === document.scrollingElement || target === document.documentElement) {
      window.scrollBy(0, delta);
    }
    return Math.abs(Number(target.scrollTop || 0) - before) > 4;

    function findOrderScrollElement() {
      const elements = [...document.body.querySelectorAll("*")];
      return elements
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 300 || rect.height < 220) return false;
          if (el.scrollHeight <= el.clientHeight + 80) return false;
          const text = String(el.innerText || el.textContent || "");
          return /课程订单|购买\s*(体验营|正式营)|主订单ID|查看详情/.test(text);
        })
        .sort((a, b) => score(b) - score(a))[0] || null;
    }

    function score(el) {
      const text = String(el.innerText || el.textContent || "");
      let value = 0;
      if (/课程订单/.test(text)) value += 30;
      if (/购买\s*(体验营|正式营)/.test(text)) value += 40;
      if (/查看详情/.test(text)) value += 20;
      return value;
    }
  }, deltaY).catch(() => false);
}

async function clickOrderDetail(page, selected) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const prepared = await page.evaluate((selected) => {
      const anchor = findOrderAnchor(selected);
      if (!anchor) return { found: false };
      anchor.scrollIntoView({ block: "center", inline: "nearest" });
      return { found: true };

      function findOrderAnchor(selected) {
        const needles = [selected.orderId, selected.productName].filter(Boolean);
        const elements = [...document.body.querySelectorAll("div, section, article, li, span, p")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
          .filter(({ rect, text }) => rect.width > 20 && rect.height > 10 && needles.some((needle) => text.includes(needle)))
          .sort((a, b) => {
            const aOrder = selected.orderId && a.text.includes(selected.orderId) ? 0 : 1;
            const bOrder = selected.orderId && b.text.includes(selected.orderId) ? 0 : 1;
            const aArea = a.rect.width * a.rect.height;
            const bArea = b.rect.width * b.rect.height;
            return aOrder - bOrder || aArea - bArea;
          });
        return elements[0]?.el || null;
      }

      function normalize(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }
    }, selected).catch(() => ({ found: false }));
    if (!prepared?.found && attempt === 0) {
      await page.mouse.wheel(0, Math.max(400, Number(selected.index || 0) * 360)).catch(() => {});
    }
    await page.waitForTimeout(300).catch(() => {});

    const target = await page.evaluate((selected) => {
      const anchor = findOrderAnchor(selected);
      if (!anchor) return { found: false };
      const card = findOrderCard(anchor, selected);
      const button = findDetailButtonInCard(card, anchor, selected);
      if (!button) return { found: false };
      button.scrollIntoView({ block: "center", inline: "center" });
      const rect = button.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 15) return { found: false };
      button.click();
      return {
        found: true,
        domClickTriggered: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      };

      function findOrderAnchor(selected) {
        const needles = [selected.orderId, selected.productName].filter(Boolean);
        const elements = [...document.body.querySelectorAll("div, section, article, li, span, p")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
          .filter(({ rect, text }) => rect.width > 20 && rect.height > 10 && needles.some((needle) => text.includes(needle)))
          .sort((a, b) => {
            const aOrder = selected.orderId && a.text.includes(selected.orderId) ? 0 : 1;
            const bOrder = selected.orderId && b.text.includes(selected.orderId) ? 0 : 1;
            const aVisible = isVisibleRect(a.rect) ? 0 : 1;
            const bVisible = isVisibleRect(b.rect) ? 0 : 1;
            const aArea = a.rect.width * a.rect.height;
            const bArea = b.rect.width * b.rect.height;
            return aVisible - bVisible || aOrder - bOrder || aArea - bArea;
          });
        return elements[0]?.el || null;
      }

      function findOrderCard(anchor, selected) {
        let current = anchor;
        while (current && current !== document.body) {
          const rect = current.getBoundingClientRect();
          const text = normalize(current.innerText || current.textContent || "");
          const hasSelected = (selected.orderId && text.includes(selected.orderId)) || (selected.productName && text.includes(selected.productName));
          const hasDetail = /查看详情/.test(text);
          const plausible = rect.width > 300 && rect.height > 80 && rect.height < 900;
          if (hasSelected && hasDetail && plausible) return current;
          current = current.parentElement;
        }
        return anchor;
      }

      function findDetailButtonInCard(card, anchor, selected) {
        const anchorRect = anchor.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const buttonsInCard = [...card.querySelectorAll("button, a, span, div")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "").replace(/\s+/g, "") }))
          .filter(({ rect, text }) => text === "查看详情" && rect.width > 20 && rect.height > 15)
          .sort((a, b) => Math.abs(centerY(a.rect) - centerY(anchorRect)) - Math.abs(centerY(b.rect) - centerY(anchorRect)));
        if (buttonsInCard[0]) return buttonsInCard[0].el;

        const allButtons = [...document.body.querySelectorAll("button, a, span, div")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "").replace(/\s+/g, "") }))
          .filter(({ rect, text }) => text === "查看详情" && rect.width > 20 && rect.height > 15)
          .filter(({ rect }) => {
            const y = centerY(rect);
            return y >= cardRect.top - 120 && y <= cardRect.bottom + 80;
          })
          .sort((a, b) => Math.abs(centerY(a.rect) - centerY(anchorRect)) - Math.abs(centerY(b.rect) - centerY(anchorRect)));
        return allButtons[0]?.el || null;
      }

      function isVisibleRect(rect) {
        return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
      }

      function centerY(rect) {
        return rect.top + rect.height / 2;
      }

      function normalize(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }
    }, selected).catch(() => ({ found: false }));
    if (target?.found) {
      const detailOpenedAfterDomClick = await waitForOrderDetailPanel(page, selected?.orderId, 1800);
      if (!shouldRetryOrderDetailClick({
        domClickTriggered: target.domClickTriggered,
        detailOpened: detailOpenedAfterDomClick
      })) return true;
      const clicked = await page.mouse.click(target.x, target.y).then(() => true).catch(() => false);
      if (clicked && await waitForOrderDetailPanel(page, selected?.orderId, 1800)) return true;
    }
    await page.mouse.wheel(0, 260).catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
  }
  return false;
}

// 鼠标事件已送达不等于页面详情已打开；未验证到当前订单详情时必须继续尝试。
export function shouldRetryOrderDetailClick({ domClickTriggered, detailOpened } = {}) {
  return Boolean(domClickTriggered) && !detailOpened;
}

export function resolveScopedOrderDetail({ expectedOrderId, roots = [] } = {}) {
  const expected = normalizeExactOrderId(expectedOrderId);
  const matchedRoots = (Array.isArray(roots) ? roots : []).filter((root) => (
    normalizeExactOrderId(root?.panelOrderId) === expected
    && hasOnlyExpectedOrderId(root?.orderIds, expected)
    && (root?.productSectionFound === true || hasCourseCategory(root?.fields))
  ));
  if (!expected || matchedRoots.length !== 1) {
    return {
      panelOrderId: "",
      category: "",
      fields: [],
      failureReason: matchedRoots.length > 1 ? "详情订单根不唯一" : "未定位到主订单ID精确匹配的详情根"
    };
  }
  const fields = (Array.isArray(matchedRoots[0].fields) ? matchedRoots[0].fields : [])
    .filter(Boolean)
    .filter((field) => normalizeExactField(field.label) && (
      normalizeExactField(field.value) || resolveCategoryFieldValue(field)
    ));
  const categories = [...new Set(fields
    .map((field) => resolveCategoryFieldValue(field))
    .filter(Boolean))];
  return {
    panelOrderId: normalizeExactOrderId(matchedRoots[0].panelOrderId),
    category: categories.length === 1 ? categories[0] : "",
    fields,
    failureReason: ""
  };
}

export function isOrderDetailTextReady({ expectedOrderId, text } = {}) {
  const expected = normalizeExactOrderId(expectedOrderId);
  const normalized = normalizeExactField(text);
  if (!expected || !normalized) return false;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasOrderId = new RegExp(`(?:主订单ID|订单ID)\\s*[:：]?\\s*${escaped}`).test(normalized);
  return hasOrderId && /(所属品类|课程品类|品类名称)/.test(normalized);
}

export function isOrderDetailPanelTextReady({ expectedOrderId, text } = {}) {
  const expected = normalizeExactOrderId(expectedOrderId);
  const normalized = normalizeExactField(text);
  if (!expected || !normalized) return false;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasOrderId = new RegExp(`(?:主订单ID|订单ID)\\s*[:：]?\\s*${escaped}`).test(normalized);
  const orderIds = [...normalized.matchAll(/(?:主订单ID|订单ID)\s*[:：]?\s*(\d+)/g)]
    .map((match) => match[1]);
  return hasOrderId && orderIds.length === 1 && orderIds[0] === expected;
}

function hasCourseCategory(fields = []) {
  return (Array.isArray(fields) ? fields : []).some((field) => Boolean(resolveCategoryFieldValue(field)));
}

function hasOnlyExpectedOrderId(orderIds, expectedOrderId) {
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : [])
    .map(normalizeExactOrderId)
    .filter(Boolean))];
  return ids.length === 0 || (ids.length === 1 && ids[0] === expectedOrderId);
}

function resolveCategoryFieldValue(field = {}) {
  const label = normalizeExactField(field.label);
  const value = normalizeExactField(field.value);
  if (["所属品类", "课程品类", "品类名称"].includes(label)) return value;
  const inline = label.match(/^(所属品类|课程品类|品类名称)\s*[:：]\s*(.+)$/u);
  return inline ? normalizeExactField(inline[2]) : "";
}

// 仅用于可测试的 DOM 结构规则：分区必须是标题所属的专属子树，不能回退到同时包含订单/商品区的共享外层。
export function resolveExclusiveDetailSections(root) {
  const names = new Set(["订单信息", "商品信息"]);
  const sections = new Map();
  for (const heading of walkDetailTree(root)) {
    const name = normalizeExactField(heading?.text);
    if (!names.has(name)) continue;
    let current = heading.parent;
    while (current) {
      const containedHeadings = walkDetailTree(current)
        .map((node) => normalizeExactField(node?.text))
        .filter((text) => names.has(text));
      if (containedHeadings.length === 1 && containedHeadings[0] === name && current.hasFieldItem === true) {
        if (sections.has(name) && sections.get(name) !== current) return new Map();
        sections.set(name, current);
        break;
      }
      current = current.parent;
    }
  }
  const order = sections.get("订单信息");
  const product = sections.get("商品信息");
  if (order && product && (order === product || treeContains(order, product) || treeContains(product, order))) return new Map();
  return sections;
}

function walkDetailTree(root) {
  if (!root || typeof root !== "object") return [];
  const seen = new Set();
  const output = [];
  const visit = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    output.push(node);
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child);
  };
  visit(root);
  return output;
}

function treeContains(ancestor, descendant) {
  return walkDetailTree(ancestor).includes(descendant);
}

export async function extractOrderDetail(page, selected = {}) {
  const expectedOrderId = String(selected?.orderId || "").trim();
  const raw = await page.evaluate(({ expectedOrderId: currentOrderId }) => {
    const fieldLabels = new Set(["主订单ID", "订单ID", "训练营名称", "营名称", "对应训练营", "训练营", "所属品类", "课程品类", "品类名称"]);
    const sectionNames = new Set(["订单信息", "商品信息"]);
    const sectionRoots = findScopedDetailRoots(currentOrderId).map((root) => {
      const sections = findOwnedSections(root);
      const fields = [...sections.entries()].flatMap(([section, sectionRoot]) => readFields(sectionRoot, section, root));
      return {
        panelOrderId: exactUniqueFieldValue(fields, ["主订单ID", "订单ID"]),
        orderIds: extractOrderIds(fields),
        productSectionFound: sections.has("商品信息"),
        fields
      };
    });
    const roots = sectionRoots.length ? sectionRoots : findLabelAnchoredDetailRoots(currentOrderId);

    return {
      text: roots.length ? `详情候选根已定位；候选数=${roots.length}` : "未定位到当前订单的详情根",
      roots
    };

    // 详情根的身份只能来自一个明确的「订单ID标签 + 同字段项值」；禁止使用祖先整段文本包含订单号。
    function findScopedDetailRoots(orderId) {
      if (!isExactOrderId(orderId)) return [];
      const idPairs = [...document.querySelectorAll("body *")]
        .filter(isVisible)
        .map((labelElement) => ({ labelElement, label: normalize(labelElement.textContent) }))
        .filter(({ label }) => label === "主订单ID" || label === "订单ID")
        .map(({ labelElement, label }) => ({ labelElement, label, pair: findFieldItem(labelElement, document.body) }))
        .filter(({ pair }) => pair && pair.value === orderId);
      const candidates = new Set();
      for (const { pair } of idPairs) {
        let current = pair.item.parentElement;
        while (current && current !== document.body) {
          const sections = findOwnedSections(current);
          const orderRoot = sections.get("订单信息");
          if (sections.has("商品信息") || (orderRoot && hasCategoryField(orderRoot))) {
            candidates.add(current);
            break;
          }
          current = current.parentElement;
        }
      }
      return [...candidates]
        .filter((root) => root.querySelectorAll("*").length > 0)
        .sort((left, right) => area(left) - area(right));
    }

    // 页面样式/标题可变化。兜底仅从当前订单 ID 对应字段项向上寻找最近容器，
    // 容器必须同时有明确品类，且不能出现另一笔订单 ID。
    function findLabelAnchoredDetailRoots(orderId) {
      if (!isExactOrderId(orderId)) return [];
      const escapedOrderId = String(orderId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const exactOrderPattern = new RegExp(`(?:主订单ID|订单ID)\\s*[:：]?\\s*${escapedOrderId}`);
      const idAnchors = [...document.querySelectorAll("body *")]
        .filter(isVisible)
        .filter((element) => exactOrderPattern.test(normalize(element.innerText || element.textContent)));
      const candidates = new Map();
      for (const anchor of idAnchors) {
        let current = anchor;
        while (current && current !== document.body) {
          const fields = readFields(current, "", current);
          const orderIds = extractOrderIdsFromText(normalize(current.innerText || current.textContent));
          if (hasCategoryField(current) && orderIds.length === 1 && orderIds[0] === orderId) {
            candidates.set(current, {
              panelOrderId: orderId,
              orderIds,
              productSectionFound: false,
              fields
            });
            break;
          }
          current = current.parentElement;
        }
      }
      const sortedCandidates = [...candidates.entries()]
        .sort(([left], [right]) => area(left) - area(right));
      if (!sortedCandidates.length) return [];
      const [nearestRoot, nearestDetail] = sortedCandidates[0];
      const hasDisjointRoot = sortedCandidates.some(([candidate]) => (
        candidate !== nearestRoot
        && !nearestRoot.contains(candidate)
        && !candidate.contains(nearestRoot)
      ));
      // 同一详情框的父子节点只保留最小容器；并列详情框仍返回多个候选，交给上层拒绝写入。
      return hasDisjointRoot ? sortedCandidates.map(([, detail]) => detail) : [nearestDetail];
    }

    // 商品/订单分区只按标题与其 DOM 祖先关系建立，不按 y 坐标猜测归属。
    function findOwnedSections(root) {
      const sections = new Map();
      for (const heading of root.querySelectorAll("*")) {
        const name = normalize(heading.textContent);
        if (!sectionNames.has(name) || !isVisible(heading)) continue;
        const sectionRoot = nearestSectionContainer(heading, root, name);
        if (!sectionRoot) continue;
        if (sections.has(name) && sections.get(name) !== sectionRoot) return new Map();
        sections.set(name, sectionRoot);
      }
      const orderRoot = sections.get("订单信息");
      const productRoot = sections.get("商品信息");
      if (orderRoot && productRoot && (
        orderRoot === productRoot
        || orderRoot.contains(productRoot)
        || productRoot.contains(orderRoot)
      )) return new Map();
      return sections;
    }

    function nearestSectionContainer(heading, root, sectionName) {
      let current = heading.parentElement;
      while (current && current !== root.parentElement) {
        if (current !== root && hasFieldItemDescendant(current) && current.contains(heading)) {
          const headings = sectionHeadingsIn(current);
          if (headings.length === 1 && headings[0] === sectionName) return current;
        }
        if (current === root) break;
        current = current.parentElement;
      }
      return null;
    }

    function sectionHeadingsIn(container) {
      return [...container.querySelectorAll("*")]
        .filter(isVisible)
        .map((candidate) => normalize(candidate.textContent))
        .filter((text) => sectionNames.has(text));
    }

    function hasFieldItemDescendant(container) {
      return [...container.querySelectorAll("*")].some((candidate) => {
        const label = normalize(candidate.textContent);
        return (fieldLabels.has(label) && Boolean(findFieldItem(candidate, container)))
          || Boolean(parseInlineField(label));
      });
    }

    function hasCategoryField(container) {
      return [...container.querySelectorAll("*")]
        .filter(isVisible)
        .some((candidate) => {
          const label = normalize(candidate.textContent);
          if (parseInlineField(label)) return true;
          if (!["所属品类", "课程品类", "品类名称"].includes(label)) return false;
          const pair = findFieldItem(candidate, container);
          return Boolean(pair?.value);
        });
    }

    function readFields(sectionRoot, section, root) {
      const seenItems = new Set();
      const fields = [];
      for (const labelElement of sectionRoot.querySelectorAll("*")) {
        const label = normalize(labelElement.textContent);
        if (!isVisible(labelElement)) continue;
        const inline = parseInlineField(label);
        if (inline) {
          if (seenItems.has(labelElement)) continue;
          seenItems.add(labelElement);
          fields.push({
            section,
            label: inline.label,
            value: inline.value,
            labelPath: pathOf(labelElement, root),
            valuePath: pathOf(labelElement, root),
            rect: rectOf(labelElement)
          });
          continue;
        }
        if (!fieldLabels.has(label)) continue;
        const pair = findFieldItem(labelElement, sectionRoot);
        if (!pair || seenItems.has(pair.item)) continue;
        seenItems.add(pair.item);
        fields.push({
          section,
          label,
          value: pair.value,
          labelPath: pathOf(labelElement, root),
          valuePath: pathOf(pair.valueElement, root),
          rect: rectOf(pair.valueElement)
        });
      }
      return fields;
    }

    function parseInlineField(text) {
      const match = normalize(text).match(/^(所属品类|课程品类|品类名称)\s*[:：]\s*(.{1,80})$/u);
      if (!match) return null;
      const value = normalize(match[2]);
      if (!value || [...fieldLabels].some((knownLabel) => value.includes(knownLabel))) return null;
      return { label: match[1], value };
    }

    // 仅接受同一字段项的唯一、无标签值节点；含其它已知字段标签的容器一律视为歧义。
    function findFieldItem(labelElement, boundary) {
      let current = labelElement.parentElement;
      while (current && current !== boundary.parentElement) {
        const labels = [...current.querySelectorAll("*")]
          .filter(isVisible)
          .map((element) => normalize(element.textContent))
          .filter((text) => fieldLabels.has(text));
        if (labels.length === 1) {
          const valueCandidates = [...current.children]
            .filter((child) => child !== labelElement && !containsKnownLabel(child))
            .filter(isVisible)
            .map((child) => ({ element: child, value: normalize(child.textContent) }))
            .filter(({ value }) => value && value.length <= 160);
          if (valueCandidates.length === 1) {
            return { item: current, valueElement: valueCandidates[0].element, value: valueCandidates[0].value };
          }
        }
        if (current === boundary) break;
        current = current.parentElement;
      }
      return null;
    }

    function containsKnownLabel(element) {
      return [...element.querySelectorAll("*")].some((child) => fieldLabels.has(normalize(child.textContent)));
    }

    function exactUniqueFieldValue(fields, labels) {
      const values = [...new Set(fields
        .filter((field) => labels.includes(field.label))
        .map((field) => normalize(field.value))
        .filter(isExactOrderId))];
      return values.length === 1 ? values[0] : "";
    }

    function extractOrderIds(fields) {
      return [...new Set(fields
        .filter((field) => field?.label === "主订单ID" || field?.label === "订单ID")
        .map((field) => normalize(field.value))
        .filter(isExactOrderId))];
    }

    function extractOrderIdsFromText(text) {
      return [...new Set([...String(text).matchAll(/(?:主订单ID|订单ID)\s*[:：]?\s*(\d+)/g)]
        .map((match) => match[1])
        .filter(isExactOrderId))];
    }

    function pathOf(element, rootElement) {
      if (!element) return "";
      const segments = [];
      let current = element;
      while (current && current !== rootElement.parentElement && segments.length < 8) {
        const siblings = current.parentElement ? [...current.parentElement.children] : [];
        segments.unshift(`${current.tagName.toLowerCase()}:nth(${Math.max(1, siblings.indexOf(current) + 1)})`);
        if (current === rootElement) break;
        current = current.parentElement;
      }
      return segments.join(">");
    }

    function rectOf(element) {
      if (!element) return null;
      const { top, left, width, height } = element.getBoundingClientRect();
      return { top, left, width, height };
    }

    function area(element) {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function isExactOrderId(value) {
      return /^\d+$/.test(normalize(value));
    }

    function normalize(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
  }, { expectedOrderId }).catch(() => ({}));

  const scoped = resolveScopedOrderDetail({ expectedOrderId, roots: raw.roots });
  const training = resolveDetailTrainingCampName({
    expectedOrderId,
    panelOrderId: scoped.panelOrderId,
    fields: scoped.fields
  });
  return {
    ...raw,
    ...scoped,
    trainingName: cleanText(training.value),
    trainingNameSource: training.source,
    trainingNameFailureReason: training.failureReason,
    trainingNameDiagnostic: training.diagnostic,
    hasTrainingName: Boolean(training.value),
    hasCategory: Boolean(scoped.category)
  };
}

// “点击成功”并不代表详情已打开：只有当前订单 ID 的专属详情根被解析到才可写为成功。
export function resolveOrderDetailReadiness({ expectedOrderId, clickSucceeded, waitSucceeded, detail = {} } = {}) {
  const expected = normalizeExactOrderId(expectedOrderId);
  const panelOrderId = normalizeExactOrderId(detail?.panelOrderId);
  if (!clickSucceeded) {
    return { opened: false, reason: "详情按钮未点击成功", clickSucceeded: false, waitSucceeded: false };
  }
  if (expected && panelOrderId === expected) {
    return {
      opened: true,
      reason: "详情主订单ID校验通过",
      clickSucceeded: true,
      waitSucceeded: Boolean(waitSucceeded)
    };
  }
  if (!waitSucceeded) {
    return {
      opened: false,
      reason: "详情按钮已点击，但未出现当前订单详情页",
      clickSucceeded: true,
      waitSucceeded: false
    };
  }
  if (expected && panelOrderId && panelOrderId !== expected) {
    return {
      opened: false,
      reason: "详情页订单ID与当前订单不一致",
      clickSucceeded: true,
      waitSucceeded: true
    };
  }
  return {
    opened: false,
    reason: "详情未出现当前订单的可验证详情根",
    clickSucceeded: true,
    waitSucceeded: Boolean(waitSucceeded)
  };
}

function normalizeExactOrderId(value) {
  const normalized = String(value ?? "").trim();
  return /^\d+$/.test(normalized) ? normalized : "";
}

function normalizeExactField(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function resolveProfileFieldsFromDom({ selected = {}, detail = {} }) {
  const actualProductType = normalizeProductType(selected.productType);
  const detailCampName = sanitizeCampNameRaw(detail.trainingName);
  const fallbackCamp = rejectCampName(selected.productName) ? "" : sanitizeCampNameRaw(selected.productName);
  const actualCampName = detailCampName || fallbackCamp;
  const rawCategory = sanitizeCourseCategoryRaw(detail.category);
  const normalizedRawCategory = normalizeCourseCategory(rawCategory);
  return {
    actualProductType,
    actualCampName,
    actualCourseCategory: normalizedRawCategory,
    actualProductTypeSource: actualProductType ? "chanceAssDom订单信息页订单购买类型" : "",
    actualCampNameSource: detailCampName
      ? "chanceAssDom详情页训练营名称"
      : (fallbackCamp ? "chanceAssDom订单信息页订单商品名称兜底" : ""),
    actualCourseCategorySource: rawCategory ? "chanceAssDom详情页所属品类" : "",
    actualCourseCategoryRaw: rawCategory || "",
    actualCourseCategoryNormalized: normalizedRawCategory || "",
    actualCourseCategorySourceTrust: rawCategory ? "detail-dom" : "",
    profileCampNameFallbackUsed: Boolean(!detailCampName && fallbackCamp),
    profileCampNameFallbackSource: !detailCampName && fallbackCamp ? "chanceAssDom订单信息页订单商品名称兜底" : "",
    profileDetailHasTrainingName: Boolean(detail.hasTrainingName && detailCampName),
    profileDetailHasCategory: Boolean(detail.hasCategory && rawCategory)
  };
}

function mergeProfileFromDom({ row, selected, detail, detailReadiness = {}, orderTextSnippet }) {
  const resolved = resolveProfileFieldsFromDom({ selected, detail });
  const {
    actualProductType,
    actualCampName,
    actualCourseCategory,
    actualProductTypeSource,
    actualCampNameSource,
    actualCourseCategorySource,
    actualCourseCategoryRaw,
    actualCourseCategoryNormalized,
    actualCourseCategorySourceTrust,
    profileCampNameFallbackUsed,
    profileCampNameFallbackSource,
    profileDetailHasTrainingName,
    profileDetailHasCategory
  } = resolved;
  const missing = [];
  if (!actualProductType) missing.push("缺Q");
  if (!actualCampName) missing.push("缺R");
  if (!actualCourseCategory) missing.push("缺S");
  return {
    profileSource: "chanceAssDom",
    profileQuerySucceeded: true,
    profileFound: Boolean(actualProductType || actualCampName || actualCourseCategory),
    profileCandidateCount: 1,
    profileSelectedReason: selected.selectionReason || "",
    profileDomQueryResultFound: true,
    profileDomOrderCount: selected.orderCount || 0,
    profileDomMatchedOrderText: selected.rawText || "",
    actualProductType,
    actualCampName,
    actualCourseCategory,
    actualProductTypeSource,
    actualCampNameSource,
    actualCourseCategorySource,
    actualCourseCategoryRaw,
    actualCourseCategoryNormalized,
    actualCourseCategorySourceTrust,
    profileCourseCategoryRejectedSource: "",
    profileCourseCategoryConflictReason: "",
    profileOrderListHasProductType: Boolean(actualProductType),
    profileOrderListProductType: actualProductType,
    profileOrderCardProductName: selected.productName || "",
    profileFormalOrderFound: Boolean(selected.formalOrderFound),
    profileMatchedOrderType: selected.productType || "",
    profileMatchedOrderName: selected.productName || "",
    profileMatchedOrderId: selected.orderId || "",
    profileOrderSelectionReason: selected.selectionReason || "",
    profileCampNameFallbackUsed,
    profileCampNameFallbackSource,
    profileDetailEndpointMatched: Boolean(detailReadiness.opened),
    profileDomDetailClickSucceeded: Boolean(detailReadiness.clickSucceeded),
    profileDomDetailWaitSucceeded: Boolean(detailReadiness.waitSucceeded),
    profileDomDetailReadyReason: detailReadiness.reason || "",
    profileDetailHasTrainingName,
    profileDetailHasCategory,
    profileDetailHasCampTypeId: Boolean(actualProductType),
    profileDomOrderTextSnippet: orderTextSnippet || selected.rawText || "",
    profileDomDetailOpened: Boolean(detailReadiness.opened),
    profileDomDetailTextSnippet: detail.text || "",
    profileError: missing.length ? `chanceAss DOM 字段部分缺失：${missing.join("，")}` : "",
    profileMs: 0
  };
}

function selectOrderForRow(candidates = [], row = {}) {
  const useful = candidates.filter((item) => item.productType || item.productName || item.orderId);
  const docType = normalizeProductType(row.docProductType || row.existing?.L) || normalizeProductType(row.docCampName || row.existing?.M);
  const docName = cleanText(row.docCampName || row.existing?.M);
  const formalOrders = useful.filter((item) => normalizeProductType(item.productType) === "正式营");
  const experienceOrders = useful.filter((item) => normalizeProductType(item.productType) === "体验营");
  let pool = useful;
  let targetType = docType;
  const reasons = [];
  if (docType === "正式营") {
    pool = formalOrders;
    reasons.push("L/M=正式营，仅匹配正式营订单并按M列精准匹配");
  } else if (docType === "体验营") {
    const recentFormalOrders = formalOrders
      .filter((item) => isOrderWithinRecentMonths(item, row, 3))
      .filter((item) => isReliableOrderName(item.productName));
    if (recentFormalOrders.length) {
      const latestFormal = selectLatestOrder(recentFormalOrders);
      const nameScore = campNameMatchScore(docName, latestFormal.productName);
      return {
        ...latestFormal,
        nameScore,
        orderCount: useful.length,
        formalOrderFound: true,
        selectionReason: [
          "L/M=体验营且近三个月内存在正式营订单，选择最新正式营订单",
          docName ? `M列仅作参考，匹配分${nameScore.toFixed(2)}` : "M列为空",
          latestFormal.time ? `订单时间${latestFormal.time}` : "",
          `原始排序${latestFormal.index + 1}`
        ].filter(Boolean).join("；")
      };
    } else {
      pool = experienceOrders;
      reasons.push(formalOrders.length
        ? "L/M=体验营但正式营订单超过三个月，匹配体验营订单"
        : "L/M=体验营且未发现正式营订单，匹配体验营订单");
    }
  } else {
    reasons.push("L/M为空或无法归一化，沿用订单候选综合选择");
  }
  if (!pool.length) {
    const fallback = selectHighNameFallback(useful, docName, docType);
    if (fallback) {
      return {
        ...fallback,
        orderCount: useful.length,
        formalOrderFound: Boolean(formalOrders.length),
        selectionReason: [
          ...reasons,
          "未识别到符合类型的订单候选，但M列与订单名称高相似，继续进入详情核验",
          `M列匹配分${fallback.nameScore.toFixed(2)}`,
          fallback.time ? `订单时间${fallback.time}` : "",
          `原始排序${fallback.index + 1}`
        ].filter(Boolean).join("；")
      };
    }
    return nullSelection(useful, `${reasons.join("；")}；未找到符合类型的订单候选`);
  }
  const ranked = pool.map((item) => {
    const nameScore = campNameMatchScore(docName, item.productName);
    let score = 0;
    if (targetType && normalizeProductType(item.productType) === targetType) score += 120;
    if (item.productType) score += 20;
    if (item.productName) score += 15;
    score += nameScore * 100;
    score += Math.max(0, 20 - Number(item.index || 0));
    return { ...item, nameScore, selectionScore: score };
  }).sort((a, b) => b.selectionScore - a.selectionScore || a.index - b.index);
  const best = ranked[0];
  const strictNameRequired = Boolean(docName) && docType === "正式营";
  if (strictNameRequired && best.nameScore < 0.5) {
    const fallback = selectHighNameFallback(useful, docName, docType, 0.85);
    if (fallback) {
      return {
        ...fallback,
        orderCount: useful.length,
        formalOrderFound: Boolean(formalOrders.length),
        selectionReason: [
          ...reasons,
          "正式营候选与M列相似度不足，改用M列高相似订单进入详情核验",
          `M列匹配分${fallback.nameScore.toFixed(2)}`,
          fallback.time ? `订单时间${fallback.time}` : "",
          `原始排序${fallback.index + 1}`
        ].filter(Boolean).join("；")
      };
    }
    const lowSimilarityFallback = selectLowSimilarityTypedFallback(ranked, docName, docType);
    if (lowSimilarityFallback) {
      return {
        ...lowSimilarityFallback,
        orderCount: useful.length,
        formalOrderFound: Boolean(formalOrders.length),
        selectionReason: [
          ...reasons,
          lowSimilarityFallback.lowSimilarityFallbackReason,
          `M列匹配分${lowSimilarityFallback.nameScore.toFixed(2)}`,
          lowSimilarityFallback.time ? `订单时间${lowSimilarityFallback.time}` : "",
          `原始排序${lowSimilarityFallback.index + 1}`
        ].filter(Boolean).join("；")
      };
    }
    return nullSelection(useful, `${reasons.join("；")}；M列“${docName}”与候选订单名称相似度不足，最高${best.nameScore.toFixed(2)}`);
  }
  return {
    ...best,
    orderCount: useful.length,
    formalOrderFound: Boolean(formalOrders.length),
    selectionReason: [
      ...reasons,
      docName ? `M列匹配分${best.nameScore.toFixed(2)}` : "M列为空，按类型/页面排序选择",
      best.time ? `订单时间${best.time}` : "",
      `原始排序${best.index + 1}`
    ].filter(Boolean).join("；")
  };
}

function selectLowSimilarityTypedFallback(ranked = [], docName = "", docType = "") {
  if (!docName || docType !== "正式营") return null;
  const reliable = ranked
    .filter((item) => item.productName && isReliableOrderName(item.productName))
    .sort((a, b) => b.nameScore - a.nameScore || a.index - b.index);
  const best = reliable[0];
  if (!best) return null;
  const second = reliable[1];
  const docCategory = normalizeCourseCategory(inferCourseCategoryFromTrainingName(docName).value);
  const orderCategory = normalizeCourseCategory(inferCourseCategoryFromTrainingName(best.productName).value);
  const sameCategory = Boolean(docCategory && orderCategory && docCategory === orderCategory);
  const scoreGap = second ? best.nameScore - second.nameScore : 1;
  const onlyReliableCandidate = reliable.length === 1;
  const strongEnoughName = best.nameScore >= 0.45;
  const sameCategoryEnough = sameCategory && best.nameScore >= 0.25 && (scoreGap >= 0.06 || best.nameScore >= 0.35);
  if (!onlyReliableCandidate && !strongEnoughName && !sameCategoryEnough) return null;
  return {
    ...best,
    lowSimilarityFallbackReason: [
      "M列未达精准阈值，启用低相似兜底进入详情核验",
      onlyReliableCandidate ? "仅1个可靠正式营候选" : "",
      sameCategory ? `M列与订单名称同品类(${docCategory})` : "",
      strongEnoughName ? "名称相似度接近阈值" : ""
    ].filter(Boolean).join("，")
  };
}

function selectHighNameFallback(candidates = [], docName = "", docType = "", threshold = 0.85) {
  if (!docName) return null;
  const ranked = candidates
    .filter((item) => item.productName && isReliableOrderName(item.productName))
    .filter((item) => {
      const type = normalizeProductType(item.productType);
      const nameScore = campNameMatchScore(docName, item.productName);
      return !type || !docType || type === docType || nameScore >= 0.95;
    })
    .map((item) => ({ ...item, nameScore: campNameMatchScore(docName, item.productName) }))
    .filter((item) => item.nameScore >= threshold)
    .sort((a, b) => b.nameScore - a.nameScore || a.index - b.index);
  return ranked[0] || null;
}

function selectLatestOrder(orders = []) {
  return [...orders]
    .map((item) => ({ ...item, parsedTime: parseDate(item.time)?.getTime() || 0 }))
    .sort((a, b) => b.parsedTime - a.parsedTime || a.index - b.index)[0];
}

function isOrderWithinRecentMonths(order, row, months = 3) {
  const orderDate = parseDate(order?.time);
  if (!orderDate) return false;
  const reference = parseDate(row?.sentAt || row?.dataDate) || new Date();
  const lower = new Date(reference);
  lower.setMonth(lower.getMonth() - months);
  return orderDate.getTime() >= lower.getTime() && orderDate.getTime() <= reference.getTime();
}

function isReliableOrderName(value) {
  const text = sanitizeCampNameRaw(value);
  if (!text || rejectCampName(text)) return false;
  const hardNonCourseLike = /大礼包|礼包|礼品|赠品|发票|发票链接|优惠券|邮费|补款|差价|兑换|资料包|伴奏包|课程歌曲伴奏/.test(text);
  const strongCourseLike = /营|训练|实战|提升|传承|塑造|蜕变|精研|俱乐部|功法|养正|调和|太极|唱歌|声乐|摄影|瑜伽|普拉提|营养|食养|变美|会员|订阅计划/.test(text);
  if (hardNonCourseLike && !strongCourseLike) return false;
  if (/课程歌曲伴奏.*礼包|伴奏.*礼包/.test(text)) return false;
  const courseLike = strongCourseLike || /课/.test(text);
  const nonCourseLike = /发票|链接|退款|礼品|赠品|优惠券|早餐分分钟|点评卡|合集|社群服务|邮费|补款|差价|兑换/.test(text);
  if (nonCourseLike && !courseLike) return false;
  return true;
}

function nullSelection(candidates, reason) {
  return {
    isNullSelection: true,
    formalOrderFound: candidates.some((item) => normalizeProductType(item.productType) === "正式营"),
    selectionReason: reason
  };
}

function campNameMatchScore(expected, actual) {
  const a = normalizeCampText(expected);
  const b = normalizeCampText(actual);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const grams = (text) => {
    const set = new Set();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  const overlap = [...ga].filter((item) => gb.has(item)).length;
  return overlap / Math.max(ga.size, gb.size, 1);
}

function normalizeCampText(value) {
  return cleanText(value)
    .replace(/[()\[\]【】（）《》“”"'、，,。.\s_-]/g, "")
    .replace(/第?[一二三四五六七八九十百千万\d]+期/g, "")
    .replace(/体验营|正式营|训练营|学习营|课程|会员|再营/g, "");
}

function normalizeProductType(value) {
  const text = cleanText(value);
  if (/正式/.test(text)) return "正式营";
  if (/体验/.test(text)) return "体验营";
  return "";
}

function inferCourseCategoryFromTrainingName(value) {
  const text = cleanText(value);
  const rules = [
    { value: "中医变美", pattern: /中医变美|面部经络|面部莹润|亮颜|焕活|美颜|变美|面部.*抗衰|经络.*亮颜/ },
    { value: "太极", pattern: /太极|武当|道家|功法|传承|柔筋活络|八段锦|五禽戏|形意|道门/ },
    { value: "唱歌", pattern: /唱歌|歌声|麦霸|声乐|歌唱|发声|演唱|国际声乐|畅弹|钢琴|琴|K歌/ },
    { value: "健康食养", pattern: /健康食养|食养|食疗/ },
    { value: "健康营养", pattern: /健康营养|营养/ },
    { value: "短视频", pattern: /短视频|拍剪|剪辑|视频拍剪|视听双享|创作营|视频创作/ },
    { value: "手机摄影", pattern: /手机摄影|摄影(?!棚)|拍照|拍摄/ },
    { value: "瑜伽", pattern: /瑜伽/ },
    { value: "普拉提", pattern: /普拉提/ },
    { value: "国学朗诵", pattern: /国学朗诵|朗诵/ },
    { value: "亚健康管理", pattern: /亚健康|排浊通络|身心健康|通络身心|冥想|身心同调/ },
    { value: "气血调理", pattern: /气血调理|气血/ }
  ];
  const matched = rules.find((rule) => rule.pattern.test(text));
  return matched ? { value: matched.value, source: "训练营名称关键词高置信兜底" } : { value: "", source: "" };
}

function normalizeCourseCategory(value) {
  const text = sanitizeCourseCategoryRaw(value);
  if (!text) return "";
  if (/面部经络|亮颜|焕活|变美|中医变美/.test(text)) return "中医变美";
  if (/太极|武当|道家|功法|八段锦|柔筋活络/.test(text)) return "太极";
  if (/唱歌|歌声|麦霸|声乐|歌唱|发声|演唱|国际声乐|畅弹|钢琴|K歌/.test(text)) return "唱歌";
  return text;
}

function sanitizeCourseCategoryRaw(value) {
  let text = cleanText(value);
  if (!text) return "";
  const stopPattern = /(正式营ID|体验营ID|训练营ID|营ID|商品ID|商品名称|所在期数|开营时间|训练营名称|营名称|订单信息|商品信息|用户信息|用户ID|用户昵称|手机号|订单链接|下单链接|渠道信息|渠道一级类型|渠道二级类型|渠道三级类型)(?:[:：\s]|$)/;
  const stopMatch = text.match(stopPattern);
  if (stopMatch?.index > 0) text = text.slice(0, stopMatch.index);
  text = cleanText(text.replace(/^(所属品类|课程品类|品类名称)[:：]?/, ""));
  const knownCategories = ["中医变美", "太极", "唱歌", "健康食养", "健康营养", "短视频", "手机摄影", "瑜伽", "普拉提", "国学朗诵", "亚健康管理", "气血调理", "东方食养", "声乐", "国际声乐"];
  const exact = knownCategories.find((item) => text === item || text.startsWith(`${item} `) || text.startsWith(`${item}　`));
  if (exact) return exact;
  return text;
}

function sanitizeCampNameRaw(value) {
  let text = cleanText(value);
  if (!text) return "";
  const stopPattern = /(用户信息|用户ID|用户昵称|手机号|订单链接|下单链接|商品信息|订单信息|所属品类|课程品类|品类名称|商品ID|正式营ID|体验营ID|训练营ID|所在期数|开营时间)(?:[:：\s]|$)/;
  const stopMatch = text.match(stopPattern);
  if (stopMatch?.index > 0) text = text.slice(0, stopMatch.index);
  text = cleanText(text.replace(/^(训练营名称|营名称|商品名称)[:：]?/, ""));
  return text;
}

function rejectCampName(value) {
  return /视频号|直投|小程序|投放|推广|JF|低价|副本|腾讯-知定/i.test(cleanText(value));
}

function buildChanceSearchDateRange(row, config) {
  const sheetRange = parseTargetSheetDateRange(config?.targetSheet, row);
  if (sheetRange) return sheetRange;
  const rowRange = buildDateRange(row);
  if (rowRange) return rowRange;
  return {
    source: "default-wide",
    start: "2026-06-01 00:00:00",
    end: "2026-06-30 23:59:59"
  };
}

function parseTargetSheetDateRange(sheetName, row) {
  const match = String(sheetName || "").match(/(\d{1,2})\.(\d{1,2})\s*[-—~至]\s*(\d{1,2})\.(\d{1,2})/);
  if (!match) return null;
  const sourceDate = parseDate(row.sentAt || row.dataDate) || new Date();
  const year = sourceDate.getFullYear();
  const [, startMonth, startDay, endMonth, endDay] = match.map(Number);
  return {
    source: "target-sheet",
    start: `${year}-${pad2(startMonth)}-${pad2(startDay)} 00:00:00`,
    end: `${year}-${pad2(endMonth)}-${pad2(endDay)} 23:59:59`
  };
}

function buildDateRange(row) {
  const source = parseDate(row.sentAt || row.dataDate);
  if (!source) return null;
  const start = new Date(source.getTime() - 30 * 864e5);
  const end = new Date(source.getTime() + 30 * 864e5);
  return {
    source: "row-date-wide",
    start: formatDate(start, "00:00:00"),
    end: formatDate(end, "23:59:59")
  };
}

function parseDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = text.replace(/[./]/g, "-");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date, time) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/[，,。；;]+$/, "").trim();
}

function emptyProfile(error = "", profileFailureStage = "") {
  return {
    profileSource: "chanceAssDom",
    profileQuerySucceeded: false,
    profileFound: false,
    profileCandidateCount: 0,
    actualProductType: "",
    actualCampName: "",
    actualCourseCategory: "",
    actualProductTypeSource: "",
    actualCampNameSource: "",
    actualCourseCategorySource: "",
    profileError: error,
    profileFailureStage,
    profilePageReset: {},
    profileDateCleared: false,
    profileDomQueryResultFound: false,
    profileDomQueryTextSnippet: "",
    profileDomUserIdFilled: false,
    profileDomUserIdVerified: false,
    profileDomSearchDateRange: {},
    profileDomStudentArchiveButtonFound: false,
    profileDomStudentArchiveClickStrategy: "",
    profileDomArchiveOpened: false,
    profileDomArchiveVerifyText: "",
    profileDomStillOnChanceList: false,
    profileDomArchiveVerifyFailedReason: "",
    profileDomOrderTabOpened: false,
    profileDomWrongPageForOrderParse: "",
    profileDomOrderCount: 0,
    profileOrderScrollCompleted: {},
    profileOrderMatchScore: 0,
    profileDomMatchedOrderText: "",
    profileDomOrderTextSnippet: "",
    profileDomDetailOpened: false,
    profileDomDetailTextSnippet: "",
    profileMs: 0
  };
}

function withTiming(profile, startedAt) {
  return {
    ...profile,
    profileMs: Date.now() - startedAt
  };
}

async function writeChanceDebug(config, row, label, text) {
  const debugConfig = config.debug || {};
  const dir = path.resolve(debugConfig.dir || "debug", `row-${row.rowNumber}`);
  fs.mkdirSync(dir, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9_.-]+/gi, "-");
  fs.writeFileSync(path.join(dir, `${safeLabel}.txt`), String(text || "").slice(0, 30000), "utf8");
}
