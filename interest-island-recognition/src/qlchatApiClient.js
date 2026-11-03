import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { buildSearchKeyword } from "./qlchatClient.js";
import { loadApiMap } from "./apiDiscovery.js";
import { extractContextWithLlm, resolveContextExtractorSettings } from "./llmContextExtractor.js";

export async function createQichatApiClient(config, disabled = false) {
  if (disabled) return new OfflineApiClient();

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("未安装 Playwright。请先运行 npm install，或使用 --offline 做离线预览。");
  }

  const { context, page } = await launchQichatContext(chromium, config);

  return new QichatApiClient(chromium, page, context, config);
}

async function launchQichatContext(chromium, config) {
  const browserConfig = config.browser || {};
  const context = await chromium.launchPersistentContext(browserConfig.userDataDir || ".browser-profile", {
    headless: Boolean(browserConfig.headless),
    viewport: { width: 1440, height: 960 }
  });
  const page = context.pages().find((item) => !item.isClosed()) || await context.newPage();
  page.setDefaultTimeout(browserConfig.timeoutMs || 30000);
  await page.goto(browserConfig.url, { waitUntil: "domcontentloaded" }).catch(() => {});
  return { context, page };
}

class OfflineApiClient {
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

class QichatApiClient {
  constructor(chromium, page, context, config) {
    this.chromium = chromium;
    this.page = page;
    this.context = context;
    this.config = config;
    this.map = loadApiMap(config);
    if (!this.map) {
      throw new Error("未找到企聊宝接口映射，请先运行：npm run api:discover -- --debug-row 3");
    }
    this.keywordMaxLength = config.keywordMaxLength || 10;
    this.api = {
      queryWindowHours: 36,
      fullMonthRetry: true,
      timeoutMs: 20000,
      maxStaffCandidates: 5,
      maxCandidates: 5,
      ...(config.api || {})
    };
    this.staffCache = new Map();
    this.extractorSettings = resolveContextExtractorSettings(config);
    this.extractorLimit = createLimiter(Number(config.contextExtractor?.concurrency || config.llm?.concurrency || 3));
  }

  async ensureReady(waitForLogin = true) {
    await this.ensureOpenPage();
    await this.page.bringToFront().catch(() => {});
    if (await this.isQueryPageReady() || await this.isApiSessionReady()) return { ready: true, waitedForLogin: false };

    if (!waitForLogin) return { ready: false, waitedForLogin: false };

    console.log("请在弹出的浏览器完成扫码登录，登录成功后回到终端按回车继续...");
    await waitForEnter();
    await this.ensureOpenPage();
    await this.gotoQueryPage();
    await this.page.waitForTimeout(1500).catch(async (error) => {
      if (!isTargetClosedError(error)) throw error;
      await this.reopenContext();
      await this.gotoQueryPage();
    });
    return { ready: await this.isQueryPageReady() || await this.isApiSessionReady(), waitedForLogin: true };
  }

  async isQueryPageReady() {
    await this.ensureOpenPage().catch(() => {});
    const text = await this.page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    return text.includes("私聊记录") && text.includes("关键词") && text.includes("查询");
  }

  async isApiSessionReady() {
    await this.ensureOpenPage().catch(() => {});
    const result = await this.page.evaluate(async () => {
      try {
        const response = await fetch("/admin/weworkUser/simpleSelectList", {
          method: "POST",
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json"
          },
          body: JSON.stringify({ size: 1, page: 1, weworkName: "", userId: "", isLeave: "N" }),
          credentials: "include"
        });
        const text = await response.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {}
        return { ok: response.ok, status: response.status, data };
      } catch {
        return { ok: false, status: 0, data: null };
      }
    }).catch(() => ({ ok: false, status: 0, data: null }));
    return Boolean(result.ok && isBusinessSuccess(result.data));
  }

  async ensureOpenPage() {
    let needsReopen = false;
    try {
      if (!this.context || !this.page || this.page.isClosed()) needsReopen = true;
      else this.context.pages();
    } catch {
      needsReopen = true;
    }
    if (needsReopen) await this.reopenContext();
    return this.page;
  }

  async reopenContext() {
    await this.context?.close?.().catch(() => {});
    const launched = await launchQichatContext(this.chromium, this.config);
    this.context = launched.context;
    this.page = launched.page;
  }

  async gotoQueryPage() {
    await this.ensureOpenPage();
    const browserConfig = this.config.browser || {};
    const url = browserConfig.url || this.page.url();
    await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(async (error) => {
      if (!isTargetClosedError(error)) throw error;
      await this.reopenContext();
      await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    });
  }

