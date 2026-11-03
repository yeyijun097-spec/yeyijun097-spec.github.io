import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { extractProfileWithLlm, resolveProfileExtractorSettings } from "./llmProfileExtractor.js";

const DEFAULT_CHANCE = {
  enabled: true,
  url: "https://edu-admin.qlchat.com/saleAssign/chanceAss",
  mapPath: "config/chance-api-map.local.json",
  discoverOnMissingMap: true,
  timeoutMs: 20000,
  maxRequests: 8,
  profileConcurrency: 4
};

const SECRET_HEADER = /cookie|authorization|token|csrf|xsrf|secret|session|sign/i;
const SECRET_QUERY = /token|ticket|sign|signature|secret|session|csrf|xsrf/i;
const TRAINING_NAME_PATTERN = /训练\s*营\s*名称|营\s*名称|trainingCampName|training_camp_name|training.*camp.*name/i;
const CATEGORY_PATTERN = /所属\s*品\s*类|课程\s*品\s*类|品\s*类\s*名称|categoryName|category_name|course.*category|subject.*name/i;
const CAMP_TYPE_ID_PATTERN = /正式\s*营\s*ID|体验\s*营\s*ID|formal.*(?:camp|finance|product)?.*id|official.*camp.*id|experience.*(?:camp|finance|product)?.*id|trial.*(?:camp|finance|product)?.*id/i;

export function chanceConfig(config = {}) {
  return { ...DEFAULT_CHANCE, ...(config.chance || {}) };
}

export function chanceApiMapPath(config) {
  return path.resolve(chanceConfig(config).mapPath || DEFAULT_CHANCE.mapPath);
}

