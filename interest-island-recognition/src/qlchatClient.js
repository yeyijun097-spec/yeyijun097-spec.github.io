import fs from "node:fs";
import path from "node:path";
import { waitForInteractiveLogin } from "./interactiveLogin.js";
import { createQueryLifecycleObserver } from "./qlchatQueryLifecycle.js";

const FIXED_FALLBACK_KEYWORDS = [
  "投诉", "举报", "伪直播", "报警", "虚假宣传", "诱导",
  "12315", "黑猫", "维权", "市长热线", "曝光你", "消协"
];

export function resolveMaxPersonCandidates(ui = {}, available = 0) {
  // 同名人员的有效会话经常位于列表末尾，不能按固定数量截断。
  // 整行耗时由 QichatDomClient 的共享硬上限统一保护。
  return Math.max(0, Number(available || 0));
}

export function orderPersonCandidatesForQuery(candidates = []) {
  // 页面列表中同名人员的有效聊天通常位于靠后位置；复制后倒序，避免改变
  // 原始快照和诊断顺序。
  return [...candidates].reverse();
}

function queryLifecycleFields(value = {}) {
  return {
    domQueryRequestObserved: Boolean(value.requestObserved),
    domQueryResponseObserved: Boolean(value.responseObserved),
    domQueryResponseStatus: Number(value.responseStatus || 0),
    domQueryResponseKind: value.responseKind || "unknown",
    domQueryResponseCount: Number(value.responseCount || 0),
    domQueryRenderObserved: Boolean(value.renderObserved),
    domQueryLifecycleFailureStage: value.failureStage || ""
  };
}

export function isQichatQueryPageReady({
  bodyText = "",
  personInputVisible = false,
  keywordInputVisible = false,
  searchButtonVisible = false
} = {}) {
  const hasQueryShell = bodyText.includes("私聊记录")
    && bodyText.includes("关键词")
    && bodyText.includes("查询");
  return hasQueryShell && personInputVisible && keywordInputVisible && searchButtonVisible;
}

export async function createQichatClient(config, disabled = false) {
  if (disabled) return new OfflineClient();

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    throw new Error("未安装 Playwright。请先运行 npm install，或使用 --offline 做离线预览。");
  }

  const browserConfig = config.browser || {};
  const context = await chromium.launchPersistentContext(browserConfig.userDataDir || ".browser-profile", {
    headless: Boolean(browserConfig.headless),
    viewport: { width: 1440, height: 960 }
  });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(browserConfig.timeoutMs || 30000);
  await page.goto(browserConfig.url, { waitUntil: "domcontentloaded" });

  return new QichatClient(page, context, config);
}

export async function recoverQichatPage({
  context,
  currentPage,
  url,
  timeoutMs = 30000,
  isReady,
  signal
} = {}) {
  if (signal?.aborted) return abortedRecoveryResult();
  if (!context || typeof context.newPage !== "function") {
    return { ok: false, stage: "context", error: "企聊宝浏览器上下文不可用" };
  }
  if (!url) return { ok: false, stage: "navigate", error: "企聊宝查询页地址为空" };
  if (currentPage && !currentPage.isClosed?.()) {
    const stopWatchingAbort = closePageOnAbort(currentPage, signal);
    try {
      currentPage.setDefaultTimeout?.(timeoutMs);
      await currentPage.goto(url, { waitUntil: "domcontentloaded" });
      if (signal?.aborted) return abortedRecoveryResult();
      if (await waitForQichatPageReady(currentPage, isReady, timeoutMs, 200, signal)) {
        return { ok: true, stage: "ready", error: "", page: currentPage, reused: true };
      }
    } catch (error) {
      if (signal?.aborted) return abortedRecoveryResult();
      // 当前页面不可复用时再建立替代页；在替代页确认可用前不关闭旧页。
    } finally {
      stopWatchingAbort();
    }
  }

  if (signal?.aborted) return abortedRecoveryResult();

  let page;
  try {
    page = await context.newPage();
  } catch (error) {
    return { ok: false, stage: "new-page", error: safeRecoveryError(error) };
  }
  if (signal?.aborted) {
    await page.close?.().catch(() => {});
    return abortedRecoveryResult();
  }
  const stopWatchingAbort = closePageOnAbort(page, signal);
  page.setDefaultTimeout?.(timeoutMs);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (error) {
    stopWatchingAbort();
    await page.close?.().catch(() => {});
    if (signal?.aborted) return abortedRecoveryResult();
    return { ok: false, stage: "navigate", error: safeRecoveryError(error) };
  }
  try {
    if (signal?.aborted) {
      await page.close?.().catch(() => {});
      return abortedRecoveryResult();
    }
    if (!(await waitForQichatPageReady(page, isReady, timeoutMs, 200, signal))) {
      await page.close?.().catch(() => {});
      if (signal?.aborted) return abortedRecoveryResult();
      return { ok: false, stage: "ready", error: "企聊宝查询页恢复后仍未就绪" };
    }
  } catch (error) {
    await page.close?.().catch(() => {});
    if (signal?.aborted) return abortedRecoveryResult();
    return { ok: false, stage: "ready", error: safeRecoveryError(error) };
  } finally {
    stopWatchingAbort();
  }
  if (signal?.aborted) {
    await page.close?.().catch(() => {});
    return abortedRecoveryResult();
  }
  if (currentPage && currentPage !== page && !currentPage.isClosed?.()) {
    await currentPage.close?.().catch(() => {});
  }
  return { ok: true, stage: "ready", error: "", page, reused: false };
}

async function waitForQichatPageReady(page, isReady, timeoutMs, pollMs = 200, signal) {
  if (typeof isReady !== "function") return false;
  const effectiveTimeoutMs = Math.max(0, Number(timeoutMs || 0));
  const attempts = Math.max(1, Math.ceil(effectiveTimeoutMs / pollMs) + 1);
  const deadline = Date.now() + effectiveTimeoutMs;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) return false;
    if (await isReady(page)) return !signal?.aborted;
    if (attempt + 1 >= attempts || Date.now() >= deadline) break;
    const waitMs = Math.min(pollMs, Math.max(0, deadline - Date.now()));
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(waitMs).catch(() => {});
    } else {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return false;
}

function closePageOnAbort(page, signal) {
  if (!signal) return () => {};
  const close = () => {
    if (!page?.isClosed?.()) Promise.resolve(page?.close?.()).catch(() => {});
  };
  if (signal.aborted) close();
  else signal.addEventListener("abort", close, { once: true });
  return () => signal.removeEventListener("abort", close);
}

function abortedRecoveryResult() {
  return { ok: false, stage: "aborted", error: "企聊宝查询页恢复已取消" };
}

function safeRecoveryError(error) {
  return String(error?.message || error || "未知错误").slice(0, 300);
}

class OfflineClient {
  async ensureReady() {
    return { ready: true, waitedForLogin: false };
  }

  async fetchContext(row) {
    return {
      contextSource: "offline",
      foundConversation: false,
      matchedMessage: false,
      contextText: row.message || "",
      userBubbleText: "",
      userBubbleMessages: [],
      userBubbleCount: 0,
      error: "offline mode"
    };
  }

  async close() {}
}

class QichatClient {
  constructor(page, context, config) {
    this.page = page;
    this.context = context;
    this.config = config;
    // 有头模式只在人工登录阶段允许抢前台；登录确认后批处理始终留在后台。
    this.loginConfirmed = false;
    this.progressStage = "";
    this.selectors = config.selectors || {};
    this.keywordMaxLength = config.keywordMaxLength || 30;
    this.debug = config.debug || {};
    this.ui = {
      personInputWaitMs: 400,
      personCandidateWaitMs: 8000,
      // 人员刷新是最容易受页面竞态影响的阶段。限制单行总预算，
      // 避免某个卡片/DOM 探针卡住后把整批任务拖住。
      personSearchBudgetMs: 45000,
      personProbeTimeoutMs: 1200,
      // 人员、查询、会话和右侧上下文共享单行总预算，避免候选数量放大耗时。
      rowSearchBudgetMs: 180000,
      candidateClickWaitMs: 350,
      queryWaitMs: 12000,
      resultWaitMs: 12000,
      middleWaitMs: 5000,
      rightWaitMs: 10000,
      conversationRetryDelayMs: 1000,
      rightRetryDelayMs: 1000,
      rightStableMs: 700,
      ...(config.ui || {})
    };
    this.setupApiCapture();
  }