  async resolveStaffCandidates(row) {
    const key = compact(row.receiverName || row.teacherName || "");
    if (!key) return { candidates: [], error: "接收人名称为空，无法解析员工ID" };
    if (this.staffCache.has(key)) return this.staffCache.get(key);

    const sourceStaffId = sourceStaffUserId(this.map);
    if (sourceStaffId && rowMatchesSourceStaff(this.map, row)) {
      const result = {
        candidates: [{
          weworkUserId: sourceStaffId,
          name: this.map.source?.receiverName || this.map.source?.teacherName || row.receiverName || "",
          source: "api-map-source"
        }],
        error: ""
      };
      this.staffCache.set(key, result);
      return result;
    }

    await this.ensureOpenPage();
    const receiverName = String(row.receiverName || row.teacherName || "").trim();
    const result = await this.page.evaluate(async (receiverName) => {
      try {
        const response = await fetch("/admin/weworkUser/simpleSelectList", {
          method: "POST",
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            size: 20,
            page: 1,
            weworkName: receiverName,
            userId: "",
            isLeave: "N"
          }),
          credentials: "include"
        });
        const text = await response.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {}
        return { ok: response.ok, status: response.status, data, text };
      } catch (error) {
        return { ok: false, status: 0, data: null, text: "", error: error.message };
      }
    }, receiverName);

    if (!result.ok || !isBusinessSuccess(result.data)) {
      const value = { candidates: [], error: businessErrorMessage(result, "员工ID解析失败") };
      this.staffCache.set(key, value);
      return value;
    }

    const list = Array.isArray(result.data?.data?.list) ? result.data.data.list : [];
    const candidates = list
      .filter((item) => item?.weworkUserId)
      .map((item) => ({
        weworkUserId: String(item.weworkUserId || ""),
        name: String(item.name || item.alias || ""),
        alias: String(item.alias || ""),
        id: item.id,
        source: "simpleSelectList",
        score: staffNameScore(item, receiverName)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Number(this.api.maxStaffCandidates || 5)));
    const value = {
      candidates,
      error: candidates.length ? "" : "员工ID解析接口未返回可用weworkUserId"
    };
    this.staffCache.set(key, value);
    return value;
  }

  async fetchContext(row) {
    const startedAt = Date.now();
    const keyword = buildSearchKeyword(row.message, this.keywordMaxLength);
    const primaryWindow = resolveTimeWindow(row, this.config, this.api.queryWindowHours);
    const fullMonthWindow = resolveMonthWindow(row, this.config);
    const windows = [primaryWindow];
    if (this.api.fullMonthRetry && !sameWindow(primaryWindow, fullMonthWindow)) windows.push(fullMonthWindow);
    const staffResolution = await this.resolveStaffCandidates(row);
    const staffCandidates = staffResolution.candidates.length
      ? staffResolution.candidates.slice(0, Math.max(1, Number(this.api.maxStaffCandidates || 5)))
      : [{ weworkUserId: "", name: "", source: "unresolved" }];

    let lastError = "";
    let lastSearchMs = 0;
    let lastDetailMs = 0;
    let bestRelatedRecords = 0;
    let bestCandidateTried = 0;
    let bestRequestMeta = {};
    let apiDetailTried = 0;
    let apiCandidateIds = [];
    let apiDetailStatuses = [];
    let contextExtractorAttempted = false;
    let contextExtractorError = "";

    for (const [index, timeWindow] of windows.entries()) {
      for (const staffCandidate of staffCandidates) {
        const searchStartedAt = Date.now();
        const searchResult = await this.callTemplate(this.map.search.request, {
          row,
          keyword,
          timeWindow,
          staffUserId: staffCandidate.weworkUserId || ""
        });
        lastSearchMs += Date.now() - searchStartedAt;
        bestRequestMeta = mergeRequestMeta(bestRequestMeta, searchResult.requestMeta);
        if (!searchResult.ok || !isBusinessSuccess(searchResult.data)) {
          lastError = businessErrorMessage(searchResult, "搜索接口失败");
          continue;
        }

        const candidates = extractCandidateObjects(searchResult.data, row, keyword);
        bestRelatedRecords = Math.max(bestRelatedRecords, candidates.length);
        bestCandidateTried = Math.max(bestCandidateTried, candidates.length);
        if (!candidates.length) {
          lastError = index === 0 ? "接口未查到相关记录，已尝试扩大时间范围" : "接口未查到相关记录";
          continue;
        }
        const candidatesToTry = chooseCandidateSequence(candidates, row, keyword, timeWindow)
          .slice(0, Math.max(1, Number(this.api.maxCandidates || 5)));
        apiCandidateIds = [...new Set([...apiCandidateIds, ...candidatesToTry.flatMap((candidate) => candidate.ids || [])])].slice(0, 30);

        for (const candidateInfo of candidatesToTry) {
        const detailKeywords = keyword ? ["", keyword] : [""];
        for (const detailKeyword of detailKeywords) {
        const detailStartedAt = Date.now();
        const detailResult = this.map.detail?.request
          ? await this.callTemplate(this.map.detail.request, {
            row,
            keyword: detailKeyword,
            timeWindow,
            candidate: candidateInfo,
            bindings: this.map.detail.bindings || [],
            staffUserId: staffCandidate.weworkUserId || "",
            contextSize: detailKeyword ? undefined : 100
          })
          : { ok: false, status: 0, data: null, text: "", requestMeta: {} };
        apiDetailTried += 1;
        apiDetailStatuses.push(detailResult.status || 0);
        lastDetailMs += Date.now() - detailStartedAt;
        bestRequestMeta = mergeRequestMeta(bestRequestMeta, detailResult.requestMeta);

        if (!detailResult.ok || !isBusinessSuccess(detailResult.data)) {
          lastError = businessErrorMessage(detailResult, "详情接口失败");
          contextExtractorError = lastError;
          continue;
        }

        const dataForMessages = detailResult.data;
        const messages = normalizeMessages(dataForMessages, row, keyword);
        const hitIndex = findHitMessageIndex(messages, row, keyword, timeWindow);
        const contextMessages = sliceContext(messages, hitIndex, this.config.contextBefore || 20, this.config.contextAfter || 20);
        const userMessages = contextMessages.filter((message) => isUserMessage(message, row));
        const localContextUsable = isUsableContext(contextMessages, row, keyword);
        const directionReliable = userMessages.length > 0;
        const contextText = formatContextMessages(contextMessages);
        const userBubbleMessages = directionReliable ? userMessages.map((message) => message.text).filter(Boolean) : [];
        const teacherMessages = directionReliable ? contextMessages.filter((message) => !isUserMessage(message, row)) : [];

        if (localContextUsable) {
          return {
            contextSource: "api",
            foundConversation: true,
            matchedMessage: hitIndex >= 0,
            originalMessageMatched: hitIndex >= 0,
            matchedByRelatedRecords: true,
            relatedRecords: candidates.length,
            candidateTried: apiDetailTried,
            queryClicked: true,
            conversationClicked: true,
            recordClicked: true,
            contextOpened: true,
            contextText,
            userBubbleText: userBubbleMessages.join("\n"),
            userBubbleMessages,
            userBubbleCount: userBubbleMessages.length,
            dialogMessages: contextMessages.map(serializeDialogMessage),
            dialogStudentMessages: userMessages.map(serializeDialogMessage),
            dialogTeacherMessages: teacherMessages.map(serializeDialogMessage),
            userDirectionReliable: directionReliable,
            searchKeyword: keyword,
            error: directionReliable ? "" : "接口已提取上下文，但无法可靠区分学员侧消息，Y列不写",
            apiSearchMs: lastSearchMs,
            apiDetailMs: lastDetailMs,
            apiDiscoveryUsed: false,
            apiEndpointMatched: true,
            apiCandidateCount: candidates.length,
            apiMessageCount: contextMessages.length,
            apiUserMessageCount: userMessages.length,
            apiError: "",
            contextExtractor: "local",
            llmContextUsed: false,
            contextExtractConfidence: 1,
            contextExtractReason: "本地接口解析提取到真实聊天上下文",
            rawStatusTextFiltered: countStatusText(dataForMessages),
            apiMessageExtractPath: "",
            apiRawMessageArrayCount: countArrays(dataForMessages),
            apiFilteredStatusTextCount: countStatusText(dataForMessages),
            apiStaffUserId: bestRequestMeta.staffUserId || "",
            apiStaffUserIdMissing: Boolean(bestRequestMeta.staffUserIdMissing),
            apiCrossStaffSearch: Boolean(bestRequestMeta.crossStaffSearch),
            apiRequestAdjustments: bestRequestMeta.adjustments || [],
            apiDetailTried,
            apiCandidateIds,
            apiBindingApplied: bestRequestMeta.bindingApplied || [],
            apiDetailStatuses,
            contextExtractorAttempted,
            contextExtractorError,
            apiStaffCandidates: staffResolution.candidates,
            apiStaffResolveError: staffResolution.error || "",
            webTimings: {},
            contextMs: Date.now() - startedAt
          };
        }

        const detailHasResponse = Boolean(detailResult.ok || detailResult.status || detailResult.text || detailResult.data);
        if (detailHasResponse) {
          contextExtractorAttempted = true;
          const llmExtract = await this.extractorLimit(() => extractContextWithLlm({
            row,
            keyword,
            searchData: searchResult.data,
            detailData: detailResult.ok ? detailResult.data : null,
            searchText: searchResult.text,
            detailText: detailResult.text,
            localMessages: messages,
            timeWindow,
            settings: this.extractorSettings
          }));
          contextExtractorError = llmExtract.contextExtractError || "";
          const llmMessages = (llmExtract.messages || []).map((message) => ({
            text: message.text,
            at: parseAnyTime(message.time),
            speaker: message.speaker,
            role: message.role,
            raw: message,
            score: 0
          }));
          const llmContextMessages = llmMessages.length ? llmMessages : textToMessages(llmExtract.contextText);
          const llmUserBubbleMessages = llmExtract.userMessages?.length
            ? llmExtract.userMessages
            : String(llmExtract.userBubbleText || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
          const llmUserSet = new Set(llmUserBubbleMessages.map(compact));
          const llmTeacherMessages = llmContextMessages.filter((message) =>
            message.text && !llmUserSet.has(compact(message.text))
          );
          const llmContextOpened = Boolean(llmExtract.llmContextUsed && !llmExtract.needsReview && llmExtract.contextText);
          if (llmContextOpened) {
            return {
              contextSource: "api",
              foundConversation: true,
              matchedMessage: Boolean(llmExtract.hitMessageIndex >= 0 || fuzzyTextIncludes(llmExtract.contextText, row.message) || fuzzyTextIncludes(llmExtract.contextText, keyword)),
              originalMessageMatched: Boolean(llmExtract.hitMessageIndex >= 0 || fuzzyTextIncludes(llmExtract.contextText, row.message)),
              matchedByRelatedRecords: true,
              relatedRecords: candidates.length,
              candidateTried: apiDetailTried,
              queryClicked: true,
              conversationClicked: true,
              recordClicked: true,
              contextOpened: true,
              contextText: llmExtract.contextText,
              userBubbleText: llmUserBubbleMessages.join("\n"),
              userBubbleMessages: llmUserBubbleMessages,
              userBubbleCount: llmUserBubbleMessages.length,
              dialogMessages: llmContextMessages.map(serializeDialogMessage),
              dialogStudentMessages: llmUserBubbleMessages.map((text) => ({ text })),
              dialogTeacherMessages: llmTeacherMessages.map(serializeDialogMessage),
              userDirectionReliable: llmUserBubbleMessages.length > 0,
              searchKeyword: keyword,
              error: llmUserBubbleMessages.length ? "" : "大模型已提取上下文，但无法可靠区分学员侧消息，Y列不写",
              apiSearchMs: lastSearchMs,
              apiDetailMs: lastDetailMs,
              apiDiscoveryUsed: false,
              apiEndpointMatched: true,
              apiCandidateCount: candidates.length,
              apiMessageCount: llmContextMessages.length || countTextLines(llmExtract.contextText),
              apiUserMessageCount: llmUserBubbleMessages.length,
              apiError: "",
              contextExtractor: llmExtract.contextExtractor,
              llmContextUsed: true,
              contextExtractConfidence: llmExtract.contextExtractConfidence,
              contextExtractReason: llmExtract.contextExtractReason,
              rawStatusTextFiltered: llmExtract.rawStatusTextFiltered,
              apiMessageExtractPath: "deepseek",
              apiRawMessageArrayCount: countArrays(dataForMessages),
              apiFilteredStatusTextCount: countStatusText(dataForMessages),
              apiStaffUserId: bestRequestMeta.staffUserId || "",
              apiStaffUserIdMissing: Boolean(bestRequestMeta.staffUserIdMissing),
              apiCrossStaffSearch: Boolean(bestRequestMeta.crossStaffSearch),
              apiRequestAdjustments: bestRequestMeta.adjustments || [],
              apiDetailTried,
              apiCandidateIds,
              apiBindingApplied: bestRequestMeta.bindingApplied || [],
              apiDetailStatuses,
              contextExtractorAttempted,
              contextExtractorError: "",
              apiStaffCandidates: staffResolution.candidates,
              apiStaffResolveError: staffResolution.error || "",
              webTimings: {},
              contextMs: Date.now() - startedAt
            };
          }

          lastError = llmExtract.contextExtractError || llmExtract.contextExtractReason || (detailResult.ok ? "接口详情未提取到聊天消息" : "接口未提取到聊天消息");
        } else {
          lastError = "详情接口无有效响应，未触发上下文解析";
        }
      }
      }
      }
    }

    return {
      contextSource: "api",
      foundConversation: bestRelatedRecords > 0,
      matchedMessage: false,
      originalMessageMatched: false,
      matchedByRelatedRecords: bestRelatedRecords > 0,
      relatedRecords: bestRelatedRecords,
      candidateTried: bestCandidateTried,
      queryClicked: true,
      conversationClicked: false,
      recordClicked: false,
      contextOpened: false,
      contextText: "",
      userBubbleText: "",
      userBubbleMessages: [],
      userBubbleCount: 0,
      userDirectionReliable: false,
      searchKeyword: keyword,
      error: lastError || "接口未查询到上下文",
      apiSearchMs: lastSearchMs,
      apiDetailMs: lastDetailMs,
      apiDiscoveryUsed: false,
      apiEndpointMatched: bestRelatedRecords > 0,
      apiCandidateCount: bestRelatedRecords,
      apiMessageCount: 0,
      apiUserMessageCount: 0,
      apiError: lastError || "接口未查询到上下文",
      contextExtractor: "none",
      llmContextUsed: false,
      contextExtractConfidence: 0,
      contextExtractReason: lastError || "接口未查询到上下文",
      rawStatusTextFiltered: 0,
      apiMessageExtractPath: "",
      apiRawMessageArrayCount: 0,
      apiFilteredStatusTextCount: 0,
      apiStaffUserId: bestRequestMeta.staffUserId || "",
      apiStaffUserIdMissing: Boolean(bestRequestMeta.staffUserIdMissing),
      apiCrossStaffSearch: Boolean(bestRequestMeta.crossStaffSearch),
      apiRequestAdjustments: bestRequestMeta.adjustments || [],
      apiDetailTried,
      apiCandidateIds,
      apiBindingApplied: bestRequestMeta.bindingApplied || [],
      apiDetailStatuses,
      contextExtractorAttempted,
      contextExtractorError: contextExtractorError || lastError || "",
      apiStaffCandidates: staffResolution.candidates,
      apiStaffResolveError: staffResolution.error || "",
      webTimings: {},
      contextMs: Date.now() - startedAt
    };
  }

  async callTemplate(template, variables) {
    const contextSize = Number(variables.contextSize || (Number(this.config.contextBefore || 20) + Number(this.config.contextAfter || 20) + 1));
    const rendered = renderRequest(template, this.map, { ...variables, contextSize });
    const request = {
      method: rendered.method,
      url: rendered.url,
      headers: rendered.headers,
      body: rendered.body
    };
    const timeoutMs = Number(this.api.timeoutMs || 20000);
    const result = await this.page.evaluate(async ({ request, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body || undefined,
          credentials: "include",
          signal: controller.signal
        });
        const text = await response.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {}
        return {
          ok: response.ok,
          status: response.status,
          text,
          data
        };
      } catch (error) {
        return { ok: false, status: 0, text: "", data: null, error: error.message };
      } finally {
        clearTimeout(timer);
      }
    }, { request, timeoutMs });
    return { ...result, requestMeta: rendered.requestMeta || {} };
  }

  async close() {
    await this.context.close();
  }
}