export function chanceApiMapExists(config) {
  const file = chanceApiMapPath(config);
  if (!fs.existsSync(file)) return false;
  try {
    return profileMapIsValid(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return false;
  }
}

export function loadChanceApiMap(config) {
  const file = chanceApiMapPath(config);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export async function discoverChanceApiMap({ config, row, keepOpen = false, existingContext = null }) {
  if (!row) throw new Error("chanceAss 接口发现需要至少一行样本数据。");
  const chance = chanceConfig(config);
  const { context, page, ownsContext } = existingContext
    ? await pageFromExistingContext(existingContext, chance.url)
    : await launchStandaloneContext(config, chance.url);
  const recorder = createRecorder(page);

  try {
    await page.bringToFront().catch(() => {});
    console.log("请在打开的浏览器完成 chanceAss 登录/验证。");
    console.log(`登录后请按截图流程操作样本用户 ${row.userId}：输入用户ID并查询 -> 点击“学员档案” -> 点击“订单信息” -> 点击“查看详情”。`);
    while (true) {
      console.log("确认订单信息页第一条可见“购买体验营/购买正式营”和商品名称，且详情页“商品信息”区块出现“所属品类”后，再回到终端按回车继续；输入 q 回车可退出发现。");
      const answer = await waitForEnter();
      if (/^q$/i.test(String(answer || "").trim())) {
        throw new Error("已退出 chanceAss 接口发现，未生成映射。");
      }
      await page.waitForTimeout(1000).catch(() => {});
      try {
        const visible = await readVisibleProfileFlags(page);
        const map = buildChanceApiMap({ events: recorder.events, row, config, visible });
        const file = chanceApiMapPath(config);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(map, null, 2), "utf8");
        return { file, map, eventCount: recorder.events.length };
      } catch (error) {
        const visible = await readVisibleProfileFlags(page);
        console.log(error.message);
        if (visible.hasTrainingName || visible.hasCategory || visible.hasCampTypeId || visible.hasOrderProductType || visible.hasOrderProductName) {
          console.log(`当前页面可见字段：${visible.labels.length ? visible.labels.join("，") : "有部分字段"}；${missingProfileValidationFields(visible)}。`);
        } else {
          console.log("当前页面可见文本里也没有识别到“购买体验营/购买正式营 / 商品名称 / 所属品类”。");
        }
        console.log("请保持浏览器打开，回到订单信息页确认第一条订单类型，再重新点“查看详情”或刷新详情弹窗后，回到终端按回车继续捕获。");
      }
    }
  } finally {
    recorder.detach();
    if (!keepOpen) {
      await page.close().catch(() => {});
      if (ownsContext) await context.close().catch(() => {});
    }
  }
}

export async function createChanceAssApiClient(config, sharedClient = null, disabled = false) {
  if (disabled || chanceConfig(config).enabled === false) return new OfflineChanceClient();
  const map = loadChanceApiMap(config);
  if (!map) return new MissingMapChanceClient(config);
  if (!profileMapIsValid(map)) {
    return new MissingMapChanceClient(
      config,
      `chanceAss 接口映射不是已验证的详情字段映射：${chanceApiMapPath(config)}。请重新运行 npm run chance:discover -- --debug-row 3 --keep-open`
    );
  }
  const { context, page, ownsContext } = sharedClient?.context
    ? await pageFromExistingContext(sharedClient.context, chanceConfig(config).url)
    : await launchStandaloneContext(config, chanceConfig(config).url);
  return new ChanceAssApiClient(page, context, config, map, ownsContext);
}

class OfflineChanceClient {
  async ensureReady() {
    return { ready: true, waitedForLogin: false };
  }

  async fetchProfile() {
    return emptyProfile("offline mode");
  }

  async close() {}
}

class MissingMapChanceClient {
  constructor(config, message = "") {
    this.config = config;
    this.message = message;
  }

  async ensureReady() {
    return { ready: false, waitedForLogin: false };
  }

  async fetchProfile() {
    return emptyProfile(this.message || `未找到 chanceAss 接口映射：${chanceApiMapPath(this.config)}`);
  }

  async close() {}
}

class ChanceAssApiClient {
  constructor(page, context, config, map, ownsContext = false) {
    this.page = page;
    this.context = context;
    this.config = config;
    this.map = map;
    this.ownsContext = ownsContext;
    this.chance = chanceConfig(config);
    this.profileExtractorSettings = resolveProfileExtractorSettings(config);
    this.cache = new Map();
  }

  async ensureReady(waitForLogin = true) {
    await this.page.bringToFront().catch(() => {});
    if (await this.isApiSessionReady()) return { ready: true, waitedForLogin: false };
    if (!waitForLogin) return { ready: false, waitedForLogin: false };

    await this.page.goto(this.chance.url, { waitUntil: "domcontentloaded" }).catch(() => {});
    console.log("请在浏览器完成 chanceAss 登录/验证，登录成功后回到终端按回车继续...");
    await waitForEnter();
    await this.page.goto(this.chance.url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.page.waitForTimeout(1000).catch(() => {});
    return { ready: await this.isApiSessionReady(), waitedForLogin: true };
  }

  async isApiSessionReady() {
    const mapped = profileRequestsFromMap(this.map);
    const request = mapped.ready ? mapped.requests[0]?.request : this.map.requests?.[0]?.request;
    if (!request) return false;
    const result = await this.callTemplate(request, { row: this.map.source || {}, timeoutMs: 5000 }).catch(() => null);
    if (!result) return false;
    if (isLoginLikeResponse(result)) return false;
    return Boolean(result.ok && isBusinessSuccess(result.data));
  }

  async fetchProfile(row) {
    const key = profileCacheKey(row);
    if (!row.userId) return emptyProfile("用户id为空，无法查询档案");
    if (this.cache.has(key)) return this.cache.get(key);
    const promise = this.fetchProfileUncached(row);
    this.cache.set(key, promise);
    return promise;
  }

  async fetchProfileUncached(row) {
    const startedAt = Date.now();
    const mappedRequests = profileRequestsFromMap(this.map);
    if (!mappedRequests.ready) {
      return {
        ...emptyProfile(mappedRequests.error),
        profileMs: Date.now() - startedAt
      };
    }
    const sourceRequests = mappedRequests.requests.slice(0, Math.max(1, Number(this.chance.maxRequests || 8)));
    let lastError = "";
    let candidateCount = 0;
    let apiTried = 0;
    const bindingApplied = [];
    const candidates = [];
    const responsePackets = [];
    const detailCandidates = [];
    const detailResponsePackets = [];
    const detailState = createProfileDetailState();

    const bindingData = [];
    let selectedOrder = null;

    for (const item of sourceRequests) {
      if (selectedOrder?.isNullSelection && isOrderDetailRole(item.role)) {
        continue;
      }
      apiTried += 1;
      const requestBindingData = selectedOrder?.bindingData
        ? [selectedOrder.bindingData, ...bindingData]
        : bindingData;
      const result = await this.callTemplate(item.request, { row, bindingData: requestBindingData });
      bindingApplied.push(...(result.bindingApplied || []));
      if (!result.ok || !isBusinessSuccess(result.data)) {
        lastError = businessErrorMessage(result, "chanceAss接口请求失败");
        continue;
      }
      const endpoint = endpointName(item.request.url);
      const packet = {
        endpoint,
        role: item.role || "",
        status: result.status,
        bindingApplied: result.bindingApplied || [],
        data: result.data,
        text: result.text
      };
      responsePackets.push(packet);
      bindingData.push(result.data);
      const profileFlags = analyzeProfileDetailData(result.data, result.text);
      const detailLike = item.role === "orderDetail" ||
        item.role === "orderDetailProbe" ||
        (item.role === "profileProbe" && (profileFlags.hasTrainingName || profileFlags.hasCategory));
      if (detailLike) {
        const flags = profileFlags;
        mergeProfileDetailState(detailState, flags);
        if (flags.hasTrainingName || flags.hasCategory || item.role === "orderDetail") {
          detailState.profileDetailEndpointMatched = true;
        }
        detailResponsePackets.push(packet);
      }
      if (item.role === "orderList") {
        const orderCandidates = extractOrderCandidates(result.data, result.text, row, endpoint);
        mergeOrderCandidatesState(detailState, orderCandidates);
        selectedOrder = selectOrderForRow(detailState.profileOrderCandidates, row);
        mergeSelectedOrderState(detailState, selectedOrder);
      }
      const rowRelated = Boolean(
        result.bindingApplied?.length ||
        includesLoose(result.text, row.userId) ||
        includesLoose(JSON.stringify(result.data || {}), row.userId) ||
        includesLoose(`${item.request.url || ""}\n${item.request.postData || ""}`, row.userId)
      );
      const extracted = extractProfileCandidates(result.data, row).map((candidate) => ({
        ...candidate,
        rowRelated
      }));
      candidateCount += extracted.length;
      const endpointCandidates = extracted.map((candidate) => ({
        ...candidate,
        endpoint,
        sourceRole: item.role || "",
        sourceTrust: detailLike ? "detail" : item.role === "orderList" ? "order-list" : "list"
      }));
      candidates.push(...endpointCandidates);
      if (detailLike) detailCandidates.push(...endpointCandidates);
    }

    const detailError = profileDetailValidationError(detailState, lastError);
    const fieldCandidate = buildProfileFieldCandidate(detailCandidates, row, detailState);
    const strictCandidates = detailError ? [] : detailCandidates;
    const selected = fieldCandidate.isComplete ? fieldCandidate : selectDetailProfileCandidate(strictCandidates, row, detailState);
    if (!selected || !selected.actualProductType || !selected.actualCampName || !selected.actualCourseCategory) {
      const partial = withOrderProductPartial(
        mergePartialWithFieldCandidate(summarizePartialProfileFields(strictCandidates.filter((candidate) => candidate.rowRelated)), fieldCandidate),
        detailState
      );
      if (detailError) {
        const profileError = buildProfileFieldError(fieldCandidate, detailState, detailError);
        return {
          ...emptyProfile(profileError),
          ...detailState,
          profileSource: "chanceAssApi",
          profileFound: fieldCandidate.hasAny,
          profileCandidateCount: candidateCount,
          profilePartialFields: partial,
          profileSelectedReason: fieldCandidate.hasAny ? "Q/R/S按列独立提取，部分字段缺失" : "",
          profileExtractor: fieldCandidate.hasAny ? "local-partial" : "",
          profileExtractConfidence: fieldCandidate.hasAny ? 1 : 0,
          profileExtractReason: fieldCandidate.reason || "",
          profileEvidenceFields: fieldCandidate.evidenceFields || {},
          actualProductType: fieldCandidate.actualProductType || "",
          actualCampName: fieldCandidate.actualCampName || "",
          actualCourseCategory: fieldCandidate.actualCourseCategory || "",
          actualProductTypeSource: fieldCandidate.actualProductTypeSource || "",
          actualCampNameSource: fieldCandidate.actualCampNameSource || "",
          actualCourseCategorySource: fieldCandidate.actualCourseCategorySource || "",
          profileApiTried: apiTried,
          profileBindingApplied: bindingApplied,
          profileMs: Date.now() - startedAt
        };
      }
      const llmProfile = await extractProfileWithLlm({
        row,
        responses: detailResponsePackets,
        localCandidates: strictCandidates.filter((candidate) => candidate.rowRelated),
        partial,
        settings: this.profileExtractorSettings
      });
      const mergedLlmProfile = normalizeLlmProfileCourseCategory(
        mergeOrderProductTypeIntoProfile(llmProfile, detailState),
        detailState
      );
      if (isValidLlmProfile(mergedLlmProfile, this.profileExtractorSettings)) {
        return {
          ...detailState,
          profileSource: "chanceAssApi",
          profileFound: true,
          profileCandidateCount: candidateCount,
          profileSelectedReason: mergedLlmProfile.profileExtractReason || "豆包按脱敏档案响应提取Q/R/S",
          profilePartialFields: partial,
          profileExtractor: mergedLlmProfile.profileExtractor,
          profileExtractConfidence: mergedLlmProfile.profileExtractConfidence,
          profileExtractReason: mergedLlmProfile.profileExtractReason,
          profileEvidenceFields: mergedLlmProfile.profileEvidenceFields,
          profileLlmError: "",
          profileSanitized: true,
          actualProductType: mergedLlmProfile.actualProductType,
          actualCampName: mergedLlmProfile.actualCampName,
          actualCourseCategory: mergedLlmProfile.actualCourseCategory,
          actualProductTypeSource: mergedLlmProfile.profileEvidenceFields?.productTypeField || "",
          actualCampNameSource: mergedLlmProfile.profileEvidenceFields?.campNameField || "",
          actualCourseCategorySource: mergedLlmProfile.profileEvidenceFields?.courseCategoryField || "",
          profileError: "",
          profileApiTried: apiTried,
          profileBindingApplied: bindingApplied,
          profileMs: Date.now() - startedAt
        };
      }
      const profileError = [
        buildProfileFieldError(fieldCandidate, detailState, lastError || `chanceAss未提取到完整Q/R/S字段${partial.summary ? `（${partial.summary}）` : ""}`),
        mergedLlmProfile.profileLlmError ? `豆包证据不足：${mergedLlmProfile.profileLlmError}` : ""
      ].filter(Boolean).join("；");
      return {
        ...emptyProfile(profileError),
        ...detailState,
        profileSource: "chanceAssApi",
        profileFound: fieldCandidate.hasAny,
        profileCandidateCount: candidateCount,
        profilePartialFields: partial,
        profileSelectedReason: fieldCandidate.hasAny ? "Q/R/S按列独立提取，部分字段缺失" : "",
        profileExtractor: fieldCandidate.hasAny ? "local-partial" : (mergedLlmProfile.profileExtractor || ""),
        profileExtractConfidence: mergedLlmProfile.profileExtractConfidence || 0,
        profileExtractReason: fieldCandidate.reason || mergedLlmProfile.profileExtractReason || "",
        profileEvidenceFields: fieldCandidate.evidenceFields || mergedLlmProfile.profileEvidenceFields || {},
        profileLlmError: mergedLlmProfile.profileLlmError || "",
        profileSanitized: Boolean(mergedLlmProfile.profileSanitized),
        actualProductType: fieldCandidate.actualProductType || "",
        actualCampName: fieldCandidate.actualCampName || "",
        actualCourseCategory: fieldCandidate.actualCourseCategory || "",
        actualProductTypeSource: fieldCandidate.actualProductTypeSource || "",
        actualCampNameSource: fieldCandidate.actualCampNameSource || "",
        actualCourseCategorySource: fieldCandidate.actualCourseCategorySource || "",
        profileApiTried: apiTried,
        profileBindingApplied: bindingApplied,
        profileMs: Date.now() - startedAt
      };
    }

    return {
      ...detailState,
      profileSource: "chanceAssApi",
      profileFound: true,
      profileCandidateCount: candidateCount,
      profileSelectedReason: selected.reason,
      profilePartialFields: mergePartialWithFieldCandidate(summarizePartialProfileFields(strictCandidates.filter((candidate) => candidate.rowRelated)), selected),
      profileExtractor: "local",
      profileExtractConfidence: 1,
      profileExtractReason: selected.reason,
      profileEvidenceFields: selected.evidenceFields || {},
      profileLlmError: "",
      profileSanitized: false,
      actualProductType: selected.actualProductType,
      actualCampName: selected.actualCampName,
      actualCourseCategory: selected.actualCourseCategory,
      actualProductTypeSource: selected.actualProductTypeSource || selected.evidenceFields?.productTypeField || "",
      actualCampNameSource: selected.actualCampNameSource || selected.evidenceFields?.campNameField || "",
      actualCourseCategorySource: selected.actualCourseCategorySource || selected.evidenceFields?.courseCategoryField || "",
      profileError: "",
      profileApiTried: apiTried,
      profileBindingApplied: bindingApplied,
      profileMs: Date.now() - startedAt
    };
  }

  async callTemplate(template, { row, timeoutMs, bindingData = [] } = {}) {
    const request = renderRequest(template, this.map, row, bindingData);
    const timeout = Number(timeoutMs || this.chance.timeoutMs || DEFAULT_CHANCE.timeoutMs);
    const result = await this.page.evaluate(async ({ request, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
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
        return { ok: response.ok, status: response.status, text, data };
      } catch (error) {
        return { ok: false, status: 0, text: "", data: null, error: error.message };
      } finally {
        clearTimeout(timer);
      }
    }, { request, timeout });
    return {
      ...result,
      bindingApplied: request.bindingApplied || []
    };
  }

  async close() {
    await this.page.close().catch(() => {});
    if (this.ownsContext) await this.context.close().catch(() => {});
  }
}

function profileRequestsFromMap(map) {
  const profile = map?.profile || {};
  const detail = profile.orderDetailRequest;
  if (!detail?.request) {
    return {
      ready: false,
      error: "chanceAss映射未包含已验证详情接口，请重新运行 npm run chance:discover -- --debug-row 3 --keep-open"
    };
  }
  const requests = [];
  const seen = new Set();
  const addRequest = (role, item) => {
    const request = item?.request || item;
    if (!request) return;
    const signature = `${request.method || "GET"}:${request.url || ""}:${request.postData || ""}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    requests.push({ role, request });
  };
  addRequest("search", profile.searchRequest);
  addRequest("orderList", profile.orderListRequest);
  addRequest("orderDetail", detail);
  for (const item of map?.requests || []) {
    addRequest(inferProfileRequestRole(item.request), item.request);
  }
  const validation = profile.validation || {};
  const hasCampNameSource = validation.hasTrainingName || validation.hasOrderProductName;
  const hasProductTypeSource = validation.hasCampTypeId || validation.hasOrderProductType;
  if (!hasCampNameSource || !validation.hasCategory || !hasProductTypeSource) {
    return {
      ready: false,
      error: `chanceAss映射字段不完整（${missingProfileValidationFields({
        hasTrainingName: validation.hasTrainingName,
        hasCategory: validation.hasCategory,
        hasCampTypeId: validation.hasCampTypeId,
        hasOrderProductType: validation.hasOrderProductType,
        hasOrderProductName: validation.hasOrderProductName
      })}），请重新运行 npm run chance:discover -- --debug-row 3 --keep-open`
    };
  }
  return {
    ready: true,
    requests
  };
}

function inferProfileRequestRole(request = {}) {
  const url = String(request.url || "");
  const body = String(request.postData || "");
  if (/saleUserAssignRef\/listV2|chanceAss|assign/i.test(url)) return "search";
  if (/userArchive\/orderDetail|订单信息|主订单|购买体验营|购买正式营/i.test(`${url}\n${body}`)) return "orderList";
  if (/intentionActCharge|charge|finance|order|userCamp|permission|商品信息|所属品类|训练营名称/i.test(`${url}\n${body}`)) return "orderDetailProbe";
  return "profileProbe";
}

function isOrderDetailRole(role = "") {
  return role === "orderDetail" || role === "orderDetailProbe" || role === "profileProbe";
}

function profileMapIsValid(map) {
  const profile = map?.profile || {};
  const validation = profile.validation || {};
  return Boolean(
    profile.orderDetailRequest?.request &&
    (validation.hasTrainingName || validation.hasOrderProductName) &&
    validation.hasCategory &&
    (validation.hasCampTypeId || validation.hasOrderProductType)
  );
}

function createProfileDetailState() {
  return {
    profileDetailEndpointMatched: false,
    profileDetailHasTrainingName: false,
    profileDetailHasCategory: false,
    profileDetailHasCampTypeId: false,
    profileDetailLabels: [],
    profileOrderListHasProductType: false,
    profileOrderListProductType: "",
    profileOrderListLabels: [],
    profileOrderCardProductName: "",
    profileOrderCandidates: [],
    profileFormalOrderFound: false,
    profileMatchedOrderType: "",
    profileMatchedOrderName: "",
    profileMatchedOrderId: "",
    profileOrderSelectionReason: "",
    profileCampNameFallbackUsed: false,
    profileCampNameFallbackSource: "",
    profileCampNameRejectedReason: "",
    actualCourseCategoryRaw: "",
    actualCourseCategoryNormalized: "",
    actualCourseCategorySourceTrust: "",
    profileCourseCategoryRejectedSource: "",
    profileCourseCategoryConflictReason: ""
  };
}

function mergeProfileDetailState(state, flags = {}) {
  state.profileDetailHasTrainingName = Boolean(state.profileDetailHasTrainingName || flags.hasTrainingName);
  state.profileDetailHasCategory = Boolean(state.profileDetailHasCategory || flags.hasCategory);
  state.profileDetailHasCampTypeId = Boolean(state.profileDetailHasCampTypeId || flags.hasCampTypeId);
  state.profileDetailLabels = uniqueValues([...(state.profileDetailLabels || []), ...(flags.labels || [])]);
}

function mergeOrderListState(state, flags = {}) {
  state.profileOrderListHasProductType = Boolean(state.profileOrderListHasProductType || flags.hasProductType);
  if (!state.profileOrderListProductType && flags.productType) state.profileOrderListProductType = flags.productType;
  if (!state.profileOrderCardProductName && flags.productName) state.profileOrderCardProductName = flags.productName;
  if (!state.profileCampNameFallbackUsed && flags.productName) {
    const fallback = validateOrderCardCampName(flags.productName);
    if (fallback.value) {
      state.profileCampNameFallbackUsed = true;
      state.profileCampNameFallbackSource = "订单信息页选中订单商品名称兜底";
    } else {
      state.profileCampNameRejectedReason = fallback.reason;
    }
  }
  state.profileOrderListLabels = uniqueValues([...(state.profileOrderListLabels || []), ...(flags.labels || [])]);
}

function mergeOrderCandidatesState(state, candidates = []) {
  state.profileOrderCandidates = uniqueOrderCandidates([...(state.profileOrderCandidates || []), ...candidates]);
  state.profileFormalOrderFound = state.profileOrderCandidates.some((candidate) => normalizeProductType(candidate.productType) === "正式营");
  const labels = candidates.flatMap((candidate) => [
    candidate.productType ? `订单候选${candidate.index + 1 || ""}=${candidate.productType}` : "",
    candidate.productName ? `订单商品名称=${candidate.productName}` : "",
    candidate.orderId ? `订单ID=${maskIdentifier(candidate.orderId)}` : ""
  ]);
  state.profileOrderListLabels = uniqueValues([...(state.profileOrderListLabels || []), ...labels]);
}

function mergeSelectedOrderState(state, selectedOrder = null) {
  if (!selectedOrder || selectedOrder.isNullSelection) {
    state.profileFormalOrderFound = Boolean(state.profileFormalOrderFound || selectedOrder?.formalOrderFound);
    if (!state.profileOrderSelectionReason) state.profileOrderSelectionReason = "未按L/M匹配到可靠订单";
    if (selectedOrder?.selectionReason) state.profileOrderSelectionReason = selectedOrder.selectionReason;
    return;
  }
  state.profileOrderListHasProductType = Boolean(selectedOrder.productType || state.profileOrderListHasProductType);
  state.profileOrderListProductType = selectedOrder.productType || state.profileOrderListProductType || "";
  state.profileOrderCardProductName = selectedOrder.productName || state.profileOrderCardProductName || "";
  state.profileMatchedOrderType = selectedOrder.productType || "";
  state.profileMatchedOrderName = selectedOrder.productName || "";
  state.profileMatchedOrderId = selectedOrder.orderId || selectedOrder.campId || selectedOrder.assignRefId || "";
  state.profileOrderSelectionReason = selectedOrder.selectionReason || "";
  if (selectedOrder.productName) {
    const fallback = validateOrderCardCampName(selectedOrder.productName, {
      allowMatchedProductName: selectedOrder.nameScore >= 0.35 || normalizeProductType(selectedOrder.productType) === "正式营",
      matchScore: selectedOrder.nameScore || 0
    });
    if (fallback.value) {
      state.profileCampNameFallbackUsed = true;
      state.profileCampNameFallbackSource = "订单信息页选中订单商品名称兜底";
      state.profileCampNameRejectedReason = "";
    } else {
      state.profileCampNameFallbackUsed = false;
      state.profileCampNameFallbackSource = "";
      state.profileCampNameRejectedReason = fallback.reason;
    }
  }
  state.profileOrderListLabels = uniqueValues([
    ...(state.profileOrderListLabels || []),
    selectedOrder.productType ? `选中订单类型=${selectedOrder.productType}` : "",
    selectedOrder.productName ? `选中订单名称=${selectedOrder.productName}` : "",
    state.profileMatchedOrderId ? `选中订单ID=${maskIdentifier(state.profileMatchedOrderId)}` : ""
  ]);
}

function profileDetailValidationError(state, lastError = "") {
  if (!state.profileDetailEndpointMatched) {
    return lastError ? `详情接口未返回有效响应（${lastError}）` : "详情接口未返回有效响应";
  }
  const missing = [];
  if (!state.profileDetailHasTrainingName && !state.profileCampNameFallbackUsed) missing.push("详情接口缺训练营名称字段");
  if (!state.profileDetailHasCategory) missing.push("详情接口缺所属品类字段");
  if (!state.profileDetailHasCampTypeId && !state.profileOrderListHasProductType) {
    missing.push("订单列表/详情缺体验营或正式营判断字段");
  }
  return missing.join("，");
}

async function launchStandaloneContext(config, url) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("未安装 Playwright。请先运行 npm install。");
  }
  const browserConfig = config.browser || {};
  const context = await chromium.launchPersistentContext(browserConfig.userDataDir || ".browser-profile", {
    headless: Boolean(browserConfig.headless),
    viewport: { width: 1440, height: 960 }
  });
  const page = context.pages().find((item) => !item.isClosed()) || await context.newPage();
  page.setDefaultTimeout(browserConfig.timeoutMs || 30000);
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  return { context, page, ownsContext: true };
}

async function pageFromExistingContext(context, url) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  return { context, page, ownsContext: false };
}

function createRecorder(page) {
  const requests = new Map();
  const events = [];

  const onRequest = (request) => {
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    const url = request.url();
    requests.set(request, {
      at: Date.now(),
      method: request.method(),
      url,
      headers: safeHeaders(request.headers()),
      postData: request.postData() || ""
    });
  };

  const onResponse = async (response) => {
    const request = response.request();
    const req = requests.get(request);
    if (!req) return;
    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    let body = "";
    if (/json|text|javascript/.test(contentType)) body = await response.text().catch(() => "");
    events.push({
      request: req,
      response: {
        at: Date.now(),
        status: response.status(),
        url: response.url(),
        contentType,
        body: body.slice(0, 1024 * 1024 * 2),
        data: parseJsonMaybe(body)
      }
    });
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  return {
    events,
    detach() {
      page.off("request", onRequest);
      page.off("response", onResponse);
    }
  };
}

async function readVisibleProfileFlags(page) {
  const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const detail = analyzeProfileDetailData({}, text);
  const order = analyzeOrderListProductType({}, text);
  return {
    ...detail,
    hasOrderProductType: order.hasProductType,
    hasOrderProductName: Boolean(order.productName),
    productType: order.productType,
    productName: order.productName,
    labels: uniqueValues([...(detail.labels || []), ...(order.labels || [])])
  };
}

function buildChanceApiMap({ events, row, config, visible = {} }) {
  const viableEvents = events
    .map((event, index) => ({ event, index, score: scoreChanceEvent(event, row) }))
    .filter((item) => item.event.response.status >= 200 && item.event.response.status < 400);
  const detailCandidates = viableEvents
    .map((item) => {
      const validation = analyzeProfileDetailData(item.event.response.data, item.event.response.body);
      return {
        ...item,
        validation,
        detailScore: scoreProfileDetailEvent(item.event, row, validation)
      };
    })
    .filter((item) => item.validation.hasCategory && item.detailScore >= 30)
    .sort((a, b) => b.detailScore - a.detailScore || b.index - a.index);
  let detail = detailCandidates[0];
  if (!detail) {
    const bestFlags = viableEvents
      .map((item) => analyzeProfileDetailData(item.event.response.data, item.event.response.body))
      .sort((a, b) => detailFlagScore(b) - detailFlagScore(a))[0] || {};
    if (visible.hasCategory) {
      const fallback = bestVisibleBackedDetailEvent(viableEvents, row);
      if (!fallback) {
        throw new Error(`chanceAss接口发现失败：页面已看到所属品类，但未捕获到可复用的订单详情接口。请返回订单信息页点一次“查看详情”或刷新后再按回车。`);
      }
      detail = {
        ...fallback,
        validation: {
          hasTrainingName: Boolean(visible.hasTrainingName),
          hasCategory: true,
          hasCampTypeId: Boolean(visible.hasCampTypeId),
          labels: visible.labels || []
        },
        detailScore: fallback.score + 60,
        visibleFallbackUsed: true
      };
    } else {
      throw new Error(`chanceAss接口发现失败：未捕获到详情页红框字段（${missingProfileValidationFields({
        ...bestFlags,
        hasOrderProductType: visible.hasOrderProductType,
        hasOrderProductName: visible.hasOrderProductName
      })}）。请确认已进入“商品信息”详情页，且页面已出现“所属品类”，订单信息页第一条订单有“购买体验营/购买正式营”和商品名称后再按回车。`);
    }
  }

  const search = viableEvents
    .filter((item) => item.index <= detail.index)
    .map((item) => ({ ...item, searchScore: scoreChanceSearchEvent(item.event, row) }))
    .filter((item) => item.searchScore >= 20)
    .sort((a, b) => b.searchScore - a.searchScore || a.index - b.index)[0] || null;
  let orderList = viableEvents
    .filter((item) => item.index <= detail.index && item.index !== search?.index && item.index !== detail.index)
    .map((item) => {
      const orderValidation = analyzeOrderListProductType(item.event.response.data, item.event.response.body);
      return {
        ...item,
        orderValidation,
        orderScore: scoreChanceOrderListEvent(item.event, row, orderValidation)
      };
    })
    .filter((item) => item.orderScore >= 20)
    .sort((a, b) => b.orderScore - a.orderScore || b.index - a.index)[0] || null;
  if (!orderList && visible.hasOrderProductType) {
    orderList = bestVisibleBackedOrderEvent(viableEvents, row, detail.index, search?.index);
    if (orderList) {
      orderList.orderValidation = {
        hasProductType: true,
        productType: visible.productType || "",
        productName: visible.productName || "",
        labels: visible.labels || []
      };
      orderList.orderScore = orderList.score + 40;
      orderList.visibleFallbackUsed = true;
    }
  }
  const hasProductTypeSource = detail.validation.hasCampTypeId || Boolean(orderList?.orderValidation?.hasProductType) || Boolean(visible.hasOrderProductType);
  if (!hasProductTypeSource) {
    throw new Error("chanceAss接口发现失败：已捕获所属品类，但未捕获到“购买体验营/购买正式营”。请回到订单信息页确认第一条订单类型可见，再点击查看详情后按回车。");
  }
  const hasCampNameSource = detail.validation.hasTrainingName || Boolean(orderList?.orderValidation?.productName) || Boolean(visible.hasOrderProductName);
  if (!hasCampNameSource) {
    throw new Error("chanceAss接口发现失败：已捕获所属品类和购买类型，但未捕获到详情页训练营名称或订单信息页商品名称。请回到订单信息页确认第一条订单卡片有商品名称，再点击查看详情后按回车。");
  }

  const scored = viableEvents
    .filter((item) => item.score >= 20)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const unique = [];
  const seen = new Set();
  for (const item of [search, orderList, detail, ...scored].filter(Boolean)) {
    const signature = `${item.event.request.method}:${sanitizeUrl(item.event.request.url)}:${normalizePostData(item.event.request.postData)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(item);
    if (unique.length >= 8) break;
  }
  if (!unique.length) {
    throw new Error("chanceAss接口发现失败：未捕获到包含用户ID或档案字段的接口。请确认已在页面用样本用户ID完成搜索。");
  }
  const ordered = [...unique].sort((a, b) => a.index - b.index);
  const profileRequests = {
    version: 2,
    searchRequest: search ? mapRequest("search", search, events, row) : null,
    orderListRequest: orderList ? mapRequest("orderList", orderList, events, row) : null,
    orderDetailRequest: mapRequest("orderDetail", detail, events, row),
    validation: {
      detailEndpoint: endpointName(detail.event.request.url),
      hasTrainingName: detail.validation.hasTrainingName,
      hasCategory: detail.validation.hasCategory,
      hasCampTypeId: detail.validation.hasCampTypeId,
      hasOrderProductType: Boolean(orderList?.orderValidation?.hasProductType || visible.hasOrderProductType),
      hasOrderProductName: Boolean(orderList?.orderValidation?.productName || visible.hasOrderProductName),
      orderProductType: orderList?.orderValidation?.productType || visible.productType || "",
      orderProductName: orderList?.orderValidation?.productName || visible.productName || "",
      productTypeSource: detail.validation.hasCampTypeId ? "orderDetail" : "orderList",
      orderMatchedLabels: uniqueValues([...(orderList?.orderValidation?.labels || []), ...(visible.hasOrderProductType ? visible.labels || [] : [])]),
      matchedLabels: detail.validation.labels,
      visibleFallbackUsed: Boolean(detail.visibleFallbackUsed)
    }
  };
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    source: {
      rowNumber: row.rowNumber,
      userId: String(row.userId || ""),
      sentAt: String(row.sentAt || ""),
      dataDate: String(row.dataDate || "")
    },
    chanceUrl: chanceConfig(config).url,
    profile: profileRequests,
    requests: ordered.map((item) => ({
      score: item.score,
      request: requestTemplate(item.event.request, bindingHintsForRequest(item.event.request, events.slice(0, item.index), row))
    })),
    responseHints: {
      capturedEvents: events.length,
      selectedRequests: unique.length,
      detailEndpoint: profileRequests.validation.detailEndpoint,
      detailMatchedLabels: profileRequests.validation.matchedLabels
    }
  };
}

function mapRequest(role, item, events, row) {
  const score = role === "orderDetail"
    ? item.detailScore
    : role === "search"
      ? item.searchScore || item.score
      : item.orderScore || item.score;
  return {
    role,
    score,
    endpoint: endpointName(item.event.request.url),
    request: requestTemplate(item.event.request, bindingHintsForRequest(item.event.request, events.slice(0, item.index), row))
  };
}

function bestVisibleBackedDetailEvent(events, row) {
  return events
    .map((item) => ({ ...item, fallbackScore: scoreVisibleBackedEvent(item.event, row, "detail") }))
    .filter((item) => item.fallbackScore >= 25)
    .sort((a, b) => b.fallbackScore - a.fallbackScore || b.index - a.index)[0] || null;
}

function bestVisibleBackedOrderEvent(events, row, beforeIndex = Infinity, searchIndex = -1) {
  return events
    .filter((item) => item.index <= beforeIndex && item.index !== searchIndex)
    .map((item) => ({ ...item, fallbackScore: scoreVisibleBackedEvent(item.event, row, "orderList") }))
    .filter((item) => item.fallbackScore >= 20)
    .sort((a, b) => b.fallbackScore - a.fallbackScore || b.index - a.index)[0] || null;
}

function scoreVisibleBackedEvent(event, row, role) {
  const text = `${event.request.url}\n${event.request.postData || ""}\n${event.response.body || JSON.stringify(event.response.data || {})}`;
  let score = 0;
  if (includesLoose(text, row.userId)) score += 20;
  if (/order|订单|charge|finance|archive|profile|detail|详情|userCamp|intention/i.test(text)) score += 35;
  if (/主订单|订单金额|商品名称|查看详情|orderId|mainOrder|开营时间|所在期数/i.test(text)) score += 25;
  if (/listV2|saleUserAssignRef/i.test(event.request.url)) score += role === "orderList" ? 20 : 5;
  if (arrayLikeCount(event.response.data) >= 1) score += 8;
  if (isLoginLikeResponse({ data: event.response.data, text: event.response.body })) score -= 100;
  return score;
}

function scoreChanceEvent(event, row) {
  const requestText = `${event.request.url}\n${event.request.postData || ""}`;
  const responseText = event.response.body || JSON.stringify(event.response.data || {});
  let score = 0;
  if (includesLoose(requestText, row.userId)) score += 40;
  if (includesLoose(responseText, row.userId)) score += 25;
  if (/训练营|品类|商品|课程|体验营|正式营|camp|course|category|goods|product/i.test(responseText)) score += 25;
  if (/chance|assign|sale|student|order|camp|course/i.test(event.request.url)) score += 10;
  if (arrayLikeCount(event.response.data) >= 1) score += 8;
  if (isLoginLikeResponse({ data: event.response.data, text: event.response.body })) score -= 80;
  return score;
}

function scoreChanceSearchEvent(event, row) {
  const requestText = `${event.request.url}\n${event.request.postData || ""}`;
  const responseText = event.response.body || JSON.stringify(event.response.data || {});
  let score = 0;
  if (/saleUserAssignRef\/listV2|chanceAss|assign|list/i.test(event.request.url)) score += 35;
  if (includesLoose(requestText, row.userId)) score += 35;
  if (includesLoose(responseText, row.userId)) score += 20;
  if (arrayLikeCount(event.response.data) >= 1) score += 10;
  if (isLoginLikeResponse({ data: event.response.data, text: event.response.body })) score -= 80;
  return score;
}

function scoreChanceOrderListEvent(event, row, validation = analyzeOrderListProductType(event.response.data, event.response.body)) {
  const text = `${event.request.url}\n${event.request.postData || ""}\n${event.response.body || JSON.stringify(event.response.data || {})}`;
  let score = 0;
  if (/order|订单|charge|finance|archive|profile|userCamp|intention/i.test(text)) score += 25;
  if (/主订单|订单金额|商品名称|查看详情|orderId|mainOrder/i.test(text)) score += 20;
  if (validation.hasProductType) score += 35;
  if (includesLoose(text, row.userId)) score += 10;
  if (arrayLikeCount(event.response.data) >= 1) score += 10;
  if (isLoginLikeResponse({ data: event.response.data, text: event.response.body })) score -= 80;
  return score;
}

function scoreProfileDetailEvent(event, row, validation = analyzeProfileDetailData(event.response.data, event.response.body)) {
  const text = `${event.request.url}\n${event.request.postData || ""}\n${event.response.body || JSON.stringify(event.response.data || {})}`;
  let score = detailFlagScore(validation);
  if (/detail|order|订单|finance|charge|archive|商品信息|详情/i.test(text)) score += 25;
  if (/listV2|列表|分页/.test(event.request.url)) score -= 25;
  if (includesLoose(text, row.userId)) score += 8;
  if (isLoginLikeResponse({ data: event.response.data, text: event.response.body })) score -= 100;
  return score;
}

function analyzeProfileDetailData(data, text = "") {
  const fields = flattenPrimitiveFields(data || {});
  const fieldLines = fields.map((field) => `${field.keyPath}:${field.value}`).join("\n");
  const raw = `${text || ""}\n${JSON.stringify(data || {})}\n${fieldLines}`;
  const trainingFields = fields.filter((field) => isTrainingNameField(field) && hasMeaningfulProfileValue(field.value));
  const categoryFields = fields.filter((field) => isCategoryField(field) && hasMeaningfulProfileValue(field.value));
  const campTypeFields = fields.filter((field) => isCampTypeIdField(field) && hasMeaningfulId(field.value));
  const textTraining = /(训练\s*营\s*名称|营\s*名称)\s*[:：]\s*[^,，\n\r}]{2,}/.test(raw) ||
    /"?training(?:CampName|_camp_name)"?\s*[:=]\s*"?[^",，\n\r}]{2,}"?/i.test(raw);
  const textCategory = /(所属\s*品\s*类|课程\s*品\s*类|品\s*类\s*名称)\s*[:：]\s*[^,，\n\r}]{2,}/.test(raw) ||
    /"?(?:categoryName|category_name|courseCategory|course_category)"?\s*[:=]\s*"?[^",，\n\r}]{2,}"?/i.test(raw);
  const textCampType = /(正式\s*营\s*ID|体验\s*营\s*ID)\s*[:：]\s*[\w-]{2,}/.test(raw) ||
    /"?(?:formal|official|experience|trial)[\w]*(?:Camp|Finance|Product)?Id"?\s*[:=]\s*"?[\w-]{2,}"?/i.test(raw);
  const labels = uniqueValues([
    ...trainingFields.map((field) => `训练营名称=${field.value}`),
    ...categoryFields.map((field) => `所属品类=${field.value}`),
    ...campTypeFields.map((field) => `${campTypeLabel(field)}=${maskIdentifier(field.value)}`)
  ]);
  return {
    hasTrainingName: trainingFields.length > 0 || textTraining,
    hasCategory: categoryFields.length > 0 || textCategory,
    hasCampTypeId: campTypeFields.length > 0 || textCampType,
    labels: labels.slice(0, 12)
  };
}