  setupApiCapture() {
    if (!this.config.api?.capture) return;
    fs.mkdirSync("logs", { recursive: true });
    const file = path.resolve("logs", `api-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    console.log(`接口捕获：已启用，日志 ${file}`);
    this.page.on("request", (request) => {
      const type = request.resourceType();
      if (!["xhr", "fetch"].includes(type)) return;
      const url = request.url();
      if (!/chat|record|workWechat|session|message|conversation/i.test(url)) return;
      const entry = {
        time: new Date().toISOString(),
        kind: "request",
        method: request.method(),
        url: sanitizeUrl(url),
        postData: trimText(request.postData() || "", 1000)
      };
      fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    });
    this.page.on("response", async (response) => {
      const request = response.request();
      const type = request.resourceType();
      if (!["xhr", "fetch"].includes(type)) return;
      const url = response.url();
      if (!/chat|record|workWechat|session|message|conversation/i.test(url)) return;
      const headers = response.headers();
      const contentType = headers["content-type"] || "";
      let bodySnippet = "";
      if (/json|text/.test(contentType)) {
        bodySnippet = trimText(await response.text().catch(() => ""), 1500);
      }
      const entry = {
        time: new Date().toISOString(),
        kind: "response",
        status: response.status(),
        url: sanitizeUrl(url),
        contentType,
        bodySnippet
      };
      fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    });
  }

  async ensureReady(waitForLogin = true) {
    if (await this.isQueryPageReady()) {
      this.loginConfirmed = true;
      return { ready: true, waitedForLogin: false };
    }

    if (!waitForLogin) {
      return { ready: false, waitedForLogin: false };
    }

    if (this.config.browser?.headless && this.config.browser?.allowInteractiveLogin !== true) {
      throw new Error("LOGIN_REQUIRED: 企聊宝聊天页登录态失效，需要临时打开有头浏览器人工验证");
    }

    const result = await waitForInteractiveLogin({
      kind: "qlchat",
      label: "企聊宝聊天记录",
      page: this.page,
      targetUrl: (this.config?.browser || {}).url || this.page.url(),
      isReady: () => this.isQueryPageReady(),
      timeoutMs: this.config.browser?.loginTimeoutMs || 300000
    });
    this.loginConfirmed = result.ready;
    if (result.ready && !this.config.browser?.headless) {
      console.log("登录验证完成：后续聊天批处理保持后台，不主动抢前台焦点。");
    }
    return result;
  }

  async isQueryPageReady(page = this.page) {
    const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    const [personInputVisible, keywordInputVisible, searchButtonVisible] = await Promise.all([
      isLocatorVisible(page, this.selectors.personNameInput),
      isLocatorVisible(page, this.selectors.keywordInput),
      isLocatorVisible(page, this.selectors.searchButton)
    ]);
    return isQichatQueryPageReady({
      bodyText: text,
      personInputVisible,
      keywordInputVisible,
      searchButtonVisible
    });
  }

  async fetchContext(row) {
    try {
      this.setProgressStage("正在重置聊天查询页");
      const chatPageReset = await this.prepareChatSearchPage(row);
      const searchResult = await this.search(row, chatPageReset);
      const text = searchResult.contextText || "";
      const originalMessageMatched = Boolean(searchResult.contextOpened) && fuzzyIncludes(text, row.message);
      const matchedMessage = Boolean(searchResult.contextOpened && searchResult.relatedRecords > 0);
      const error = searchResult.contextOpened
        ? ""
        : searchResult.error || (searchResult.relatedRecords > 0 ? "已查到相关记录，但右侧上下文未打开" : "未查询到相关记录");
      return {
        contextSource: "ui",
        foundConversation: Boolean(searchResult.conversationClicked) || text.includes(String(row.userId || "")) || text.includes(rowPersonName(row)),
        matchedMessage,
        originalMessageMatched,
        contextText: text,
        userBubbleText: searchResult.userBubbleText || "",
        userBubbleMessages: searchResult.userBubbleMessages || [],
        userBubbleCount: searchResult.userBubbleCount || 0,
        error,
        candidateTried: searchResult.candidateTried || 0,
        queryClicked: Boolean(searchResult.queryClicked),
        searchKeyword: searchResult.searchKeyword || "",
        personSearchName: searchResult.personSearchName || "",
        relatedRecords: searchResult.relatedRecords || 0,
        matchedByRelatedRecords: Boolean(searchResult.matchedByRelatedRecords),
        conversationClicked: Boolean(searchResult.conversationClicked),
        recordClicked: Boolean(searchResult.recordClicked),
        contextOpened: Boolean(searchResult.contextOpened),
        chatPageReset,
        domDetectedKeywords: searchResult.domDetectedKeywords || [],
        domSearchKeywordTried: searchResult.domSearchKeywordTried || [],
        domQueryResultChanged: Boolean(searchResult.domQueryResultChanged),
        domRightBubbleVerified: Boolean(searchResult.domRightBubbleVerified),
        domPersonCandidates: searchResult.domPersonCandidates || 0,
        domPersonCandidateTried: searchResult.domPersonCandidateTried || searchResult.candidateTried || 0,
        domPersonCandidateTexts: searchResult.domPersonCandidateTexts || [],
        domCandidateSnapshotCount: searchResult.domCandidateSnapshotCount || 0,
        domCandidateAttemptDetails: searchResult.domCandidateAttemptDetails || [],
        domCandidateFailureReason: searchResult.domCandidateFailureReason || error,
        domPersonExpectedName: searchResult.domPersonExpectedName || rowPersonName(row),
        domPersonInputValue: searchResult.domPersonInputValue || "",
        domPersonListBeforeSignature: searchResult.domPersonListBeforeSignature || chatPageReset.personListBeforeSignature || "",
        domPersonListAfterSignature: searchResult.domPersonListAfterSignature || "",
        domPersonListRefreshed: Boolean(searchResult.domPersonListRefreshed),
        domPersonMatchLevel: searchResult.domPersonMatchLevel || 0,
        domPersonIdentityVerified: Boolean(searchResult.domPersonIdentityVerified),
        domSelectedPersonText: searchResult.domSelectedPersonText || "",
        domSelectedPersonVerified: Boolean(searchResult.domSelectedPersonVerified),
        domConversationUserIdVerified: Boolean(searchResult.domConversationUserIdVerified),
        domQueryExpectedUserId: searchResult.domQueryExpectedUserId || String(row.userId || "").trim(),
        domQueryActualUserId: searchResult.domQueryActualUserId || "",
        domQueryFormVerified: Boolean(searchResult.domQueryFormVerified),
        domQueryResultTerminal: Boolean(searchResult.domQueryResultTerminal),
        invalidContext: Boolean(searchResult.invalidContext),
        webTimings: searchResult.webTimings || {}
      };
    } catch (error) {
      return {
        contextSource: "ui",
        foundConversation: false,
        matchedMessage: false,
        contextText: "",
        userBubbleText: "",
        userBubbleMessages: [],
        userBubbleCount: 0,
        chatPageReset: { readyAfter: false, error: error.message },
        error: error.message
      };
    }
  }

  setProgressStage(stage) {
    this.progressStage = String(stage || "");
  }

  getProgressStage() {
    return this.progressStage;
  }

  async prepareChatSearchPage(row) {
    const info = {
      broughtToFront: false,
      navigated: false,
      readyBefore: false,
      readyAfter: false,
      resetClicked: false,
      formCleared: false,
      personListBeforeSignature: "",
      personListClearedSignature: "",
      personListCleared: false
    };
    // 不在逐行处理时调用 bringToFront。页面仍可正常导航和读取 DOM，
    // 但不会把用户正在使用的窗口反复抢到前台。
    info.focusSuppressed = !this.config.browser?.headless;

    info.readyBefore = await this.isQueryPageReady();
    const targetUrl = (this.config?.browser || {}).url || "";
    const currentUrl = this.page.url();
    if (targetUrl && (!/workWechat\/chatRecordPlatform/.test(currentUrl) || !info.readyBefore)) {
      await this.page.goto(targetUrl, { waitUntil: "domcontentloaded" }).then(() => {
        info.navigated = true;
      }).catch(() => {});
      await this.page.waitForTimeout(800).catch(() => {});
    }

    info.readyAfter = await this.isQueryPageReady();
    info.personListBeforeSignature = await leftPersonListSignature(this.page);
    info.resetClicked = await clickResetButton(this.page, this.selectors.resetButton);
    await this.page.waitForTimeout(200).catch(() => {});
    await fillIfVisible(this.page, this.selectors.personNameInput, "");
    await fillIfVisible(this.page, this.selectors.keywordInput, "");
    await fillRightUserIdInput(this.page, "");
    await this.page.keyboard.press("Escape").catch(() => {});
    const clearStartedAt = Date.now();
    while (Date.now() - clearStartedAt < 1800) {
      info.personListClearedSignature = await leftPersonListSignature(this.page);
      if (!info.personListClearedSignature || info.personListClearedSignature !== info.personListBeforeSignature) {
        info.personListCleared = true;
        break;
      }
      await this.page.waitForTimeout(180).catch(() => {});
    }
    info.formCleared = true;
    info.rowNumber = row?.rowNumber || 0;
    return info;
  }

  async search(row, chatPageReset = {}) {
    const s = this.selectors;
    const webTimings = {
      personSearchMs: 0,
      candidates: []
    };
    const personStartedAt = Date.now();
    const personName = rowPersonName(row);
    this.setProgressStage(`正在搜索人员：${personName || "未命名"}`);
    const detectedKeywords = buildSearchKeywords(row.message, this.keywordMaxLength);
    console.log(
      `K列固定关键词扫描${row?.rowNumber ? `（行${row.rowNumber}）` : ""}：` +
      (detectedKeywords.length ? detectedKeywords.join("、") : "未发现，按用户ID查询")
    );
    let personInputFilled = await fillIfVisible(this.page, s.personNameInput, personName);
    await this.page.waitForTimeout(this.ui.personInputWaitMs);
    let personInputValue = await readInputValue(this.page, s.personNameInput);
    let candidateSnapshot = await this.waitForStablePersonCandidates(row, chatPageReset);

    if (!personInputFilled || personInputValue !== personName || !candidateSnapshot.refreshed) {
      await clickResetButton(this.page, this.selectors.resetButton).catch(() => false);
      await fillIfVisible(this.page, s.personNameInput, "");
      await fillIfVisible(this.page, s.keywordInput, "");
      await fillRightUserIdInput(this.page, "");
      await this.page.waitForTimeout(350).catch(() => {});
      const retryOriginalSignature = candidateSnapshot.afterSignature
        || await leftPersonListSignature(this.page, this.ui.personProbeTimeoutMs);
      const retryClearedSignature = await leftPersonListSignature(this.page, this.ui.personProbeTimeoutMs);
      personInputFilled = await fillIfVisible(this.page, s.personNameInput, personName);
      await this.page.waitForTimeout(this.ui.personInputWaitMs);
      personInputValue = await readInputValue(this.page, s.personNameInput);
      candidateSnapshot = await this.waitForStablePersonCandidates(row, {
        ...chatPageReset,
        personListBeforeSignature: retryOriginalSignature,
        personListClearedSignature: retryClearedSignature,
        personListCleared: retryClearedSignature !== retryOriginalSignature
      });
    }

    const candidates = orderPersonCandidatesForQuery(candidateSnapshot.candidates);
    webTimings.personSearchMs = Date.now() - personStartedAt;
    webTimings.candidateSnapshotCount = candidateSnapshot.snapshotCount;
    const maxCandidates = resolveMaxPersonCandidates(this.ui, candidates.length);
    const candidateTexts = candidates.map((item) => item.text || "").filter(Boolean);
    let lastText = "";
    let lastQueryClicked = false;
    let lastSearchKeyword = "";
    let lastQueryActualUserId = "";
    let lastQueryLifecycle = {};
    let bestFailure = null;
    const allTriedKeywords = [];
    const candidateAttemptDetails = [];

    const commonIdentity = {
      domPersonExpectedName: personName,
      domPersonInputValue: personInputValue,
      domPersonListBeforeSignature: candidateSnapshot.beforeSignature || chatPageReset.personListBeforeSignature || "",
      domPersonListAfterSignature: candidateSnapshot.afterSignature || "",
      domPersonListRefreshed: Boolean(candidateSnapshot.refreshed),
      domPersonIdentityVerified: candidates.length > 0 && candidates.every((item) => item.matchLevel > 0),
      domPersonCandidates: candidates.length,
      domPersonCandidateTexts: candidateTexts,
      domCandidateSnapshotCount: candidateSnapshot.snapshotCount
    };

    if (!personInputFilled || personInputValue !== personName || !candidateSnapshot.refreshed || !candidates.length) {
      const reason = !personInputFilled || personInputValue !== personName
        ? `人员名称输入未生效：期望「${personName}」，实际「${personInputValue}」`
        : (!candidateSnapshot.refreshed ? "人员列表未刷新到当前行" : "人员列表已刷新，但没有与当前姓名匹配的候选");
      return {
        ...commonIdentity,
        contextText: "",
        userBubbleText: "",
        userBubbleMessages: [],
        userBubbleCount: 0,
        candidateTried: 0,
        personSearchName: personName,
        queryClicked: false,
        searchKeyword: "",
        domSearchKeywordTried: [],
        domQueryResultChanged: false,
        domRightBubbleVerified: false,
        domPersonCandidateTried: 0,
        domCandidateAttemptDetails: [],
        domDetectedKeywords: detectedKeywords,
        domCandidateFailureReason: reason,
        domPersonIdentityVerified: false,
        domSelectedPersonVerified: false,
        domConversationUserIdVerified: false,
        domQueryFormVerified: false,
        domQueryResultTerminal: false,
        relatedRecords: 0,
        matchedByRelatedRecords: false,
        invalidContext: true,
        webTimings,
        error: reason
      };
    }

    for (let i = 0; i < maxCandidates; i += 1) {
      this.setProgressStage(`正在验证人员候选 ${i + 1}/${maxCandidates}`);
      const candidateTiming = {
        index: i + 1,
        text: candidates[i]?.text || "",
        selectMs: 0,
        queryMs: 0,
        detectRelatedMs: 0,
        openContextMs: 0
      };
      const attemptDetail = {
        index: i + 1,
        personText: candidates[i]?.text || "未采集到人员卡片，直接查询",
        keywords: [],
        relatedRecords: 0,
        conversationClicked: false,
        recordClicked: false,
        contextOpened: false,
        failureStage: "",
        personMatchLevel: candidates[i]?.matchLevel || 0,
        personClickCount: 0,
        selectedPersonVerified: false,
        conversationUserIdVerified: false
      };
      candidateAttemptDetails.push(attemptDetail);
      if (candidates[i]) {
        if (!(candidates[i].matchLevel > 0)) {
          attemptDetail.failureStage = "候选人员姓名与当前行无关，已阻止点击";
          continue;
        }
        const selectStartedAt = Date.now();
        const beforeConversationSignature = await conversationListSignature(this.page);
        let selected = await candidates[i].click().catch(() => false);
        attemptDetail.personClickCount += selected ? 1 : 0;
        const selectionVisualVerified = selected
          ? await waitForSelectedPerson(this.page, candidates[i], beforeConversationSignature, 1000)
          : false;
        // 企聊页面只有在填入用户 ID/关键词并点击查询后才会刷新会话列表。
        // 因此人员点击阶段只要 DOM locator 点击成功且姓名匹配就可以进入查询；
        // 查询后仍会校验 D 列用户 ID、结果终态和右侧气泡，不会放宽上下文写回。
        const selectedPersonVerified = Boolean(selected && candidates[i]?.matchLevel > 0);
        attemptDetail.personClickSucceeded = Boolean(selected);
        attemptDetail.personSelectionVisualVerified = Boolean(selectionVisualVerified);
        attemptDetail.personSelectionVerificationSource = selectionVisualVerified
          ? "selected-style"
          : (selectedPersonVerified ? "dom-click-and-name-match" : "unverified");
        attemptDetail.selectedPersonVerified = Boolean(selectedPersonVerified);
        candidateTiming.selectMs = Date.now() - selectStartedAt;
        if (!selectedPersonVerified || !(candidates[i]?.matchLevel > 0)) {
          attemptDetail.failureStage = "人员卡片点击后未确认选中，或姓名与当前行不匹配";
          continue;
        }
      }

      // 附件消息在 K 列可能只保留 JSON 元数据，不能把 JSON 前缀当聊天关键词。
      // 这类行改为仅按用户 ID 查询，仍遵守“每个人员只尝试一次查询”的约束。
      // 只使用完整 K 列字段中实际出现的固定关键词；
      // 不再输入整段消息或随意拆词，减少无效查询。
      const keywords = detectedKeywords.length ? detectedKeywords : [""];
      const triedKeywords = [];
      for (const keyword of keywords) {
        this.setProgressStage(`正在等待查询结果（候选 ${i + 1}/${maxCandidates}）`);
        const queryStartedAt = Date.now();
        const query = await this.runQuery(row, keyword, attemptDetail.selectedPersonVerified);
        candidateTiming.queryMs += Date.now() - queryStartedAt;
        lastQueryClicked = query.clicked;
        lastSearchKeyword = query.searchKeyword;
        lastQueryActualUserId = query.rightUserIdValue || "";
        lastQueryLifecycle = query.queryLifecycle || {};
        triedKeywords.push(query.searchKeyword);
        allTriedKeywords.push(`候选${i + 1}:${query.searchKeyword || "(仅按用户ID)"}`);
        const keywordDetail = {
          keyword: query.searchKeyword,
          keywordInputFilled: Boolean(query.keywordInputFilled),
          queryClicked: Boolean(query.clicked),
          resultChanged: Boolean(query.resultChanged),
          formVerified: Boolean(query.formVerified),
          resultTerminal: Boolean(query.resultTerminal),
          resultTerminalKind: query.resultTerminalKind || "",
          currentUserMatched: Boolean(query.currentUserMatched),
          queryValidationError: query.queryValidationError || "",
          expectedUserId: String(row.userId || "").trim(),
          actualUserId: query.rightUserIdValue || "",
          relatedRecords: 0,
          contextOpened: false,
          ...queryLifecycleFields(lastQueryLifecycle)
        };
        attemptDetail.keywords.push(keywordDetail);
        if (query.error) {
          keywordDetail.failureStage = query.error;
          attemptDetail.failureStage = query.error;
          await this.debugStep(row, `candidate-${i + 1}-keyword-input-failed-${triedKeywords.length}`);
          continue;
        }
        await this.debugStep(row, `candidate-${i + 1}-after-query-${triedKeywords.length}`);
        const detectStartedAt = Date.now();
        // runQuery 已经在同一轮轮询中同时确认“结果区刷新”和“相关记录数”。
        // 优先复用该结果，避免查询完成后再次等待一整轮相关记录检测。
        // 旧客户端或异常页面没有返回该字段时，保留原有轮询作为兼容兜底。
        let relatedRecords = Number(query.relatedRecords || 0);
        if (!query.relatedRecordsWaited) {
          if (query.resultChanged) {
            const currentSignature = await resultAreaSignature(this.page);
            if (!query.beforeSignature || currentSignature !== query.beforeSignature) {
              relatedRecords = await this.detectRelatedRecords();
            }
          }
          if (relatedRecords <= 0) {
            relatedRecords = await this.waitForRelatedRecords(
              query.beforeSignature,
              this.ui.resultWaitMs || this.ui.queryWaitMs || 10000
            );
          }
        }
        candidateTiming.detectRelatedMs += Date.now() - detectStartedAt;
        keywordDetail.relatedRecords = relatedRecords;
        attemptDetail.relatedRecords = Math.max(attemptDetail.relatedRecords, relatedRecords);
        if (relatedRecords <= 0) {
          if (!query.resultTerminal) {
            keywordDetail.failureStage = "查询结果未刷新到明确终态";
            attemptDetail.failureStage = keywordDetail.failureStage;
          }
          continue;
        }

        const conversationUserIdVerified = await waitForConversationUserId(this.page, row.userId, 5000);
        attemptDetail.conversationUserIdVerified = Boolean(conversationUserIdVerified);
        if (!conversationUserIdVerified) {
          keywordDetail.failureStage = `会话列表未出现当前用户ID：${row.userId || "空"}`;
          attemptDetail.failureStage = keywordDetail.failureStage;
          continue;
        }

        const openContextStartedAt = Date.now();
        this.setProgressStage("正在打开中间记录并验证右侧气泡");
        const contextResult = await this.collectBestResultText(row, query.searchKeyword);
        candidateTiming.openContextMs += Date.now() - openContextStartedAt;
        let text = contextResult.text;
        lastText = text || lastText;

        const error = contextResult.contextOpened
          ? ""
          : buildOpenContextError(contextResult);
        keywordDetail.contextOpened = Boolean(contextResult.contextOpened);
        keywordDetail.openMethod = contextResult.openMethod || "";
        keywordDetail.failureStage = contextResult.failureStage || "";
        attemptDetail.conversationClicked = attemptDetail.conversationClicked || Boolean(contextResult.conversationClicked);
        attemptDetail.recordClicked = attemptDetail.recordClicked || Boolean(contextResult.recordClicked);
        attemptDetail.contextOpened = attemptDetail.contextOpened || Boolean(contextResult.contextOpened);
        attemptDetail.failureStage = contextResult.contextOpened ? "" : (contextResult.failureStage || error);
        const result = {
          ...commonIdentity,
          contextText: text,
          userBubbleText: contextResult.userBubbleText || "",
          userBubbleMessages: contextResult.userBubbleMessages || [],
          userBubbleCount: contextResult.userBubbleCount || 0,
          candidateTried: i + 1,
          personSearchName: personName,
          queryClicked: lastQueryClicked,
          searchKeyword: lastSearchKeyword,
          domSearchKeywordTried: [...allTriedKeywords],
          domQueryResultChanged: Boolean(query.resultChanged),
          domRightBubbleVerified: Boolean(contextResult.contextOpened),
          domPersonCandidates: candidates.length,
          domPersonCandidateTried: i + 1,
          domPersonCandidateTexts: candidateTexts,
          domCandidateSnapshotCount: candidateSnapshot.snapshotCount,
          domCandidateAttemptDetails: [...candidateAttemptDetails],
          domDetectedKeywords: detectedKeywords,
          domCandidateFailureReason: error,
          domPersonMatchLevel: candidates[i]?.matchLevel || 0,
          domPersonIdentityVerified: Boolean(candidates[i]?.matchLevel > 0),
          domSelectedPersonText: candidates[i]?.text || "",
          domSelectedPersonVerified: Boolean(attemptDetail.selectedPersonVerified),
          domConversationUserIdVerified: Boolean(conversationUserIdVerified),
          domQueryExpectedUserId: String(row.userId || "").trim(),
          domQueryActualUserId: query.rightUserIdValue || "",
          domQueryFormVerified: Boolean(query.formVerified),
          domQueryResultTerminal: Boolean(query.resultTerminal),
          ...queryLifecycleFields(lastQueryLifecycle),
          relatedRecords,
          matchedByRelatedRecords: relatedRecords > 0,
          conversationClicked: contextResult.conversationClicked,
          recordClicked: contextResult.recordClicked,
          contextOpened: Boolean(
            contextResult.contextOpened
            && attemptDetail.selectedPersonVerified
            && conversationUserIdVerified
            && query.formVerified
            && query.resultTerminal
          ),
          invalidContext: Boolean(
            contextResult.contextOpened
            && (!attemptDetail.selectedPersonVerified || !conversationUserIdVerified || !query.formVerified || !query.resultTerminal)
          ),
          webTimings,
          error
        };
        if (result.contextOpened) {
          webTimings.candidates.push(candidateTiming);
          return result;
        }

        bestFailure = chooseBetterSearchFailure(bestFailure, result);
      }
      if (!attemptDetail.contextOpened && !attemptDetail.failureStage) {
        attemptDetail.failureStage = attemptDetail.relatedRecords > 0 ? "右侧气泡未出现" : "人员/关键词未命中相关记录";
      }
      webTimings.candidates.push(candidateTiming);
    }

    if (bestFailure) {
      Object.assign(bestFailure, commonIdentity);
      bestFailure.candidateTried = Math.max(bestFailure.candidateTried || 0, maxCandidates);
      bestFailure.domPersonCandidates = candidates.length;
      bestFailure.domPersonCandidateTried = Math.max(bestFailure.domPersonCandidateTried || 0, maxCandidates);
      bestFailure.domPersonCandidateTexts = candidateTexts;
      bestFailure.domCandidateSnapshotCount = candidateSnapshot.snapshotCount;
      bestFailure.domCandidateAttemptDetails = candidateAttemptDetails;
      bestFailure.webTimings = webTimings;
      return bestFailure;
    }

    const allCandidatesTemporarilyEmpty = candidateAttemptDetails.length > 0 && candidateAttemptDetails.every((item) =>
      item.personMatchLevel > 0
      && item.selectedPersonVerified
      && item.keywords.length > 0
      && item.keywords.every((keyword) =>
        keyword.formVerified
        && keyword.queryClicked
        && keyword.resultTerminal
        && Number(keyword.relatedRecords || 0) === 0
      )
    );
    const selectedAttempts = candidateAttemptDetails.filter((item) => item.selectedPersonVerified);
    return {
      ...commonIdentity,
      contextText: lastText,
      userBubbleText: "",
      userBubbleMessages: [],
      userBubbleCount: 0,
      candidateTried: maxCandidates,
      personSearchName: personName,
      queryClicked: lastQueryClicked,
      searchKeyword: lastSearchKeyword,
      domSearchKeywordTried: allTriedKeywords,
      domQueryResultChanged: candidateAttemptDetails.some((attempt) =>
        attempt.keywords.some((keyword) => keyword.resultChanged)
      ),
      domRightBubbleVerified: false,
      domPersonCandidates: candidates.length,
      domPersonCandidateTried: maxCandidates,
      domPersonCandidateTexts: candidateTexts,
      domCandidateSnapshotCount: candidateSnapshot.snapshotCount,
      domCandidateAttemptDetails: candidateAttemptDetails,
      domDetectedKeywords: detectedKeywords,
      domCandidateFailureReason: allCandidatesTemporarilyEmpty
        ? `已尝试 ${maxCandidates} 个匹配人员候选，当前均暂未加载出记录；按技术失败处理并加入失败集合重跑`
        : "人员、查询表单或结果终态未完成验证，不能判定为无相关记录",
      domPersonMatchLevel: selectedAttempts.length
        ? Math.min(...selectedAttempts.map((item) => Number(item.personMatchLevel || 0)))
        : 0,
      domPersonIdentityVerified: candidateAttemptDetails.length > 0
        && candidateAttemptDetails.every((item) => item.personMatchLevel > 0),
      domSelectedPersonText: selectedAttempts.map((item) => item.personText).filter(Boolean).join(" | "),
      domSelectedPersonVerified: candidateAttemptDetails.length > 0
        && candidateAttemptDetails.every((item) => item.selectedPersonVerified),
      domConversationUserIdVerified: false,
      domQueryExpectedUserId: String(row.userId || "").trim(),
      domQueryActualUserId: lastQueryActualUserId,
      domQueryFormVerified: candidateAttemptDetails.length > 0 && candidateAttemptDetails.every((item) =>
        item.keywords.length > 0 && item.keywords.every((keyword) => keyword.formVerified)
      ),
      // 候选级“0 条稳定”只用于切换到下一张左侧名片，不能作为整行业务终态。
      // 业务约束是这些输入均应存在记录，因此整行未命中必须进入失败集合重跑。
      domQueryResultTerminal: false,
      ...queryLifecycleFields(lastQueryLifecycle),
      relatedRecords: 0,
      matchedByRelatedRecords: false,
      webTimings,
      invalidContext: true,
      error: allCandidatesTemporarilyEmpty
        ? `所有匹配人员候选暂未加载出记录，可能是页面加载或左侧名片选择问题，已加入失败集合重跑`
        : "人员身份、查询表单或查询结果未刷新到明确终态，不能判定为无相关记录"
    };
  }

  async detectRelatedRecords() {
    return await detectRelatedRecordsFromPage(this.page);
  }

  async waitForRelatedRecords(beforeSignature = "", maxWaitMs = 10000) {
    const startedAt = Date.now();
    let lastCount = 0;
    while (Date.now() - startedAt < maxWaitMs) {
      const count = await this.detectRelatedRecords();
      const signature = await resultAreaSignature(this.page);
      lastCount = Math.max(lastCount, count);
      if (count > 0 && (!beforeSignature || signature !== beforeSignature)) return count;
      await this.page.waitForTimeout(250).catch(() => {});
    }
    return beforeSignature ? 0 : lastCount;
  }

  async runQuery(row, keyword = "", selectedPersonVerified = false) {
    const s = this.selectors;
    // 空关键词表示只按用户 ID 查询，不再回退成整段 K 列消息。
    const searchKeyword = String(keyword ?? "").trim();
    await fillIfVisible(this.page, s.keywordInput, "");
    await fillRightUserIdInput(this.page, "");
    const keywordInputFilled = await fillIfVisible(this.page, s.keywordInput, searchKeyword);
    const keywordValue = await readInputValue(this.page, s.keywordInput);
    if (searchKeyword && (!keywordInputFilled || keywordValue !== searchKeyword)) {
      return {
        clicked: false,
        resultChanged: false,
        searchKeyword,
        keywordInputFilled: false,
        beforeSignature: "",
        error: `关键词输入失败：期望「${searchKeyword}」，实际「${keywordValue}」`
      };
    }
    const expectedUserId = String(row.userId || "").trim();
    let userIdInputFilled = await fillRightUserIdInput(this.page, expectedUserId);
    let actualUserId = await readRightUserIdInput(this.page);
    let formVerified = Boolean(
      selectedPersonVerified
      && userIdInputFilled
      && actualUserId === expectedUserId
      && (!searchKeyword || keywordValue === searchKeyword)
    );
    if (!formVerified) {
      return {
        clicked: false,
        resultChanged: false,
        searchKeyword,
        keywordInputFilled: !searchKeyword || keywordInputFilled,
        beforeSignature: "",
        formVerified: false,
        rightUserIdValue: actualUserId,
        resultTerminal: false,
        error: `查询表单校验失败：人员选中=${selectedPersonVerified}，用户ID期望「${expectedUserId}」实际「${actualUserId}」`
      };
    }
    let beforeSignature = await resultAreaSignature(this.page);
    let validationToastCount = await queryValidationToastCount(this.page);
    const maxWaitMs = Math.max(
      Number(this.ui.queryWaitMs || 10000),
      Number(this.ui.resultWaitMs || 10000)
    );

    const lifecycleObserver = createQueryLifecycleObserver(this.page, {
      expectedUserId,
      keyword: searchKeyword
    });
    let clickCount = 0;
    let clicked = await clickQueryButton(this.page, s.searchButton);
    clickCount += clicked ? 1 : 0;
    if (!clicked) {
      const queryLifecycle = await lifecycleObserver.finish();
      return {
        clicked: false,
        resultChanged: false,
        searchKeyword,
        keywordInputFilled: !searchKeyword || keywordInputFilled,
        beforeSignature,
        formVerified,
        rightUserIdValue: actualUserId,
        resultTerminal: false,
        queryLifecycle,
        error: "查询按钮未能通过DOM点击"
      };
    }

    let completion = await waitForQueryResultAndRelatedRecords(
      this.page,
      beforeSignature,
      expectedUserId,
      maxWaitMs,
      validationToastCount
    );

    // 页面有时显示了用户ID，但组件内部状态仍为空。只有出现新的表单校验提示时，
    // 才重新同步一次输入值并补点一次查询，避免连续点击制造更多竞态。
    if (completion.validationError) {
      userIdInputFilled = await fillRightUserIdInput(this.page, expectedUserId, true);
      actualUserId = await readRightUserIdInput(this.page);
      const keywordRefilled = await fillIfVisible(this.page, s.keywordInput, searchKeyword);
      const retryKeywordValue = await readInputValue(this.page, s.keywordInput);
      formVerified = Boolean(
        selectedPersonVerified
        && userIdInputFilled
        && actualUserId === expectedUserId
        && (!searchKeyword || (keywordRefilled && retryKeywordValue === searchKeyword))
      );
      if (!formVerified) {
        const queryLifecycle = await lifecycleObserver.finish();
        return {
          clicked: true,
          clickCount,
          resultChanged: false,
          searchKeyword,
          keywordInputFilled: !searchKeyword || retryKeywordValue === searchKeyword,
          beforeSignature,
          formVerified: false,
          rightUserIdValue: actualUserId,
          resultTerminal: false,
          queryLifecycle,
          queryValidationError: completion.validationError,
          error: `页面提示用户ID为空，重新同步后仍未通过：期望「${expectedUserId}」实际「${actualUserId}」`
        };
      }

      await this.page.waitForTimeout(600).catch(() => {});
      beforeSignature = await resultAreaSignature(this.page);
      validationToastCount = await queryValidationToastCount(this.page);
      const retryClicked = await clickQueryButton(this.page, s.searchButton);
      clickCount += retryClicked ? 1 : 0;
      if (!retryClicked) {
        const queryLifecycle = await lifecycleObserver.finish();
        return {
          clicked: true,
          clickCount,
          resultChanged: false,
          searchKeyword,
          keywordInputFilled: true,
          beforeSignature,
          formVerified,
          rightUserIdValue: actualUserId,
          resultTerminal: false,
          queryLifecycle,
          queryValidationError: completion.validationError,
          error: "重新同步用户ID后，查询按钮补点失败"
        };
      }
      completion = await waitForQueryResultAndRelatedRecords(
        this.page,
        beforeSignature,
        expectedUserId,
        maxWaitMs,
        validationToastCount
      );
    }

    const queryLifecycle = await lifecycleObserver.finish({
      renderObserved: Boolean(completion.currentUserMatched && completion.relatedRecords > 0)
    });

    return {
      clicked: clickCount > 0,
      clickCount,
      searchKeyword,
      keywordInputFilled: !searchKeyword || keywordInputFilled,
      resultChanged: completion.resultChanged,
      relatedRecords: completion.relatedRecords,
      relatedRecordsWaited: true,
      resultTerminal: Boolean(completion.resultTerminal),
      resultTerminalKind: completion.terminalKind || "",
      currentUserMatched: Boolean(completion.currentUserMatched),
      queryValidationError: completion.validationError || "",
      queryLifecycle,
      formVerified,
      rightUserIdValue: actualUserId,
      beforeSignature,
      error: completion.validationError
        ? `查询仍被页面拦截：${completion.validationError}`
        : ""
    };
  }

  async personCandidates(row, probeTimeoutMs = this.ui.personProbeTimeoutMs) {
    const expectedName = rowPersonName(row);
    const variants = nameVariants(expectedName);
    const cardCandidates = await collectLeftPersonCards(this.page, variants, probeTimeoutMs);
    if (cardCandidates.length) {
      return cardCandidates
        .map((candidate) => ({ ...candidate, ...matchPersonIdentity(expectedName, candidate.text) }))
        .filter((candidate) => candidate.matchLevel > 0)
        .sort((a, b) => a.matchLevel - b.matchLevel || (a._box?.y || 0) - (b._box?.y || 0));
    }

    const candidates = [];
    const seen = new Set();

    const addCandidate = async (locator, fallbackText = "") => {
      if (!(await locator.isVisible({ timeout: probeTimeoutMs }).catch(() => false))) return;
      const box = await locator.boundingBox({ timeout: probeTimeoutMs }).catch(() => null);
      if (!box || box.x > 420 || box.y < 260) return;
      const text = String(
        await locator.innerText({ timeout: probeTimeoutMs }).catch(() => "")
        || await locator.textContent({ timeout: probeTimeoutMs }).catch(() => "")
        || fallbackText
      ).replace(/\s+/g, " ").trim();
      const duplicateNode = candidates.some((item) => {
        const previous = item._box;
        if (!previous) return false;
        const sameRow = Math.abs((previous.y + previous.height / 2) - (box.y + box.height / 2)) < 18;
        const sameText = item.text === text || item.text.includes(text) || text.includes(item.text);
        return sameRow && sameText;
      });
      if (duplicateNode) return;
      const key = `${Math.round(box.x / 8)}:${Math.round(box.y / 8)}:${Math.round(box.height / 8)}:${text.slice(0, 60)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const identity = matchPersonIdentity(expectedName, text || fallbackText);
      if (!identity.matchLevel) return;
      candidates.push({
        text: text || fallbackText,
        _box: box,
        ...identity,
        isSelected: async () => isLocatorSelected(locator),
        click: async () => {
          await locator.scrollIntoViewIfNeeded().catch(() => {});
          return await locator.click({ force: true, timeout: 5000 })
            .then(() => true)
            .catch(() => false);
        }
      });
    };

    for (const variant of variants) {
      const byText = this.page.getByText(variant, { exact: false });
      const count = Math.min(await byText.count().catch(() => 0), 6);
      for (let i = 0; i < count; i += 1) {
        await addCandidate(byText.nth(i), variant);
      }
    }

    if (!candidates.length && this.selectors.personResultItems) {
      const items = this.page.locator(this.selectors.personResultItems);
      const count = Math.min(await items.count().catch(() => 0), 20);
      for (let i = 0; i < count; i += 1) {
        const item = items.nth(i);
        const text = await item.innerText().catch(() => "");
        if (variants.some((variant) => text.includes(variant))) await addCandidate(item, text);
      }
    }

    return candidates.sort((a, b) => a.matchLevel - b.matchLevel || (a._box?.y || 0) - (b._box?.y || 0));
  }

  async waitForStablePersonCandidates(row, resetInfo = {}, deadline = null) {
    const maxWaitMs = Number(this.ui.personCandidateWaitMs || 8000);
    const startedAt = Date.now();
    const effectiveDeadline = deadline ? Math.min(startedAt + maxWaitMs, deadline) : startedAt + maxWaitMs;
    const expectedName = rowPersonName(row);
    const beforeSignature = String(resetInfo.personListBeforeSignature || "");
    const clearedSignature = String(resetInfo.personListClearedSignature || "");
    let accepted = [];
    let lastSignature = "";
    let stableHits = 0;
    let snapshotCount = 0;
    let afterSignature = "";
    let refreshed = false;

    while (Date.now() < effectiveDeadline) {
      const remaining = Math.max(1, Math.min(this.ui.personProbeTimeoutMs, effectiveDeadline - Date.now()));
      const current = await this.personCandidates(row, remaining);
      afterSignature = await leftPersonListSignature(this.page, remaining);
      snapshotCount += 1;
      const signature = current.map((item) => item.text || "").join("|");
      if (current.length && signature && signature === lastSignature) {
        stableHits += 1;
      } else {
        stableHits = current.length ? 1 : 0;
      }
      lastSignature = signature;
      refreshed = Boolean(
        afterSignature
        && (
          !beforeSignature
          || afterSignature !== beforeSignature
          || (resetInfo.personListCleared && afterSignature !== clearedSignature)
        )
      );
      if (isStablePersonSnapshot({
        beforeSignature,
        afterSignature,
        clearedSignature,
        personListCleared: Boolean(resetInfo.personListCleared),
        expectedName,
        candidates: current,
        stableHits
      })) {
        accepted = current;
        break;
      }
      await this.page.waitForTimeout(Math.min(220, Math.max(0, effectiveDeadline - Date.now()))).catch(() => {});
    }

    const identityStable = Boolean(
      accepted.length
      && accepted.every((item) => matchPersonIdentity(expectedName, item.text || "").matchLevel > 0)
      && stableHits >= 3
    );
    return {
      candidates: accepted,
      snapshotCount,
      beforeSignature,
      afterSignature,
      refreshed: Boolean((refreshed || identityStable) && accepted.length && stableHits >= 3),
      signatureChanged: Boolean(refreshed),
      identityStable,
      stableHits
    };
  }

  async collectBestResultText(row, searchKeyword = "") {
    const keyword = String(searchKeyword || "").trim();
    let conversationClicked = false;
    let recordClicked = false;
    let text = "";
    let middleText = "";
    let rightText = "";
    let userBubbleText = "";
    let userBubbleMessages = [];

    const conversationCardCount = await countConversationCards(this.page, row.userId);
    // 不把“只有1条会话”强行重复点击3次。一次点击失败后交给中间记录
    // 穷举逻辑处理，避免页面停在同一张左侧卡片上反复触发。
    const maxConversationAttempts = Math.max(1, Math.min(conversationCardCount || 1, 8));
    // 同一人员/关键词下的所有会话卡片和中间记录共享一个总预算。
    // 预算若放在循环内部，8 张会话卡会把 35 秒放大成近 5 分钟。
    const rightOpenBudget = createRightOpenBudget(this.ui);

    for (let attempt = 1; attempt <= maxConversationAttempts; attempt += 1) {
      if (rightOpenBudgetExpired(rightOpenBudget)) break;
      let middleOpened = false;
      // 查询完成后页面经常已经自动选中会话卡片，并把相关记录加载到中间栏。
      // 此时再次点击已选中的卡片不会产生状态变化，不能据此判定“会话未打开”。
      // 先验证现有中间栏；只要有正数记录和真实时间戳，就直接进入记录点击。
      const existingPanel = await inspectMiddleRecordPanel(this.page, keyword);
      if (existingPanel.opened) {
        const existingMiddleText = await collectMiddleRecordText(this.page);
        middleText = `${existingPanel.headerText || "学员相关记录"}\n${existingPanel.recordText || existingMiddleText || ""}`.trim();
        middleOpened = true;
      }
      // 页面把点击事件绑定在完整会话卡片上，内部“X条相关记录”文字节点本身
      // 没有点击处理。最多尝试两个不同层级的卡片容器，每次点击后都以中间栏
      // 真实出现记录为准，避免“locator.click 成功但页面没有动作”的假成功。
      for (let variant = 0; variant < 2 && !middleOpened; variant += 1) {
        const conversationAttempt = await clickConversationCard(this.page, row, attempt - 1, variant);
        if (!conversationAttempt.clicked) continue;
        const middleWaitMs = Math.min(
          Number(this.ui.middleWaitMs || 5000),
          Math.max(0, rightOpenBudget.deadline - Date.now())
        );
        middleText = middleWaitMs > 0
          ? await waitForMiddleRecordList(this.page, keyword, middleWaitMs)
          : "";
        middleOpened = isMeaningfulMiddleRecordText(middleText, keyword);
        if (!middleOpened) {
          const panelState = await inspectMiddleRecordPanel(this.page, keyword);
          if (panelState.opened) {
            const currentMiddleText = await collectMiddleRecordText(this.page);
            middleText = `${panelState.headerText || "学员相关记录"}\n${panelState.recordText || currentMiddleText || ""}`.trim();
            middleOpened = true;
          }
        }
        if (!middleOpened && variant === 0) {
          await this.page.waitForTimeout(1000).catch(() => {});
        }
      }
      conversationClicked = middleOpened || conversationClicked;
      await this.debugStep(row, `attempt-${attempt}-after-conversation-click`);

      if (!middleOpened) {
        // 中间栏仍为空时不允许进入记录点击兜底，否则可能在空白区域或旧结果上
        // 产生点击，并把其他页面文本误判成当前会话上下文。
        continue;
      }

      // 同一个关键词的所有中间记录点击共享总预算。过去每个候选都各自等待
      // 10 秒，候选较多时单行可能卡住数分钟；总预算到期后应切换人员，而
      // 不是继续在同一屏反复试点。
      const recordOpenResult = await openRightContextFromMiddleRecords(this.page, row, keyword, this.ui, rightOpenBudget);
      const recordAttempt = Boolean(recordOpenResult.clicked);
      rightText = recordOpenResult.text || "";
      const userBubbles = rightText ? await collectRightSideUserBubbles(this.page) : { text: "", messages: [] };
      userBubbleText = userBubbles.text || userBubbleText;
      userBubbleMessages = userBubbles.messages?.length ? userBubbles.messages : userBubbleMessages;
      recordClicked = recordAttempt || recordClicked;

      if (!rightText) {
        const fallback = await openRightContextFallback(this.page, keyword, this.ui, rightOpenBudget);
        rightText = fallback.text || "";
        const fallbackBubbles = rightText ? await collectRightSideUserBubbles(this.page) : { text: "", messages: [] };
        userBubbleText = fallbackBubbles.text || userBubbleText;
        userBubbleMessages = fallbackBubbles.messages?.length ? fallbackBubbles.messages : userBubbleMessages;
        recordClicked = Boolean(fallback.clicked || rightText) || recordClicked;
      }

      await this.debugStep(row, `attempt-${attempt}-after-record-click`);

      text = rightText || text;
      if (rightText) {
        return {
          text: rightText,
          userBubbleText,
          userBubbleMessages,
          userBubbleCount: userBubbleMessages.length,
          conversationClicked,
          recordClicked,
          contextOpened: true,
          middleText,
          conversationCardCount,
          openMethod: recordOpenResult.method || "right-context-opened",
          failureStage: ""
        };
      }

      if (!recordAttempt) await this.page.waitForTimeout(300);
    }

    return {
      text: text || rightText || middleText,
      userBubbleText,
      userBubbleMessages,
      userBubbleCount: userBubbleMessages.length,
      conversationClicked,
      recordClicked,
      contextOpened: false,
      middleText,
      conversationCardCount,
      openMethod: "",
      failureStage: rightOpenBudgetExpired(rightOpenBudget)
        ? `右侧上下文打开总预算耗尽(${rightOpenBudget.maxMs}ms)`
        : (!conversationClicked ? "会话卡片未打开" : (!recordClicked ? "中间记录未打开" : "右侧气泡未出现"))
    };
  }

  async expandRightContext(row, currentContext = {}, options = {}) {
    const beforeScreens = Math.max(0, Number(options.beforeScreens ?? 2));
    const afterScreens = Math.max(0, Number(options.afterScreens ?? 2));
    if (!currentContext.contextOpened) {
      return {
        ...currentContext,
        contextExpanded: false,
        contextExpandError: "右侧上下文未打开，不能扩展"
      };
    }

    const keyword = currentContext.searchKeyword || buildSearchKeywords(row.message, this.keywordMaxLength)[0] || "";
    const expanded = await expandRightSideContext(this.page, {
      keyword,
      beforeScreens,
      afterScreens,
      stableMs: this.ui.rightStableMs
    });

    if (!expanded.expanded) {
      return {
        ...currentContext,
        contextExpanded: false,
        contextExpandError: expanded.error || "未能定位右侧聊天滚动容器"
      };
    }

    const mergedText = mergeTextBlocks([expanded.contextText, currentContext.contextText]);
    const mergedUserMessages = mergeMessageLists(expanded.userBubbleMessages, currentContext.userBubbleMessages);
    const mergedUserText = mergedUserMessages.join("\n") || mergeTextBlocks([expanded.userBubbleText, currentContext.userBubbleText]);
    return {
      ...currentContext,
      contextText: mergedText,
      userBubbleText: mergedUserText,
      userBubbleMessages: mergedUserMessages,
      userBubbleCount: mergedUserMessages.length,
      contextOpened: Boolean(mergedText),
      contextExpanded: true,
      contextExpandBeforeScreens: beforeScreens,
      contextExpandAfterScreens: afterScreens,
      contextExpandedLineCount: contextLineCount(mergedText),
      contextExpandedUserBubbleCount: mergedUserMessages.length,
      contextExpandedTextLength: mergedText.length,
      contextExpandSamples: expanded.samples,
      domRightBubbleVerified: Boolean(mergedText)
    };
  }

  async close() {
    await this.context.close();
  }

  async abortCurrentPage() {
    const page = this.page;
    if (page && !page.isClosed?.()) {
      await page.close().catch(() => {});
    }
  }

  async recoverPage(signal) {
    const result = await recoverQichatPage({
      context: this.context,
      currentPage: this.page,
      url: this.config.browser?.url,
      timeoutMs: this.config.browser?.timeoutMs || 30000,
      signal,
      isReady: async (page) => await this.isQueryPageReady(page)
    });
    if (result.ok && !signal?.aborted) this.page = result.page;
    return result;
  }

  async debugStep(row, label) {
    if (!this.debug.enabled) return;
    const dir = path.resolve(this.debug.dir || "debug", `row-${row.rowNumber}`);
    fs.mkdirSync(dir, { recursive: true });
    const safeLabel = label.replace(/[^a-z0-9_.-]+/gi, "-");
    await this.page.screenshot({ path: path.join(dir, `${safeLabel}.png`), fullPage: false }).catch(() => {});
    const text = await this.page.locator("body").innerText().catch(() => "");
    fs.writeFileSync(path.join(dir, `${safeLabel}.txt`), text.slice(0, 20000), "utf8");
    const middleText = await collectMiddleRecordText(this.page);
    const rightText = await collectRightSideVisibleText(this.page);
    const userBubbles = await collectRightSideUserBubbles(this.page);
    fs.writeFileSync(path.join(dir, `${safeLabel}.middle.txt`), middleText.slice(0, 12000), "utf8");
    fs.writeFileSync(path.join(dir, `${safeLabel}.right.txt`), rightText.slice(0, 12000), "utf8");
    fs.writeFileSync(path.join(dir, `${safeLabel}.right-user-bubbles.txt`), userBubbles.text.slice(0, 12000), "utf8");
  }
}

async function fillIfVisible(page, selector, value, timeoutMs = 1500) {
  if (!selector) return false;
  const locator = page.locator(selector).first();
  // Locator.count() 没有 timeout 参数；传入对象会在部分 Playwright 版本
  // 直接抛错，随后被当成“输入框不存在”，导致关键词/用户ID流程反复重试。
  if (!(await locator.count().catch(() => 0))) return false;
  return await locator.fill(String(value ?? ""), { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

async function isLocatorVisible(page, selector) {
  if (!selector) return false;
  return await page.locator(selector).first().isVisible({ timeout: 1000 }).catch(() => false);
}

async function readInputValue(page, selector, timeoutMs = 1500) {
  if (!selector) return "";
  const locator = page.locator(selector).first();
  if (!(await locator.count().catch(() => 0))) return "";
  return await locator.inputValue({ timeout: timeoutMs }).catch(() => "");
}

async function markRightUserIdInput(page) {
  return await page.evaluate(() => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const inputs = [...document.querySelectorAll("input")]
      .map((input) => ({ input, rect: input.getBoundingClientRect() }))
      .filter(({ input, rect }) => {
        const placeholder = input.getAttribute("placeholder") || "";
        if (!placeholder.includes("请输入")) return false;
        if (rect.left < width * 0.62 || rect.top > 180) return false;
        if (input.readOnly || input.disabled) return false;
        return rect.width > 60 && rect.height > 20;
      })
      .sort((a, b) => a.rect.left - b.rect.left);
    const target = inputs[0]?.input;
    if (!target) return "";
    const marker = `qlchat-right-user-id-${Date.now()}`;
    target.setAttribute("data-qlchat-right-user-id", marker);
    return marker;
  }).catch(() => "");
}

async function fillRightUserIdInput(page, value, keyboardFallback = false) {
  if (value === undefined || value === null) return false;
  const nextValue = String(value ?? "");
  const marker = await markRightUserIdInput(page);
  if (!marker) return false;
  const locator = page.locator(`[data-qlchat-right-user-id="${marker}"]`).first();
  if (!(await locator.count().catch(() => 0))) return false;

  await locator.click({ timeout: 3000 }).catch(() => {});
  let filled = await locator.fill(nextValue, { timeout: 4000 }).then(() => true).catch(() => false);
  await locator.evaluate((input, inputValue) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, inputValue);
    else input.value = inputValue;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: inputValue }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  }, nextValue).catch(() => {});
  await page.waitForTimeout(180).catch(() => {});