function renderRequest(template, map, { row, keyword, timeWindow, candidate = null, bindings = [], contextSize = 41, staffUserId = "" }) {
  const source = map.source || {};
  const staffIdentity = resolveStaffIdentity(map, row, candidate, staffUserId);
  const candidateBindings = semanticCandidateBindings(candidate);
  const rewriteMeta = {
    staffUserId: staffIdentity.id,
    staffSource: staffIdentity.source,
    staffUserIdMissing: !staffIdentity.id,
    crossStaffSearch: !staffIdentity.id,
    contextSize,
    candidateBindings,
    adjustments: [],
    bindingApplied: []
  };
  let url = replaceKnownValues(template.url || "", source, row, keyword, timeWindow);
  let body = replaceKnownValues(template.postData || "", source, row, keyword, timeWindow);

  if (candidate) {
    const candidateObject = candidateData(candidate);
    for (const binding of bindings || []) {
      const nextValue = getPath(candidate, binding.candidatePath) ?? getPath(candidateObject, binding.candidatePath);
      if (nextValue === undefined || nextValue === null) continue;
      url = replaceAll(url, String(binding.sourceValue), String(nextValue));
      body = replaceAll(body, String(binding.sourceValue), String(nextValue));
      rewriteMeta.bindingApplied.push(`map:${binding.sourceValue}->${String(nextValue).slice(0, 80)}`);
    }
  }

  url = rewriteUrlQuery(url, row, keyword, timeWindow, rewriteMeta);
  body = rewriteBody(body, template.headers || {}, row, keyword, timeWindow, rewriteMeta);

  return {
    method: template.method || "GET",
    url,
    headers: template.headers || {},
    body,
    requestMeta: {
      staffUserId: rewriteMeta.staffUserId,
      staffSource: rewriteMeta.staffSource,
      staffUserIdMissing: rewriteMeta.staffUserIdMissing,
      crossStaffSearch: rewriteMeta.crossStaffSearch,
      adjustments: [...new Set(rewriteMeta.adjustments)],
      bindingApplied: [...new Set(rewriteMeta.bindingApplied)]
    }
  };
}