function analyzeOrderListProductType(data, text = "") {
  const candidates = [];
  let visitIndex = 0;
  walkWithPath(data, (value, pathValue) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const fields = flattenPrimitiveFields(value);
    const itemText = JSON.stringify(value);
    const productType = inferProductTypeFromOrderText(itemText);
    const productName = findGoodsName(fields) || extractOrderCardProductNameFromText(itemText);
    if (!productType && !productName) return;
    candidates.push({
      productType,
      productName,
      index: visitIndex++,
      path: pathValue.join("."),
      time: bestTime(fields)
    });
  });
  const textType = inferProductTypeFromOrderText(text);
  const textProductName = extractOrderCardProductNameFromText(text);
  if (textType || textProductName) {
    candidates.push({ productType: textType, productName: textProductName, index: candidates.length ? 999 : 0, path: "visible/orderListText", time: null });
  }
  candidates.sort((a, b) => a.index - b.index);
  const productTypeCandidate = candidates.find((candidate) => candidate.productType) || null;
  const productNameCandidate = candidates.find((candidate) => candidate.productName) || null;
  return {
    hasProductType: Boolean(productTypeCandidate?.productType),
    productType: productTypeCandidate?.productType || "",
    productName: productNameCandidate?.productName || "",
    labels: [
      productTypeCandidate?.productType ? `订单信息第一条=${productTypeCandidate.productType}` : "",
      productNameCandidate?.productName ? `订单商品名称=${productNameCandidate.productName}` : ""
    ].filter(Boolean)
  };
}