  let actual = await locator.inputValue().catch(() => "");
  if (keyboardFallback || actual !== nextValue) {
    await locator.click({ timeout: 3000 }).catch(() => {});
    await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await locator.press("Backspace").catch(() => {});
    if (nextValue) await locator.pressSequentially(nextValue, { delay: 25 }).catch(() => {});
    await locator.press("Tab").catch(() => {});
    await page.waitForTimeout(220).catch(() => {});
    actual = await locator.inputValue().catch(() => "");
    filled = actual === nextValue;
  }
  return Boolean(filled && actual === nextValue);
}

async function readRightUserIdInput(page) {
  return await page.evaluate(() => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const inputs = [...document.querySelectorAll("input")]
      .map((input) => ({ input, rect: input.getBoundingClientRect() }))
      .filter(({ input, rect }) => {
        const placeholder = input.getAttribute("placeholder") || "";
        return placeholder.includes("请输入")
          && rect.left >= width * 0.62
          && rect.top <= 180
          && rect.width > 60
          && rect.height > 20
          && !input.disabled;
      })
      .sort((a, b) => a.rect.left - b.rect.left);
    return String(inputs[0]?.input?.value || "").trim();
  }).catch(() => "");
}

async function clickQueryButton(page, configuredSelector) {
  const candidates = [
    configuredSelector,
    "button:has-text('查询')",
    "xpath=//button[.//*[normalize-space()='查询'] or normalize-space()='查询']",
    "xpath=//*[self::button or @role='button'][contains(normalize-space(.), '查询')]"
  ].filter(Boolean);

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (!(await locator.count().catch(() => 0))) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const clicked = await locator.click({ force: true, timeout: 5000 }).then(() => true).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

async function clickResetButton(page, configuredSelector) {
  const candidates = [
    configuredSelector,
    "button:has-text('重置')",
    "xpath=//button[.//*[normalize-space()='重置'] or normalize-space()='重置']",
    "xpath=//*[self::button or @role='button'][contains(normalize-space(.), '重置')]"
  ].filter(Boolean);

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (!(await locator.count().catch(() => 0))) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    const box = await locator.boundingBox().catch(() => null);
    if (box && (box.y < 120 || box.y > 380)) continue;
    await locator.click({ force: true, timeout: 2500 }).catch(async () => {
      const handle = await locator.elementHandle().catch(() => null);
      if (handle) await page.evaluate((el) => el.click(), handle).catch(() => {});
    });
    return true;
  }

  const point = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button, [role='button'], span, div")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, "").trim();
        const style = window.getComputedStyle(el);
        return { el, rect, text, style };
      })
      .filter(({ rect, text, style }) => {
        if (text !== "重置") return false;
        if (rect.width < 24 || rect.height < 18) return false;
        if (rect.top < 120 || rect.top > 380) return false;
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
        return true;
      })
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const target = buttons[0];
    if (!target) return null;
    return { x: target.rect.left + target.rect.width / 2, y: target.rect.top + target.rect.height / 2 };
  }).catch(() => null);
  if (!point) return false;
  await page.mouse.click(point.x, point.y).catch(() => {});
  return true;
}