function replaceKnownValues(value, source, row, keyword, timeWindow) {
  let result = String(value || "");
  const replacements = [
    [source.userId, row.userId],
    [source.receiverName, row.receiverName],
    [source.userWechatName, row.userWechatName],
    [source.teacherName, row.teacherName],
    [source.keyword, keyword],
    [source.message, row.message]
  ];
  for (const [from, to] of replacements) {
    if (!from || to === undefined || to === null) continue;
    result = replaceAll(result, String(from), String(to));
  }
  result = replaceTimeLike(result, timeWindow);
  return result;
}

function rewriteUrlQuery(rawUrl, row, keyword, timeWindow, meta) {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (isStaffIdKey(lower)) {
        if (meta.staffUserId) {
          url.searchParams.set(key, meta.staffUserId);
        } else {
          url.searchParams.delete(key);
          meta.adjustments.push(`删除未知员工ID参数 ${key}`);
        }
        continue;
      }
      if (isStudentUserIdKey(lower)) url.searchParams.set(key, String(row.userId || ""));
      const semanticValue = candidateBindingValueForKey(lower, meta.candidateBindings);
      if (semanticValue !== undefined) {
        url.searchParams.set(key, semanticValue);
        meta.bindingApplied.push(`semantic:${key}->${semanticValue.slice(0, 80)}`);
        continue;
      }
      if (/keyword|content|message|msg|search/.test(lower)) url.searchParams.set(key, keyword);
      if (isReceiverNameKey(lower)) url.searchParams.set(key, String(row.receiverName || ""));
      if (/start|begin|from/.test(lower)) url.searchParams.set(key, formatLike(url.searchParams.get(key), timeWindow.start));
      if (/end|finish|to/.test(lower)) url.searchParams.set(key, formatLike(url.searchParams.get(key), timeWindow.end));
      if (isSizeKey(lower)) url.searchParams.set(key, String(Math.max(Number(url.searchParams.get(key)) || 0, Number(meta.contextSize || 41))));
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function rewriteBody(body, headers, row, keyword, timeWindow, meta) {
  if (!body) return body;
  const contentType = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
  if (/json/i.test(contentType) || looksJson(body)) {
    try {
      const data = JSON.parse(body);
      rewriteObject(data, row, keyword, timeWindow, meta);
      return JSON.stringify(data);
    } catch {
      return body;
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType) || body.includes("=")) {
    const params = new URLSearchParams(body);
    for (const key of [...params.keys()]) {
      const lower = key.toLowerCase();
      if (isStaffIdKey(lower)) {
        if (meta.staffUserId) {
          params.set(key, meta.staffUserId);
        } else {
          params.delete(key);
          meta.adjustments.push(`删除未知员工ID字段 ${key}`);
        }
        continue;
      }
      if (isStudentUserIdKey(lower)) params.set(key, String(row.userId || ""));
      const semanticValue = candidateBindingValueForKey(lower, meta.candidateBindings);
      if (semanticValue !== undefined) {
        params.set(key, semanticValue);
        meta.bindingApplied.push(`semantic:${key}->${semanticValue.slice(0, 80)}`);
        continue;
      }
      if (/keyword|content|message|msg|search/.test(lower)) params.set(key, keyword);
      if (isReceiverNameKey(lower)) params.set(key, String(row.receiverName || ""));
      if (/start|begin|from/.test(lower)) params.set(key, formatLike(params.get(key), timeWindow.start));
      if (/end|finish|to/.test(lower)) params.set(key, formatLike(params.get(key), timeWindow.end));
      if (isSizeKey(lower)) params.set(key, String(Math.max(Number(params.get(key)) || 0, Number(meta.contextSize || 41))));
    }
    return params.toString();
  }
  return body;
}

function rewriteObject(value, row, keyword, timeWindow, meta) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => rewriteObject(item, row, keyword, timeWindow, meta));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (isStaffIdKey(lower)) {
      if (meta.staffUserId) {
        value[key] = preserveType(item, meta.staffUserId);
      } else {
        delete value[key];
        meta.adjustments.push(`删除未知员工ID字段 ${key}`);
      }
    }
    else if (isStudentUserIdKey(lower)) value[key] = preserveType(item, row.userId);
    else if (candidateBindingValueForKey(lower, meta.candidateBindings) !== undefined) {
      const semanticValue = candidateBindingValueForKey(lower, meta.candidateBindings);
      value[key] = preserveType(item, semanticValue);
      meta.bindingApplied.push(`semantic:${key}->${semanticValue.slice(0, 80)}`);
    }
    else if (/keyword|content|message|msg|search/.test(lower) && typeof item === "string") value[key] = keyword;
    else if (isReceiverNameKey(lower) && typeof item === "string") value[key] = String(row.receiverName || "");
    else if (/start|begin|from/.test(lower)) value[key] = preserveType(item, formatLike(item, timeWindow.start));
    else if (/end|finish|to/.test(lower)) value[key] = preserveType(item, formatLike(item, timeWindow.end));
    else if (isSizeKey(lower)) value[key] = preserveType(item, Math.max(Number(item) || 0, Number(meta.contextSize || 41)));
    else rewriteObject(item, row, keyword, timeWindow, meta);
  }
}