function extractOrderCandidates(data, text = "", row = {}, endpoint = "") {
  const candidates = [];
  let visitIndex = 0;
  walkWithPath(data, (value, pathValue) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const fields = flattenPrimitiveFields(value);
    const itemText = JSON.stringify(value);
    const productType = normalizeProductType(inferProductTypeFromOrderText(itemText) || inferProductTypeFromExactFields(fields));
    const productName = findGoodsName(fields) || extractOrderCardProductNameFromText(itemText);
    const ids = extractOrderBindingIds(fields);
    if (!productType && !productName && !Object.values(ids).some(Boolean)) return;
    const candidate = {
      index: visitIndex++,
      path: pathValue.join("."),
      endpoint,
      productType,
      productName,
      orderId: ids.orderId,
      mainOrderId: ids.mainOrderId || ids.orderId,
      campId: ids.campId,
      financeId: ids.financeId || ids.campId,
      goodsId: ids.goodsId,
      productId: ids.productId || ids.goodsId,
      assignRefId: ids.assignRefId,
      categoryId: ids.categoryId,
      time: bestTime(fields),
      statusScore: statusScore(fields),
      textScore: includesLoose(itemText, row.userId) ? 10 : 0,
      rawText: itemText.slice(0, 2000)
    };
    candidate.bindingData = orderBindingData(candidate);
    candidates.push(candidate);
  });

  const textType = normalizeProductType(inferProductTypeFromOrderText(text));
  const textProductName = extractOrderCardProductNameFromText(text);
  if (textType || textProductName) {
    const candidate = {
      index: candidates.length ? 999 : 0,
      path: "visible/orderListText",
      endpoint,
      productType: textType,
      productName: textProductName,
      orderId: "",
      mainOrderId: "",
      campId: "",
      financeId: "",
      goodsId: "",
      productId: "",
      assignRefId: "",
      categoryId: "",
      time: null,
      statusScore: 0,
      textScore: 0,
      rawText: String(text || "").slice(0, 2000)
    };
    candidate.bindingData = orderBindingData(candidate);
    candidates.push(candidate);
  }

  return uniqueOrderCandidates(candidates)
    .sort((a, b) => a.index - b.index)
    .slice(0, 30);
}

function extractOrderBindingIds(fields) {
  return {
    orderId: findIdFieldValue(fields, [/main.*order.*id/i, /order.*id/i, /主订单|订单ID/i], "orderId"),
    mainOrderId: findIdFieldValue(fields, [/main.*order.*id/i, /主订单/i], "orderId"),
    campId: findIdFieldValue(fields, [/camp.*id/i, /course.*id/i, /营.*id/i, /课程.*id/i], "campId"),
    financeId: findIdFieldValue(fields, [/financial|finance|正式营|体验营/i], "campId"),
    goodsId: findIdFieldValue(fields, [/goods.*id/i, /product.*id/i, /商品ID/i], "goodsId"),
    productId: findIdFieldValue(fields, [/product.*id/i, /goods.*id/i, /商品ID/i], "goodsId"),
    assignRefId: findIdFieldValue(fields, [/assign.*ref/i, /reception/i, /target.*id/i], "assignRefId"),
    categoryId: findIdFieldValue(fields, [/category.*id/i, /cate.*id/i, /品类.*id/i], "categoryId")
  };
}