async function clickQueryButtonByCoordinate(page) {
  const point = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button, [role='button']")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, "").trim();
        const style = window.getComputedStyle(el);
        return { el, rect, text, style };
      })
      .filter(({ rect, text, style }) => {
        if (text !== "查询") return false;
        if (rect.width < 30 || rect.height < 20) return false;
        if (rect.top < 120 || rect.top > 360) return false;
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
        return true;
      })
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const target = buttons[0];
    if (!target) return null;
    return { x: target.rect.left + target.rect.width / 2, y: target.rect.top + target.rect.height / 2 };
  }).catch(() => null);

  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  return true;
}

async function waitForQueryResultChange(page, beforeSignature, maxWaitMs = 2500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const related = await detectRelatedRecordsFromPage(page);
    const signature = await resultAreaSignature(page);
    if (related > 0 && (!beforeSignature || signature !== beforeSignature)) return true;
    if (signature && signature !== beforeSignature && !/暂无会话|暂无消息/.test(signature)) return true;
    await page.waitForTimeout(180);
  }
  return false;
}

async function queryValidationToastCount(page) {
  return await page.evaluate(() => {
    const pattern = /期数和用户ID不能同时为空/;
    return [...document.body.querySelectorAll("div, span, p")].filter((node) => {
      const text = (node.innerText || node.textContent || "").replace(/\s+/g, "").trim();
      if (!pattern.test(text)) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 20
        && rect.height > 10
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity) !== 0;
    }).length;
  }).catch(() => 0);
}

async function inspectQueryResultState(page, expectedUserId = "") {
  const expected = String(expectedUserId || "").trim();
  const [signature, cardState] = await Promise.all([
    resultAreaSignature(page),
    page.evaluate((userId) => {
      const width = window.innerWidth || document.documentElement.clientWidth;
      const height = window.innerHeight || document.documentElement.clientHeight;
      const cards = [];
      const seen = new Set();
      for (const node of document.body.querySelectorAll("div, li, tr, section, article")) {
        const rect = node.getBoundingClientRect();
        const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || !/条相关记录/.test(text)) continue;
        if (rect.width < 120 || rect.height < 32 || rect.height > 220) continue;
        if (rect.left < width * 0.16 || rect.right > width * 0.53) continue;
        if (rect.top < 220 || rect.bottom > height + 120) continue;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
        const key = `${Math.round(rect.left / 8)}:${Math.round(rect.top / 8)}:${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const counts = [...text.matchAll(/(\d+)\s*条相关记录/g)].map((match) => Number(match[1]));
        cards.push({ text, count: counts.length ? Math.max(...counts) : 0 });
      }
      const matching = userId ? cards.filter((card) => card.text.includes(userId)) : cards;
      return {
        currentUserMatched: Boolean(userId && matching.length),
        relatedRecords: matching.length ? Math.max(...matching.map((card) => card.count)) : 0,
        visibleCardCount: cards.length
      };
    }, expected).catch(() => ({ currentUserMatched: false, relatedRecords: 0, visibleCardCount: 0 }))
  ]);
  return {
    signature,
    ...cardState,
    explicitEmpty: isTerminalEmptyResultSignature(signature)
  };
}

export function decideQueryResultTerminal({
  elapsedMs = 0,
  currentUserMatched = false,
  relatedRecords = 0,
  explicitEmpty = false,
  emptyStableHits = 0,
  resultChanged = false,
  validationError = false
} = {}) {
  if (validationError) return { terminal: false, kind: "validation-error" };
  if (currentUserMatched && relatedRecords > 0) return { terminal: true, kind: "current-user-records" };
  // 页面短暂显示 0 条很常见。连续观察至少 6 秒后，0 条也只表示当前
  // 左侧人员候选暂时失败，用于切换下一候选；不能表示整行业务上无记录。
  if (explicitEmpty && resultChanged && elapsedMs >= 6000 && emptyStableHits >= 5) {
    return { terminal: true, kind: "candidate-empty" };
  }
  return { terminal: false, kind: resultChanged ? "refreshing" : "unchanged" };
}

async function waitForQueryResultAndRelatedRecords(
  page,
  beforeSignature,
  expectedUserId,
  maxWaitMs = 10000,
  beforeValidationToastCount = 0
) {
  const startedAt = Date.now();
  let lastSignature = beforeSignature || "";
  let lastCount = 0;
  let emptyStableHits = 0;
  let previousEmptySignature = "";

  while (Date.now() - startedAt < maxWaitMs) {
    const state = await inspectQueryResultState(page, expectedUserId);
    const signature = state.signature;
    const changed = Boolean(signature && (!beforeSignature || signature !== beforeSignature));
    const validationToastCount = await queryValidationToastCount(page);
    const validationError = validationToastCount > beforeValidationToastCount;
    if (validationError) {
      return {
        resultChanged: changed,
        relatedRecords: 0,
        resultTerminal: false,
        currentUserMatched: false,
        validationError: "期数和用户ID不能同时为空"
      };
    }

    lastSignature = signature || lastSignature;
    lastCount = Math.max(lastCount, state.relatedRecords || 0);
    if (state.explicitEmpty) {
      emptyStableHits = signature === previousEmptySignature ? emptyStableHits + 1 : 1;
      previousEmptySignature = signature;
    } else {
      emptyStableHits = 0;
      previousEmptySignature = "";
    }

    const decision = decideQueryResultTerminal({
      elapsedMs: Date.now() - startedAt,
      currentUserMatched: state.currentUserMatched,
      relatedRecords: state.relatedRecords,
      explicitEmpty: state.explicitEmpty,
      emptyStableHits,
      resultChanged: changed
    });
    if (decision.terminal) {
      return {
        resultChanged: changed || state.currentUserMatched,
        relatedRecords: state.relatedRecords,
        resultTerminal: true,
        currentUserMatched: state.currentUserMatched,
        terminalKind: decision.kind,
        validationError: ""
      };
    }
    await page.waitForTimeout(200).catch(() => {});
  }

  return {
    resultChanged: Boolean(lastSignature && (!beforeSignature || lastSignature !== beforeSignature)),
    relatedRecords: lastCount,
    resultTerminal: false,
    currentUserMatched: false,
    validationError: ""
  };
}

export function isTerminalEmptyResultSignature(signature) {
  const text = String(signature || "")
    .replace(/\d+:/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /共\s*0\s*(?:个)?\s*私聊会话|暂无会话|没有相关记录|未查询到|0\s*条相关记录/.test(text);
}

async function detectRelatedRecordsFromPage(page) {
  return await page.evaluate(() => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const counts = [];
    const seen = new Set();
    const nodes = [...document.body.querySelectorAll("div, li, tr, section, article, span, p")];

    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 8) continue;
      if (rect.left < width * 0.16 || rect.right > width * 0.76) continue;
      if (rect.top < 230 || rect.top > height + 120) continue;

      const style = window.getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;

      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || !/条相关记录/.test(text) || seen.has(text)) continue;
      seen.add(text);

      for (const match of text.matchAll(/(\d+)\s*条相关记录/g)) {
        counts.push(Number(match[1]));
      }
    }

    return counts.length ? Math.max(...counts) : 0;
  }).catch(() => 0);
}

async function resultAreaSignature(page) {
  return await page.evaluate(() => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const nodes = [...document.body.querySelectorAll("div, li, section, article, span, p")];
    const lines = [];
    const seen = new Set();
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 8) continue;
      if (rect.left < width * 0.18 || rect.right > width * 0.75) continue;
      if (rect.top < 240 || rect.top > height) continue;
      const style = window.getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 2 || text.length > 500) continue;
      if (/请选择|查询|重置|按记录数排序/.test(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      lines.push(`${Math.round(rect.top)}:${text}`);
      if (lines.length >= 12) break;
    }
    return lines.join("|");
  }).catch(() => "");
}

function fuzzyIncludes(text, message) {
  const t = compact(text);
  const m = compact(message);
  if (!m) return false;
  if (t.includes(m)) return true;
  const sample = m.slice(0, Math.min(30, m.length));
  return sample.length >= 8 && t.includes(sample);
}

function rowPersonName(row = {}) {
  // I 列是接收人名称，但模板合并时 I 列可能为空；H 列老师企微名称才是左侧人员搜索的可靠兜底。
  return String(
    row.receiverName || row.teacherName || row.senderName || ""
  ).trim();
}

function nameVariants(name) {
  const raw = personDisplayName(name);
  const variants = new Set([raw]);
  for (const alias of personNameAliases(raw)) variants.add(alias);
  return [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
}

function personDisplayName(value) {
  return String(value || "")
    .split(/\s*@/)[0]
    .replace(/\s+/g, "")
    .replace(/[()（）\[\]【】]/g, "")
    .trim();
}

function stripPersonRoleSuffix(value) {
  return String(value || "")
    .replace(/(?:老师|助教|导师|指导|班主任|教练|顾问|修缘)+\d*$/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function personNameAliases(value) {
  const display = personDisplayName(value);
  const aliases = new Set();
  const add = (item) => {
    const cleaned = stripPersonRoleSuffix(item);
    if (cleaned.length >= 2) aliases.add(cleaned);
  };
  add(display);
  for (const part of display.split(/[-–—_·|/]+/)) add(part);
  return [...aliases];
}

export function matchPersonIdentity(expected, actual) {
  const expectedDisplay = personDisplayName(expected);
  const actualDisplay = personDisplayName(actual);
  if (!expectedDisplay || !actualDisplay) {
    return { matchLevel: 0, matchReason: "姓名为空" };
  }
  if (expectedDisplay === actualDisplay) {
    return { matchLevel: 1, matchReason: "标准化姓名完全一致" };
  }

  const expectedAliases = personNameAliases(expectedDisplay);
  const actualAliases = personNameAliases(actualDisplay);
  const exactAlias = expectedAliases.find((left) => actualAliases.includes(left));
  if (exactAlias) {
    return { matchLevel: 2, matchReason: `去除角色后缀后完全一致：${exactAlias}` };
  }

  for (const left of expectedAliases) {
    for (const right of actualAliases) {
      const shorter = left.length <= right.length ? left : right;
      const longer = left.length > right.length ? left : right;
      const prefixRelated = longer.startsWith(shorter);
      const ratio = shorter.length / Math.max(longer.length, 1);
      if (prefixRelated && shorter.length >= 2 && ratio >= 0.6 && (shorter.length >= 3 || longer.length - shorter.length <= 1)) {
        return { matchLevel: 3, matchReason: `核心姓名前缀匹配：${left}/${right}` };
      }
    }
  }
  return { matchLevel: 0, matchReason: `候选姓名与当前行无关：${actualDisplay}` };
}

export function isStablePersonSnapshot({
  beforeSignature = "",
  afterSignature = "",
  clearedSignature = "",
  personListCleared = false,
  expectedName = "",
  candidates = [],
  stableHits = 0
} = {}) {
  const refreshed = Boolean(
    afterSignature
    && (
      !beforeSignature
      || afterSignature !== beforeSignature
      || (personListCleared && afterSignature !== clearedSignature)
    )
  );
  const identityStable = Boolean(
    expectedName
    && candidates.length > 0
    && candidates.every((item) => matchPersonIdentity(expectedName, item?.text || "").matchLevel > 0)
  );
  return (refreshed || identityStable) && candidates.length > 0 && stableHits >= 3;
}

async function leftPersonListSignature(page, timeoutMs = 1200) {
  const evaluation = page.evaluate(() => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const maxRight = Math.min(460, width * 0.3);
    const rows = [...document.querySelectorAll("div, li, section, article")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        const style = window.getComputedStyle(el);
        const hasAvatar = [...el.querySelectorAll("img")].some((img) => {
          const imageRect = img.getBoundingClientRect();
          return imageRect.width >= 24 && imageRect.height >= 24;
        });
        return { rect, text, style, hasAvatar };
      })
      .filter(({ rect, text, style, hasAvatar }) => {
        if (!text || text.length > 220) return false;
        if (rect.left < 0 || rect.right > maxRight || rect.top < 220 || rect.top > height + 80) return false;
        if (rect.height < 44 || rect.height > 150 || rect.width < 60) return false;
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
        if (/请选择|请输入|用户ID|部门|账号归属人|展示已离职账号|聊天内容|关键词|查询|重置/.test(text)) return false;
        return /@/.test(text) || hasAvatar;
      })
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const unique = [];
    for (const row of rows) {
      if (unique.some((item) => Math.abs(item.rect.top - row.rect.top) < 16)) continue;
      unique.push(row);
      if (unique.length >= 12) break;
    }
    return unique.map((item) => `${Math.round(item.rect.top)}:${item.text}`).join("|");
  }).catch(() => "");
  return await Promise.race([
    evaluation,
    new Promise((resolve) => setTimeout(() => resolve(""), Math.max(50, timeoutMs)))
  ]);
}

async function conversationListSignature(page) {
  return await page.evaluate(() => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    return [...document.querySelectorAll("div, li, section, article")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return { rect, text };
      })
      .filter(({ rect, text }) => text
        && rect.left >= width * 0.16
        && rect.right <= width * 0.52
        && rect.top >= 220
        && rect.top <= height
        && /条相关记录|ID[:：]|暂无会话|0\s*个私聊会话|共\s*0\s*个私聊会话/.test(text))
      .sort((a, b) => a.rect.top - b.rect.top)
      .slice(0, 8)
      .map((item) => `${Math.round(item.rect.top)}:${item.text}`)
      .join("|");
  }).catch(() => "");
}

async function isLocatorSelected(locator) {
  return await locator.evaluate((el) => {
    let current = el;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      const classText = String(current.className || "");
      const ariaSelected = current.getAttribute("aria-selected");
      const style = window.getComputedStyle(current);
      const background = style.backgroundColor || "";
      const rightBorderColor = style.borderRightColor || "";
      const rightBorderWidth = Number.parseFloat(style.borderRightWidth || "0") || 0;
      if (ariaSelected === "true" || /active|selected|current/i.test(classText)) return true;
      if (/rgb\(32,\s*145,\s*?\d+\)|rgb\(64,\s*158,\s*255\)|rgb\(230,\s*247,\s*255\)|#409eff/i.test(background)) return true;
      if (rightBorderWidth >= 2 && /rgb\((?:24|32|64),\s*(?:144|145|158),\s*(?:255|\d+)\)|#409eff/i.test(rightBorderColor)) return true;
    }
    return false;
  }).catch(() => false);
}

async function waitForSelectedPerson(page, candidate, beforeConversationSignature = "", maxWaitMs = 4000) {
  void beforeConversationSignature;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const selected = Boolean(candidate?.isSelected && await candidate.isSelected().catch(() => false));
    if (selected) return true;
    await page.waitForTimeout(180).catch(() => {});
  }
  return false;
}

async function waitForConversationUserId(page, userId, maxWaitMs = 3000) {
  const expected = String(userId || "").trim();
  if (!expected) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const matched = await page.evaluate((target) => {
      const width = window.innerWidth || document.documentElement.clientWidth;
      const height = window.innerHeight || document.documentElement.clientHeight;
      return [...document.querySelectorAll("div, li, section, article")].some((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return rect.left >= width * 0.16
          && rect.right <= width * 0.54
          && rect.top >= 220
          && rect.top <= height
          && /条相关记录|ID[:：]/.test(text)
          && text.includes(target);
      });
    }, expected).catch(() => false);
    if (matched) return true;
    await page.waitForTimeout(180).catch(() => {});
  }
  return false;
}

async function collectLeftPersonCards(page, variants, timeoutMs = 1200) {
  const evaluation = page.evaluate((names) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const maxRight = Math.min(460, width * 0.3);
    const minTop = 220;
    const candidates = [];
    const seen = new Set();
    let markerCounter = 0;

    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const matchesName = (text) => names.some((name) => name && text.includes(name));
    const controlPattern = /请选择|请输入|用户ID|部门|账号归属人|展示已离职账号|私聊记录|群聊记录|聊天内容|关键词|查询|重置/;
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 60
        && rect.height > 36
        && rect.left >= 0
        && rect.right <= maxRight
        && rect.top >= minTop
        && rect.top <= height + 80
        && style.visibility !== "hidden"
        && style.display !== "none"
        && Number(style.opacity) !== 0;
    };
    const scoreCard = (text, rect) => {
      let score = 0;
      for (const name of names) {
        if (!name) continue;
        if (text.includes(name)) score += Math.min(name.length, 8) * 5;
      }
      if (/@/.test(text)) score += 15;
      if (matchesName(text)) score += 10;
      if (controlPattern.test(text)) score -= 100;
      if (rect.height >= 56 && rect.height <= 130) score += 8;
      if (rect.left < 30) score += 3;
      return score;
    };
    const cardRootFrom = (node) => {
      let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      let best = null;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        if (!isVisible(current)) continue;
        const rect = current.getBoundingClientRect();
        const text = normalize(current.innerText || current.textContent || "");
        if (!text || text.length < 2 || text.length > 260) continue;
        if (controlPattern.test(text)) continue;
        if (!/@/.test(text) && !matchesName(text)) continue;
        if (rect.height < 44 || rect.height > 150) continue;
        best = { el: current, text, rect };
      }
      return best;
    };
    const pushCard = (card, scoreOffset = 0) => {
      if (!card) return;
      const { el, text, rect } = card;
      const key = `${Math.round(rect.top / 8) * 8}:${Math.round(rect.left / 8) * 8}:${text.slice(0, 60)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const marker = `qlchat-person-${markerCounter++}`;
      el.setAttribute("data-qlchat-person-candidate", marker);
      candidates.push({
        marker,
        text,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        x: rect.left + Math.min(Math.max(rect.width * 0.42, 40), rect.width - 12),
        y: rect.top + Math.min(Math.max(rect.height * 0.5, 20), rect.height - 12),
        score: scoreCard(text, rect) + scoreOffset,
        hasNameMatch: matchesName(text),
        hasAt: /@/.test(text),
        tag: el.tagName
      });
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent) continue;
      const marker = normalize(node.nodeValue || "");
      if (!marker || marker.length > 120) continue;
      if (!/@/.test(marker) && !matchesName(marker)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()];
      range.detach();
      if (!rects.some((rect) => rect.left >= 0 && rect.right <= maxRight && rect.top >= minTop && rect.top <= height + 80)) continue;
      pushCard(cardRootFrom(node));
    }

    const nodes = [...document.body.querySelectorAll("div, li, section, article, a, button")];
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const rect = node.getBoundingClientRect();
      const text = normalize(node.innerText || node.textContent || "");
      if (!text || text.length < 2 || text.length > 260) continue;
      if (controlPattern.test(text)) continue;
      if (!/@/.test(text) && !matchesName(text)) continue;
      if (rect.height < 44 || rect.height > 150) continue;
      pushCard({ el: node, text, rect }, /@/.test(text) ? 0 : -10);
    }

    if (candidates.length <= 1) {
      const leftNodes = [...document.body.querySelectorAll("div, li")];
      for (const node of leftNodes) {
        if (!isVisible(node)) continue;
        const rect = node.getBoundingClientRect();
        const text = normalize(node.innerText || node.textContent || "");
        if (!text || text.length < 2 || text.length > 260) continue;
        if (controlPattern.test(text)) continue;
        const hasAvatar = [...node.querySelectorAll("img")].some((img) => {
          const imgRect = img.getBoundingClientRect();
          return imgRect.width >= 24 && imgRect.height >= 24 && imgRect.left >= 0 && imgRect.right <= maxRight;
        });
        if (!hasAvatar && !/@/.test(text) && !matchesName(text)) continue;
        if (rect.height < 44 || rect.height > 150) continue;
        pushCard({ el: node, text, rect }, hasAvatar ? -3 : -12);
      }
    }

    candidates.sort((a, b) => {
      const aName = a.hasNameMatch ? 0 : 1;
      const bName = b.hasNameMatch ? 0 : 1;
      if (aName !== bName) return aName - bName;
      return a.top - b.top || a.left - b.left;
    });

    const result = [];
    const occupied = [];
    for (const item of candidates) {
      const duplicate = occupied.some((rect) => Math.abs(rect.top - item.top) < 16 && Math.abs(rect.left - item.left) < 16);
      if (duplicate) continue;
      occupied.push(item);
      result.push({
        marker: item.marker,
        text: item.text,
        x: item.x,
        y: item.y,
        top: item.top,
        left: item.left,
        score: item.score
      });
      if (result.length >= 8) break;
    }
    return result;
  }, variants).catch(() => null);
  const cardData = await Promise.race([
    evaluation,
    new Promise((resolve) => setTimeout(() => resolve(null), Math.max(50, timeoutMs)))
  ]);

  if (!Array.isArray(cardData)) return [];
  return cardData.map((item) => ({
    text: item.text || "",
    marker: item.marker || "",
    _box: { x: item.x || 0, y: item.y || item.top || 0, width: 0, height: 0 },
    clicked: false,
    isSelected: async () => {
      if (!item.marker) return false;
      const locator = page.locator(`[data-qlchat-person-candidate="${item.marker}"]`).first();
      if (!(await locator.count().catch(() => 0))) return false;
      return await isLocatorSelected(locator);
    },
    click: async () => {
      if (item.clicked) return false;
      item.clicked = true;
      if (item.marker) {
        const locator = page.locator(`[data-qlchat-person-candidate="${item.marker}"]`).first();
        if (await locator.count().catch(() => 0) && await locator.isVisible().catch(() => false)) {
          await locator.scrollIntoViewIfNeeded().catch(() => {});
          return await locator.click({ force: true, timeout: 5000 }).then(() => true).catch(() => false);
        }
      }
      await page.mouse.click(Number(item.x), Number(item.y)).catch(() => {});
      return true;
    }
  }));
}