function mergeRequestMeta(previous = {}, next = {}) {
  return {
    ...previous,
    ...next,
    staffUserId: next.staffUserId || previous.staffUserId || "",
    staffSource: next.staffSource || previous.staffSource || "",
    staffUserIdMissing: Boolean(previous.staffUserIdMissing || next.staffUserIdMissing),
    crossStaffSearch: Boolean(previous.crossStaffSearch || next.crossStaffSearch),
    adjustments: [...new Set([...(previous.adjustments || []), ...(next.adjustments || [])])],
    bindingApplied: [...new Set([...(previous.bindingApplied || []), ...(next.bindingApplied || [])])]
  };
}

function resolveStaffIdentity(map, row, candidate, staffUserId = "") {
  if (staffUserId) return { id: String(staffUserId), source: "staff-resolver" };
  const fromCandidate = staffIdFromCandidate(candidate);
  if (fromCandidate) return { id: fromCandidate, source: "candidate" };

  const sourceStaffId = sourceStaffUserId(map);
  if (sourceStaffId && rowMatchesSourceStaff(map, row)) {
    return { id: sourceStaffId, source: "api-map-source" };
  }

  return { id: "", source: "" };
}

function sourceStaffUserId(map) {
  const source = map?.source || {};
  if (source.weworkUserId) return String(source.weworkUserId);
  const requests = [map?.search?.request, map?.detail?.request].filter(Boolean);
  for (const request of requests) {
    const bodyValue = requestValueByKey(request.postData, isStaffIdKey);
    if (bodyValue) return bodyValue;
    const queryValue = queryValueByKey(request.url, isStaffIdKey);
    if (queryValue) return queryValue;
  }
  return "";
}

function rowMatchesSourceStaff(map, row) {
  const source = map?.source || {};
  const sourceNames = [source.receiverName, source.teacherName].map(compact).filter(Boolean);
  const rowNames = [row.receiverName, row.teacherName].map(compact).filter(Boolean);
  if (!sourceNames.length || !rowNames.length) return false;
  return sourceNames.some((sourceName) => rowNames.some((rowName) => rowName === sourceName || rowName.includes(sourceName) || sourceName.includes(rowName)));
}

function staffNameScore(item, receiverName) {
  const target = compact(receiverName);
  const name = compact(item?.name || "");
  const alias = compact(item?.alias || "");
  let score = 0;
  if (name === target) score += 100;
  if (alias === target) score += 80;
  if (name.includes(target) || target.includes(name)) score += 40;
  if (alias.includes(target) || target.includes(alias)) score += 25;
  if (String(item?.status || "") === "1") score += 10;
  if (String(item?.corpName || "").includes("兴趣岛")) score += 5;
  return score;
}

function isBusinessSuccess(data) {
  if (!data || typeof data !== "object") return true;
  const code = data.state?.code ?? data.code;
  if (code === undefined || code === null) return true;
  return Number(code) === 0;
}

function businessErrorMessage(result, fallback) {
  const message = result?.data?.state?.msg || result?.data?.msg || result?.error || result?.text || "";
  const status = result?.status ? ` ${result.status}` : "";
  return `${fallback}${status}${message ? `：${String(message).slice(0, 120)}` : ""}`.trim();
}

function staffIdFromCandidate(candidate) {
  const object = candidateData(candidate);
  if (!object || typeof object !== "object") return "";
  const direct = primitiveValueByKey(object, isStaffIdKey);
  if (direct) return direct;
  const sessionId = primitiveValueByKey(object, (key) => /sessionid|session_id/.test(key));
  const prefix = String(sessionId || "").split("_")[0] || "";
  return /^[a-z][a-z0-9_-]{4,}$/i.test(prefix) ? prefix : "";
}