function findIdFieldValue(fields, preferredPatterns = [], expectedKind = "") {
  const ranked = fields
    .map((field) => {
      const value = cleanProfileValue(field.value);
      if (!hasMeaningfulId(value) || !isBindableValue(value)) return null;
      const keyPath = String(field.keyPath || "");
      let score = 0;
      if (expectedKind && bindingKind(keyPath) === expectedKind) score += 30;
      if (preferredPatterns.some((pattern) => pattern.test(keyPath))) score += 50;
      if (/id|编号|订单|营|课|商品|goods|order|finance|camp|course/i.test(keyPath)) score += 10;
      if (/^\d{6,}$/.test(value)) score += 5;
      return { value, score };
    })
    .filter(Boolean)
    .filter((item) => item.score >= 30)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.value || "";
}

function uniqueOrderCandidates(candidates = []) {
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    const signature = [
      candidate.orderId || "",
      candidate.campId || "",
      candidate.goodsId || "",
      candidate.assignRefId || "",
      normalizeProductType(candidate.productType),
      normalizeCampText(candidate.productName),
      candidate.path || ""
    ].join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);
    output.push(candidate);
  }
  return output;
}

function selectOrderForRow(candidates = [], row = {}) {
  const useful = uniqueOrderCandidates(candidates).filter((candidate) =>
    candidate.productType || candidate.productName || candidate.orderId || candidate.campId || candidate.assignRefId
  );
  const docType = normalizeProductType(row.docProductType);
  const docName = cleanProfileValue(row.docCampName);
  const formalOrders = useful.filter((candidate) => normalizeProductType(candidate.productType) === "正式营");
  const experienceOrders = useful.filter((candidate) => normalizeProductType(candidate.productType) === "体验营");
  let pool = useful;
  let targetType = docType;
  const reasonParts = [];

  if (docType === "正式营") {
    pool = formalOrders;
    reasonParts.push("L=正式营，仅匹配正式营订单");
  } else if (docType === "体验营") {
    if (formalOrders.length) {
      pool = formalOrders;
      targetType = "正式营";
      reasonParts.push("L=体验营但存在正式营订单，优先正式营");
    } else {
      pool = experienceOrders;
      reasonParts.push("L=体验营且未发现正式营订单，匹配体验营订单");
    }
  } else {
    reasonParts.push("L列为空或无法归一化，沿用订单候选综合选择");
  }

  if (!pool.length) {
    return nullSelection(useful, `${reasonParts.join("；")}；未找到符合类型的订单候选`);
  }

  const sentAt = parseExcelDateTime(row.sentAt) || parseDataDate(row.dataDate);
  const ranked = pool
    .map((candidate) => {
      const nameScore = campNameMatchScore(docName, candidate.productName);
      let score = 0;
      if (targetType && normalizeProductType(candidate.productType) === targetType) score += 120;
      if (candidate.productType) score += 20;
      if (candidate.productName) score += 15;
      score += nameScore * 100;
      score += Number(candidate.statusScore || 0);
      if (sentAt && candidate.time) score += Math.max(0, 40 - Math.abs(candidate.time.getTime() - sentAt.getTime()) / 864e5);
      score += Math.max(0, 20 - Number(candidate.index || 0));
      return {
        ...candidate,
        nameScore,
        selectionScore: score
      };
    })
    .sort((a, b) => b.selectionScore - a.selectionScore || a.index - b.index);

  const best = ranked[0] || null;
  if (!best) return nullSelection(useful, `${reasonParts.join("；")}；没有可排序订单候选`);

  const strictNameRequired = Boolean(docName) && (
    docType === "正式营" ||
    (docType === "体验营" && !formalOrders.length)
  );
  if (strictNameRequired && best.nameScore < 0.35) {
    return nullSelection(useful, `${reasonParts.join("；")}；M列“${docName}”与候选订单名称相似度不足，最高${best.nameScore.toFixed(2)}`);
  }

  const selectionReason = [
    ...reasonParts,
    docName ? `M列匹配分${best.nameScore.toFixed(2)}` : "M列为空，按类型/状态/时间选择",
    best.statusScore ? `状态分${best.statusScore}` : "",
    best.time ? `订单时间${formatDateTime(best.time)}` : "",
    `原始排序${best.index + 1}`
  ].filter(Boolean).join("；");

  return {
    ...best,
    selectionReason,
    formalOrderFound: formalOrders.length > 0
  };
}

function nullSelection(candidates, reason) {
  return {
    productType: "",
    productName: "",
    orderId: "",
    campId: "",
    assignRefId: "",
    bindingData: null,
    formalOrderFound: candidates.some((candidate) => normalizeProductType(candidate.productType) === "正式营"),
    selectionReason: reason,
    isNullSelection: true
  };
}

function orderBindingData(order) {
  if (!order || order.isNullSelection) return null;
  return {
    __selectedOrderBinding: "1",
    orderId: order.orderId || order.mainOrderId || "",
    mainOrderId: order.mainOrderId || order.orderId || "",
    campId: order.campId || order.financeId || "",
    financeId: order.financeId || order.campId || "",
    goodsId: order.goodsId || order.productId || "",
    productId: order.productId || order.goodsId || "",
    assignRefId: order.assignRefId || "",
    categoryId: order.categoryId || "",
    data: [{
      orderId: order.orderId || order.mainOrderId || "",
      mainOrderId: order.mainOrderId || order.orderId || "",
      campId: order.campId || order.financeId || "",
      financeId: order.financeId || order.campId || "",
      goodsId: order.goodsId || order.productId || "",
      productId: order.productId || order.goodsId || "",
      assignRefId: order.assignRefId || "",
      categoryId: order.categoryId || ""
    }]
  };
}

function normalizeProductType(value) {
  const text = cleanProfileValue(value);
  if (/正式营|正价课|正式课|购买正式/.test(text)) return "正式营";
  if (/体验营|体验课|体验班|购买体验/.test(text)) return "体验营";
  return "";
}