function chooseBetterSearchFailure(current, next) {
  if (!current) return next;
  const currentScore = searchFailureScore(current);
  const nextScore = searchFailureScore(next);
  return nextScore > currentScore ? next : current;
}

function searchFailureScore(item) {
  let score = 0;
  score += Number(item.relatedRecords || 0) * 10;
  if (item.conversationClicked) score += 8;
  if (item.recordClicked) score += 6;
  if (item.contextText) score += Math.min(String(item.contextText).length, 500) / 100;
  if (item.userBubbleCount) score += Number(item.userBubbleCount) * 5;
  return score;
}

function compact(value) {
  return String(value || "").replace(/\s+/g, "");
}

export function buildSearchKeyword(message, maxLength) {
  const text = String(message || "")
    .replace(/\s+/g, " ")
    .replace(/\[[^\]]{1,10}\]/g, "")
    .trim();
  if (isAttachmentMetadataMessage(text)) return "";
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim();
}

function buildSearchKeywords(message, maxLength) {
  const raw = String(message || "").replace(/\s+/g, " ").trim();
  if (isAttachmentMetadataMessage(raw)) return [];
  // 忽略关键词之间的空格、换行和常见标点，兼容“投 诉”“投-诉”等表格文本。
  const compactRaw = raw.replace(/[^\p{L}\p{N}]+/gu, "");
  const keywords = new Set();
  for (const keyword of FIXED_FALLBACK_KEYWORDS) {
    if (raw.includes(keyword) || compactRaw.includes(keyword)) keywords.add(keyword);
  }
  return [...keywords].filter((item) => String(item || "").trim().length >= 2);
}

function isAttachmentMetadataMessage(value) {
  const text = String(value || "").trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return false;
  if (!text.endsWith("}") && !text.endsWith("]")) return false;
  return /(?:"(?:url|size|width|height|duration|name|fileName)"\s*:)/i.test(text);
}

function isRightContextOpened(text, keyword) {
  const usefulLines = String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(isUsefulContextLine);
  const normalized = usefulLines.join("").replace(/\s+/g, "");
  const compactKeyword = String(keyword || "").replace(/\s+/g, "");
  if (!normalized || String(text || "").includes("暂无消息")) return false;
  const timeLikeCount = (text.match(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/g) || []).length;
  const hasKeyword = compactKeyword && normalized.includes(compactKeyword.slice(0, Math.min(6, compactKeyword.length)));
  const hasChatEvidence = timeLikeCount >= 1 || usefulLines.length >= 2;
  if (!hasChatEvidence) return false;
  return Boolean(hasKeyword) || timeLikeCount >= 1 || usefulLines.length >= 3;
}

async function collectRightSideVisibleText(page) {
  return await page.evaluate(() => {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = viewportWidth * 0.58;
    const minTop = 250;
    const lines = [];
    const seen = new Set();
    const uiTextPattern = /^(数据洞察|售前管理|售后管理|教学管理|运营管理|趣趣智联|系统管理|下载管理|消息通知|升级日志|我已知晓|操作手册|常见问题|数据字典|问题反馈|用户ID|微信昵称|手机号|学员相关记录|老师相关记录|搜索聊天内容|加载更多消息|查看更多消息|没有更多了|暂无消息)$/;
    const uiMixedPattern = /数据洞察售前管理|操作手册 常见问题|用户ID 微信昵称 手机号|消息通知 升级日志|学员相关记录：\s*\d+条\s*老师相关记录/;
    const root = findRegionRoot(minLeft - 60, viewportWidth + 10, minTop - 80, viewportHeight + 80) || document.body;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent) continue;

      const style = window.getComputedStyle(parent);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;

      const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 2 || text.length > 300) continue;
      if (uiTextPattern.test(text) || uiMixedPattern.test(text)) continue;

      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 3 && rect.height > 5);
      range.detach();

      for (const rect of rects) {
        if (rect.left < minLeft || rect.left > viewportWidth || rect.bottom < minTop || rect.top > viewportHeight) continue;
        if (rect.width > viewportWidth * 0.52 || rect.height > 120) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        lines.push({ top: rect.top, left: rect.left, text });
        break;
      }
    }

    if (!lines.length) {
      const nodes = [...root.querySelectorAll("div, p, span")];
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        if (rect.left < minLeft || rect.left > viewportWidth || rect.bottom < minTop || rect.top > viewportHeight) continue;

        const style = window.getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;

        const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length < 2 || text.length > 300) continue;
        if (uiTextPattern.test(text) || uiMixedPattern.test(text)) continue;
        if (rect.width > viewportWidth * 0.52 || rect.height > 120) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        lines.push({ top: rect.top, left: rect.left, text });
      }
    }

    if (!lines.length) return "";

    const chatTopCandidates = lines
      .filter((item) => /^\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(item.text) || item.top > minTop + 80)
      .map((item) => item.top);
    const firstChatTop = chatTopCandidates.length ? Math.min(...chatTopCandidates) : Math.min(...lines.map((item) => item.top));

    return lines
      .filter((item) => item.top >= firstChatTop - 30)
      .sort((a, b) => a.top - b.top || a.left - b.left)
      .map((item) => item.text)
      .join("\n");

    function findRegionRoot(minX, maxX, minY, maxY) {
      const points = [
        [viewportWidth * 0.72, Math.max(minTop + 120, viewportHeight * 0.48)],
        [viewportWidth * 0.84, Math.max(minTop + 160, viewportHeight * 0.52)],
        [viewportWidth * 0.92, Math.max(minTop + 200, viewportHeight * 0.58)]
      ];
      const candidates = [];
      for (const [x, y] of points) {
        let el = document.elementFromPoint(x, y);
        for (let depth = 0; el && depth < 8; depth += 1, el = el.parentElement) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 180 || rect.height < 220) continue;
          if (rect.left < minX || rect.right > maxX || rect.top > maxY || rect.bottom < minY) continue;
          if (el === document.body || el === document.documentElement) continue;
          candidates.push({ el, area: rect.width * rect.height, rect });
        }
      }
      candidates.sort((a, b) => a.area - b.area);
      return candidates[0]?.el || null;
    }
  }).catch(() => "");
}

async function collectRightSideUserBubbles(page) {
  return await page.evaluate(() => {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = viewportWidth * 0.58;
    const maxUserLeft = viewportWidth * 0.78;
    const minTop = 250;
    const messages = [];
    const seen = new Set();
    const uiTextPattern = /^(数据洞察|售前管理|售后管理|教学管理|运营管理|趣趣智联|系统管理|下载管理|消息通知|升级日志|我已知晓|操作手册|常见问题|数据字典|问题反馈|用户ID|微信昵称|手机号|学员相关记录|老师相关记录|搜索聊天内容|加载更多消息|查看更多消息|没有更多了|暂无消息|查看最新消息)$/;
    const root = findRegionRoot(minLeft - 60, viewportWidth + 10, minTop - 80, viewportHeight + 80) || document.body;

    const parseRgb = (value) => {
      const match = String(value || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
      if (!match) return null;
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] === undefined ? 1 : Number(match[4])
      };
    };

    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    };

    const isBlue = (rgb) => {
      if (!rgb || rgb.a === 0) return false;
      return rgb.b >= 170 && rgb.g >= 110 && rgb.r <= 180;
    };

    const isLightBubble = (rgb) => {
      if (!rgb || rgb.a === 0) return false;
      return rgb.r >= 215 && rgb.g >= 215 && rgb.b >= 215;
    };

    const nearestBubble = (el) => {
      let current = el;
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        if (!isVisible(current)) continue;
        const rect = current.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 16 || rect.width > viewportWidth * 0.45 || rect.height > 180) continue;
        const rgb = parseRgb(window.getComputedStyle(current).backgroundColor);
        if (isBlue(rgb) || isLightBubble(rgb)) return { el: current, rect, rgb };
      }
      const rect = el.getBoundingClientRect();
      return { el, rect, rgb: parseRgb(window.getComputedStyle(el).backgroundColor) };
    };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || !isVisible(parent)) continue;

      const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 2 || text.length > 300) continue;
      if (uiTextPattern.test(text)) continue;
      if (/^\d{4}-\d{2}-\d{2}/.test(text) || /^\d{2}:\d{2}:\d{2}$/.test(text)) continue;
      if (/^ID[:：]/i.test(text) || /学员相关记录|老师相关记录/.test(text)) continue;

      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 3 && rect.height > 5);
      range.detach();

      for (const rect of rects) {
        if (rect.left < minLeft || rect.left > viewportWidth || rect.bottom < minTop || rect.top > viewportHeight) continue;
        if (rect.left > maxUserLeft) continue;

        const bubble = nearestBubble(parent);
        if (!bubble || bubble.rect.left > maxUserLeft) continue;
        if (isBlue(bubble.rgb)) continue;
        if (bubble.rect.top < minTop || bubble.rect.bottom > viewportHeight + 120) continue;

        const light = isLightBubble(bubble.rgb);
        const leftAligned = bubble.rect.left < viewportWidth * 0.74 || rect.left < viewportWidth * 0.74;
        if (!light && !leftAligned) continue;

        const key = `${Math.round(bubble.rect.top)}:${text}`;
        if (seen.has(key) || seen.has(text)) continue;
        seen.add(key);
        seen.add(text);
        messages.push({
          top: bubble.rect.top,
          left: bubble.rect.left,
          text
        });
        break;
      }
    }

    const cleaned = messages
      .sort((a, b) => a.top - b.top || a.left - b.left)
      .map((item) => item.text)
      .filter((text, index, all) => all.indexOf(text) === index);

    return {
      messages: cleaned,
      text: cleaned.join("\n")
    };

    function findRegionRoot(minX, maxX, minY, maxY) {
      const points = [
        [viewportWidth * 0.72, Math.max(minTop + 120, viewportHeight * 0.48)],
        [viewportWidth * 0.84, Math.max(minTop + 160, viewportHeight * 0.52)],
        [viewportWidth * 0.92, Math.max(minTop + 200, viewportHeight * 0.58)]
      ];
      const candidates = [];
      for (const [x, y] of points) {
        let el = document.elementFromPoint(x, y);
        for (let depth = 0; el && depth < 8; depth += 1, el = el.parentElement) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 180 || rect.height < 220) continue;
          if (rect.left < minX || rect.right > maxX || rect.top > maxY || rect.bottom < minY) continue;
          if (el === document.body || el === document.documentElement) continue;
          candidates.push({ el, area: rect.width * rect.height, rect });
        }
      }
      candidates.sort((a, b) => a.area - b.area);
      return candidates[0]?.el || null;
    }
  }).catch(() => ({ messages: [], text: "" }));
}

async function collectMiddleRecordText(page) {
  return await page.evaluate(() => {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = viewportWidth * 0.36;
    const maxRight = viewportWidth * 0.72;
    const root = findMiddleRoot() || document.body;
    const nodes = [...root.querySelectorAll("div, section, article, main, li, p, span")];
    const lines = [];
    const seen = new Set();

    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10) continue;
      if (rect.left < minLeft || rect.right > maxRight || rect.bottom < 0 || rect.top > viewportHeight) continue;

      const style = window.getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;

      const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 2 || text.length > 800) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      lines.push({ top: rect.top, left: rect.left, text });
    }

    return lines
      .sort((a, b) => a.top - b.top || a.left - b.left)
      .map((item) => item.text)
      .join("\n");

    function findMiddleRoot() {
      const points = [
        [viewportWidth * 0.48, viewportHeight * 0.52],
        [viewportWidth * 0.56, viewportHeight * 0.52],
        [viewportWidth * 0.50, 340]
      ];
      const candidates = [];
      for (const [x, y] of points) {
        let el = document.elementFromPoint(x, y);
        for (let depth = 0; el && depth < 7; depth += 1, el = el.parentElement) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 150 || rect.height < 180) continue;
          if (rect.left < minLeft - 80 || rect.right > maxRight + 80) continue;
          if (el === document.body || el === document.documentElement) continue;
          candidates.push({ el, area: rect.width * rect.height });
        }
      }
      candidates.sort((a, b) => a.area - b.area);
      return candidates[0]?.el || null;
    }
  }).catch(() => "");
}

async function waitForMiddleRecordList(page, keyword, maxWaitMs = 1800) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const text = await collectMiddleRecordText(page);
    // 查询结果明确为空时立即结束，不再把“无会话”当成仍在加载。
    // 这只影响候选切换的等待时间，不会放宽右侧真实气泡的成功条件。
    if (/共\s*0\s*(?:个)?\s*私聊会话|暂无会话|没有相关记录|未查询到/.test(text)) return text;
    if (isMeaningfulMiddleRecordText(text, keyword)) return text;
    const panelState = await inspectMiddleRecordPanel(page, keyword);
    if (panelState.opened) {
      // collectMiddleRecordText 为避免采集整列容器会略过栏头；把已由独立 DOM
      // 检查确认的栏头补入返回值，供调用方统一执行二次验证。
      return `${panelState.headerText || "学员相关记录"}\n${text || panelState.recordText || ""}`.trim();
    }
    await page.waitForTimeout(180);
  }
  return "";
}