function semanticCandidateBindings(candidate) {
  const object = candidateData(candidate);
  if (!object || typeof object !== "object") return {};
  const sessionId = primitiveValueByKey(object, (key) => /sessionid|session_id/.test(key));
  const contactOrRoomId = primitiveValueByKey(object, (key) => /contactorroomid|contact_or_room_id|roomid|room_id|externaluserid|external_user_id/.test(key));
  const conversationId = primitiveValueByKey(object, (key) => /conversationid|conversation_id/.test(key));
  const chatId = primitiveValueByKey(object, (key) => /chatid|chat_id/.test(key));
  const afterKey = primitiveValueByKey(object, (key) => /afterkey|after_key/.test(key));
  const suffix = sessionId && String(sessionId).includes("_") ? String(sessionId).split("_").slice(1).join("_") : "";
  return {
    sessionId: sessionId || "",
    contactOrRoomId: contactOrRoomId || suffix || "",
    conversationId: conversationId || "",
    chatId: chatId || "",
    afterKey: afterKey || sessionId || ""
  };
}

function candidateBindingValueForKey(lower, bindings = {}) {
  if (/sessionid|session_id/.test(lower) && bindings.sessionId) return String(bindings.sessionId);
  if (/contactorroomid|contact_or_room_id|roomid|room_id/.test(lower) && bindings.contactOrRoomId) return String(bindings.contactOrRoomId);
  if (/conversationid|conversation_id/.test(lower) && bindings.conversationId) return String(bindings.conversationId);
  if (/chatid|chat_id/.test(lower) && bindings.chatId) return String(bindings.chatId);
  if (/afterkey|after_key/.test(lower) && bindings.afterKey) return String(bindings.afterKey);
  return undefined;
}

function candidateData(candidate) {
  return candidate && typeof candidate === "object" && Object.prototype.hasOwnProperty.call(candidate, "object")
    ? candidate.object
    : candidate;
}

function primitiveValueByKey(value, predicate) {
  let found = "";
  const visit = (item) => {
    if (found || !item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (found) return;
      const lower = key.toLowerCase();
      if (predicate(lower) && child !== null && child !== undefined && typeof child !== "object") {
        found = String(child);
        return;
      }
      visit(child);
    }
  };
  visit(value);
  return found;
}

function requestValueByKey(body, predicate) {
  if (!body) return "";
  try {
    const data = JSON.parse(body);
    return primitiveValueByKey(data, predicate);
  } catch {}
  const params = new URLSearchParams(String(body));
  for (const key of params.keys()) {
    if (predicate(key.toLowerCase())) return String(params.get(key) || "");
  }
  return "";
}

function queryValueByKey(rawUrl, predicate) {
  try {
    const url = new URL(rawUrl);
    for (const key of url.searchParams.keys()) {
      if (predicate(key.toLowerCase())) return String(url.searchParams.get(key) || "");
    }
  } catch {}
  return "";
}

function isStaffIdKey(lower) {
  return /weworkuserid|wework_user_id|workuserid|work_user_id|staffid|staff_id|teacherid|teacher_id|employeeid|employee_id|workerid|worker_id|advisorid|advisor_id|consultantid|consultant_id/.test(lower);
}

function isStudentUserIdKey(lower) {
  if (isStaffIdKey(lower)) return false;
  if (/room|group/.test(lower)) return false;
  if (/wechatuserid|wechat_user_id|externaluserid|external_user_id|customer.*id|student.*id|member.*id|client.*id/.test(lower)) return true;
  return /^(user|user_id|userid|uid)$/.test(lower);
}

function isReceiverNameKey(lower) {
  if (isStaffIdKey(lower) || isStudentUserIdKey(lower)) return false;
  return /name|staff|teacher|receiver|employee|advisor|consultant/.test(lower);
}

function isSizeKey(lower) {
  return lower === "size" || lower === "pagesize" || lower === "page_size" || lower === "limit";
}

function extractCandidateObjects(data, row, keyword) {
  const objects = [];
  walkWithPath(data, (value, path) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const text = JSON.stringify(value);
    let score = 0;
    if (includesLoose(text, row.userId)) score += 8;
    if (includesLoose(text, keyword)) score += 8;
    if (includesLoose(text, row.receiverName)) score += 4;
    if (/相关记录|record|conversation|session|chat|id/i.test(text)) score += 2;
    const ids = candidateIds(value);
    if (ids.length) score += 4;
    if (score > 0) objects.push({ object: value, path, score, ids });
  });
  return uniqueCandidates(objects).sort((a, b) => b.score - a.score);
}

function chooseCandidateSequence(candidates, row, keyword, timeWindow) {
  return candidates
    .map((candidateInfo) => {
      const candidate = candidateData(candidateInfo);
      const text = JSON.stringify(candidate);
      let score = candidateInfo.score || 0;
      if (includesLoose(text, row.userId)) score += 30;
      if (includesLoose(text, keyword)) score += 25;
      if (includesLoose(text, row.receiverName)) score += 10;
      const time = firstTimeValue(candidate);
      if (time) score += Math.max(0, 10 - Math.abs(time.getTime() - timeWindow.center.getTime()) / 36e5);
      return { ...candidateInfo, score };
    })
    .sort((a, b) => b.score - a.score);
}

function normalizeMessages(data, row, keyword) {
  const messages = [...extractKnownQichatMessages(data, row, keyword)];
  walk(data, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const text = firstTextValue(value);
    if (!text || text.length < 2) return;
    if (isStatusText(text)) return;
    if (!looksLikeMessageObject(value, text)) return;
    messages.push({
      text,
      at: firstTimeValue(value),
      speaker: firstSpeakerValue(value),
      role: firstRoleValue(value),
      raw: value,
      score: messageScore(value, row, keyword)
    });
  });
  return messages
    .filter((message, index, all) => all.findIndex((item) => item.text === message.text && sameTime(item.at, message.at)) === index)
    .sort((a, b) => {
      if (a.at && b.at) return a.at - b.at;
      if (a.at) return -1;
      if (b.at) return 1;
      return b.score - a.score;
    });
}

function extractKnownQichatMessages(data, row, keyword) {
  const list = data?.data?.list;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const text = cleanMessageText(item.msgContent || item.searchMsgContent || item.content || item.message || item.text || "");
      if (!text || text.length < 2 || isStatusText(text)) return null;
      return {
        text,
        at: parseAnyTime(item.sendTime || item.createTime || item.createdAt || item.time),
        speaker: firstSpeakerValue(item),
        role: firstRoleValue(item),
        raw: item,
        score: messageScore(item, row, keyword)
      };
    })
    .filter(Boolean);
}