function normalizeCampText(value) {
  return cleanProfileValue(value)
    .toLowerCase()
    .replace(/[【】\[\]（）(){}<>《》「」『』]/g, "")
    .replace(/[\s,，.。:：;；!！?？'"“”‘’、/_\\|+\-—~·]/g, "")
    .replace(/第?\d+期|第?[一二三四五六七八九十百]+期/g, "")
    .replace(/副本|低价|高价|直投|投放|推广|视频号|小程序|腾讯知定|腾讯-知定|jf|黄色|蓝色|红色|主营|旧营|新营/gi, "");
}

function campNameMatchScore(docName, orderName) {
  const doc = normalizeCampText(docName);
  const order = normalizeCampText(orderName);
  if (!doc || !order) return 0;
  if (doc === order) return 1;
  if (doc.includes(order) || order.includes(doc)) return Math.min(0.95, Math.min(doc.length, order.length) / Math.max(doc.length, order.length) + 0.25);
  return bigramDice(doc, order);
}

function bigramDice(a, b) {
  if (!a || !b) return 0;
  if (a.length === 1 || b.length === 1) return a === b ? 1 : 0;
  const grams = (text) => {
    const output = [];
    for (let i = 0; i < text.length - 1; i += 1) output.push(text.slice(i, i + 2));
    return output;
  };
  const left = grams(a);
  const right = grams(b);
  const counts = new Map();
  for (const gram of left) counts.set(gram, (counts.get(gram) || 0) + 1);
  let overlap = 0;
  for (const gram of right) {
    const current = counts.get(gram) || 0;
    if (!current) continue;
    counts.set(gram, current - 1);
    overlap += 1;
  }
  return (2 * overlap) / (left.length + right.length);
}

function inferProductTypeFromOrderText(text) {
  const value = cleanProfileValue(text);
  if (/购买\s*正式营|正式营/.test(value) && !/购买\s*体验营/.test(value)) return "正式营";
  if (/购买\s*体验营|体验营/.test(value)) return "体验营";
  return "";
}

function extractOrderCardProductNameFromText(text) {
  const value = cleanProfileValue(text);
  const match = value.match(/商品名称\s*[:：]\s*([^,，\n\r]+?)(?=\s+(支付方式|分销人ID|所属部门|所在期数|开营时间|订单金额|订单类型|销售归属人)\s*[:：]|$)/);
  return cleanProfileValue(match?.[1] || "");
}

function validateOrderCardCampName(value, options = {}) {
  const text = cleanProfileValue(value);
  if (!text) return { value: "", reason: "订单商品名称为空" };
  if (text.length < 4 || text.length > 60) return { value: "", reason: `订单商品名称长度不可靠：${text}` };
  if (/视频号|直投|小程序|投放|推广|\bJF\b|低价|副本|\d+\s*元|腾讯-知定|渠道|黄色|蓝色|红色|落地页|表单|私域/i.test(text)) {
    return { value: "", reason: `订单商品名称疑似投放/商品字段：${text}` };
  }
  if (!/(营|课|训练|课程|正式|体验|班|期)/.test(text)) {
    if (options.allowMatchedProductName) {
      return { value: text, reason: "" };
    }
    return { value: "", reason: `订单商品名称不像训练营名称：${text}` };
  }
  return { value: text, reason: "" };
}

function isTrainingNameField(field) {
  const keyPath = String(field.keyPath || "");
  if (!TRAINING_NAME_PATTERN.test(keyPath)) return false;
  if (/商品名称|投放|推广|activity|goods|product|sku|category/i.test(keyPath)) return false;
  if (/(^|[.[_])campName$/i.test(keyPath) || /(^|[.[_])camp_name$/i.test(keyPath)) return false;
  return true;
}

function isCategoryField(field) {
  return CATEGORY_PATTERN.test(field.keyPath);
}

function isCampTypeIdField(field) {
  return CAMP_TYPE_ID_PATTERN.test(field.keyPath);
}

function campTypeLabel(field) {
  if (/正式营|formal|official/i.test(field.keyPath)) return "正式营ID";
  if (/体验营|experience|trial/i.test(field.keyPath)) return "体验营ID";
  return "营ID";
}

function hasMeaningfulProfileValue(value) {
  const text = cleanProfileValue(value);
  return Boolean(text && text !== "-" && !/^null|undefined|无|暂无$/i.test(text));
}

function detailFlagScore(flags = {}) {
  return (flags.hasTrainingName ? 35 : 0) + (flags.hasCategory ? 30 : 0) + (flags.hasCampTypeId ? 35 : 0);
}

function missingDetailFields(flags = {}) {
  const missing = [];
  if (!flags.hasTrainingName && !flags.hasOrderProductName) missing.push("缺详情训练营名称或订单页商品名称");
  if (!flags.hasCategory) missing.push("缺所属品类");
  if (!flags.hasCampTypeId && !flags.hasOrderProductType) missing.push("缺订单页购买体验营/购买正式营或详情页营ID");
  return missing.length ? missing.join("、") : "字段完整";
}

function missingProfileValidationFields(flags = {}) {
  const missing = [];
  if (!flags.hasTrainingName && !flags.hasOrderProductName) missing.push("缺详情训练营名称或订单页商品名称");
  if (!flags.hasCategory) missing.push("缺所属品类");
  if (!flags.hasCampTypeId && !flags.hasOrderProductType) missing.push("缺订单页购买体验营/购买正式营或详情页营ID");
  return missing.length ? missing.join("、") : "字段完整";
}

function requestTemplate(request, bindings = []) {
  return {
    method: request.method || "GET",
    url: sanitizeUrl(request.url || ""),
    headers: safeHeaders(request.headers || {}),
    postData: request.postData || "",
    bindings
  };
}

function renderRequest(template, map, row = {}, bindingData = []) {
  const source = map.source || {};
  const bindingApplied = [];
  let url = replaceKnownValues(template.url || "", source, row);
  let body = replaceKnownValues(template.postData || "", source, row);
  url = applyRequestBindings(url, template.bindings || [], bindingData, row, bindingApplied, "url");
  body = applyRequestBindings(body, template.bindings || [], bindingData, row, bindingApplied, "body");
  url = rewriteQuery(url, row);
  body = rewriteBody(body, template.headers || {}, row);
  return {
    method: template.method || "GET",
    url,
    headers: template.headers || {},
    body,
    bindingApplied
  };
}

function replaceKnownValues(value, source, row) {
  let result = String(value || "");
  for (const [from, to] of [[source.userId, row.userId]]) {
    if (!from || to === undefined || to === null) continue;
    result = replaceAll(result, String(from), String(to));
  }
  return result;
}

function rewriteQuery(rawUrl, row) {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (isUserIdKey(lower)) url.searchParams.set(key, String(row.userId || ""));
      if (/page/.test(lower) && !url.searchParams.get(key)) url.searchParams.set(key, "1");
      if (/size|limit|pagesize|page_size/.test(lower)) url.searchParams.set(key, String(Math.max(Number(url.searchParams.get(key)) || 0, 20)));
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function rewriteBody(body, headers, row) {
  if (!body) return body;
  const contentType = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
  if (/json/i.test(contentType) || looksJson(body)) {
    try {
      const data = JSON.parse(body);
      rewriteObject(data, row);
      return JSON.stringify(data);
    } catch {
      return body;
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType) || body.includes("=")) {
    const params = new URLSearchParams(body);
    for (const key of [...params.keys()]) {
      const lower = key.toLowerCase();
      if (isUserIdKey(lower)) {
        if (/ids$|list|array/.test(lower)) {
          params.delete(key);
          params.append(key, String(row.userId || ""));
        } else {
          params.set(key, String(row.userId || ""));
        }
      }
      if (/page/.test(lower) && !params.get(key)) params.set(key, "1");
      if (/size|limit|pagesize|page_size/.test(lower)) params.set(key, String(Math.max(Number(params.get(key)) || 0, 20)));
    }
    return params.toString();
  }
  return body;
}

function rewriteObject(value, row) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => rewriteObject(item, row));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (isUserIdKey(lower)) value[key] = preserveUserIdType(item, row.userId);
    else if (/page/.test(lower) && (item === "" || item === null || item === undefined)) value[key] = preserveType(item, 1);
    else if (/size|limit|pagesize|page_size/.test(lower)) value[key] = preserveType(item, Math.max(Number(item) || 0, 20));
    else rewriteObject(item, row);
  }
}

function bindingHintsForRequest(request, previousEvents, row) {
  const requestText = `${request.url || ""}\n${request.postData || ""}`;
  const sourceUserId = String(row.userId || "");
  const hints = [];
  const seen = new Set();
  for (const event of previousEvents) {
    const fields = flattenPrimitiveFields(event.response?.data || {});
    for (const field of fields) {
      const value = cleanProfileValue(field.value);
      if (!isBindableValue(value, sourceUserId)) continue;
      if (!requestText.includes(value)) continue;
      const signature = `${value}:${pathSignature(field.keyPath)}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      hints.push({
        sourceValue: value,
        keyPath: field.keyPath,
        key: field.key,
        signature: pathSignature(field.keyPath),
        kind: bindingKind(field.keyPath)
      });
      if (hints.length >= 12) return hints;
    }
  }
  return hints;
}

function applyRequestBindings(text, bindings, bindingData, row, applied = [], location = "") {
  let result = String(text || "");
  if (!result || !bindings?.length || !bindingData?.length) return result;
  for (const binding of bindings) {
    const expectedKind = effectiveBindingKind(binding);
    if (expectedKind === "genericId") continue;
    if (!isBindableValue(binding.sourceValue, String(row.userId || ""))) continue;
    if (!binding.sourceValue || !result.includes(binding.sourceValue)) continue;
    const replacement = findBindingReplacement(binding, bindingData, row);
    if (!replacement || replacement === binding.sourceValue) continue;
    const before = result;
    result = location === "url"
      ? replaceUrlSearchValue(result, binding.sourceValue, replacement)
      : replaceAll(result, binding.sourceValue, replacement);
    if (result === before) continue;
    applied.push({
      location,
      keyPath: binding.keyPath,
      kind: binding.kind,
      sourceValue: maskIdentifier(binding.sourceValue),
      replacement: maskIdentifier(replacement)
    });
  }
  return result;
}

function replaceUrlSearchValue(rawUrl, sourceValue, replacement) {
  try {
    const url = new URL(rawUrl);
    let changed = false;
    for (const [key, value] of [...url.searchParams.entries()]) {
      if (!String(value).includes(sourceValue)) continue;
      url.searchParams.set(key, replaceAll(value, sourceValue, replacement));
      changed = true;
    }
    return changed ? url.toString() : rawUrl;
  } catch {
    return rawUrl;
  }
}

function findBindingReplacement(binding, bindingData, row) {
  const sourceUserId = String(row.userId || "");
  const expectedKind = effectiveBindingKind(binding);
  if (expectedKind === "genericId") return "";
  const fields = bindingData.flatMap((data, sourceIndex) =>
    flattenPrimitiveFields(data || {}).map((field) => ({
      ...field,
      sourceIndex,
      selectedOrderBinding: Boolean(data?.__selectedOrderBinding)
    }))
  );
  const ranked = fields
    .map((field) => {
      const value = cleanProfileValue(field.value);
      if (!isBindableValue(value, sourceUserId)) return null;
      const fieldKind = bindingKind(field.keyPath);
      if (fieldKind !== expectedKind) return null;
      let score = 0;
      const sig = pathSignature(field.keyPath);
      if (sig === binding.signature) score += 60;
      if (lastPathKey(field.keyPath) === lastPathKey(binding.keyPath)) score += 35;
      if (fieldKind === expectedKind) score += 20;
      if (/id|编号|订单|营|课|商品|goods|order|finance|camp|course/i.test(field.keyPath)) score += 8;
      if (includesLoose(JSON.stringify(field), sourceUserId)) score += 4;
      if (field.selectedOrderBinding || field.sourceIndex === 0 && bindingData[0]?.__selectedOrderBinding) score += 120;
      return { value, score };
    })
    .filter(Boolean)
    .filter((item) => item.score >= 20)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.value || "";
}

function effectiveBindingKind(binding) {
  const fromPath = bindingKind(binding?.keyPath || "");
  if (fromPath !== "genericId") return fromPath;
  return binding?.kind || "genericId";
}

function isBindableValue(value, sourceUserId = "") {
  const text = cleanProfileValue(value);
  if (!text || text === sourceUserId) return false;
  if (text.length < 4 || text.length > 80) return false;
  if (/^(true|false|null|undefined|操作成功|成功)$/i.test(text)) return false;
  if (/^(admin|launch|list|detail|query|page|limit|null|none)$/i.test(text)) return false;
  if (!/\d/.test(text)) return false;
  if (/^https?:\/\//i.test(text)) return false;
  return /^[\w\-:.]+$/.test(text) || /^\d{4,}$/.test(text);
}

function bindingKind(keyPath = "") {
  const text = String(keyPath).toLowerCase();
  if (/assign.*ref|reception|target.*id/.test(text)) return "assignRefId";
  if (/main.*order|order.*id|订单/.test(text)) return "orderId";
  if (/financial|finance|正式营|体验营|营.*id|camp.*id|course.*id/.test(text)) return "campId";
  if (/category.*id|cate.*id|品类.*id|类目.*id/.test(text)) return "categoryId";
  if (/dimension.*id|维度.*id/.test(text)) return "dimensionId";
  if (/user.*id|userid|uid/.test(text)) return "userId";
  if (/goods|product|商品/.test(text)) return "goodsId";
  return "genericId";
}

function pathSignature(keyPath = "") {
  return String(keyPath)
    .split(".")
    .filter((part) => !/^\d+$/.test(part))
    .slice(-4)
    .join(".")
    .toLowerCase();
}

function lastPathKey(keyPath = "") {
  return String(keyPath)
    .split(".")
    .filter((part) => !/^\d+$/.test(part))
    .pop()
    ?.toLowerCase() || "";
}

function isUserIdKey(lower) {
  return /^(user|user_id|userid|uid)$/.test(lower) || /student.*id|member.*id|client.*id|wechat.*user.*id|user.*id/.test(lower);
}

function extractProfileCandidates(data, row) {
  const candidates = [];
  walkWithPath(data, (value, pathValue) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const fields = flattenPrimitiveFields(value);
    const productType = findProductType(fields, value);
    const campName = findCampName(fields);
    const courseCategory = findCourseCategory(fields);
    const goodsName = findGoodsName(fields);
    const text = JSON.stringify(value);
    let score = 0;
    if (includesLoose(text, row.userId)) score += 25;
    if (productType) score += 18;
    if (campName) score += 18;
    if (courseCategory) score += 18;
    if (goodsName) score += 6;
    score += statusScore(fields);
    score += timeScore(fields, row);
    if (score >= 30 && (productType || campName || courseCategory || goodsName)) {
      candidates.push({
        actualProductType: productType,
        actualCampName: campName,
        actualCourseCategory: courseCategory,
        actualGoodsName: goodsName,
        score,
        path: pathValue.join("."),
        time: bestTime(fields),
        reason: ""
      });
    }
  });
  return uniqueCandidates(candidates).sort((a, b) => b.score - a.score);
}

function selectProfileCandidate(candidates, row) {
  if (!candidates.length) return null;
  const sentAt = parseExcelDateTime(row.sentAt) || parseDataDate(row.dataDate);
  const ranked = candidates
    .map((candidate) => {
      let score = candidate.score || 0;
      if (candidate.rowRelated) score += 80;
      if (sentAt && candidate.time) score += Math.max(0, 30 - Math.abs(candidate.time.getTime() - sentAt.getTime()) / 864e5);
      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score);
  const selected = ranked.find((candidate) =>
    candidate.rowRelated &&
    candidate.actualProductType &&
    candidate.actualCampName &&
    candidate.actualCourseCategory
  );
  if (!selected) return buildCompositeProfileCandidate(ranked.filter((candidate) => candidate.rowRelated), row, sentAt);
  selected.reason = selected.time
    ? `按发送时间附近有效档案选择，接口${selected.endpoint || ""}，记录时间${formatDateTime(selected.time)}`
    : `按有效字段完整度选择，接口${selected.endpoint || ""}`;
  return selected;
}

function selectDetailProfileCandidate(candidates, row, detailState) {
  const selected = buildProfileFieldCandidate(candidates, row, detailState);
  if (!selected.isComplete) return null;
  return {
    actualProductType: selected.actualProductType,
    actualCampName: selected.actualCampName,
    actualCourseCategory: selected.actualCourseCategory,
    actualProductTypeSource: selected.actualProductTypeSource,
    actualCampNameSource: selected.actualCampNameSource,
    actualCourseCategorySource: selected.actualCourseCategorySource,
    evidenceFields: selected.evidenceFields,
    score: selected.score,
    rowRelated: true,
    endpoint: [
      selected.actualProductTypeSource,
      selected.actualCampNameSource,
      selected.actualCourseCategorySource
    ].filter(Boolean).join(" + "),
    reason: selected.reason
  };
}

function buildProfileFieldCandidate(candidates, row, detailState) {
  const sentAt = parseExcelDateTime(row.sentAt) || parseDataDate(row.dataDate);
  const product = bestCandidateField(candidates, "actualProductType", sentAt);
  if (!product.value && detailState.profileOrderListProductType) {
    product.value = detailState.profileOrderListProductType;
    product.score = 90;
    product.source = "订单信息页选中订单购买类型";
  }
  const camp = bestCandidateField(candidates, "actualCampName", sentAt);
  if (!camp.value && detailState.profileCampNameFallbackUsed) {
    camp.value = detailState.profileOrderCardProductName;
    camp.score = 70;
    camp.source = detailState.profileCampNameFallbackSource || "订单信息页选中订单商品名称兜底";
  }
  const category = bestCourseCategoryField(candidates, sentAt, [
    camp.value,
    detailState.profileOrderCardProductName,
    row.docCampName
  ], detailState);
  const hasAny = Boolean(product.value || camp.value || category.value);
  const isComplete = Boolean(product.value && camp.value && category.value);
  return {
    actualProductType: product.value || "",
    actualCampName: camp.value || "",
    actualCourseCategory: category.value || "",
    actualProductTypeSource: product.source || "",
    actualCampNameSource: camp.source || "",
    actualCourseCategorySource: category.source || "",
    evidenceFields: {
      productTypeField: product.source || "",
      campNameField: camp.source || "",
      courseCategoryField: category.source || ""
    },
    score: (product.score || 0) + (camp.score || 0) + (category.score || 0),
    hasAny,
    isComplete,
    reason: [
      product.value ? `Q=${product.value}(${product.source || "未知来源"})` : "Q缺失",
      camp.value ? `R=${camp.value}(${camp.source || "未知来源"})` : "R缺失",
      category.value ? `S=${category.value}(${category.source || "未知来源"})` : "S缺失"
    ].join("，")
  };
}

function buildProfileFieldError(candidate, detailState, fallback = "") {
  const errors = [];
  if (!candidate.actualProductType) errors.push("缺Q：未识别订单页购买体验营/购买正式营");
  if (!candidate.actualCampName) {
    errors.push("缺R：详情接口缺训练营名称字段");
    if (detailState.profileOrderCardProductName) {
      errors.push(`订单商品名未用于R：${detailState.profileCampNameRejectedReason || "不满足兜底规则"}`);
    }
  }
  if (!candidate.actualCourseCategory) errors.push("缺S：详情接口缺所属品类字段");
  if (fallback && !errors.length) errors.push(fallback);
  else if (fallback && !String(fallback).includes(errors[0] || "__none__")) errors.push(fallback);
  return errors.filter(Boolean).join("；");
}

function mergePartialWithFieldCandidate(partial, candidate) {
  const q = uniqueValues([...(partial.Q || []), candidate.actualProductType]);
  const r = uniqueValues([...(partial.R || []), candidate.actualCampName]);
  const s = uniqueValues([...(partial.S || []), candidate.actualCourseCategory]);
  const missing = [];
  if (!q.length) missing.push("Q");
  if (!r.length) missing.push("R");
  if (!s.length) missing.push("S");
  const summary = [
    q.length ? `Q=${q.slice(0, 2).join("/")}` : "",
    r.length ? `R=${r.slice(0, 2).join("/")}` : "",
    s.length ? `S=${s.slice(0, 2).join("/")}` : "",
    missing.length ? `缺${missing.join("/")}` : ""
  ].filter(Boolean).join("，");
  return { ...partial, Q: q, R: r, S: s, missing, summary };
}

function mergeOrderProductTypeIntoProfile(profile, detailState) {
  if (!profile || profile.actualProductType || !detailState.profileOrderListProductType) return profile;
  const next = {
    ...profile,
    actualProductType: detailState.profileOrderListProductType,
    profileEvidenceFields: {
      ...(profile.profileEvidenceFields || {}),
      productTypeField: "订单信息页选中订单购买类型"
    }
  };
  if (
    next.actualProductType &&
    next.actualCampName &&
    next.actualCourseCategory &&
    /字段不完整|Q证据不足/.test(next.profileLlmError || "")
  ) {
    next.profileLlmError = "";
  }
  return next;
}

function normalizeLlmProfileCourseCategory(profile, detailState = {}) {
  if (!profile?.actualCourseCategory) return profile;
  const raw = profile.actualCourseCategory;
  const normalized = normalizeCourseCategory(raw);
  detailState.actualCourseCategoryRaw = detailState.actualCourseCategoryRaw || raw;
  detailState.actualCourseCategoryNormalized = detailState.actualCourseCategoryNormalized || normalized;
  detailState.actualCourseCategorySourceTrust = detailState.actualCourseCategorySourceTrust || "deepseek-profile";
  return {
    ...profile,
    actualCourseCategory: normalized
  };
}

function isValidLlmProfile(profile, settings = {}) {
  if (!profile || profile.profileLlmError) return false;
  const minConfidence = Number(settings.minConfidence || 0.9);
  return Boolean(
    profile.actualProductType &&
    profile.actualCampName &&
    profile.actualCourseCategory &&
    Number(profile.profileExtractConfidence || 0) >= minConfidence &&
    !profile.needsReview
  );
}

function buildCompositeProfileCandidate(candidates, row, sentAt) {
  if (!candidates.length) return null;
  const product = bestCandidateField(candidates, "actualProductType", sentAt);
  const camp = bestCandidateField(candidates, "actualCampName", sentAt);
  const category = bestCandidateField(candidates, "actualCourseCategory", sentAt);
  if (!product.value || !camp.value || !category.value) return null;
  const sourceCount = new Set([product.source, camp.source, category.source].filter(Boolean)).size;
  const score = product.score + camp.score + category.score + (sourceCount <= 2 ? 20 : 0);
  return {
    actualProductType: product.value,
    actualCampName: camp.value,
    actualCourseCategory: category.value,
    score,
    rowRelated: true,
    time: camp.time || category.time || product.time || null,
    endpoint: [product.source, camp.source, category.source].filter(Boolean).join(" + "),
    reason: `同一用户档案响应跨接口合并Q/R/S：${product.source || "-"} / ${camp.source || "-"} / ${category.source || "-"}`
  };
}

function inferProductTypeFromProfile(campName, courseCategory, candidates = []) {
  const text = [
    campName || "",
    courseCategory || "",
    ...candidates.map((candidate) => candidate.actualGoodsName || ""),
    ...candidates.map((candidate) => candidate.path || "")
  ].join("\n");
  if (/正式营|正价课|购买正式|主订单|订单金额[:：]?\s*(?!0(?:\.0+)?\b)\d{3,}/.test(text)) {
    return { value: "正式营", score: 60, source: "按订单/营期文本高置信推断" };
  }
  const experienceSignals = [
    /体验营/,
    /视频号/,
    /直投/,
    /小程序/,
    /投放/,
    /\bJF/i,
    /\d+元/,
    /-\d+营$/,
    /主营$/,
    /引流|线索|领券|低价/
  ];
  const hits = experienceSignals.filter((pattern) => pattern.test(text)).length;
  if (hits >= 2) {
    return { value: "体验营", score: 55 + hits, source: "按训练营名称投放特征高置信推断" };
  }
  return null;
}

function inferCourseCategoryFromTrainingName(value) {
  const text = cleanProfileValue(value);
  if (!text) return { value: "", score: 0, source: "" };
  const rules = [
    { value: "普拉提", patterns: [/普拉提/] },
    { value: "短视频", patterns: [/短视频|拍剪|剪辑|视频拍剪/] },
    { value: "手机摄影", patterns: [/手机摄影|摄影(?!棚)|拍照|拍摄/] },
    { value: "中医变美", patterns: [/中医变美|面部经络|面部莹润|亮颜|焕活|美颜|变美|面部.*抗衰|经络.*亮颜/] },
    { value: "健康食养", patterns: [/健康食养|食养|食疗/] },
    { value: "太极", patterns: [/太极|武当|道家|功法|传承|柔筋活络|八段锦|五禽戏|形意|道门/] },
    { value: "瑜伽", patterns: [/瑜伽/] },
    { value: "唱歌", patterns: [/唱歌|歌声|麦霸|声乐|歌唱|发声|演唱|国际声乐/] },
    { value: "国学朗诵", patterns: [/国学朗诵|朗诵/] },
    { value: "亚健康管理", patterns: [/亚健康|排浊通络|身心健康|通络身心/] },
    { value: "气血调理", patterns: [/气血调理|气血/] },
    { value: "健康营养", patterns: [/健康营养|营养/] }
  ];
  const matched = rules.find((rule) => rule.patterns.some((pattern) => pattern.test(text)));
  if (!matched) return { value: "", score: 0, source: "" };
  return {
    value: normalizeCourseCategory(matched.value),
    score: 62,
    source: "训练营名称关键词高置信兜底"
  };
}

function normalizeCourseCategory(value) {
  const text = cleanProfileValue(value);
  if (!text) return "";
  const rules = [
    { value: "中医变美", pattern: /面部经络|亮颜|焕活|变美|中医变美/ },
    { value: "太极", pattern: /太极|武当|道家|功法|八段锦|柔筋活络/ },
    { value: "唱歌", pattern: /唱歌|歌声|麦霸|声乐|歌唱|发声|演唱|国际声乐/ }
  ];
  const matched = rules.find((rule) => rule.pattern.test(text));
  return matched?.value || text;
}

function summarizePartialProfileFields(candidates) {
  const q = uniqueValues(candidates.map((candidate) => candidate.actualProductType));
  const r = uniqueValues(candidates.map((candidate) => candidate.actualCampName));
  const s = uniqueValues(candidates.map((candidate) => candidate.actualCourseCategory));
  const missing = [];
  if (!q.length) missing.push("Q");
  if (!r.length) missing.push("R");
  if (!s.length) missing.push("S");
  const summary = [
    q.length ? `Q=${q.slice(0, 2).join("/")}` : "",
    r.length ? `R=${r.slice(0, 2).join("/")}` : "",
    s.length ? `S=${s.slice(0, 2).join("/")}` : "",
    missing.length ? `缺${missing.join("/")}` : ""
  ].filter(Boolean).join("，");
  return { Q: q, R: r, S: s, missing, summary };
}

function withOrderProductPartial(partial, detailState) {
  if (!detailState.profileOrderListProductType) return partial;
  const q = uniqueValues([...(partial.Q || []), detailState.profileOrderListProductType]);
  const missing = [];
  if (!q.length) missing.push("Q");
  if (!partial.R?.length) missing.push("R");
  if (!partial.S?.length) missing.push("S");
  const summary = [
    q.length ? `Q=${q.slice(0, 2).join("/")}` : "",
    partial.R?.length ? `R=${partial.R.slice(0, 2).join("/")}` : "",
    partial.S?.length ? `S=${partial.S.slice(0, 2).join("/")}` : "",
    missing.length ? `缺${missing.join("/")}` : ""
  ].filter(Boolean).join("，");
  return { ...partial, Q: q, missing, summary };
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => cleanProfileValue(value)).filter(Boolean))];
}

function bestCandidateField(candidates, field, sentAt) {
  const ranked = candidates
    .filter((candidate) => candidate[field])
    .map((candidate) => {
      let score = Number(candidate.score || 0);
      if (sentAt && candidate.time) score += Math.max(0, 30 - Math.abs(candidate.time.getTime() - sentAt.getTime()) / 864e5);
      if (candidate.actualProductType && candidate.actualCampName && candidate.actualCourseCategory) score += 20;
      return {
        value: candidate[field],
        score,
        source: candidate.endpoint || candidate.path || "",
        time: candidate.time || null
      };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0] || { value: "", score: 0, source: "", time: null };
}

function bestCourseCategoryField(candidates, sentAt, trainingNameValues = [], detailState = {}) {
  const ranked = candidates
    .filter((candidate) => candidate.actualCourseCategory)
    .map((candidate) => {
      let score = Number(candidate.score || 0);
      if (sentAt && candidate.time) score += Math.max(0, 30 - Math.abs(candidate.time.getTime() - sentAt.getTime()) / 864e5);
      if (candidate.actualProductType && candidate.actualCampName && candidate.actualCourseCategory) score += 20;
      return {
        rawValue: candidate.actualCourseCategory,
        value: normalizeCourseCategory(candidate.actualCourseCategory),
        score,
        source: candidate.endpoint || candidate.path || "",
        sourceRole: candidate.sourceRole || "",
        time: candidate.time || null
      };
    })
    .sort((a, b) => b.score - a.score);
  const trusted = ranked.find((item) => isTrustedCourseCategorySource(item));
  const rejected = ranked.find((item) => !isTrustedCourseCategorySource(item));
  let selected = trusted || null;
  let sourceTrust = trusted ? "detail" : "";

  if (!selected) {
    const inferred = trainingNameValues
      .map((value) => inferCourseCategoryFromTrainingName(value))
      .find((item) => item.value);
    if (inferred) {
      selected = {
        rawValue: inferred.value,
        value: inferred.value,
        score: inferred.score,
        source: inferred.source,
        sourceRole: "trainingNameFallback",
        time: null
      };
      sourceTrust = "training-name-fallback";
    }
  }

  if (selected) {
    detailState.actualCourseCategoryRaw = selected.rawValue || selected.value || "";
    detailState.actualCourseCategoryNormalized = selected.value || "";
    detailState.actualCourseCategorySourceTrust = sourceTrust || "unknown";
    if (rejected) {
      detailState.profileCourseCategoryRejectedSource = rejected.source || rejected.sourceRole || "";
      if (rejected.value && selected.value && rejected.value !== selected.value) {
        detailState.profileCourseCategoryConflictReason = `列表S=${rejected.rawValue || rejected.value}与${sourceTrust || "可信来源"}S=${selected.value}冲突，拒绝列表来源`;
      }
    }
    return {
      value: selected.value || "",
      score: selected.score || 0,
      source: selected.source || "",
      time: selected.time || null
    };
  }

  if (rejected) {
    detailState.actualCourseCategoryRaw = rejected.rawValue || rejected.value || "";
    detailState.actualCourseCategoryNormalized = normalizeCourseCategory(rejected.rawValue || rejected.value || "");
    detailState.actualCourseCategorySourceTrust = "rejected-list";
    detailState.profileCourseCategoryRejectedSource = rejected.source || rejected.sourceRole || "";
    detailState.profileCourseCategoryConflictReason = "详情页缺S，列表/机会接口S不允许作为最终S";
  }
  return { value: "", score: 0, source: "", time: null };
}

function isTrustedCourseCategorySource(item = {}) {
  const source = `${item.source || ""}\n${item.sourceRole || ""}`;
  if (/saleUserAssignRef\/listV2|chanceAss|线索|机会|search|order-list|orderList|listV2/i.test(source)) return false;
  if (/orderDetail|orderDetailProbe|intentionActCharge|charge|finance|order|userCamp|permission|商品信息|订单详情/i.test(source)) return true;
  return false;
}

function findProductType(fields, object) {
  const exact = inferProductTypeFromExactFields(fields);
  if (exact) return exact;
  return "";
}

function findCampName(fields) {
  const exact = bestField(fields, [
    /训练\s*营\s*名称|营\s*名称|trainingCampName|training_camp_name|training.*camp.*name/i
  ], (value) => value.length >= 2);
  if (exact) return exact;
  return "";
}

function findCourseCategory(fields) {
  return bestField(fields, [
    /所属品类|课程品类|品类名称|category.*name|cate.*name|course.*category|subject.*name/i
  ], (value) => value.length >= 2 && value.length <= 50);
}

function findGoodsName(fields) {
  return bestField(fields, [
    /商品名称|goods.*name|product.*name|sku.*name/i
  ], (value) => value.length >= 2);
}

function inferProductTypeFromExactFields(fields) {
  const formal = fields.find((field) =>
    /正式营.*id|formal.*(camp|finance|product).*id|official.*camp.*id/i.test(field.keyPath) &&
    hasMeaningfulId(field.value)
  );
  if (formal) return "正式营";
  const experience = fields.find((field) =>
    /体验营.*id|experience.*(camp|finance|product).*id|trial.*camp.*id/i.test(field.keyPath) &&
    hasMeaningfulId(field.value)
  );
  if (experience) return "体验营";
  return "";
}

function hasMeaningfulId(value) {
  const text = cleanProfileValue(value);
  return Boolean(text && text !== "-" && text !== "0" && !/^null|undefined$/i.test(text));
}

function bestField(fields, keyPatterns, valuePredicate = () => true) {
  const matches = fields
    .filter((field) => keyPatterns.some((pattern) => pattern.test(field.keyPath)) && valuePredicate(field.value))
    .sort((a, b) => fieldScore(b) - fieldScore(a));
  return cleanProfileValue(matches[0]?.value || "");
}

function fieldScore(field) {
  let score = 0;
  if (field.labelValue) score += 30;
  if (/name|名称/.test(field.keyPath)) score += 5;
  if (/actual|实际/.test(field.keyPath)) score += 5;
  if (field.value.length >= 2 && field.value.length <= 40) score += 3;
  return score;
}

function flattenPrimitiveFields(value, prefix = []) {
  const result = [];
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    value.forEach((item, index) => result.push(...flattenPrimitiveFields(item, [...prefix, index])));
    return result;
  }
  const labelField = labelValueField(value, prefix);
  if (labelField) result.push(labelField);
  for (const [key, child] of Object.entries(value)) {
    const pathValue = [...prefix, key];
    if (child === null || child === undefined) continue;
    if (typeof child === "object") {
      result.push(...flattenPrimitiveFields(child, pathValue));
    } else {
      const text = cleanProfileValue(child);
      if (text) result.push({ key, keyPath: pathValue.join("."), value: text });
    }
  }
  return result;
}

function labelValueField(object, prefix = []) {
  const labelKeys = ["label", "title", "name", "fieldName", "fieldLabel", "keyName", "text"];
  const valueKeys = ["value", "fieldValue", "content", "val", "data", "nameValue"];
  const labelEntry = Object.entries(object).find(([key, value]) =>
    labelKeys.includes(key) && typeof value !== "object" && isProfileLabel(value)
  );
  if (!labelEntry) return null;
  const valueEntry = Object.entries(object).find(([key, value]) =>
    valueKeys.includes(key) && value !== null && value !== undefined && typeof value !== "object"
  );
  if (!valueEntry) return null;
  const label = cleanProfileValue(labelEntry[1]).replace(/[：:]\s*$/, "");
  const text = cleanProfileValue(valueEntry[1]);
  if (!text) return null;
  return {
    key: label,
    keyPath: [...prefix, label].join("."),
    value: text,
    labelValue: true
  };
}

function isProfileLabel(value) {
  return /训练\s*营\s*名称|营\s*名称|所属\s*品\s*类|课程\s*品\s*类|品\s*类\s*名称|商品名称|正式\s*营\s*ID|体验\s*营\s*ID|商品ID|开营时间|所在期数/.test(cleanProfileValue(value));
}

function statusScore(fields) {
  const text = fields.map((field) => `${field.keyPath}:${field.value}`).join("\n");
  if (/无效|失效|取消|作废|关闭|退款成功|已退款|删除|invalid|cancel|closed/i.test(text)) return -40;
  if (/有效|已报名|在读|已支付|已成交|进行中|active|paid|success/i.test(text)) return 15;
  return 0;
}

function timeScore(fields, row) {
  const sentAt = parseExcelDateTime(row.sentAt) || parseDataDate(row.dataDate);
  const time = bestTime(fields);
  if (!sentAt || !time) return 0;
  return Math.max(0, 20 - Math.abs(time.getTime() - sentAt.getTime()) / 864e5);
}

function bestTime(fields) {
  const times = fields
    .filter((field) => /time|date|created|updated|pay|order|报名|创建|支付|成交|开始|结束/i.test(field.keyPath))
    .map((field) => parseAnyTime(field.value))
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime());
  return times[0] || null;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const signature = [candidate.actualProductType, candidate.actualCampName, candidate.actualCourseCategory, candidate.path].join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(candidate);
  }
  return result;
}

function emptyProfile(error = "") {
  return {
    profileSource: "chanceAssApi",
    profileFound: false,
    profileCandidateCount: 0,
    profileSelectedReason: "",
    profilePartialFields: { Q: [], R: [], S: [], missing: ["Q", "R", "S"], summary: "" },
    profileExtractor: "",
    profileExtractConfidence: 0,
    profileExtractReason: "",
    profileEvidenceFields: {},
    profileLlmError: "",
    profileSanitized: false,
    profileDetailEndpointMatched: false,
    profileDetailHasTrainingName: false,
    profileDetailHasCategory: false,
    profileDetailHasCampTypeId: false,
    profileDetailLabels: [],
    profileOrderListHasProductType: false,
    profileOrderListProductType: "",
    profileOrderListLabels: [],
    profileOrderCardProductName: "",
    profileOrderCandidates: [],
    profileFormalOrderFound: false,
    profileMatchedOrderType: "",
    profileMatchedOrderName: "",
    profileMatchedOrderId: "",
    profileOrderSelectionReason: "",
    profileCampNameFallbackUsed: false,
    profileCampNameFallbackSource: "",
    profileCampNameRejectedReason: "",
    actualCourseCategoryRaw: "",
    actualCourseCategoryNormalized: "",
    actualCourseCategorySourceTrust: "",
    profileCourseCategoryRejectedSource: "",
    profileCourseCategoryConflictReason: "",
    profileApiTried: 0,
    profileBindingApplied: [],
    actualProductType: "",
    actualCampName: "",
    actualCourseCategory: "",
    actualProductTypeSource: "",
    actualCampNameSource: "",
    actualCourseCategorySource: "",
    profileError: error,
    profileMs: 0
  };
}

function isBusinessSuccess(data) {
  if (!data || typeof data !== "object") return true;
  const code = data.state?.code ?? data.code;
  if (code === undefined || code === null) return true;
  const numeric = Number(code);
  if (Number.isFinite(numeric)) return numeric === 0 || numeric === 200;
  return /^(success|ok)$/i.test(String(code));
}

function businessErrorMessage(result, fallback) {
  const message = result?.data?.state?.msg || result?.data?.msg || result?.error || result?.text || "";
  const status = result?.status ? ` ${result.status}` : "";
  return `${fallback}${status}${message ? `：${String(message).slice(0, 120)}` : ""}`.trim();
}

function isLoginLikeResponse(result) {
  const text = `${result?.text || ""}\n${JSON.stringify(result?.data || {})}`;
  return /扫码|登录|login|qrConnect|未登录|无权限|请先登录/i.test(text);
}

function safeHeaders(headers) {
  const outputHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (SECRET_HEADER.test(key)) continue;
    if (!/accept|content-type|x-requested-with/i.test(key)) continue;
    outputHeaders[key] = value;
  }
  return outputHeaders;
}

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function normalizePostData(value) {
  return String(value || "").replace(/\d{5,}/g, "[num]");
}

function parseJsonMaybe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function walkWithPath(value, visitor, pathValue = []) {
  visitor(value, pathValue);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkWithPath(item, visitor, [...pathValue, index]));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    walkWithPath(item, visitor, [...pathValue, key]);
  }
}

function arrayLikeCount(value) {
  let count = 0;
  walkWithPath(value, (item) => {
    if (Array.isArray(item)) count = Math.max(count, item.length);
  });
  return count;
}

function parseExcelDateTime(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 20000) return new Date(Math.round((numeric - 25569) * 86400 * 1000));
  return parseAnyTime(value);
}

function parseDataDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  return parseAnyTime(value);
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

function formatDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

function endpointName(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url || "").slice(0, 80);
  }
}

function cleanProfileValue(value) {
  return String(value ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function preserveType(oldValue, newValue) {
  if (typeof oldValue === "number") {
    const next = Number(newValue);
    return Number.isFinite(next) ? next : oldValue;
  }
  return String(newValue ?? "");
}

function preserveUserIdType(oldValue, newValue) {
  if (Array.isArray(oldValue)) {
    if (!oldValue.length) return [String(newValue ?? "")];
    return oldValue.map((item, index) => index === 0 ? preserveType(item, newValue) : item);
  }
  return preserveType(oldValue, newValue);
}

function looksJson(text) {
  const value = String(text || "").trim();
  return value.startsWith("{") || value.startsWith("[");
}

function replaceAll(text, from, to) {
  if (!from) return text;
  return String(text).split(from).join(to);
}

function maskIdentifier(value) {
  const text = String(value || "");
  if (text.length <= 6) return "***";
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
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

function profileCacheKey(row = {}) {
  return JSON.stringify([
    String(row.userId || ""),
    normalizeProductType(row.docProductType) || String(row.docProductType || ""),
    normalizeCampText(row.docCampName || ""),
    String(row.sentAt || "")
  ]);
}

async function waitForEnter() {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question("");
  } finally {
    rl.close();
  }
}