async function inspectMiddleRecordPanel(page, keyword = "") {
  return await page.evaluate((expectedKeyword) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const timestampPattern = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?/g;
    const parseTimestamp = (value) => {
      const match = String(value || "").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
      if (!match) return 0;
      return new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6] || 0)
      ).getTime();
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10
        && rect.height > 8
        && rect.top >= 200
        && rect.bottom <= height + 120
        && rect.left >= width * 0.34
        && rect.right <= width * 0.82
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity) !== 0;
    };
    const nodes = [...document.body.querySelectorAll("div, section, article, li, p, span")];
    const headers = nodes
      .map((el) => ({ el, text: normalize(el.innerText || el.textContent) }))
      .filter(({ el, text }) => {
        if (!visible(el) || !text || text.length > 320) return false;
        const rect = el.getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        return center >= width * 0.38
          && center <= width * 0.78
          && /(?:学员|老师)相关记录\s*[:：]?\s*\d+\s*条?/.test(text);
      });
    const headerText = [...new Set(headers.map(({ text }) => text))].join(" ");
    const positiveHeader = /(?:学员|老师)相关记录\s*[:：]?\s*[1-9]\d*\s*条?/.test(headerText);

    // 页面会把“学员相关记录：2条”拆成多个文本节点。时间戳是中间栏
    // 最稳定的 DOM 锚点，不能再依赖完整栏头必须位于同一节点。
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const timestampAnchors = [];
    const seen = new Set();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = normalize(node.nodeValue);
      const matches = text.match(timestampPattern) || [];
      if (!matches.length || !node.parentElement || !visible(node.parentElement)) continue;
      const rect = node.parentElement.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      if (center < width * 0.40 || center > width * 0.78) continue;
      if (rect.top < 220 || rect.bottom > height + 120) continue;
      for (const value of matches) {
        const key = `${value}:${Math.round(rect.top)}:${Math.round(rect.left)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        timestampAnchors.push({ el: node.parentElement, value, time: parseTimestamp(value), top: rect.top });
      }
    }
    timestampAnchors.sort((a, b) => b.time - a.time || a.top - b.top);

    const records = timestampAnchors.slice(0, 8).map((anchor) => {
      let best = anchor.el;
      for (let current = anchor.el, depth = 0; current && current !== document.body && depth < 9; depth += 1, current = current.parentElement) {
        if (!visible(current)) continue;
        const rect = current.getBoundingClientRect();
        const text = normalize(current.innerText || current.textContent);
        const timestamps = text.match(timestampPattern) || [];
        const center = rect.left + rect.width / 2;
        if (timestamps.length !== 1) continue;
        if (center < width * 0.40 || center > width * 0.78) continue;
        if (rect.width < 80 || rect.height < 22 || rect.height > 680) continue;
        if (/(?:学员|老师)相关记录|暂无消息|没有更多/.test(text)) continue;
        best = current;
        if (rect.width >= 180 && rect.height >= 48) break;
      }
      return normalize(best.innerText || best.textContent);
    }).filter(Boolean);

    // 正数栏头或至少一条真实中间记录均可证明记录栏已展开；两者任一
    // 单独缺失通常只是 FineBI/企聊宝把文本拆节点造成的 DOM 差异。
    const opened = timestampAnchors.length > 0 && (positiveHeader || records.length > 0);
    return {
      opened,
      headerText,
      recordText: [...new Set(records)].join("\n"),
      recordCount: timestampAnchors.length,
      newestTimestamp: timestampAnchors[0]?.value || ""
    };
  }, String(keyword || "")).catch(() => ({ opened: false, headerText: "", recordText: "" }));
}

export function isMeaningfulMiddleRecordText(text, keyword = "") {
  const value = String(text || "");
  if (!value || /暂无会话|暂无消息/.test(value)) return false;
  // collectMiddleRecordText 为避免把整列容器重复采集，可能不包含栏头。
  // 此时“真实时间戳 + 当前查询关键词 + 消息正文”同样能够证明中间记录已展开。
  // 查询前的空白中间栏不会出现时间戳，因此不会把旧页面文本误判为成功。
  const hasHeader = /学员相关记录\s*[:：]?\s*\d*\s*条?|老师相关记录\s*[:：]?\s*\d*\s*条?/.test(value);
  const prefix = compact(keyword).slice(0, Math.min(6, compact(keyword).length));
  const normalized = compact(value);
  const hasKeyword = Boolean(prefix && normalized.includes(prefix));
  const hasTimestamp = /\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?|\d{2}:\d{2}:\d{2}/.test(value);
  const hasPositiveCount = /(?:学员|老师)相关记录\s*[:：]?\s*[1-9]\d*\s*条?/.test(value);
  const hasMessageBody = value
    .split(/\n+/)
    .map((line) => line.trim())
    .some((line) => line.length >= 4
      && !/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/.test(line)
      && !/^(?:学员|老师)相关记录/.test(line));
  if (hasHeader) return hasTimestamp || hasKeyword || hasPositiveCount;
  return hasTimestamp && hasKeyword && hasMessageBody;
}

async function waitForRightContext(page, keyword, ui = {}) {
  let bestText = "";
  let bestScore = 0;
  let lastSignature = "";
  let stableCount = 0;
  let openedAt = 0;
  // 共享预算耗尽时调用方会显式传入 0。这里必须保留 0，不能用 `||`
  // 又回退成 5 秒，否则每个尾部候选仍会突破整行总预算。
  const maxWaitMs = Math.max(0, Number(ui.rightWaitMs ?? 5000));
  const stableMs = Number(ui.rightStableMs ?? 700);
  if (maxWaitMs === 0) return "";
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const text = await collectRightSideVisibleText(page);
    const hasBubbleDom = await hasRightBubbleDom(page);
    const openedByText = isRightContextOpened(text, keyword);
    const hasUsefulBubbleText = hasBubbleDom && !String(text || "").includes("暂无消息") && contextLineCount(text) >= 1;
    if ((!openedByText && !hasUsefulBubbleText) || !hasBubbleDom) {
      await page.waitForTimeout(220);
      continue;
    }

    if (!openedAt) openedAt = Date.now();

    const score = scoreContextCompleteness(text);
    if (score >= bestScore) {
      bestText = text;
      bestScore = score;
    }

    const signature = contextSignature(text);
    if (signature === lastSignature) stableCount += 1;
    else stableCount = 0;
    lastSignature = signature;

    const waitedAfterOpen = Date.now() - openedAt;
    const lineCount = contextLineCount(text);
    const stableEnough = waitedAfterOpen >= stableMs && stableCount >= 2;
    const waitedLongEnough = waitedAfterOpen >= Math.max(stableMs + 1200, 2800);

    if ((stableEnough && lineCount >= 2) || waitedLongEnough) {
      return bestText || text;
    }

    await page.waitForTimeout(220);
  }
  return bestText;
}

async function expandRightSideContext(page, options = {}) {
  const beforeScreens = Math.max(0, Number(options.beforeScreens || 0));
  const afterScreens = Math.max(0, Number(options.afterScreens || 0));
  const stableMs = Math.max(200, Number(options.stableMs || 700));
  const container = await findRightScrollContainerInfo(page);
  if (!container?.found) return { expanded: false, error: "未定位到右侧聊天滚动容器", samples: [] };

  const originalTop = container.scrollTop || 0;
  const step = Math.max(240, Math.floor((container.clientHeight || 520) * 0.82));
  const samples = [];

  await sampleRightContext(page, samples, "current");

  for (let i = 1; i <= beforeScreens; i += 1) {
    const moved = await scrollRightContextContainer(page, -step);
    await page.waitForTimeout(stableMs).catch(() => {});
    await sampleRightContext(page, samples, `before-${i}`);
    if (!moved) break;
  }

  await setRightContextScrollTop(page, originalTop);
  await page.waitForTimeout(Math.min(stableMs, 500)).catch(() => {});
  await sampleRightContext(page, samples, "current-restored");

  for (let i = 1; i <= afterScreens; i += 1) {
    const moved = await scrollRightContextContainer(page, step);
    await page.waitForTimeout(stableMs).catch(() => {});
    await sampleRightContext(page, samples, `after-${i}`);
    if (!moved) break;
  }

  await setRightContextScrollTop(page, originalTop);
  await page.waitForTimeout(120).catch(() => {});

  const ordered = orderContextSamples(samples);
  const contextText = mergeTextBlocks(ordered.map((item) => item.text));
  const userBubbleMessages = mergeMessageLists(...ordered.map((item) => item.userBubbleMessages || []));
  return {
    expanded: Boolean(contextText),
    error: contextText ? "" : "翻阅后未采集到有效右侧气泡",
    contextText,
    userBubbleMessages,
    userBubbleText: userBubbleMessages.join("\n"),
    samples: ordered.map((item) => ({
      label: item.label,
      scrollTop: item.scrollTop,
      lineCount: contextLineCount(item.text),
      userBubbleCount: item.userBubbleMessages?.length || 0
    }))
  };
}

async function sampleRightContext(page, samples, label) {
  const [position, text, userBubbles] = await Promise.all([
    getRightContextScrollTop(page),
    collectRightSideVisibleText(page),
    collectRightSideUserBubbles(page)
  ]);
  if (!text && !userBubbles?.text) return;
  samples.push({
    label,
    scrollTop: position.scrollTop || 0,
    text,
    userBubbleMessages: userBubbles?.messages || []
  });
}

async function findRightScrollContainerInfo(page) {
  return await page.evaluate(() => {
    const target = findRightScrollContainer();
    if (!target) return { found: false };
    return {
      found: true,
      scrollTop: target.scrollTop || 0,
      scrollHeight: target.scrollHeight || 0,
      clientHeight: target.clientHeight || 0
    };

    function findRightScrollContainer() {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const minLeft = viewportWidth * 0.58;
      const candidates = [...document.body.querySelectorAll("div, main, section, article")]
        .map((el) => ({ el, rect: el.getBoundingClientRect(), style: window.getComputedStyle(el) }))
        .filter(({ el, rect, style }) => {
          if (rect.left < minLeft || rect.top < 220 || rect.height < 220 || rect.width < 180) return false;
          if (rect.right > viewportWidth + 80 || rect.bottom < 320) return false;
          if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
          if (el.scrollHeight <= el.clientHeight + 40) return false;
          const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          if (!text || /暂无消息/.test(text)) return false;
          return /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|投诉|退款|课程|老师|视频|回放/.test(text);
        })
        .sort((a, b) => {
          const aArea = a.rect.width * a.rect.height;
          const bArea = b.rect.width * b.rect.height;
          const aScroll = a.el.scrollHeight - a.el.clientHeight;
          const bScroll = b.el.scrollHeight - b.el.clientHeight;
          return bScroll - aScroll || aArea - bArea;
        });
      if (candidates[0]) return candidates[0].el;

      const points = [
        [viewportWidth * 0.72, viewportHeight * 0.52],
        [viewportWidth * 0.84, viewportHeight * 0.56],
        [viewportWidth * 0.92, viewportHeight * 0.60]
      ];
      for (const [x, y] of points) {
        let current = document.elementFromPoint(x, y);
        for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
          const rect = current.getBoundingClientRect();
          if (rect.left >= minLeft - 80 && rect.height > 220 && current.scrollHeight > current.clientHeight + 40) {
            return current;
          }
        }
      }
      return document.scrollingElement || document.documentElement;
    }
  }).catch(() => ({ found: false }));
}

async function getRightContextScrollTop(page) {
  return await page.evaluate(() => {
    const target = findRightScrollContainer();
    if (!target) return { scrollTop: 0 };
    return { scrollTop: target.scrollTop || 0 };

    function findRightScrollContainer() {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const minLeft = viewportWidth * 0.58;
      const candidates = [...document.body.querySelectorAll("div, main, section, article")]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left >= minLeft && rect.top < window.innerHeight && rect.height > 220 && el.scrollHeight > el.clientHeight + 40;
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      return candidates[0] || document.scrollingElement || document.documentElement;
    }
  }).catch(() => ({ scrollTop: 0 }));
}

async function scrollRightContextContainer(page, delta) {
  return await page.evaluate((delta) => {
    const target = findRightScrollContainer();
    if (!target) return false;
    const before = target.scrollTop || 0;
    target.scrollTop = before + delta;
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
    return Math.abs((target.scrollTop || 0) - before) > 2;

    function findRightScrollContainer() {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const minLeft = viewportWidth * 0.58;
      const candidates = [...document.body.querySelectorAll("div, main, section, article")]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left >= minLeft && rect.top < window.innerHeight && rect.height > 220 && el.scrollHeight > el.clientHeight + 40;
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      return candidates[0] || document.scrollingElement || document.documentElement;
    }
  }, delta).catch(() => false);
}

async function setRightContextScrollTop(page, scrollTop) {
  return await page.evaluate((scrollTop) => {
    const target = findRightScrollContainer();
    if (!target) return false;
    target.scrollTop = Math.max(0, Number(scrollTop || 0));
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
    return true;

    function findRightScrollContainer() {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const minLeft = viewportWidth * 0.58;
      const candidates = [...document.body.querySelectorAll("div, main, section, article")]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left >= minLeft && rect.top < window.innerHeight && rect.height > 220 && el.scrollHeight > el.clientHeight + 40;
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      return candidates[0] || document.scrollingElement || document.documentElement;
    }
  }, scrollTop).catch(() => false);
}

function orderContextSamples(samples) {
  const unique = [];
  const seen = new Set();
  for (const sample of samples) {
    const key = `${Math.round(Number(sample.scrollTop || 0) / 10)}:${contextSignature(sample.text).slice(0, 160)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(sample);
  }
  return unique.sort((a, b) => Number(a.scrollTop || 0) - Number(b.scrollTop || 0));
}

async function hasRightBubbleDom(page) {
  return await page.evaluate(() => {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = viewportWidth * 0.58;
    const minTop = 250;
    const nodes = [...document.body.querySelectorAll("div, span, p")];
    let bubbleLike = 0;
    let timeLike = 0;

    const uiTextPattern = /^(私聊记录|群聊记录|查询|重置|请选择|请输入|用户ID|学员相关记录|老师相关记录|搜索聊天内容|查看最新消息|暂无消息|暂无会话|没有更多了|加载更多消息|查看更多消息)$/;
    const parseRgb = (value) => {
      const match = String(value || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!match) return null;
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3])
      };
    };
    const isUsefulText = (value) => {
      if (!value || value.length < 2 || value.length > 300) return false;
      if (/暂无消息|暂无会话/.test(value)) return false;
      if (uiTextPattern.test(value)) return false;
      if (/学员相关记录：\s*\d+条\s*老师相关记录/.test(value)) return false;
      return true;
    };
    const isBubbleLikeNode = (node) => {
      let current = node;
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        const rect = current.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 14) continue;
        if (rect.width > viewportWidth * 0.46 || rect.height > 220) continue;
        if (rect.left < minLeft || rect.top < minTop || rect.top > viewportHeight + 80) continue;
        const style = window.getComputedStyle(current);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
        const rgb = parseRgb(style.backgroundColor);
        if (!rgb) continue;
        const isPureWhite = rgb.r >= 248 && rgb.g >= 248 && rgb.b >= 248;
        const isLightUserBubble = rgb.r >= 215 && rgb.r <= 247 && rgb.g >= 215 && rgb.g <= 247 && rgb.b >= 215 && rgb.b <= 247;
        const isBlueTeacherBubble = rgb.b >= 160 && rgb.g >= 120 && rgb.r <= 210;
        if (!isPureWhite && (isLightUserBubble || isBlueTeacherBubble)) return true;
      }
      return false;
    };

    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10) continue;
      if (rect.left < minLeft || rect.top < minTop || rect.top > viewportHeight + 80) continue;
      const style = window.getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      const value = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      if (!isUsefulText(value)) continue;
      if (/^\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(value)) timeLike += 1;
      if (isBubbleLikeNode(node)) {
        bubbleLike += 1;
      }
    }
    return bubbleLike >= 1 || timeLike >= 1;
  }).catch(() => false);
}

function contextSignature(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("|");
}

function mergeTextBlocks(blocks = []) {
  const lines = [];
  const seen = new Set();
  for (const block of blocks.flat()) {
    for (const line of String(block || "").split(/\n+/)) {
      const text = line.replace(/\s+/g, " ").trim();
      if (!isUsefulContextLine(text)) continue;
      const key = compact(text);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(text);
    }
  }
  return lines.join("\n");
}

function mergeMessageLists(...lists) {
  const messages = [];
  const seen = new Set();
  for (const list of lists.flat()) {
    const text = String(list || "").replace(/\s+/g, " ").trim();
    if (!isUsefulContextLine(text)) continue;
    const key = compact(text);
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push(text);
  }
  return messages;
}

function isUsefulContextLine(text) {
  if (!text || text.length < 2) return false;
  if (/^(暂无消息|暂无会话|搜索聊天内容|查看最新消息|加载更多消息|查看更多消息|没有更多了)$/.test(text)) return false;
  if (/^(私聊记录|群聊记录|查询|重置|请选择|请输入)/.test(text)) return false;
  if (/学员相关记录：\s*\d+条\s*老师相关记录/.test(text)) return false;
  return true;
}

function contextLineCount(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(isUsefulContextLine)
    .length;
}

function scoreContextCompleteness(text) {
  const value = String(text || "");
  const lineCount = contextLineCount(value);
  const timeLikeCount = (value.match(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/g) || []).length;
  return value.length + lineCount * 20 + timeLikeCount * 30;
}

function buildOpenContextError(result) {
  const parts = [];
  if (!result.conversationClicked) parts.push(`相关会话未真正打开${result.conversationCardCount ? `，已尝试${result.conversationCardCount}个会话卡片` : ""}`);
  if (!result.recordClicked) parts.push("相关记录未真正打开或中间记录候选无效");
  if (!result.contextOpened) parts.push("右侧上下文未打开");
  return parts.join("、") || "右侧上下文未打开";
}