function isUsableContext(messages, row, keyword) {
  if (!messages.length) return false;
  const useful = messages.filter((message) => !isStatusText(message.text) && message.text.length >= 2);
  if (!useful.length) return false;
  const text = useful.map((message) => message.text).join("\n");
  if (fuzzyTextIncludes(text, row.message) || fuzzyTextIncludes(text, keyword)) return true;
  return useful.length >= 2 && useful.some((message) => message.at || message.speaker || message.role);
}

function looksLikeMessageObject(object, text) {
  if (isStatusText(text)) return false;
  const keys = Object.keys(object).join(" ");
  if (/^(TEXT|IMAGE|VIDEO|AUDIO|FILE)$/i.test(text)) return false;
  if (/^[a-f0-9]{16,}$/i.test(text)) return false;
  if (/code|success|status/.test(keys) && !/content|message|msg|text|send|time|sender|from|role|type/i.test(keys)) return false;
  return /content|message|msg|text|send|time|sender|from|role|type|contentType/i.test(keys);
}

function findHitMessageIndex(messages, row, keyword, timeWindow) {
  const compactMessage = compact(row.message);
  const compactKeyword = compact(keyword).slice(0, Math.min(6, compact(keyword).length));
  let best = { index: -1, score: -Infinity };
  messages.forEach((message, index) => {
    const text = compact(message.text);
    let score = 0;
    if (compactMessage && text.includes(compactMessage.slice(0, Math.min(18, compactMessage.length)))) score += 50;
    if (compactKeyword && text.includes(compactKeyword)) score += 30;
    if (message.at) score += Math.max(0, 20 - Math.abs(message.at.getTime() - timeWindow.center.getTime()) / 36e5);
    if (score > best.score) best = { index, score };
  });
  return best.score > 0 ? best.index : -1;
}

function sliceContext(messages, hitIndex, before, after) {
  if (!messages.length) return [];
  if (hitIndex < 0) return messages.slice(0, Math.min(messages.length, before + after + 1));
  return messages.slice(Math.max(0, hitIndex - before), Math.min(messages.length, hitIndex + after + 1));
}

function isUserMessage(message, row) {
  const roleText = `${message.role || ""} ${message.speaker || ""}`;
  const rawText = JSON.stringify(message.raw || {});
  const allText = `${roleText} ${rawText}`;
  if (/学员|用户|客户|学生|student|customer|member|\buser\b|\bclient\b/i.test(roleText)) return true;
  if (/老师|助教|运营|顾问|客服|训练营|企业|员工|staff|teacher|service|assistant/i.test(roleText)) return false;
  if (row.userId && allText.includes(String(row.userId))) return true;
  if (row.userWechatName && allText.includes(String(row.userWechatName))) return true;
  if (row.senderRole && /学员|用户|客户|学生/.test(row.senderRole) && row.senderName && allText.includes(String(row.senderName))) return true;
  if (row.teacherName && allText.includes(String(row.teacherName))) return false;
  if (row.receiverName && allText.includes(String(row.receiverName))) return false;
  return false;
}

function formatContextMessages(messages) {
  return messages
    .map((message) => {
      const time = message.at ? formatDateTime(message.at) : "";
      const speaker = message.speaker || message.role || "";
      return [time, speaker, message.text].filter(Boolean).join(" ");
    })
    .join("\n");
}

function serializeDialogMessage(message) {
  return {
    text: message.text || "",
    time: message.at ? formatDateTime(message.at) : "",
    speaker: message.speaker || "",
    role: message.role || ""
  };
}

function resolveTimeWindow(row, config, hours) {
  const center = parseExcelDateTime(row.sentAt) || parseDataDate(row.dataDate) || monthCenter(config.targetSheet);
  const offset = Number(hours || 36) * 60 * 60 * 1000;
  return {
    center,
    start: new Date(center.getTime() - offset),
    end: new Date(center.getTime() + offset)
  };
}

function resolveMonthWindow(row, config) {
  const month = parseSheetMonth(config.targetSheet) || parseDataDate(row.dataDate) || new Date();
  const start = new Date(month.getFullYear(), month.getMonth(), 1, 0, 0, 0);
  const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 0, 23, 59, 59);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const end = monthEnd.getTime() > todayEnd.getTime() ? todayEnd : monthEnd;
  return { center: new Date((start.getTime() + end.getTime()) / 2), start, end };
}