async function countConversationCards(page, userId = "") {
  return await page.evaluate((expectedUserId) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const seen = new Set();
    let count = 0;
    for (const el of document.body.querySelectorAll("div, li, tr, section, span, p")) {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || !/条相关记录/.test(text)) continue;
      if (expectedUserId && !text.includes(expectedUserId)) continue;
      if (rect.width < 120 || rect.height < 32 || rect.height > 180) continue;
      if (rect.left < width * 0.16 || rect.right > width * 0.5) continue;
      if (rect.top < 220 || rect.bottom > height + 120) continue;
      const key = `${Math.round(rect.left / 8)}:${Math.round(rect.top / 8)}:${text.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      count += 1;
    }
    return count;
  }, String(userId || "").trim()).catch(() => 0);
}

async function clickResultByRegion(page, region) {
  const ranges = {
    conversation: [0.17, 0.38],
    record: [0.38, 0.58]
  };
  const [minRatio, maxRatio] = ranges[region];
  const clicked = await page.evaluate(({ minRatio, maxRatio, region }) => {
    const scoreCandidate = (text, currentRegion) => {
      let score = 0;
      if (/相关记录/.test(text)) score += 5;
      if (/ID[:：]/.test(text)) score += 3;
      if (currentRegion === "record" && /\d{4}-\d{2}-\d{2}/.test(text)) score += 5;
      return score;
    };
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = width * minRatio;
    const maxRight = width * maxRatio;
    const candidates = [...document.body.querySelectorAll("div, li, tr, section")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return { el, rect, text };
      })
      .filter(({ rect, text }) => {
        if (!text || text.length < 2) return false;
        if (rect.width < 80 || rect.height < 30) return false;
        if (rect.left < minLeft || rect.right > maxRight) return false;
        if (rect.top < 220 || rect.bottom > height + 200) return false;
        if (/请选择|查询|重置|暂无|没有更多/.test(text)) return false;
        if (region === "conversation" && !/相关记录|ID[:：]/.test(text)) return false;
        if (region === "record" && /学员相关记录|老师相关记录/.test(text)) return false;
        return true;
      })
      .sort((a, b) => {
        const scoreA = scoreCandidate(a.text, region);
        const scoreB = scoreCandidate(b.text, region);
        if (scoreA !== scoreB) return scoreB - scoreA;
        const areaA = a.rect.width * a.rect.height;
        const areaB = b.rect.width * b.rect.height;
        return a.rect.top - b.rect.top || areaB - areaA;
      });

    const target = candidates[0]?.el;
    if (!target) return false;
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return true;
  }, { minRatio, maxRatio, region }).catch(() => false);

  return clicked;
}

async function clickConversationCard(page, row, candidateIndex = 0, variant = 0) {
  const marker = await page.evaluate(({ userId, candidateIndex, variant }) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const matches = (el) => {
      const text = normalize(el.innerText || el.textContent);
      return /条相关记录/.test(text) && (!userId || text.includes(String(userId)));
    };
    // 先找最内层的记录数量/ID文本，再向上寻找真正承载点击事件的完整卡片。
    const leaves = [...document.body.querySelectorAll("div, li, tr, section, article, span, p")]
      .filter((el) => matches(el))
      .filter((el) => ![...el.children].some((child) => matches(child)))
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => (
        rect.width >= 60
        && rect.height >= 12
        && rect.left >= width * 0.16
        && rect.right <= width * 0.52
        && rect.top >= 220
        && rect.bottom <= height + 100
      ))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    const leaf = leaves[candidateIndex];
    if (!leaf) return "";
    const candidates = [];
    let el = leaf.el;
    for (let depth = 0; el && depth < 8; depth += 1, el = el.parentElement) {
      const rect = el.getBoundingClientRect();
      const text = normalize(el.innerText || el.textContent);
      if (!matches(el)) continue;
      if (rect.width < 150 || rect.width > width * 0.38) continue;
      if (rect.height < 42 || rect.height > 190) continue;
      if (rect.left < width * 0.16 || rect.right > width * 0.52) continue;
      if (rect.top < 220 || rect.bottom > height + 100) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const className = typeof el.className === "string" ? el.className : "";
      let score = 0;
      if (style.cursor === "pointer") score += 80;
      if (el.matches("li, tr, article, [role='button'], [role='option'], [tabindex]")) score += 55;
      if (/item|card|session|conversation|chat|record|active|current|select/i.test(className)) score += 45;
      if (el.querySelector("img")) score += 30;
      if (rect.height >= 60 && rect.height <= 130) score += 35;
      if (rect.width >= 210) score += 20;
      if (text.length > 20 && text.length < 220) score += 15;
      // 内部文字节点通常 depth=0；真正的卡片一般位于其上方 1-4 层。
      if (depth >= 1 && depth <= 4) score += 18;
      if (depth > 5) score -= 20;
      candidates.push({ el, score, depth, area: rect.width * rect.height });
    }
    candidates.sort((a, b) => b.score - a.score || b.area - a.area || a.depth - b.depth);
    const target = candidates[Math.min(variant, Math.max(0, candidates.length - 1))];
    if (!target) return "";
    const value = `qlchat-conversation-${Date.now()}-${candidateIndex}-${variant}`;
    target.el.setAttribute("data-qlchat-conversation-candidate", value);
    return value;
  }, { userId: String(row.userId || "").trim(), candidateIndex, variant }).catch(() => "");

  if (!marker) return { clicked: false, method: "conversation-card-not-found" };
  const locator = page.locator(`[data-qlchat-conversation-candidate="${marker}"]`).first();
  if (!(await locator.count().catch(() => 0))) return { clicked: false, method: "conversation-card-marker-lost" };
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const clicked = await locator.click({ timeout: 5000 })
    .then(() => true)
    .catch(() => locator.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false));
  return { clicked, method: `conversation-card-container-${variant + 1}` };
}

async function clickRecordCard(page, row, searchKeyword = "") {
  const keyword = String(searchKeyword || "").trim();
  const textClicked = await clickRecordTextByKeyword(page, keyword);
  if (textClicked) return true;

  const blockClicked = await clickRecordBlockByKeyword(page, keyword);
  if (blockClicked) return true;

  const point = await page.evaluate((keyword) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const nodes = [...document.body.querySelectorAll("div, li, tr, section")];
    const allCandidates = nodes
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return { el, rect, text };
      })
      .filter(({ rect, text }) => {
        if (!text || text.length < 2) return false;
        if (keyword && !text.includes(keyword.slice(0, Math.min(6, keyword.length)))) return false;
        if (rect.width < 120 || rect.height < 40) return false;
        if (rect.left < width * 0.34 || rect.right > width * 0.72) return false;
        if (rect.top < 220 || rect.bottom > height + 100) return false;
        if (/学员相关记录|老师相关记录/.test(text)) return false;
        return true;
      });
    const keywordPrefix = keyword ? keyword.slice(0, Math.min(6, keyword.length)) : "";
    const candidates = allCandidates
      .filter(({ text }) => !keywordPrefix || text.includes(keywordPrefix))
      .sort((a, b) => a.rect.top - b.rect.top);
    const fallbackCandidates = allCandidates
      .filter(({ text }) => /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|投诉|退款|退费|报警|骚扰/.test(text))
      .sort((a, b) => a.rect.top - b.rect.top);

    const target = candidates[0] || fallbackCandidates[0] || allCandidates[0];
    if (!target) return null;
    target.el.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, keyword).catch(() => false);

  if (point) {
    await page.mouse.click(point.x, point.y);
    return true;
  }

  const forced = await clickRecordByFixedRegion(page);
  if (forced) return true;

  return await clickResultByRegion(page, "record");
}

async function openRightContextFromMiddleRecords(page, row, keyword, ui = {}, budget = createRightOpenBudget(ui)) {
  // 中间栏默认按时间倒序展示，但不能依赖页面顺序。先从完整记录块解析
  // 时间戳并点击最新一条匹配记录；只有右侧真实出现消息后才算成功。
  const latestResult = await openNewestMiddleRecordByDom(page, keyword, ui, budget);
  if (latestResult.text) return latestResult;

  const maxCandidates = Math.max(1, Number(ui.maxMiddleCandidates || 3));
  const candidates = (await collectMiddleRecordClickCandidates(page, keyword)).slice(0, maxCandidates);
  const tried = new Set();

  for (const candidate of candidates) {
    if (rightOpenBudgetExpired(budget)) break;
    const key = middlePointKey(candidate);
    if (tried.has(key)) continue;
    tried.add(key);
    const text = await clickMiddlePointAndWaitForRightContext(page, candidate, keyword, ui, budget).catch(() => "");
    if (text) return { clicked: true, text, method: candidate.method || "middle-candidate" };

    await activateMiddleRecordByDomAtPoint(page, candidate).catch(() => {});
    // 前面的 clickMiddlePointAndWaitForRightContext 已经完成第二次真实点击并
    // 使用完整等待验证过一次。DOM 激活只是补救动作，使用短轮询即可，避免
    // 每个失败候选再额外消耗一整轮右侧长等待。
    const domText = await waitForRightContext(page, keyword, budgetedRightWaitOptions(quickRightWaitOptions(ui), budget));
    if (domText) return { clicked: true, text: domText, method: `${candidate.method || "middle-candidate"}-dom-activate` };
  }

  const visibleBlockResult = await openRightContextByVisibleMiddleBlocks(page, keyword, ui, tried, budget);
  if (visibleBlockResult.text) return visibleBlockResult;

  const middleSweepResult = await openRightContextByMiddleColumnSweep(page, keyword, ui, tried, budget);
  if (middleSweepResult.text) return middleSweepResult;

  const maxFallbackBlocks = Math.max(1, Number(ui.maxMiddleFallbackBlocks || 3));
  for (let index = 0; index < maxFallbackBlocks && !rightOpenBudgetExpired(budget); index += 1) {
    const clicked = await clickMiddleRecordDomBlock(page, keyword, index);
    if (!clicked) break;
    const text = await waitForRightContext(page, keyword, budgetedRightWaitOptions(ui, budget, ui.rightFallbackWaitMs));
    if (text) return { clicked: true, text, method: `middle-dom-block-${index + 1}` };
  }

  const clicked = !rightOpenBudgetExpired(budget) && await clickRecordCard(page, row, keyword);
  if (clicked) {
    const text = await waitForRightContext(page, keyword, budgetedRightWaitOptions(ui, budget, ui.rightFallbackWaitMs));
    if (text) return { clicked: true, text, method: "legacy-record-click" };
  }

  return { clicked, text: "", method: clicked ? "legacy-record-click-empty" : "none" };
}

async function openNewestMiddleRecordByDom(page, keyword, ui = {}, budget = createRightOpenBudget(ui)) {
  if (rightOpenBudgetExpired(budget)) return { clicked: false, text: "", method: "none" };

  let target = await markNewestMiddleRecord(page, keyword);
  if (!target?.marked) return { clicked: false, text: "", method: "none" };

  let clicked = await clickMarkedNewestMiddleRecord(page, false);
  if (!clicked) return { clicked: false, text: "", method: "none" };

  let text = await waitForRightContext(
    page,
    keyword,
    budgetedRightWaitOptions(quickRightWaitOptions(ui), budget, 1200)
  );
  if (text) {
    return {
      clicked: true,
      text,
      method: "newest-middle-record-dom",
      recordTimestamp: target.timestamp,
      recordText: target.text
    };
  }

  // 页面偶尔只完成选中态而未加载右侧。遵循“一次点击，1 秒后最多补点
  // 一次”，重新发现 DOM，避免在已经重绘失效的旧节点上反复点击。
  const retryDelay = Math.min(1000, Math.max(0, Number(budget?.deadline || 0) - Date.now()));
  if (retryDelay > 0) await page.waitForTimeout(retryDelay).catch(() => {});
  if (rightOpenBudgetExpired(budget)) {
    return { clicked: true, text: "", method: "newest-middle-record-dom-empty" };
  }

  target = await markNewestMiddleRecord(page, keyword);
  if (target?.marked) clicked = await clickMarkedNewestMiddleRecord(page, true) || clicked;
  text = await waitForRightContext(
    page,
    keyword,
    budgetedRightWaitOptions(ui, budget, ui.rightPrimaryWaitMs)
  );
  return {
    clicked,
    text,
    method: text ? "newest-middle-record-dom-retry" : "newest-middle-record-dom-empty",
    recordTimestamp: target?.timestamp || "",
    recordText: target?.text || ""
  };
}

async function clickMarkedNewestMiddleRecord(page, timestampFallback = false) {
  const selector = timestampFallback
    ? '[data-qlchat-newest-middle-timestamp="true"]'
    : '[data-qlchat-newest-middle-record="true"]';
  const locator = page.locator(selector);
  if (!await locator.count().catch(() => 0)) return false;
  await locator.first().scrollIntoViewIfNeeded().catch(() => {});
  return await locator.first().click({ timeout: 3000 })
    .then(() => true)
    .catch(() => locator.first().click({ force: true, timeout: 2000 }).then(() => true).catch(() => false));
}

async function markNewestMiddleRecord(page, keyword) {
  const prefix = compact(keyword).slice(0, Math.min(6, compact(keyword).length));
  return await page.evaluate((expectedPrefix) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = width * 0.34;
    const maxRight = width * 0.82;
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const compactText = (value) => String(value || "").replace(/\s+/g, "");
    const timestampPattern = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?/g;
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10
        && rect.height > 8
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity) !== 0;
    };
    const parseTimestamp = (value) => {
      const match = String(value || "").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
      if (!match) return 0;
      return new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6] || 0)
      ).getTime();
    };

    document.querySelectorAll('[data-qlchat-newest-middle-record], [data-qlchat-newest-middle-timestamp]')
      .forEach((el) => {
        el.removeAttribute('data-qlchat-newest-middle-record');
        el.removeAttribute('data-qlchat-newest-middle-timestamp');
      });

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const candidates = [];
    const seen = new Set();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const leafText = normalize(node.nodeValue);
      // 关键词在 FineBI/企聊宝页面中常被拆成蓝色高亮 span，无法保证和正文
      // 位于同一个文本节点。以时间戳作为记录块锚点，关键词只参与加分，不再
      // 作为硬条件；最终严格按时间倒序选择最新记录。
      if (!leafText || !/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?/.test(leafText)) continue;
      const anchor = node.parentElement;
      if (!visible(anchor)) continue;
      const anchorRect = anchor.getBoundingClientRect();
      const anchorCenter = anchorRect.left + anchorRect.width / 2;
      if (anchorCenter < width * 0.40 || anchorCenter > width * 0.78) continue;
      if (anchorRect.top < 220 || anchorRect.bottom > height + 180) continue;

      const anchorMatches = leafText.match(timestampPattern) || [];
      for (const timestampText of anchorMatches) {
        const timestamp = parseTimestamp(timestampText);
        if (!timestamp) continue;
        const key = `${timestampText}:${Math.round(anchorRect.top)}:${Math.round(anchorRect.left)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let best = null;
        for (let current = anchor, depth = 0; current && current !== document.body && depth < 11; depth += 1, current = current.parentElement) {
          if (!visible(current)) continue;
          const rect = current.getBoundingClientRect();
          const center = rect.left + rect.width / 2;
          const text = normalize(current.innerText || current.textContent);
          const timestamps = text.match(timestampPattern) || [];
          if (timestamps.length !== 1) continue;
          if (center < width * 0.40 || center > width * 0.78) continue;
          if (rect.top < 220 || rect.bottom > height + 180) continue;
          if (rect.width < 70 || rect.width > Math.min(950, width * 0.55)) continue;
          if (rect.height < 18 || rect.height > 720) continue;
          if (/学员相关记录|老师相关记录|没有更多|暂无消息|按记录数排序/.test(text)) continue;

          const body = normalize(text.replace(timestampPattern, " "));
          if (body.length < 2 && depth > 2) continue;
          const style = window.getComputedStyle(current);
          const hasExpectedPrefix = Boolean(expectedPrefix && compactText(text).includes(expectedPrefix));
          let score = 0;
          if (rect.width >= 160) score += 35;
          if (rect.height >= 44 && rect.height <= 560) score += 35;
          if (body.length >= 4) score += 30;
          if (hasExpectedPrefix) score += 35;
          if (/pointer/.test(style.cursor)) score += 18;
          if (/(item|record|message|cell|row)/i.test(String(current.className || ""))) score += 15;
          if (depth >= 1 && depth <= 6) score += depth * 2;
          score -= Math.max(0, text.length - 1200) / 100;
          score -= Math.max(0, rect.height - 560) / 20;
          if (!best || score > best.score) best = { el: current, text, score, top: rect.top };
        }

        const selected = best || { el: anchor, text: leafText, score: 0, top: anchorRect.top };
        candidates.push({
          ...selected,
          timestamp,
          timestampText,
          timestampEl: anchor
        });
      }
    }

    candidates.sort((a, b) => b.timestamp - a.timestamp || b.score - a.score || a.top - b.top);
    const target = candidates[0];
    if (!target) return { marked: false, timestamp: "", text: "" };
    target.el.setAttribute('data-qlchat-newest-middle-record', 'true');
    target.timestampEl.setAttribute('data-qlchat-newest-middle-timestamp', 'true');
    return {
      marked: true,
      timestamp: target.timestampText,
      text: target.text.slice(0, 500),
      candidateCount: candidates.length
    };
  }, prefix).catch(() => ({ marked: false, timestamp: "", text: "" }));
}

async function openRightContextByMiddleColumnSweep(page, keyword, ui = {}, tried = new Set(), budget = createRightOpenBudget(ui)) {
  const maxBlocks = Math.max(1, Number(ui.maxMiddleFallbackBlocks || 3));
  const blocks = (await collectMiddleColumnSweepBlocks(page, keyword)).slice(0, maxBlocks);
  let clickedAny = false;
  for (const block of blocks) {
    if (rightOpenBudgetExpired(budget)) break;
    clickedAny = true;
    const points = Array.isArray(block.points) ? block.points : [];
    for (const point of points.slice(0, 2)) {
      const key = middlePointKey(point);
      if (tried.has(key)) continue;
      tried.add(key);
      const text = await clickMiddlePointAndWaitForRightContext(page, point, keyword, ui, budget).catch(() => "");
      if (text) {
        return {
          clicked: true,
          text,
          method: block.method || "middle-column-sweep"
        };
      }
    }
  }
  return { clicked: clickedAny, text: "", method: clickedAny ? "middle-column-sweep-empty" : "none" };
}

async function collectMiddleColumnSweepBlocks(page, keyword) {
  const prefix = String(keyword || "").replace(/\s+/g, "").slice(0, Math.min(6, String(keyword || "").replace(/\s+/g, "").length));
  return await page.evaluate((prefix) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = width * 0.40;
    const maxRight = width * 0.70;
    const riskPattern = /(投诉|退款|退费|报警|骚扰|课程|老师|视频|回放|礼品|手册|发票|退钱|返钱|骗子|欺骗|举报|处理|申请|物流|快递|小音箱|赔|客服|售后)/;
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const compactText = (value) => String(value || "").replace(/\s+/g, "");
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    };

    const candidates = [...document.body.querySelectorAll("div, li, tr, section, article")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(el.innerText || el.textContent || "");
        const compact = compactText(text);
        return { el, rect, text, compact };
      })
      .filter(({ el, rect, text, compact }) => {
        if (!visible(el)) return false;
        if (!text || text.length < 2 || text.length > 2600) return false;
        if (rect.width < 140 || rect.width > 760) return false;
        if (rect.height < 28 || rect.height > 900) return false;
        if (rect.left < minLeft || rect.right > maxRight) return false;
        if (rect.top < 230 || rect.bottom > height + 220) return false;
        if (/学员相关记录|老师相关记录|没有更多|暂无|按记录数排序|搜索聊天内容|私聊记录|群聊记录/.test(text)) return false;
        return Boolean(
          (prefix && compact.includes(prefix))
          || riskPattern.test(text)
          || /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(text)
        );
      })
      .map((item) => {
        let score = 0;
        if (prefix && item.compact.includes(prefix)) score += 60;
        if (riskPattern.test(item.text)) score += 20;
        if (/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(item.text)) score += 12;
        if (item.rect.height > 420) score -= 8;
        if (item.text.length > 1000) score -= 5;
        return { ...item, score };
      })
      .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top);

    const deduped = [];
    for (const item of candidates) {
      if (deduped.some((seen) => Math.abs(seen.rect.top - item.rect.top) < 14)) continue;
      const rect = item.rect;
      const yCandidates = [
        rect.top + Math.min(Math.max(rect.height * 0.32, 26), Math.max(rect.height - 12, 26)),
        rect.top + Math.min(Math.max(rect.height * 0.52, 30), Math.max(rect.height - 12, 30)),
        rect.top + Math.min(Math.max(rect.height * 0.72, 34), Math.max(rect.height - 12, 34))
      ];
      const xCandidates = [
        rect.left + rect.width * 0.22,
        rect.left + rect.width * 0.48,
        rect.left + rect.width * 0.76,
        rect.right - Math.min(32, rect.width * 0.12)
      ];
      const points = [];
      for (const y of yCandidates) {
        for (const x of xCandidates) {
          if (x <= minLeft || x >= maxRight || y <= 230 || y >= height + 120) continue;
          points.push({ x, y });
        }
      }
      deduped.push({
        text: item.text.slice(0, 300),
        score: item.score,
        points,
        method: "middle-column-sweep"
      });
      if (deduped.length >= 8) break;
    }
    return deduped;
  }, prefix).catch(() => []);
}

async function openRightContextByVisibleMiddleBlocks(page, keyword, ui = {}, tried = new Set(), budget = createRightOpenBudget(ui)) {
  const maxBlocks = Math.max(1, Number(ui.maxMiddleFallbackBlocks || 3));
  const blocks = (await collectVisibleMiddleRecordBlocks(page, keyword)).slice(0, maxBlocks);
  let clickedAny = false;
  for (const block of blocks) {
    if (rightOpenBudgetExpired(budget)) break;
    clickedAny = true;
    const text = await clickMiddleBlockAndWaitForRightContext(page, block, keyword, ui, tried, budget).catch(() => "");
    if (text) return { clicked: true, text, method: block.method || "visible-middle-block" };
  }
  return { clicked: clickedAny, text: "", method: clickedAny ? "visible-middle-block-empty" : "none" };
}

function quickRightWaitOptions(ui = {}) {
  const maxWaitMs = Number(ui.rightWaitMs || 5000);
  const stableMs = Number(ui.rightStableMs || 700);
  return {
    ...ui,
    rightWaitMs: Math.min(maxWaitMs, 1000),
    rightStableMs: Math.min(stableMs, 350)
  };
}

function createRightOpenBudget(ui = {}, externalDeadline = 0) {
  const maxMs = Math.max(8000, Number(ui.openContextBudgetMs || 35000));
  const localDeadline = Date.now() + maxMs;
  const deadline = Number(externalDeadline) > Date.now()
    ? Math.min(localDeadline, Number(externalDeadline))
    : localDeadline;
  return { deadline, maxMs: Math.max(0, deadline - Date.now()) };
}

function rightOpenBudgetExpired(budget) {
  return !budget || Date.now() >= Number(budget.deadline || 0);
}