function parseExcelDateTime(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 20000) {
    return new Date(Math.round((numeric - 25569) * 86400 * 1000));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDataDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseSheetMonth(sheetName) {
  const match = String(sheetName || "").match(/(\d{1,2})\.(\d{1,2})-(\d{1,2})\.(\d{1,2})/);
  if (!match) return null;
  const year = new Date().getFullYear();
  return new Date(year, Number(match[1]) - 1, 1, 12, 0, 0);
}

function monthCenter(sheetName) {
  const month = parseSheetMonth(sheetName) || new Date();
  return new Date(month.getFullYear(), month.getMonth(), 15, 12, 0, 0);
}

function sameWindow(a, b) {
  return a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();
}

function replaceTimeLike(text, timeWindow) {
  return String(text || "").replace(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/g, (value, offset, fullText) => {
    const previous = fullText.slice(Math.max(0, offset - 20), offset).toLowerCase();
    return /end|to|结束|截止/.test(previous) ? formatLike(value, timeWindow.end) : formatLike(value, timeWindow.start);
  });
}

function formatLike(sample, date) {
  const raw = String(sample ?? "");
  if (/^\d{13}$/.test(raw)) return String(date.getTime());
  if (/^\d{10}$/.test(raw)) return String(Math.floor(date.getTime() / 1000));
  if (/^\d{8}$/.test(raw)) return formatDate(date).replace(/-/g, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return formatDate(date);
  return formatDateTime(date);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDateTime(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${formatDate(date)} ${h}:${m}:${s}`;
}

function firstTextValue(object) {
  const keys = ["content", "msg", "message", "text", "body", "chatContent", "messageContent", "contentText", "contentValue"];
  for (const key of keys) {
    if (typeof object[key] === "string" && object[key].trim()) return cleanMessageText(object[key]);
  }
  for (const [key, value] of Object.entries(object)) {
    if (/content|message|msg|text/i.test(key) && typeof value === "string" && value.trim()) return cleanMessageText(value);
  }
  return "";
}

function cleanMessageText(value) {
  const raw = String(value || "").trim();
  if (looksJson(raw)) {
    try {
      const parsed = JSON.parse(raw);
      const nested = nestedMessageText(parsed);
      if (nested) return nested;
    } catch {}
  }
  return raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function nestedMessageText(value) {
  if (!value || typeof value !== "object") return "";
  const directKeys = ["text", "content", "title", "description"];
  for (const key of directKeys) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    }
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      const nested = nestedMessageText(item);
      if (nested) return nested;
    }
  }
  return "";
}

function isStatusText(value) {
  return /^(操作成功|成功|success|ok|true|暂无消息|没有更多了|查看最新消息|搜索聊天内容|TEXT)$/i.test(String(value || "").trim());
}

function countStatusText(value) {
  let count = 0;
  walk(value, (item) => {
    if (typeof item === "string" && isStatusText(item)) count += 1;
  });
  return count;
}

function countArrays(value) {
  let count = 0;
  walk(value, (item) => {
    if (Array.isArray(item)) count += 1;
  });
  return count;
}

function candidateIds(value) {
  const ids = [];
  const bindings = semanticCandidateBindings(value);
  for (const item of [bindings.sessionId, bindings.contactOrRoomId, bindings.conversationId, bindings.chatId, bindings.afterKey, staffIdFromCandidate(value)]) {
    if (item) ids.push(String(item));
  }
  return [...new Set(ids)].slice(0, 8);
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const signature = candidate.ids?.length
      ? candidate.ids.join("|")
      : JSON.stringify(candidate.object).slice(0, 500);
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(candidate);
  }
  return result;
}

function countTextLines(text) {
  return String(text || "").split(/\n+/).filter((line) => line.trim().length >= 2).length;
}

function textToMessages(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ text: line, at: null, speaker: "", role: "unknown", raw: { text: line }, score: 0 }));
}

function fuzzyTextIncludes(text, value) {
  const haystack = compact(text);
  const needle = compact(value);
  if (!needle) return false;
  if (haystack.includes(needle)) return true;
  const prefix = needle.slice(0, Math.min(10, needle.length));
  return prefix.length >= 4 && haystack.includes(prefix);
}

function firstTimeValue(object) {
  for (const [key, value] of Object.entries(object)) {
    if (!/time|date|created|updated|send/i.test(key)) continue;
    const parsed = parseAnyTime(value);
    if (parsed) return parsed;
  }
  return null;
}

function parseAnyTime(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (value > 1e12) return new Date(value);
    if (value > 1e9) return new Date(value * 1000);
  }
  const text = String(value);
  if (/^\d{13}$/.test(text)) return new Date(Number(text));
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000);
  const parsed = new Date(text.replace(/-/g, "/"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function firstSpeakerValue(object) {
  const nestedCandidates = [
    object.from,
    object.sender,
    object.user,
    object.member,
    object.customer,
    object.student,
    object.staff,
    object.teacher
  ];
  for (const item of nestedCandidates) {
    if (!item || typeof item !== "object") continue;
    const value = item.displayName || item.name || item.nickName || item.nickname || item.realName || item.alias;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const [key, value] of Object.entries(object)) {
    if (/name|sender|from|user|staff|teacher|member/i.test(key) && typeof value === "string" && value.trim()) return value.trim();
    if (/sender|from|user|customer|student|member|staff|teacher/i.test(key) && value && typeof value === "object") {
      const nested = value.displayName || value.name || value.nickName || value.nickname || value.realName || value.alias;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return "";
}

function firstRoleValue(object) {
  const nestedCandidates = [object.from, object.sender, object.user, object.member, object.customer, object.student, object.staff, object.teacher];
  for (const item of nestedCandidates) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.coworker === "boolean") return item.coworker ? "staff" : "user";
    if (typeof item.isCoworker === "boolean") return item.isCoworker ? "staff" : "user";
    if (typeof item.isStaff === "boolean" && item.isStaff) return "staff";
    if (typeof item.isTeacher === "boolean" && item.isTeacher) return "staff";
    if (typeof item.isCustomer === "boolean" && item.isCustomer) return "user";
    if (typeof item.isStudent === "boolean" && item.isStudent) return "user";
  }
  for (const [key, value] of Object.entries(object)) {
    const lower = key.toLowerCase();
    if (/coworker|isstaff|isteacher/.test(lower) && typeof value === "boolean") return value ? "staff" : "user";
    if (/iscustomer|isstudent|isuser/.test(lower) && typeof value === "boolean") return value ? "user" : "";
    if (/role|type|identity|senderType|fromType|userType/i.test(key) && value !== null && value !== undefined) return String(value);
  }
  return "";
}

function messageScore(object, row, keyword) {
  const text = JSON.stringify(object);
  let score = 0;
  if (includesLoose(text, row.userId)) score += 8;
  if (includesLoose(text, keyword)) score += 8;
  if (includesLoose(text, row.message)) score += 12;
  return score;
}

function getPath(object, path) {
  let current = object;
  for (const key of path || []) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function preserveType(oldValue, newValue) {
  if (typeof oldValue === "number") {
    const next = Number(newValue);
    return Number.isFinite(next) ? next : oldValue;
  }
  return String(newValue ?? "");
}

function looksJson(text) {
  const value = String(text || "").trim();
  return value.startsWith("{") || value.startsWith("[");
}

function walk(value, visitor) {
  visitor(value);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor);
    return;
  }
  for (const item of Object.values(value)) walk(item, visitor);
}

function walkWithPath(value, visitor, path = []) {
  visitor(value, path);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkWithPath(item, visitor, [...path, index]));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    walkWithPath(item, visitor, [...path, key]);
  }
}

function compact(value) {
  return String(value || "").replace(/\s+/g, "");
}

function includesLoose(text, value) {
  const needle = compact(value);
  if (!needle) return false;
  const haystack = compact(text);
  if (haystack.includes(needle)) return true;
  const prefix = needle.slice(0, Math.min(10, needle.length));
  return prefix.length >= 4 && haystack.includes(prefix);
}

function replaceAll(text, from, to) {
  if (!from) return text;
  return String(text).split(from).join(to);
}

function sameTime(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.getTime() === b.getTime();
}

function isTargetClosedError(error) {
  return /target.*closed|browser.*closed|context.*closed|page.*closed/i.test(String(error?.message || error || ""));
}

async function waitForEnter() {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question("");
  } finally {
    rl.close();
  }
}

function createLimiter(max) {
  const concurrency = Math.max(1, Number(max || 1));
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= concurrency || !queue.length) return;
    const item = queue.shift();
    active += 1;
    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}