function budgetedRightWaitOptions(ui = {}, budget, requestedMs) {
  const remaining = Math.max(0, Number(budget?.deadline || 0) - Date.now());
  const configured = Math.max(0, Number(requestedMs ?? ui.rightWaitMs ?? 5000));
  return {
    ...ui,
    rightWaitMs: Math.max(0, Math.min(configured, remaining))
  };
}

async function clickMiddlePointAndWaitForRightContext(page, point, keyword, ui = {}, budget = createRightOpenBudget(ui)) {
  const x = Number(point?.x || 0);
  const y = Number(point?.y || 0);
  if (!x || !y || rightOpenBudgetExpired(budget)) return "";

  await page.mouse.move(x, y).catch(() => {});
  await page.mouse.click(x, y).catch(() => {});

  const firstText = await waitForRightContext(page, keyword, budgetedRightWaitOptions(quickRightWaitOptions(ui), budget, 1000));
  if (firstText) return firstText;

  if (rightOpenBudgetExpired(budget)) return "";
  const retryDelay = Math.min(Number(ui.rightRetryDelayMs || 1000), Math.max(0, budget.deadline - Date.now()));
  if (retryDelay > 0) await page.waitForTimeout(retryDelay).catch(() => {});
  if (rightOpenBudgetExpired(budget)) return "";
  await page.mouse.move(x, y).catch(() => {});
  await page.mouse.click(x, y).catch(() => {});
  return await waitForRightContext(page, keyword, budgetedRightWaitOptions(ui, budget, ui.rightPrimaryWaitMs));
}

async function clickMiddleBlockAndWaitForRightContext(page, candidate, keyword, ui = {}, tried = new Set(), budget = createRightOpenBudget(ui)) {
  const points = Array.isArray(candidate.points) && candidate.points.length
    ? candidate.points
    : [{ x: candidate.x, y: candidate.y }];
  for (const point of points.slice(0, 2)) {
    if (rightOpenBudgetExpired(budget)) break;
    const key = middlePointKey(point);
    if (tried.has(key)) continue;
    tried.add(key);
    const text = await clickMiddlePointAndWaitForRightContext(page, point, keyword, ui, budget);
    if (text) return text;
  }
  return "";
}

function middlePointKey(point) {
  return `${Math.round(Number(point?.x || 0))}:${Math.round(Number(point?.y || 0))}`;
}

async function clickMiddlePointVariants(page, candidate) {
  const x = Number(candidate.x || 0);
  const y = Number(candidate.y || 0);
  if (!x || !y) return false;
  await page.mouse.move(x, y).catch(() => {});
  await page.mouse.click(x, y).catch(() => {});
  await page.waitForTimeout(1000).catch(() => {});
  await page.mouse.click(x, y).catch(() => {});
  return true;
}

async function clickMiddleBlockPointVariants(page, candidate) {
  const points = Array.isArray(candidate.points) && candidate.points.length
    ? candidate.points
    : [{ x: candidate.x, y: candidate.y }];
  const point = points.find((item) => Number(item?.x || 0) && Number(item?.y || 0));
  if (!point) return false;
  const x = Number(point.x || 0);
  const y = Number(point.y || 0);
  await page.mouse.move(x, y).catch(() => {});
  await page.mouse.click(x, y).catch(() => {});
  await page.waitForTimeout(1000).catch(() => {});
  await page.mouse.click(x, y).catch(() => {});
  return true;
}

async function activateMiddleRecordByDomAtPoint(page, point) {
  const x = Number(point.x || 0);
  const y = Number(point.y || 0);
  if (!x || !y) return false;
  return await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    if (!target) return false;
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    };
    const eventOptions = { bubbles: true, cancelable: true, view: window };
    const emit = (el, type) => {
      if (!el) return;
      if (typeof PointerEvent !== "undefined") {
        el.dispatchEvent(new PointerEvent(type.replace("mouse", "pointer"), { ...eventOptions, clientX: x, clientY: y, pointerType: "mouse" }));
      }
      el.dispatchEvent(new MouseEvent(type, { ...eventOptions, clientX: x, clientY: y }));
    };
    const ancestors = [];
    let current = target;
    while (current && current !== document.body && ancestors.length < 10) {
      if (current instanceof HTMLElement && visible(current)) ancestors.push(current);
      current = current.parentElement;
    }
    const middleWidth = window.innerWidth || document.documentElement.clientWidth;
    const clickable = ancestors.find((el) => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || /学员相关记录|老师相关记录|暂无消息|暂无会话|没有更多/.test(text)) return false;
      if (rect.left < middleWidth * 0.36 || rect.right > middleWidth * 0.72) return false;
      if (rect.width < 80 || rect.height < 20 || rect.height > 900) return false;
      const className = String(el.className || "");
      const role = String(el.getAttribute("role") || "");
      return /item|record|message|list|row|card|cell|content|conversation|el-|ant-/i.test(className) || /button|row|listitem|option/i.test(role);
    }) || ancestors.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.left >= middleWidth * 0.36 && rect.right <= middleWidth * 0.72 && rect.width >= 80 && rect.height >= 20;
    });
    const targets = [target, clickable, ...ancestors.slice(0, 4)].filter(Boolean);
    for (const el of targets) {
      emit(el, "mousedown");
      emit(el, "mouseup");
      emit(el, "click");
      if (typeof el.click === "function") el.click();
    }
    return true;
  }, { x, y }).catch(() => false);
}

async function clickMiddleRecordDomBlock(page, keyword, index = 0) {
  const prefix = String(keyword || "").slice(0, Math.min(6, String(keyword || "").length));
  return await page.evaluate(({ prefix, index }) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = width * 0.40;
    const maxRight = width * 0.72;
    const riskPattern = /(投诉|退款|退费|报警|骚扰|课程|老师|视频|回放|礼品|手册|发票|退钱|返钱|骗子|欺骗|举报|处理|申请)/;
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    };
    const blocks = [...document.body.querySelectorAll("div, li, tr, section, article")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return { el, rect, text };
      })
      .filter(({ el, rect, text }) => {
        if (!visible(el)) return false;
        if (!text || text.length < 2 || text.length > 1800) return false;
        if (rect.width < 160 || rect.width > 680) return false;
        if (rect.height < 34 || rect.height > 720) return false;
        if (rect.left < minLeft || rect.right > maxRight) return false;
        if (rect.top < 230 || rect.bottom > height + 180) return false;
        if (/学员相关记录|老师相关记录|没有更多|暂无|按记录数排序|搜索聊天内容/.test(text)) return false;
        return Boolean((prefix && text.includes(prefix)) || riskPattern.test(text) || /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(text));
      })
      .map((item) => {
        let score = 0;
        if (prefix && item.text.includes(prefix)) score += 40;
        if (riskPattern.test(item.text)) score += 16;
        if (/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(item.text)) score += 8;
        score -= Math.max(0, item.text.length - 600) / 200;
        return { ...item, score };
      })
      .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top);

    const deduped = [];
    for (const item of blocks) {
      const duplicate = deduped.some((seen) => Math.abs(seen.rect.top - item.rect.top) < 10);
      if (duplicate) continue;
      deduped.push(item);
      if (deduped.length >= 10) break;
    }

    const target = deduped[index];
    if (!target) return false;
    target.el.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.el.getBoundingClientRect();
    const eventOptions = { bubbles: true, cancelable: true, view: window };
    target.el.dispatchEvent(new MouseEvent("mousedown", eventOptions));
    target.el.dispatchEvent(new MouseEvent("mouseup", eventOptions));
    target.el.click();
    const point = {
      x: rect.left + Math.min(rect.width * 0.5, rect.width - 12),
      y: rect.top + Math.min(rect.height * 0.55, rect.height - 12)
    };
    document.elementFromPoint(point.x, point.y)?.dispatchEvent(new MouseEvent("click", eventOptions));
    return true;
  }, { prefix, index }).catch(() => false);
}

async function collectVisibleMiddleRecordBlocks(page, keyword) {
  const prefix = String(keyword || "").replace(/\s+/g, "").slice(0, Math.min(6, String(keyword || "").replace(/\s+/g, "").length));
  return await page.evaluate((prefix) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = width * 0.38;
    const maxRight = width * 0.72;
    const riskPattern = /(投诉|退款|退费|报警|骚扰|课程|老师|视频|回放|礼品|手册|发票|退钱|返钱|骗子|欺骗|举报|处理|申请|物流|快递|小音箱)/;
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const compactText = (value) => String(value || "").replace(/\s+/g, "");
    const nodes = [...document.body.querySelectorAll("div, li, tr, section, article")];
    const candidates = nodes
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(el.innerText || el.textContent || "");
        const compact = compactText(text);
        return { el, rect, text, compact };
      })
      .filter(({ el, rect, text, compact }) => {
        if (!visible(el)) return false;
        if (!text || text.length < 2 || text.length > 2400) return false;
        if (rect.width < 120 || rect.width > 760) return false;
        if (rect.height < 28 || rect.height > 760) return false;
        if (rect.left < minLeft || rect.right > maxRight) return false;
        if (rect.top < 230 || rect.bottom > height + 180) return false;
        if (/学员相关记录|老师相关记录|没有更多|暂无|按记录数排序|搜索聊天内容/.test(text)) return false;
        return Boolean(
          (prefix && compact.includes(prefix))
          || riskPattern.test(text)
          || /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(text)
        );
      })
      .map((item) => {
        let score = 0;
        if (prefix && item.compact.includes(prefix)) score += 50;
        if (riskPattern.test(item.text)) score += 18;
        if (/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(item.text)) score += 10;
        if (item.rect.height > 360) score -= 8;
        if (item.text.length > 900) score -= 4;
        return { ...item, score, area: item.rect.width * item.rect.height };
      })
      .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top || a.area - b.area);

    const deduped = [];
    for (const item of candidates) {
      const duplicate = deduped.some((seen) => Math.abs(seen.rect.top - item.rect.top) < 12);
      if (duplicate) continue;
      const rect = item.rect;
      const left = rect.left;
      const right = rect.right;
      const top = rect.top;
      const bottom = rect.bottom;
      const midY = top + Math.min(Math.max(rect.height * 0.48, 24), Math.max(rect.height - 12, 24));
      const points = [
        { x: left + rect.width * 0.35, y: midY },
        { x: left + rect.width * 0.52, y: midY },
        { x: left + rect.width * 0.70, y: midY },
        { x: left + rect.width * 0.48, y: top + Math.min(64, rect.height * 0.35) },
        { x: left + rect.width * 0.48, y: bottom - Math.min(24, rect.height * 0.25) }
      ].filter((point) => point.x > minLeft && point.x < maxRight && point.y > 230 && point.y < height + 80);
      deduped.push({
        x: points[0]?.x || left + rect.width / 2,
        y: points[0]?.y || top + rect.height / 2,
        points,
        text: item.text.slice(0, 300),
        score: item.score,
        method: "visible-middle-block"
      });
      if (deduped.length >= 12) break;
    }
    return deduped;
  }, prefix).catch(() => []);
}

async function collectMiddleRecordClickCandidates(page, keyword) {
  const prefix = String(keyword || "").slice(0, Math.min(6, String(keyword || "").length));
  return await page.evaluate((prefix) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = width * 0.34;
    const maxRight = width * 0.72;
    const riskPattern = /(投诉|退款|退费|报警|骚扰|课程|老师|视频|回放|礼品|手册|发票|退钱|返钱|骗子|欺骗|举报)/;
    const isBlueText = (rgb) => {
      const match = String(rgb || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!match) return false;
      const [r, g, b] = match.slice(1).map(Number);
      return b >= 150 && g >= 90 && r <= 140;
    };
    const scoreText = (text, color = "") => {
      let score = 0;
      if (prefix && text.includes(prefix)) score += 40;
      if (riskPattern.test(text)) score += 18;
      if (/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(text)) score += 8;
      if (isBlueText(color)) score += 12;
      return score;
    };

    const points = [];
    const seen = new Set();
    const addPoint = (rect, text, score, method) => {
      if (!rect || rect.width < 5 || rect.height < 5) return;
      if (rect.left < minLeft || rect.right > maxRight) return;
      if (rect.top < 230 || rect.bottom > height + 120) return;
      if (/学员相关记录|老师相关记录|没有更多|暂无|按记录数排序/.test(text)) return;
      const key = `${Math.round(rect.left / 8)}:${Math.round(rect.top / 8)}:${text.slice(0, 24)}`;
      if (seen.has(key)) return;
      seen.add(key);
      points.push({
        x: rect.left + Math.min(rect.width * 0.45, rect.width - 8),
        y: rect.top + Math.min(rect.height * 0.55, rect.height - 8),
        score,
        text,
        method
      });
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent) continue;
      const style = window.getComputedStyle(parent);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 2) continue;
      const score = scoreText(text, style.color);
      if (score <= 0 && prefix) continue;
      if (score <= 0 && !/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(text)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()];
      range.detach();
      for (const rect of rects) addPoint(rect, text, score, "middle-text");
    }

    const blocks = [...document.body.querySelectorAll("div, li, tr, section, article")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return { el, rect, text };
      })
      .filter(({ rect, text }) => {
        if (!text || text.length < 2 || text.length > 600) return false;
        if (rect.width < 120 || rect.height < 32 || rect.height > 260) return false;
        if (rect.left < minLeft || rect.right > maxRight) return false;
        if (rect.top < 230 || rect.bottom > height + 160) return false;
        if (/学员相关记录|老师相关记录|没有更多|暂无|按记录数排序/.test(text)) return false;
        return Boolean((prefix && text.includes(prefix)) || riskPattern.test(text) || /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(text));
      });

    for (const block of blocks) {
      const score = scoreText(block.text) + 4;
      addPoint(block.rect, block.text, score, "middle-block");
    }

    const parseTimestamp = (value) => {
      const match = String(value || "").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
      if (!match) return 0;
      return new Date(
        Number(match[1]), Number(match[2]) - 1, Number(match[3]),
        Number(match[4]), Number(match[5]), Number(match[6] || 0)
      ).getTime();
    };
    return points
      .map((item) => ({ ...item, timestamp: parseTimestamp(item.text) }))
      .sort((a, b) => b.timestamp - a.timestamp || b.score - a.score || a.y - b.y || a.x - b.x)
      .slice(0, 8);
  }, prefix).catch(() => []);
}

async function openRightContextFallback(page, keyword, ui = {}, budget = createRightOpenBudget(ui)) {
  const methods = [
    () => clickMiddleBlueRecordText(page, keyword),
    () => clickRecordBlockByKeyword(page, keyword),
    () => clickRecordByFixedRegion(page),
    () => clickResultByRegion(page, "record")
  ];

  for (const method of methods) {
    if (rightOpenBudgetExpired(budget)) break;
    const clicked = await method().catch(() => false);
    if (!clicked) continue;
    const text = await waitForRightContext(page, keyword, budgetedRightWaitOptions(ui, budget, ui.rightFallbackWaitMs));
    if (text) return { clicked: true, text };
  }
  return { clicked: false, text: "" };
}

async function clickMiddleBlueRecordText(page, keyword) {
  const prefix = String(keyword || "").slice(0, Math.min(6, String(keyword || "").length));
  const point = await page.evaluate((prefix) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const isBlueText = (rgb) => {
      const match = String(rgb || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!match) return false;
      const [r, g, b] = match.slice(1).map(Number);
      return b >= 150 && g >= 90 && r <= 120;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const matches = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent) continue;
      const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 2) continue;
      if (prefix && !text.includes(prefix) && !/(投诉|退款|退费|报警|骚扰|视频|课程|老师)/.test(text)) continue;
      const style = window.getComputedStyle(parent);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 5 && rect.height > 5);
      range.detach();
      for (const rect of rects) {
        if (rect.left < width * 0.36 || rect.right > width * 0.72) continue;
        if (rect.top < 240 || rect.bottom > height + 80) continue;
        const color = window.getComputedStyle(parent).color;
        matches.push({
          rect,
          text,
          score: (isBlueText(color) ? 10 : 0) + (prefix && text.includes(prefix) ? 8 : 0)
        });
      }
    }
    matches.sort((a, b) => b.score - a.score || a.rect.top - b.rect.top);
    const target = matches[0];
    if (!target) return null;
    return { x: target.rect.left + target.rect.width / 2, y: target.rect.top + target.rect.height / 2 };
  }, prefix).catch(() => null);

  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  return true;
}

async function clickRecordTextByKeyword(page, keyword) {
  const prefix = String(keyword || "").slice(0, Math.min(6, String(keyword || "").length));
  if (!prefix) return false;

  const point = await page.evaluate((prefix) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const matches = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (!text.includes(prefix)) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 5 && rect.height > 5);
      range.detach();
      for (const rect of rects) {
        if (rect.left < width * 0.34 || rect.right > width * 0.72) continue;
        if (rect.top < 220 || rect.bottom > height + 100) continue;
        const style = window.getComputedStyle(parent);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
        matches.push({ rect, text });
      }
    }

    matches.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const target = matches[0];
    if (!target) return null;
    return {
      x: target.rect.left + target.rect.width / 2,
      y: target.rect.top + target.rect.height / 2
    };
  }, prefix).catch(() => null);

  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  return true;
}

async function clickRecordBlockByKeyword(page, keyword) {
  const prefix = String(keyword || "").slice(0, Math.min(6, String(keyword || "").length));
  const point = await page.evaluate((prefix) => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = width * 0.34;
    const maxRight = width * 0.72;
    const nodes = [...document.body.querySelectorAll("div, li, tr, section, article")];
    const candidates = nodes
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return { el, rect, text };
      })
      .filter(({ rect, text }) => {
        if (!text || text.length < 2) return false;
        if (prefix && !text.includes(prefix)) return false;
        if (rect.width < 140 || rect.height < 36 || rect.height > 260) return false;
        if (rect.left < minLeft || rect.right > maxRight) return false;
        if (rect.top < 220 || rect.bottom > height + 160) return false;
        if (/学员相关记录|老师相关记录|没有更多|暂无|按记录数排序/.test(text)) return false;
        return true;
      })
      .sort((a, b) => {
        const areaA = a.rect.width * a.rect.height;
        const areaB = b.rect.width * b.rect.height;
        return a.rect.top - b.rect.top || areaA - areaB;
      });
    const target = candidates[0];
    if (!target) return null;
    target.el.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.el.getBoundingClientRect();
    return {
      x: rect.left + Math.min(rect.width * 0.42, rect.width - 12),
      y: rect.top + Math.min(rect.height * 0.58, rect.height - 12)
    };
  }, prefix).catch(() => null);

  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  return true;
}

async function clickRecordByFixedRegion(page) {
  const point = await page.evaluate(() => {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const minLeft = width * 0.34;
    const maxRight = width * 0.72;
    const nodes = [...document.body.querySelectorAll("div, li, tr, section")];
    const candidates = nodes
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return { el, rect, text };
      })
      .filter(({ rect, text }) => {
        if (!text || text.length < 2) return false;
        if (rect.width < 120 || rect.height < 35) return false;
        if (rect.left < minLeft || rect.right > maxRight) return false;
        if (rect.top < 260 || rect.bottom > height + 100) return false;
        if (/学员相关记录|老师相关记录|没有更多|暂无|按记录数排序/.test(text)) return false;
        return true;
      })
      .sort((a, b) => a.rect.top - b.rect.top);

    const target = candidates[0];
    if (!target) return null;
    target.el.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 55) };
  }).catch(() => null);

  if (point) {
    await page.mouse.click(point.x, point.y);
    return true;
  }

  const viewport = page.viewportSize();
  if (viewport) {
    await page.mouse.click(viewport.width * 0.5, viewport.height * 0.43);
    return true;
  }
  return false;
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|auth|ticket|key|secret|password|cookie|session/i.test(key)) {
        url.searchParams.set(key, "***");
      }
    }
    return url.toString();
  } catch {
    return String(value || "").replace(/(token|auth|ticket|key|secret|password|cookie|session)=([^&]+)/gi, "$1=***");
  }
}

function trimText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}
