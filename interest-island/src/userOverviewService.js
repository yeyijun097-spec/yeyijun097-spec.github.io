import { isTargetClosedError } from "./browserClient.js";
import { clickButtonByText, cleanText, extractRowContaining, findVisibleText, pickValue, readLabelValuePairs } from "./domUtils.js";
import { queryComplaintRecords } from "./complaintService.js";

const MAX_ORDERS_PER_QUERY = 500;

const ORDER_FIELD_LABELS = [
  "支付方式", "分销人ID", "分销人名称", "销售归属人", "所属部门", "所属品类",
  "所在期数", "开营时间", "下单时间", "主订单ID", "订单金额", "订单类型", "商品名称"
];
const FORBIDDEN_PRODUCT_LABELS = /(?:订单金额|订单类型|主订单ID|支付方式|分销人ID)\s*[:：]/;
const ORDER_DETAIL_FIELD_ALIASES = {
  mainOrderId: ["主订单ID", "订单ID"],
  orderTime: ["下单时间", "支付时间"],
  paymentMethod: ["支付方式"],
  orderStatus: ["订单状态", "支付状态"],
  orderType: ["订单类型"],
  amountText: ["订单金额", "支付金额", "实付金额"],
  category: ["所属品类", "课程品类", "品类名称"],
  formalCampId: ["正式营ID"],
  experienceCampId: ["体验营ID"],
  trainingCampId: ["训练营ID", "营ID"],
  productName: ["商品名称"],
  trainingName: ["训练营名称", "营名称"],
  periodName: ["所在期数", "期数"],
  className: ["所在班级", "班级"],
  startTime: ["开营时间"],
  endTime: ["结营时间"],
  salesOwner: ["销售归属人"],
  afterSalesTeacher: ["售后老师", "售后接待人"],
  department: ["所属部门"],
  distributorId: ["分销人ID"],
  distributorName: ["分销人名称"],
  userId: ["用户ID"],
  wechatNickname: ["微信昵称", "用户昵称"],
  phone: ["手机号", "手机号码"],
  orderLink: ["下单链接", "订单链接"],
  proxyPay: ["是否代付"],
  changedCamp: ["是否换营"]
};

export function parseOrderCardFields(textOrFields = "") {
  const fields = textOrFields && typeof textOrFields === "object" ? textOrFields : {};
  const text = cleanText(typeof textOrFields === "string"
    ? textOrFields
    : fields.rawText || fields.text || "");
  const readField = (label, stops = ORDER_FIELD_LABELS) => {
    const directValue = fields[label] ?? fields[{
      "主订单ID": "orderId",
      "订单金额": "amountText",
      "商品名称": "productName",
      "订单类型": "productType"
    }[label]];
    if (directValue !== undefined && directValue !== null) return cleanText(directValue);
    const labelPattern = new RegExp(`${escapeRegExp(label)}\\s*[:：]\\s*`, "g");
    const match = labelPattern.exec(text);
    if (!match) return "";
    const tail = text.slice(match.index + match[0].length);
    const stopPattern = new RegExp(`(?:${stops.map(escapeRegExp).join("|")})\\s*[:：]`, "g");
    const stop = stopPattern.exec(tail);
    return cleanText(stop ? tail.slice(0, stop.index) : tail);
  };
  const productType = fields.productType || text.match(/购买\s*(体验营|正式营)/)?.[1] || readField("订单类型");
  const orderId = fields.orderId || text.match(/主订单ID\s*[:：]\s*([0-9]+)/)?.[1] || readField("主订单ID");
  // 金额只接受明确“订单金额”标签；商品名称中的天数或对象的裸 amountText 均不可作为金额。
  const amountMatch = text.match(/(?:^|\s)订单金额\s*[:：]\s*(\d+(?:\.\d{1,2})?)/);
  const amountText = amountMatch?.[1] || readField("订单金额");
  const explicitAmount = typeof fields.amount === "number" && Number.isFinite(fields.amount) ? fields.amount : null;
  const amount = explicitAmount ?? (amountMatch ? Number(amountMatch[1]) : null);
  const rawProductName = readField("商品名称");
  const productName = rawProductName.split(FORBIDDEN_PRODUCT_LABELS)[0].trim();
  const time = fields.time || readField("下单时间") || text.match(/([0-9]{4}[.-][0-9]{2}[.-][0-9]{2}(?:\s+[0-9:]{5,8})?)/)?.[1] || "";
  const contaminatedFields = FORBIDDEN_PRODUCT_LABELS.test(rawProductName) ? ["productName"] : [];
  return {
    orderId: cleanText(orderId),
    productType: cleanText(productType),
    productName: cleanText(productName),
    amount: Number.isFinite(amount) ? amount : null,
    amountText: cleanText(amountText),
    time: cleanText(time),
    fieldIntegrity: {
      valid: contaminatedFields.length === 0,
      contaminatedFields,
      reasons: contaminatedFields.length ? ["商品名称字段包含后续订单字段标签：订单金额/订单类型/主订单ID等"] : []
    }
  };
}

export function parseInlineOrderCardDetail(textOrFields = "") {
  const fields = textOrFields && typeof textOrFields === "object" ? textOrFields : {};
  const text = cleanText(typeof textOrFields === "string"
    ? textOrFields
    : fields.rawText || fields.text || "");
  const labels = [...new Set(Object.values(ORDER_DETAIL_FIELD_ALIASES).flat())];
  const readLabel = (aliases = []) => {
    for (const label of aliases) {
      const expression = new RegExp(`(?:^|\\s)${escapeRegExp(label)}\\s*[:：]\\s*`, "g");
      const match = expression.exec(text);
      if (!match) continue;
      const tail = text.slice(match.index + match[0].length);
      const stop = new RegExp(`(?:^|\\s)(?:${labels.map(escapeRegExp).join("|")})\\s*[:：]`, "g").exec(tail);
      const value = cleanText(stop ? tail.slice(0, stop.index) : tail);
      if (value) return value;
    }
    return "";
  };
  const card = parseOrderCardFields({
    rawText: text,
    orderId: fields.orderId,
    productType: fields.productType,
    productName: fields.productName,
    amountText: fields.amountText,
    time: fields.time
  });
  const detail = {};
  for (const [key, aliases] of Object.entries(ORDER_DETAIL_FIELD_ALIASES)) detail[key] = readLabel(aliases);
  detail.mainOrderId = cleanText(detail.mainOrderId || card.orderId || "");
  detail.productName = cleanText(detail.productName || card.productName || "");
  detail.amountText = cleanText(detail.amountText || card.amountText || "");
  detail.orderTime = cleanText(detail.orderTime || card.time || "");
  detail.amount = parseOrderAmount(detail.amountText);
  return detail;
}

function createInlineOrderCardDetailSnapshot(candidate = {}) {
  const rawCardText = cleanText(candidate.rawText || "");
  const hasCapturedCardDetail = Boolean(candidate.cardDetail && typeof candidate.cardDetail === "object");
  const hasInlineCardLabels = /主订单ID\s*[:：]/.test(rawCardText)
    && /商品名称\s*[:：]/.test(rawCardText)
    && /订单金额\s*[:：]/.test(rawCardText);
  if (!hasCapturedCardDetail && !hasInlineCardLabels) {
    return { ok: false, reason: "订单卡片未提供可验证的内嵌详情字段" };
  }
  const detail = normalizeOrderDetailData(candidate.cardDetail || parseInlineOrderCardDetail({
    rawText: candidate.rawText || "",
    orderId: candidate.orderId,
    productType: candidate.productType,
    productName: candidate.productName,
    amountText: candidate.amountText,
    time: candidate.time
  }));
  const expectedOrderId = cleanText(candidate.orderId || "");
  const schemaHits = [detail.mainOrderId, detail.productName, detail.amountText, detail.salesOwner, detail.periodName, detail.startTime]
    .filter(Boolean).length;
  if (!expectedOrderId || detail.mainOrderId !== expectedOrderId) {
    return { ok: false, reason: "订单卡片主订单ID未通过校验" };
  }
  if (!detail.productName || !detail.amountText) {
    return { ok: false, reason: "订单卡片详情字段不足" };
  }
  const pairs = Object.entries(ORDER_DETAIL_FIELD_ALIASES)
    .map(([key, aliases]) => ({ label: aliases[0], value: detail[key] }))
    .filter((pair) => pair.value)
    .map((pair) => ({ ...pair, source: "order-card-inline-dom" }));
  return {
    ok: true,
    snapshot: {
      visible: true,
      text: cleanText(candidate.rawText || ""),
      pairs,
      trainingName: cleanText(detail.trainingName || detail.productName || ""),
      productName: detail.productName,
      category: detail.category,
      startTime: cleanText(detail.orderTime || detail.startTime || ""),
      salesOwner: detail.salesOwner,
      mainOrderId: detail.mainOrderId,
      matched: true,
      schemaHits,
      detail
    }
  };
}

function resolveCampType(order = {}) {
  const values = [
    order.campType,
    order.productTypeRaw,
    order.productType,
    order.rawText,
    order.sourceTextSnippet
  ];
  for (const value of values) {
    const resolved = normalizeOrderType(value);
    if (resolved !== "other") return resolved;
  }
  // 仅兼容历史已规范化值；不能把“微信/当期订单”等业务订单类型拿来推断营类型。
  return ["formal", "experience"].includes(order.orderType) ? order.orderType : "other";
}

export class UserOverviewService {
  constructor({ config, browserClient, logger }) {
    this.config = config;
    this.browserClient = browserClient;
    this.logger = logger;
    this.queue = Promise.resolve();
    this.activeTasks = 0;
    this.queuedTasks = 0;
    this.loginLease = null;
    this.backendReadySessions = new Map();
    this.backendReadyTtlMs = 30 * 60 * 1000;
    this.progressByQuery = new Map();
    this.progressTtlMs = 30 * 60 * 1000;
    this.pendingQueries = new Map();
    this.blockedUsers = new Set();
    this.userGenerations = new Map();
  }

  backendReadyKey(userId, sessionId) {
    return `${String(userId || "")}\u0000${String(sessionId || "")}`;
  }

  rememberBackendReady(userId, sessionId) {
    const expiresAt = Date.now() + this.backendReadyTtlMs;
    this.backendReadySessions.set(this.backendReadyKey(userId, sessionId), { expiresAt });
    return expiresAt;
  }

  getRememberedBackendReady(userId, sessionId) {
    const key = this.backendReadyKey(userId, sessionId);
    const record = this.backendReadySessions.get(key);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.backendReadySessions.delete(key);
      return null;
    }
    return record;
  }

  clearBackendReady(userId, sessionId = "") {
    if (sessionId) {
      return this.backendReadySessions.delete(this.backendReadyKey(userId, sessionId));
    }
    let cleared = false;
    const prefix = `${String(userId || "")}\u0000`;
    for (const key of this.backendReadySessions.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.backendReadySessions.delete(key);
      cleared = true;
    }
    return cleared;
  }

  progressKey(progressId, userId) {
    return `${String(userId || "")}\u0000${String(progressId || "")}`;
  }

  updateProgress(progressId, userId, patch = {}) {
    if (!progressId) return;
    const key = this.progressKey(progressId, userId);
    const previous = this.progressByQuery.get(key) || {
      progressId,
      state: "queued",
      stage: "queued",
      label: "等待查询任务开始",
      detail: "",
      trace: [],
      partial: null,
      result: null,
      counts: {
        ordersFound: 0,
        ordersProcessed: 0,
        formalTotal: 0,
        formalProcessed: 0,
        complaints: "pending"
      },
      updatedAt: 0
    };
    const trace = Array.isArray(patch.trace)
      ? patch.trace.slice(-30)
      : previous.trace;
    const counts = patch.counts
      ? { ...(previous.counts || {}), ...patch.counts }
      : previous.counts;
    this.progressByQuery.set(key, {
      ...previous,
      ...patch,
      counts,
      progressId,
      trace,
      updatedAt: Date.now()
    });
    this.cleanupProgress();
  }

  completeProgress(progressId, userId, result = {}) {
    if (!progressId) return;
    const hasError = Boolean(result.error);
    this.updateProgress(progressId, userId, {
      state: hasError ? "partial" : "done",
      stage: hasError ? "done" : "done",
      label: hasError ? "查询完成，部分数据未完成" : "查询完成",
      detail: result.error || "订单、营期和投诉信息查询流程已结束",
      result,
      partial: result,
      counts: progressCountsFromResult(result)
    });
  }

  getProgress(progressId, userId) {
    const record = this.progressByQuery.get(this.progressKey(progressId, normalizeServiceUserId(userId)));
    if (!record) {
      return {
        progressId,
        state: progressId ? "error" : "idle",
        stage: progressId ? "error" : "idle",
        label: progressId ? "任务已失效，请重新查询" : "等待开始查询",
        detail: progressId ? "查询结果已超过 30 分钟保留期限，或服务已重启" : "",
        trace: [],
        steps: progressSteps(progressId ? "error" : "idle", progressId ? "error" : "idle")
      };
    }
    return {
      ...record,
      expiresAt: record.updatedAt + this.progressTtlMs,
      steps: progressSteps(record.stage, record.state)
    };
  }

  cleanupProgress() {
    const cutoff = Date.now() - this.progressTtlMs;
    for (const [key, record] of this.progressByQuery.entries()) {
      if (record.updatedAt < cutoff) {
        this.progressByQuery.delete(key);
        this.pendingQueries.delete(key);
      }
    }
  }

  async fetchOverview(query, userId = "local-cli") {
    const normalized = normalizeQuery(query);
    const ownerId = normalizeServiceUserId(userId);
    return this.enqueue(() => this.executeOverview(normalized, ownerId));
  }

  startOverview(query, userId = "local-cli") {
    const normalized = normalizeQuery(query);
    const ownerId = normalizeServiceUserId(userId);
    const progressId = normalized.progressId || createProgressId();
    normalized.progressId = progressId;
    const existing = progressId
      ? this.progressByQuery.get(this.progressKey(progressId, ownerId))
      : null;
    if (existing && ["queued", "running", "waiting", "done", "partial"].includes(existing.state)) {
      return {
        progressId,
        state: existing.state,
        loginRequired: existing.state === "waiting",
        resumed: true
      };
    }
    const activeForOwner = [...this.progressByQuery.entries()]
      .filter(([key, record]) => key.startsWith(`${ownerId}\u0000`)
        && ["queued", "running", "waiting"].includes(record.state))
      .length;
    const perUserLimit = Math.max(1, Number(this.config.server?.queryQueuePerUserLimit || 2));
    const globalLimit = Math.max(perUserLimit, Number(this.config.server?.queryQueueGlobalLimit || 20));
    if (activeForOwner >= perUserLimit) {
      throw overviewError("当前账号已有过多查询任务，请等待已有任务完成", 429);
    }
    if (this.queuedTasks >= globalLimit) {
      throw overviewError("查询队列已满，请稍后再试", 503);
    }
    this.updateProgress(progressId, ownerId, {
      state: "queued",
      stage: "queued",
      label: "已提交查询，等待后台任务",
      detail: normalized.userId ? "正在准备按用户ID查询" : "正在准备按手机号查询"
    });
    if (this.loginLease?.userId === ownerId) {
      this.updateProgress(progressId, ownerId, {
        state: "waiting",
        stage: "login",
        label: "等待后台登录验证",
        detail: "请完成扫码/验证后继续查询"
      });
    }
    this.enqueue(() => this.executeOverview(normalized, ownerId, true)).catch((error) => {
      this.updateProgress(progressId, ownerId, {
        state: "error",
        stage: "error",
        label: "查询失败",
        detail: error?.message || String(error),
        error: error?.message || String(error)
      });
    });
    return {
      progressId,
      state: this.loginLease?.userId === ownerId ? "waiting" : "queued",
      loginRequired: Boolean(this.loginLease?.userId === ownerId)
    };
  }

  async executeOverview(query, userId = "local-cli", waitForLogin = false) {
    const normalized = normalizeQuery(query);
    const ownerId = normalizeServiceUserId(userId);
    const generation = this.userGenerations.get(ownerId) || 0;
    const progressId = normalized.progressId;
    this.updateProgress(progressId, ownerId, {
      state: "queued",
      stage: "queued",
      label: "已提交查询，等待后台任务",
      detail: normalized.userId ? "正在准备按用户ID查询" : "正在准备按手机号查询"
    });
    if (this.loginLease?.userId === ownerId && !waitForLogin) {
      this.updateProgress(progressId, ownerId, {
        state: "waiting",
        stage: "login",
        label: "等待后台登录验证",
        detail: "请完成扫码/验证后继续查询"
      });
      return createLoginRequiredResult(normalized, this.loginLease.expiresAt);
    }
    {
      this.updateProgress(progressId, ownerId, {
        state: "running",
        stage: "connect",
        label: "正在连接后台查询页面",
        detail: "正在检查后台登录态"
      });
      if (this.loginLease?.userId === ownerId) {
        this.updateProgress(progressId, ownerId, {
          state: "waiting",
          stage: "login",
          label: "等待后台登录验证",
          detail: "检测到登录验证任务，验证完成后自动继续"
        });
      }
      await this.waitForLoginLease();
      this.assertUserEnabled(ownerId, generation);
      await this.browserClient.activateUser(ownerId);
      const result = await this.fetchOverviewWithRetry(normalized, ownerId, generation, progressId);
      if (result.loginRequired) {
        this.updateProgress(progressId, ownerId, {
          state: "waiting",
          stage: "login",
          label: "等待后台登录验证",
          detail: result.error || "请完成扫码/验证后继续查询"
        });
        if (waitForLogin && progressId) {
          this.pendingQueries.set(this.progressKey(progressId, ownerId), {
            query: normalized,
            userId: ownerId
          });
        }
      } else {
        this.pendingQueries.delete(this.progressKey(progressId, ownerId));
        this.completeProgress(progressId, ownerId, result);
      }
      return result;
    }
  }

  publishOrderProgress(progressId, userId, orders = [], total = 0, formalTotal = 0, stage = "orders", detail = "") {
    if (!progressId) return;
    const normalizedOrders = normalizeOrderDetails(orders);
    const formalProcessed = normalizedOrders.filter((order) => order.orderType === "formal" && order.campSchedule?.matched).length;
    this.updateProgress(progressId, userId, {
      state: "running",
      stage,
      label: stage === "schedule"
        ? `营期信息处理中 ${formalProcessed} / ${formalTotal || normalizedOrders.filter((order) => order.orderType === "formal").length}`
        : `订单信息处理中 ${normalizedOrders.length} / ${total || normalizedOrders.length}`,
      detail: detail || `已完成 ${normalizedOrders.length} 条订单`,
      counts: {
        ordersFound: Number(total || normalizedOrders.length),
        ordersProcessed: normalizedOrders.length,
        formalTotal: Number(formalTotal || normalizedOrders.filter((order) => order.orderType === "formal").length),
        formalProcessed,
        complaints: "pending"
      },
      partial: {
        orders: normalizedOrders,
        orderGroups: groupOrdersByType(normalizedOrders)
      }
    });
  }

  async fetchOverviewWithRetry(query, userId, generation, progressId = "") {
    try {
      return await this.fetchOverviewUnqueued(query, userId, generation, progressId);
    } catch (error) {
      if (!isTargetClosedError(error)) throw error;
      this.assertUserEnabled(userId, generation);
      await this.browserClient.reset(this.config.browser.chanceAssUrl);
      this.updateProgress(progressId, userId, {
        state: "running",
        stage: "connect",
        label: "后台页面已重连，正在重试查询",
        detail: "检测到页面被重绘，已安全重试"
      });
      return this.fetchOverviewUnqueued(query, userId, generation, progressId);
    }
  }

  enqueue(task) {
    this.queuedTasks += 1;
    const run = async () => {
      this.queuedTasks = Math.max(0, this.queuedTasks - 1);
      this.activeTasks += 1;
      try {
        return await task();
      } finally {
        this.activeTasks = Math.max(0, this.activeTasks - 1);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  getStatus() {
    return {
      busy: this.activeTasks > 0,
      active: this.activeTasks,
      queued: this.queuedTasks,
      backendLoginActive: Boolean(this.loginLease)
    };
  }

  async checkLogin(options = {}, userId = "local-cli") {
    const ownerId = normalizeServiceUserId(userId);
    return this.enqueue(async () => {
      await this.waitForLoginLease();
      this.assertUserEnabled(ownerId);
      await this.browserClient.activateUser(ownerId);
      const open = options.open !== false;
      const page = open
        ? await this.browserClient.ensurePage(this.config.browser.chanceAssUrl, { navigateExisting: true })
        : this.browserClient.getExistingPage();
      if (!page) {
        return {
          ready: false,
          loginRequired: true,
          message: "后台浏览器尚未打开，请先点击登录验证按钮。",
          url: "",
          checkedAt: new Date().toISOString()
        };
      }
      const readiness = await this.browserClient.ensureReady(page, {
        waitMs: open ? undefined : 1200
      });
      return {
        ready: readiness.ready,
        loginRequired: !readiness.ready,
        message: readiness.ready
          ? "已检测到后台登录态，可以开始提取。"
          : readiness.message,
        url: page.url(),
        checkedAt: new Date().toISOString()
      };
    });
  }

  async startBackendLogin(userId, sessionId = "local-session") {
    const ownerId = normalizeServiceUserId(userId);
    const ownerSession = normalizeSessionId(sessionId);
    if (this.loginLease?.userId === ownerId && this.loginLease?.sessionId === ownerSession) {
      return this.getBackendLoginStatus(ownerId, ownerSession);
    }
    return this.enqueue(async () => {
      await this.waitForLoginLease();
      this.assertUserEnabled(ownerId);
      await this.browserClient.activateUser(ownerId);
      const page = await this.browserClient.ensurePage(this.config.browser.chanceAssUrl, { navigateExisting: true });
      const readiness = await this.browserClient.ensureReady(page, { waitMs: 1200 });
      if (readiness.ready) {
        const expiresAt = this.rememberBackendReady(ownerId, ownerSession);
        return {
          ready: true,
          state: "ready",
          loginRequired: false,
          expiresAt: new Date(expiresAt).toISOString()
        };
      }
      this.clearBackendReady(ownerId, ownerSession);
      const qrReady = await this.browserClient.prepareQrLogin(page);
      if (!qrReady) {
        throw new Error("未能进入企业微信官方二维码页面，扫码会话未创建");
      }
      const qrPage = this.browserClient.getExistingPage();
      if (!qrPage || !/login\.work\.weixin\.qq\.com/i.test(qrPage.url?.() || "")) {
        throw new Error("扫码截图来源校验失败：当前页面不是企业微信官方二维码页");
      }
      const expiresAt = Date.now() + 120000;
      this.loginLease = {
        userId: ownerId,
        sessionId: ownerSession,
        expiresAt,
        loginPage: qrPage,
        screenshot: await this.browserClient.captureScreenshot(qrPage),
        interactionRequired: await this.browserClient.detectUnsupportedLoginInteraction(qrPage)
      };
      this.loginLease.timer = setTimeout(() => this.releaseLoginLease(ownerId, "expired"), 120000);
      return {
        ready: false,
        state: "waiting",
        loginRequired: true,
        interactionRequired: this.loginLease.interactionRequired,
        screenshotAvailable: Boolean(this.loginLease.screenshot),
        expiresAt: new Date(expiresAt).toISOString()
      };
    });
  }

  async getBackendLoginStatus(userId, sessionId = "local-session") {
    const ownerId = normalizeServiceUserId(userId);
    const ownerSession = normalizeSessionId(sessionId);
    const lease = this.loginLease;
    if (!lease || lease.userId !== ownerId || lease.sessionId !== ownerSession) {
      const remembered = this.getRememberedBackendReady(ownerId, ownerSession);
      if (remembered) {
        return {
          ready: true,
          state: "ready",
          loginRequired: false,
          screenshotAvailable: false,
          expiresAt: new Date(remembered.expiresAt).toISOString()
        };
      }
      return { ready: false, state: "idle", loginRequired: true, screenshotAvailable: false };
    }
    if (Date.now() >= lease.expiresAt) {
      this.releaseLoginLease(ownerId, "expired");
      return { ready: false, state: "expired", loginRequired: true, screenshotAvailable: false };
    }
    this.assertUserEnabled(ownerId);
    const loginPage = lease.loginPage && !(typeof lease.loginPage.isClosed === "function" && lease.loginPage.isClosed())
      ? lease.loginPage
      : this.browserClient.getExistingPage();
    const page = loginPage;
    const ready = Boolean(page && await this.browserClient.isLoggedIn(page, { waitMs: 800 }));
    if (ready) {
      const expiresAt = this.rememberBackendReady(ownerId, ownerSession);
      this.releaseLoginLease(ownerId, "ready");
      return {
        ready: true,
        state: "ready",
        loginRequired: false,
        expiresAt: new Date(expiresAt).toISOString()
      };
    }
    lease.screenshot = await this.browserClient.captureScreenshot(page);
    lease.interactionRequired = await this.browserClient.detectUnsupportedLoginInteraction(page);
    return {
      ready: false,
      state: "waiting",
      loginRequired: true,
      interactionRequired: lease.interactionRequired,
      screenshotAvailable: Boolean(lease.screenshot),
      expiresAt: new Date(lease.expiresAt).toISOString()
    };
  }

  getBackendLoginScreenshot(userId, sessionId = "local-session") {
    const ownerId = normalizeServiceUserId(userId);
    const ownerSession = normalizeSessionId(sessionId);
    const lease = this.loginLease;
    if (!lease || lease.userId !== ownerId || lease.sessionId !== ownerSession || !lease.screenshot) return null;
    return lease.screenshot;
  }

  async cancelBackendLogin(userId, sessionId = "local-session") {
    const ownerId = normalizeServiceUserId(userId);
    const ownerSession = normalizeSessionId(sessionId);
    const clearedReady = this.clearBackendReady(ownerId, ownerSession);
    const cancelled = this.loginLease?.sessionId === ownerSession
      ? this.releaseLoginLease(ownerId, "cancelled")
      : false;
    if (cancelled || clearedReady) await this.browserClient.closeUser(ownerId);
    return cancelled || clearedReady;
  }

  async closeUser(userId) {
    const ownerId = normalizeServiceUserId(userId);
    this.clearBackendReady(ownerId);
    this.releaseLoginLease(ownerId, "closed");
    await this.browserClient.closeUser(ownerId);
  }

  async disableUser(userId, options = {}) {
    const ownerId = normalizeServiceUserId(userId);
    this.userGenerations.set(ownerId, (this.userGenerations.get(ownerId) || 0) + 1);
    this.blockedUsers.add(ownerId);
    this.clearBackendReady(ownerId);
    for (const [key, pending] of this.pendingQueries.entries()) {
      if (pending.userId === ownerId) this.pendingQueries.delete(key);
    }
    this.releaseLoginLease(ownerId, "disabled");
    await this.browserClient.closeUser(ownerId);
    if (options.deleteProfile !== false) await this.browserClient.deleteUserProfile(ownerId);
  }

  enableUser(userId) {
    this.blockedUsers.delete(normalizeServiceUserId(userId));
  }

  releaseLoginLease(userId, reason) {
    if (!this.loginLease || this.loginLease.userId !== userId) return false;
    clearTimeout(this.loginLease.timer);
    this.loginLease = null;
    this.loginLeaseReleased?.({ reason });
    this.loginLeaseReleased = null;
    if (reason === "ready") this.resumePendingQueries(userId);
    return true;
  }

  resumePendingQueries(userId) {
    const ownerId = normalizeServiceUserId(userId);
    for (const [key, pending] of this.pendingQueries.entries()) {
      if (pending.userId !== ownerId) continue;
      this.pendingQueries.delete(key);
      this.enqueue(() => this.executeOverview(pending.query, ownerId, true)).catch((error) => {
        this.updateProgress(pending.query.progressId, ownerId, {
          state: "error",
          stage: "error",
          label: "登录完成后恢复查询失败",
          detail: error?.message || String(error)
        });
      });
    }
  }

  async waitForLoginLease() {
    while (this.loginLease) {
      if (Date.now() >= this.loginLease.expiresAt) {
        this.releaseLoginLease(this.loginLease.userId, "expired");
        break;
      }
      await new Promise((resolve) => {
        const previous = this.loginLeaseReleased;
        this.loginLeaseReleased = (value) => {
          previous?.(value);
          resolve(value);
        };
      });
    }
  }

  assertUserEnabled(userId, expectedGeneration = null) {
    if (this.blockedUsers.has(userId)) throw new Error("该网站账号已被禁用");
    if (expectedGeneration !== null && expectedGeneration !== (this.userGenerations.get(userId) || 0)) {
      throw new Error("该网站账号的当前任务已被管理员终止");
    }
  }

  async fetchOverviewUnqueued(query, websiteUserId = "local-cli", generation = 0, progressId = "") {
    const startedAt = Date.now();
    const lookup = query.userId
      ? { type: "userId", label: "用户ID", value: query.userId }
      : { type: "phone", label: "手机号", value: query.phone };
    const baseResult = createEmptyOverview(query, lookup);
    const trace = [];
    const rawTracePush = trace.push.bind(trace);
    trace.push = (...items) => {
      for (const item of items) this.updateProgressFromTrace(progressId, websiteUserId, item, trace);
      return rawTracePush(...items);
    };
    const writeTrace = (stage, extra = {}) => {
      const progress = progressFromTraceStage(stage, extra);
      if (progress) this.updateProgress(progressId, websiteUserId, { ...progress, trace });
      this.logger.writeJson("search-trace", {
        stage,
        trace,
        websiteUserId,
        lookupType: lookup.type,
        userId: maskForTrace(lookup.value),
        at: new Date().toISOString(),
        ...extra
      });
    };
    if (!lookup.value) {
      return {
        ...baseResult,
        error: "请填写用户ID或手机号。",
        trace,
        durationMs: Date.now() - startedAt
      };
    }

    trace.push("打开页面");
    writeTrace("entered");
    const queryMode = normalizeQueryMode(query.mode);
    const entryUrl = this.config.browser.chanceAssUrl;
    const page = await this.browserClient.ensurePage(entryUrl);
    trace.push("登录检查");
    writeTrace("login-check");
    const readiness = await this.browserClient.ensureReady(page);
    if (!readiness.ready) {
      writeTrace("login-required", { message: readiness.message });
      return {
        ...baseResult,
        error: "请先点击“打开后台并验证登录”，完成扫码/验证后再提取。",
        loginRequired: true,
        trace,
        durationMs: Date.now() - startedAt
      };
    }

    const evidence = [];
    let chancePage = null;
    try {
      if (queryMode === "complaint" && lookup.type === "userId") {
        const resolvedUserId = String(lookup.value).trim();
        trace.push("投诉模式使用独立任务页");
        writeTrace("complaint-isolated-start", { directUserId: true });
        this.updateProgress(progressId, websiteUserId, {
          state: "running",
          stage: "complaints",
          label: "正在查询投诉信息",
          detail: "已取得用户ID，正在读取投诉记录",
          counts: { complaints: "running" }
        });
        const complaintQuery = { ...query, userId: resolvedUserId };
        const complaint = await this.queryComplaintsIsolated(complaintQuery, trace);
        this.updateProgress(progressId, websiteUserId, {
          state: "running",
          stage: "complaints",
          label: "投诉信息查询完成",
          detail: complaint.error || `已读取 ${complaint.records?.length || 0} 条投诉记录`,
          counts: { complaints: "done" }
        });
        evidence.push(...(complaint.evidence || []));
        return {
          ...baseResult,
          found: complaint.found,
          overview: {
            ...baseResult.overview,
            basic: {
              ...baseResult.overview.basic,
              userId: resolvedUserId,
              phone: query.phone
            },
            complaints: complaint.records,
            complaintSummary: { tabs: complaint.tabs, diagnostics: complaint.diagnostics || {} }
          },
          evidence,
          source: "complaintWorkDom",
          error: complaint.error || (complaint.found ? "" : "未查询到投诉记录"),
          trace,
          durationMs: Date.now() - startedAt
        };
      }

      chancePage = page;
      await chancePage.goto(this.config.browser.chanceAssUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await chancePage.waitForTimeout(this.config.ui.afterGotoWaitMs);
      const chanceReady = await this.browserClient.ensureReady(chancePage);
      if (!chanceReady.ready) {
        writeTrace("login-required-after-goto", { message: chanceReady.message });
        return {
          ...baseResult,
          error: "请先点击“打开后台并验证登录”，完成扫码/验证后再提取。",
          loginRequired: true,
          trace,
          durationMs: Date.now() - startedAt
        };
      }

      const chance = await this.searchChanceAss(chancePage, query, lookup, trace);
      writeTrace("chance-search-done", { found: chance.found, error: chance.error || "" });
      evidence.push(...chance.evidence);
      if (queryMode === "complaint") {
        const resolvedUserId = lookup.type === "userId"
          ? lookup.value
          : await resolveProfileUserId(chance.profilePage, chance);
        if (!resolvedUserId) {
          return {
            ...baseResult,
            error: chance.error || "已按手机号命中记录，但未能从学员档案取得用户ID，无法继续查询投诉。",
            evidence,
            trace,
            durationMs: Date.now() - startedAt
          };
        }
        const complaintQuery = { ...query, userId: resolvedUserId };
        this.updateProgress(progressId, websiteUserId, {
          state: "running",
          stage: "complaints",
          label: "正在查询投诉信息",
          detail: "已从手机号结果解析用户ID，正在读取投诉记录",
          counts: { complaints: "running" }
        });
        const complaint = await this.queryComplaintsIsolated(complaintQuery, trace);
        this.updateProgress(progressId, websiteUserId, {
          state: "running",
          stage: "complaints",
          label: "投诉信息查询完成",
          detail: complaint.error || `已读取 ${complaint.records?.length || 0} 条投诉记录`,
          counts: { complaints: "done" }
        });
        evidence.push(...(complaint.evidence || []));
        return {
          ...baseResult,
          found: complaint.found,
          overview: {
            ...baseResult.overview,
            basic: {
              ...baseResult.overview.basic,
              userId: resolvedUserId,
              phone: lookup.type === "phone" ? lookup.value : query.phone
            },
            complaints: complaint.records,
            complaintSummary: { tabs: complaint.tabs, diagnostics: complaint.diagnostics || {} }
          },
          evidence,
          source: "complaintWorkDom",
          error: complaint.error || (complaint.found ? "" : "未查询到投诉记录"),
          trace,
          durationMs: Date.now() - startedAt
        };
      }

      let profile = null;
      if (chance.profilePage) {
        try {
          profile = await this.extractProfile(chance.profilePage, query, lookup, trace, {
            progressId,
            websiteUserId,
            onOrders: (orders, total, formalTotal, detail) =>
              this.publishOrderProgress(progressId, websiteUserId, orders, total, formalTotal, "orders", detail)
          });
        } catch (error) {
          profile = {
            orders: [],
            evidence: [],
            error: `学员档案提取异常：${error.message || String(error)}`
          };
          trace.push("学员档案异常，继续独立投诉查询");
          writeTrace("profile-extract-error", { error: profile.error });
        }
      }
      writeTrace("profile-extract-done", {
        orderCount: profile?.orders?.length || 0,
        error: profile?.error || ""
      });
      if (profile?.evidence?.length) evidence.push(...profile.evidence);

      let merged = mergeOverview({
        base: baseResult,
        config: this.config,
        lookup,
        chance,
        profile,
        evidence
      });

      if (queryMode === "all") {
        const complaintUserId = resolveComplaintQueryUserId(lookup, merged.overview.basic.userId);
        const complaintQuery = { ...query, userId: complaintUserId };
        this.updateProgress(progressId, websiteUserId, {
          state: "running",
          stage: "complaints",
          label: "正在查询投诉信息",
          detail: complaintUserId ? "正在读取投诉记录" : "未取得用户ID，跳过投诉查询",
          counts: { complaints: complaintUserId ? "running" : "skipped" }
        });
        const complaint = complaintUserId ? await this.queryComplaintsIsolated(complaintQuery, trace) : {
          found: false,
          records: [],
          tabs: [],
          evidence: [],
          error: "未能取得用户ID，已跳过投诉查询。",
          diagnostics: { complaintPageIsolated: true, technicalFailure: true }
        };
        this.updateProgress(progressId, websiteUserId, {
          state: "running",
          stage: "complaints",
          label: "投诉信息查询完成",
          detail: complaint.error || `已读取 ${complaint.records?.length || 0} 条投诉记录`,
          counts: { complaints: "done" }
        });
        evidence.push(...(complaint.evidence || []));
        merged = {
          ...merged,
          found: Boolean(merged.found || complaint.found),
          overview: {
            ...merged.overview,
            basic: {
              ...merged.overview.basic,
              userId: merged.overview.basic.userId || complaintUserId
            },
            complaints: complaint.records,
            complaintSummary: { tabs: complaint.tabs, diagnostics: complaint.diagnostics || {} }
          },
          evidence: prioritizeScheduleEvidence(evidence, 30),
          error: [merged.error, complaint.error].filter(Boolean).join(" ")
        };
      }

      if (!merged.found) {
        await this.logger.pageSnapshot(chancePage, "not-found", query);
      }

      return {
        ...merged,
        trace,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      writeTrace("error", { message: error.message || String(error) });
      if (isTargetClosedError(error)) {
        this.assertUserEnabled(websiteUserId, generation);
        await this.browserClient.reset(this.config.browser.chanceAssUrl);
        throw error;
      }
      if (chancePage) await this.logger.pageSnapshot(chancePage, "dom-error", query);
      return {
        ...baseResult,
        error: `DOM 抓取异常：${error.message}`,
        trace,
        durationMs: Date.now() - startedAt
      };
    } finally {
      // 主 chanceAss 页面保留给下一次查询复用登录态和页面状态。
    }
  }

  updateProgressFromTrace(progressId, userId, item, trace) {
    if (!progressId) return;
    const label = String(item || "").trim();
    if (!label) return;
    let patch = null;
    if (/投诉/.test(label)) {
      patch = { state: "running", stage: "complaints", label: "正在查询投诉信息", detail: label };
    } else if (/营期|期数|开营|结营|训练营/.test(label)) {
      patch = { state: "running", stage: "schedule", label: "已查询到营期信息", detail: label };
    } else if (/订单|商品/.test(label)) {
      patch = { state: "running", stage: "orders", label: "正在查询订单信息", detail: label };
    } else if (/学员档案|机会管理/.test(label)) {
      patch = { state: "running", stage: "profile", label: "已查询到学员档案", detail: label };
    } else if (/登录/.test(label)) {
      patch = { state: "running", stage: "login", label: "正在检查后台登录态", detail: label };
    }
    if (patch) this.updateProgress(progressId, userId, { ...patch, trace });
  }

  async queryComplaintsIsolated(query, trace = []) {
    let previous = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const retryReason = attempt === 1
        ? ""
        : previous?.diagnostics?.technicalFailureReason || previous?.error || "投诉查询技术失败";
      const result = await this.browserClient.withIsolatedPage(
        this.config.browser.complaintWorkUrl,
        (page) => queryComplaintRecords({
          page,
          config: this.config,
          query,
          trace,
          logger: this.logger
        })
      );
      const enriched = {
        ...result,
        diagnostics: {
          ...(result.diagnostics || {}),
          complaintPageIsolated: true,
          complaintAttempt: attempt,
          complaintRetryReason: retryReason
        }
      };
      if (!enriched.diagnostics.technicalFailure) return enriched;
      previous = enriched;
      if (attempt < 2) trace.push(`投诉查询技术重试：${retryReason}`);
    }
    return previous;
  }

  async searchChanceAss(page, query, lookup, trace = []) {
    await clickButtonByText(page, this.config.selectors.resetButtonText).catch(() => false);
    await page.waitForTimeout(300).catch(() => {});
    trace.push("清日期");
    const dateRange = await clearChanceAssDateRange(page);
    if (!dateRange.cleared) {
      const snapshot = await this.logger.pageSnapshot(page, "date-range-clear-failed", query);
      return {
        found: false,
        error: `日期范围清理失败${snapshot ? `，调试日志：${snapshot}` : ""}`,
        evidence: buildDateRangeEvidence(dateRange),
        pairs: [],
        bodyText: "",
        dateRange
      };
    }

    trace.push(`切换${lookup.label}筛选`);
    const identityFilter = await ensureChanceAssIdentityFilter(page, lookup);
    if (!identityFilter.confirmed) {
      const snapshot = await this.logger.pageSnapshot(page, "identity-filter-failed", query);
      const probeFile = this.logger.writeJson("identity-filter-probe", identityFilter);
      return {
        found: false,
        error: `chanceAss 未能将查询条件切换为${lookup.label}${snapshot ? `，调试日志：${snapshot}` : ""}${probeFile ? `，DOM探针：${probeFile}` : ""}`,
        evidence: buildDateRangeEvidence(dateRange),
        pairs: [],
        bodyText: "",
        dateRange
      };
    }

    trace.push(`${lookup.label}筛选已确认`);
    trace.push(`填${lookup.label}`);
    const filled = await fillChanceAssIdentityValue(page, lookup.value);
    if (!filled) {
      const snapshot = await this.logger.pageSnapshot(page, "identity-value-fill-failed", query);
      const probe = await probeChanceAssInputs(page, lookup.value);
      const probeFile = this.logger.writeJson("identity-value-fill-probe", probe);
      return {
        found: false,
        error: `chanceAss ${lookup.label}输入框未找到或未填入${snapshot ? `，调试日志：${snapshot}` : ""}${probeFile ? `，DOM探针：${probeFile}` : ""}`,
        evidence: buildDateRangeEvidence(dateRange),
        pairs: [],
        bodyText: "",
        dateRange
      };
    }

    const filterAndValueConfirmed = await verifyChanceAssIdentityFilter(page, lookup);
    if (!filterAndValueConfirmed.confirmed) {
      const snapshot = await this.logger.pageSnapshot(page, "identity-filter-verification-failed", query);
      const probeFile = this.logger.writeJson("identity-filter-verification-probe", filterAndValueConfirmed);
      return {
        found: false,
        error: `chanceAss ${lookup.label}筛选条件校验失败，已阻止错误查询${snapshot ? `，调试日志：${snapshot}` : ""}${probeFile ? `，DOM探针：${probeFile}` : ""}`,
        evidence: buildDateRangeEvidence(dateRange),
        pairs: [],
        bodyText: "",
        dateRange
      };
    }

    await page.waitForTimeout(this.config.ui.afterFillWaitMs);
    trace.push("点击查询");
    const clicked = await clickChanceAssQueryButton(page, lookup);
    if (!clicked) {
      const snapshot = await this.logger.pageSnapshot(page, "query-click-failed", query);
      return {
        found: false,
        error: `查询按钮未找到，或点击后未发出包含本次${lookup.label}的查询请求${snapshot ? `，调试日志：${snapshot}` : ""}`,
        evidence: [],
        pairs: [],
        bodyText: ""
      };
    }

    trace.push("查询请求已确认");
    trace.push("等待结果");
    await page.waitForTimeout(this.config.ui.afterQueryWaitMs);
    const rowFound = await waitForChanceAssUserRow(page, lookup, this.config.ui.afterQueryWaitMs);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const pairs = await readLabelValuePairs(page);
    const matchedUserId = await extractMatchedUserId(page, lookup);
    const found = Boolean(rowFound);
    const evidence = [
      ...buildDateRangeEvidence(dateRange),
      ...buildEvidence("机会管理", bodyText, lookup.value, pairs)
    ];
    let profilePage = null;

    if (found) {
      trace.push("学员档案");
      profilePage = await this.tryOpenProfile(page, lookup);
      if (!profilePage) {
        const snapshot = await this.logger.pageSnapshot(page, "profile-open-failed", query);
        return {
          found: false,
          error: `学员档案入口未找到或未打开${snapshot ? `，调试日志：${snapshot}` : ""}`,
          evidence,
          pairs,
          bodyText,
          dateRange,
          profilePage: null
        };
      }
    }

    return {
      found,
      error: found ? "" : "未查询到用户记录",
      evidence,
      pairs,
      bodyText,
      dateRange,
      profilePage,
      matchedUserId
    };
  }

  async tryOpenProfile(page, lookup) {
    const normalizedLookup = normalizeChanceLookup(lookup);
    const expectedUserId = normalizedLookup.type === "userId" ? normalizedLookup.value : "";
    const context = page.context();

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const beforePages = new Set(context.pages());
      const clicked = await clickStudentProfileInMatchedRow(page, normalizedLookup);
      if (!clicked) return null;
      await page.waitForTimeout(this.config.ui.afterClickWaitMs);

      const afterPages = context.pages();
      const opened = afterPages.find((item) => !beforePages.has(item) && !item.isClosed());
      const target = opened || page;
      await target.bringToFront().catch(() => {});
      const archiveState = await getStudentArchiveState(target, expectedUserId, 6500);
      if (archiveState.ready) return target;

      if (target !== page || attempt >= 2) return null;
      await page.waitForTimeout(500).catch(() => {});
    }
    return null;
  }

  async extractProfile(page, query, lookup, trace = [], progressContext = {}) {
    const bodyBefore = await findVisibleText(page, 8000);
    const profilePairs = await readLabelValuePairs(page);
    const profileUserId = resolveUserIdFromContent(bodyBefore, profilePairs)
      || (lookup.type === "userId" ? lookup.value : "");
    const operationalLookup = profileUserId
      ? { type: "userId", label: "用户ID", value: profileUserId }
      : lookup;
    const evidence = buildEvidence("学员档案", bodyBefore, lookup.value, profilePairs);
    const archiveState = await getStudentArchiveState(page, profileUserId, 3500);
    if (!archiveState.ready) {
      const snapshot = await this.logger.pageSnapshot(page, "archive-page-not-opened", query);
      return {
        pairs: [],
        bodyText: bodyBefore,
        redBox: normalizeSingleOrderRedBox({}),
        orders: [],
        evidence,
        error: `学员档案未打开：${archiveState.reason}${snapshot ? `，调试日志：${snapshot}` : ""}`
      };
    }

    trace.push("订单信息");
    await clickTabByText(page, this.config.selectors.orderInfoText).catch(() => false);
    const orderState = await getOrderPageState(page, 6000);
    const bodyAfterOrder = await findVisibleText(page, 10000);
    const orderPairs = await readLabelValuePairs(page);
    evidence.push(...buildEvidence("订单信息", bodyAfterOrder, operationalLookup.value, orderPairs));
    if (!orderState.ready) {
      const snapshot = await this.logger.pageSnapshot(page, "order-page-not-opened", query);
      return {
        pairs: orderPairs,
        bodyText: cleanText(`${bodyBefore}\n${bodyAfterOrder}`),
        redBox: normalizeSingleOrderRedBox({}),
        orders: [],
        evidence,
        error: `订单信息 Tab 未打开：${orderState.reason}${snapshot ? `，调试日志：${snapshot}` : ""}`
      };
    }
    trace.push("订单信息页已确认");

    const orderScan = await collectDomOrdersAcrossScroll(page);
    this.logger.writeJson("order-card-dom-probe", {
      lookupType: lookup.type,
      scannedOrders: orderScan.orders.length,
      summary: orderScan.summary
    });
    const orderPageText = await collectOrderPageText(page);
    trace.push(`采集订单${orderScan.orders.length}个`);
    if (!orderScan.orders.length) {
      const snapshot = await this.logger.pageSnapshot(page, "order-detail-buttons-not-found", query);
      return {
        pairs: orderPairs,
        bodyText: cleanText(`${bodyBefore}\n${bodyAfterOrder}\n${orderPageText}`),
        redBox: normalizeSingleOrderRedBox({}),
        orders: [],
        evidence,
        error: `订单详情按钮未找到${snapshot ? `，调试日志：${snapshot}` : ""}`
      };
    }

    const queryMode = normalizeQueryMode(query.mode);
    const formalTotal = orderScan.orders.filter((order) => resolveCampType(order) === "formal").length;
    let orderDetails = await extractAllOrderDetails(page, this.config, operationalLookup, orderScan.orders, trace, {
      includeRefunds: queryMode !== "schedule",
      logger: this.logger,
      query,
      onOrder: progressContext.onOrders
        ? (orders) => progressContext.onOrders(orders, orderScan.orders.length, formalTotal, "订单详情已完成")
        : null
    });
    progressContext.onOrders?.(orderDetails, orderScan.orders.length, formalTotal, "订单详情读取完成，正在匹配营期");
    const scheduleResult = queryMode === "order"
      ? {
        orders: orderDetails.map((order) => ({ ...order, campSchedule: createCampSchedule({ requested: false }) })),
        evidence: []
      }
      : await enrichFormalOrderSchedules({
        page,
        config: this.config,
        lookup: operationalLookup,
        query,
        orders: orderDetails,
        trace,
        logger: this.logger
      });
    orderDetails = scheduleResult.orders;
    progressContext.onOrders?.(orderDetails, orderScan.orders.length, formalTotal, "订单详情读取完成，营期信息继续处理");
    evidence.push(...scheduleResult.evidence);
    const detailPairs = orderDetails.flatMap((item) => item.pairs || []);
    const bodyAfterDetail = orderDetails.map((item) => item.bodyText || "").join("\n");
    const firstOpened = orderDetails.find((item) => item.detailOpened);
    const redBox = firstOpened?.redBox || orderDetails[0]?.redBox || extractOrderDetailRedBox(bodyAfterDetail, detailPairs);
    trace.push(`提取字段(${orderDetails.length || 0}个订单)`);
    for (const item of orderDetails) {
      evidence.push(...buildEvidence(`订单详情${item.index ? `#${item.index}` : ""}`, item.bodyText || "", operationalLookup.value, item.pairs || []));
    }

    const errors = [];
    if (orderScan.summary?.truncated) {
      errors.push(`订单数量超过安全处理上限 ${MAX_ORDERS_PER_QUERY} 条，已保留前 ${MAX_ORDERS_PER_QUERY} 条并停止继续读取。`);
    }
    if (orderDetails.some((item) => !item.detailOpened)) {
      errors.push("部分订单详情未能打开；订单列表可识别字段和其他结果已保留。");
    }
    if (queryMode !== "order" && orderDetails.some((item) => item.orderType === "formal" && !item.campSchedule?.matched)) {
      errors.push("部分正式营未能匹配开营/结营时间；订单信息和其他结果不受影响。");
    }

    return {
      pairs: [...orderPairs, ...detailPairs],
      bodyText: cleanText(`${bodyBefore}\n${bodyAfterOrder}\n${bodyAfterDetail}`),
      redBox,
      orders: orderDetails,
      resolvedUserId: profileUserId,
      evidence,
      error: errors.join(" ")
    };
  }
}

export async function extractAllOrderDetails(page, config, lookup, orderCandidates = [], trace = [], options = {}) {
  const includeRefunds = options.includeRefunds !== false;
  const details = [];
  const recordOrderDetailFailure = async (candidate, index, error) => {
    const fallbackError = cleanText(error?.message || error || "订单详情打开失败");
    let probe = { reason: fallbackError };
    try {
      probe = typeof options.probeOrderDetailOpen === "function"
        ? await options.probeOrderDetailOpen({ page, candidate, index })
        : await probeOrderDetailOpen(page, candidate);
    } catch (probeError) {
      probe = { reason: `${fallbackError}；诊断探针失败：${cleanText(probeError?.message || probeError)}` };
    }
    let diagnosticRefs = [];
    try {
      const diagnosticFile = await options.logger?.writeJson?.("order-detail-open-failed", {
        orderIndex: index,
        orderId: maskForTrace(candidate.orderId || ""),
        productName: cleanText(candidate.productName || ""),
        sourceScrollTop: Number(candidate.sourceScrollTop || 0),
        probe
      });
      diagnosticRefs = diagnosticFile ? [diagnosticFile] : [];
    } catch {
      diagnosticRefs = [];
    }
    return {
      error: error ? fallbackError : cleanText(probe?.reason || fallbackError),
      probe,
      diagnosticRefs
    };
  };
  for (let index = 0; index < orderCandidates.length; index += 1) {
    const candidate = orderCandidates[index];
    let detailOpenAttempts = 0;
    try {
    trace.push(`打开订单详情#${index + 1}`);
    const returnToList = async (reason) => {
      if (typeof options.returnToOrderList === "function") {
        return Boolean(await options.returnToOrderList({ page, candidate, index: index + 1, reason }));
      }
      return returnToOrderListAfterDetail(page);
    };
    await returnToList("before-open");
    let detailOpened = false;
    let detailOpenError = "";
    let diagnosticRefs = [];
    let snapshot = { text: "", pairs: [], trainingName: "", productName: "", category: "", startTime: "", salesOwner: "", matched: false };
    let detailMode = "";

    const inlineCard = createInlineOrderCardDetailSnapshot(candidate);
    if (inlineCard.ok) {
      snapshot = inlineCard.snapshot;
      detailOpened = true;
      detailMode = "inline-card";
      trace.push(`订单详情#${index + 1}直接读取卡片字段`);
    }

    for (let attempt = 1; !detailOpened && attempt <= 2; attempt += 1) {
      detailOpenAttempts = attempt;
      const strategy = attempt === 1 ? "standard" : "alternate";
      if (attempt > 1) {
        trace.push(`订单详情#${index + 1}首次未打开，返回列表后使用备用定位重试`);
        await returnToList("retry");
        await page.waitForTimeout?.(500).catch(() => {});
      }
      if (typeof options.openOrderDetail === "function") {
        const outcome = await options.openOrderDetail({ page, candidate, index: index + 1, attempt, strategy });
        detailOpened = Boolean(outcome?.opened);
        if (outcome?.snapshot) snapshot = { ...snapshot, ...outcome.snapshot };
      } else {
        const panelBefore = await captureOrderDetailPanelProbe(page);
        const beforeUrl = page.url();
        const context = page.context();
        const beforePages = new Set(context.pages());
        const popupPromise = typeof context.waitForEvent === "function"
          ? context.waitForEvent("page", { timeout: 10000 }).catch(() => null)
          : Promise.resolve(null);
        const targetProbe = strategy === "standard"
          ? await findOrderDetailTarget(page, candidate)
          : null;
        const clicked = strategy === "standard"
          ? await clickOrderDetail(page, candidate)
          : await clickOrderDetail(page, candidate);
        let detailTargetUrl = "";
        let detailIdentity = null;
        if (clicked) {
          const outcome = await captureOpenedOrderDetail({
            sourcePage: page,
            candidate,
            beforePages,
            beforeUrl,
            popupPromise,
            maxWaitMs: strategy === "standard"
              ? Math.max(6500, Number(config?.ui?.afterClickWaitMs || 1500) + 5000)
              : 9000
          });
          detailOpened = Boolean(outcome.opened);
          detailMode = outcome.mode || "";
          detailTargetUrl = sanitizeUrlForTrace(outcome.targetUrl || "");
          detailIdentity = outcome.validation || null;
          if (outcome.snapshot) snapshot = { ...snapshot, ...outcome.snapshot };
          if (outcome.error) detailOpenError = cleanText(outcome.error);
        }
        const panelAfter = await captureOrderDetailPanelProbe(page);
        options.logger?.writeJson?.("order-detail-click-probe", {
          orderIndex: index + 1,
          attempt,
          strategy,
          orderId: maskForTrace(candidate.orderId || ""),
          sourceScrollTop: Number(candidate.sourceScrollTop || 0),
          candidate: {
            productType: cleanText(candidate.productType || ""),
            productName: cleanText(candidate.productName || ""),
            orderTime: cleanText(candidate.time || candidate.orderTime || "")
          },
          target: targetProbe,
          clicked,
          detailOpened,
          detailMode,
          detailTargetUrl,
          detailIdentity,
          parsedFields: Object.keys(snapshot.detail || {}).filter((key) => cleanText(snapshot.detail?.[key] || "")),
          panelBefore,
          panelAfter
        });
        if (!clicked || !detailOpened) continue;
      }
      if (detailOpened) break;
    }
    if (!detailOpened) {
      snapshot = createEmptyOrderDetailSnapshot();
      const failure = await recordOrderDetailFailure(candidate, index + 1, detailOpenError);
      const probe = failure.probe;
      detailOpenError = failure.error;
      trace.push(`订单详情#${index + 1}打开失败：${detailOpenError}`);
      diagnosticRefs = failure.diagnosticRefs;
    }
    const detailData = detailOpened ? normalizeOrderDetailData(snapshot.detail || {}) : normalizeOrderDetailData({});
    const verifiedDetailProductName = detailOpened ? cleanText(snapshot.productName || "") : "";
    const productName = cleanText(verifiedDetailProductName || candidate.productName || "");
    // 详情页“订单类型”（如“当期订单”）与列表“正式营/体验营”不是同一语义，
    // 顶层营类型必须继续以列表卡片为准，详情订单类型仅保存在 detail 中展示。
    const resolvedCampType = resolveCampType(candidate);
    const resolvedAmount = detailOpened && typeof detailData.amount === "number"
      ? detailData.amount
      : candidate.amount;
    const resolvedAmountText = detailOpened && detailData.amountText
      ? detailData.amountText
      : candidate.amountText || "";
    const resolvedOrderTime = detailOpened && detailData.orderTime
      ? detailData.orderTime
      : candidate.time || "";
    const redBox = normalizeSingleOrderRedBox({
      category: detailData.category || snapshot.category,
      startTime: detailData.startTime || snapshot.startTime,
      trainingCampName: detailOpened ? snapshot.trainingName || verifiedDetailProductName : ""
    });
    const bodyText = cleanText(snapshot.text || candidate.rawText || "");
    details.push({
      index: index + 1,
      // orderType 保留为兼容字段，但语义固定为营类型。详情中的“订单类型”
      // （如微信、当期订单）只保存在 detail.orderType，不能覆盖这里。
      orderType: resolvedCampType,
      orderTypeLabel: normalizeOrderType(resolvedCampType, true),
      campType: resolvedCampType,
      campTypeLabel: normalizeOrderType(resolvedCampType, true),
      productTypeRaw: candidate.productType || "",
      orderId: candidate.orderId || "",
      amount: resolvedAmount,
      amountText: resolvedAmountText,
      productName,
      detailProductName: verifiedDetailProductName,
      orderTime: resolvedOrderTime,
      detailOpened,
      detailMode,
      detailOpenAttempts,
      detailMatched: Boolean(snapshot.matched),
      processed: true,
      error: detailOpenError,
      diagnosticRefs,
      salesOwner: cleanText(detailData.salesOwner || snapshot.salesOwner || ""),
      detail: detailData,
      redBox,
      pairs: snapshot.pairs || [],
      bodyText,
      sourceTextSnippet: cleanText(candidate.rawText || "").slice(0, 1000),
      detailTextSnippet: bodyText.slice(0, 1200),
      text: [
        `订单${index + 1}（${normalizeOrderType(resolvedCampType, true)}）`,
        candidate.orderId ? `主订单ID：${candidate.orderId}` : "",
        candidate.productName ? `商品名称：${candidate.productName}` : "",
        snapshot.salesOwner ? `销售归属人：${snapshot.salesOwner}` : "",
        redBox.text
      ].filter(Boolean).join("\n")
    });
    const returnedToOrderList = await returnToList("after-detail");
    if (detailOpened && !returnedToOrderList) {
      trace.push(`订单详情#${index + 1}回退未确认`);
    }
    details[details.length - 1].returnedToOrderList = returnedToOrderList;
    if (options.onOrder) await options.onOrder(details.slice());

    if (includeRefunds && candidate.hasRefundRecord && returnedToOrderList) {
      trace.push(`退款记录#${index + 1}`);
      const refundClicked = await clickRefundRecord(page, candidate);
      const refundOpened = refundClicked ? await waitForRefundRecord(page, candidate, 5000) : false;
      const refund = refundOpened ? await extractRefundRecord(page, candidate) : { found: false };
      details[details.length - 1].refund = {
        ...refund,
        found: Boolean(refund.found)
      };
      await returnToOrderListAfterDetail(page);
    } else {
      details[details.length - 1].refund = {
        found: false
      };
    }
    if (options.onOrder) await options.onOrder(details.slice());
    } catch (error) {
      const failure = await recordOrderDetailFailure(candidate, index + 1, error);
      trace.push(`订单详情#${index + 1}打开失败：${failure.error}`);
      const failedOrder = {
        index: index + 1,
        orderType: resolveCampType(candidate),
        orderTypeLabel: normalizeOrderType(resolveCampType(candidate), true),
        campType: resolveCampType(candidate),
        campTypeLabel: normalizeOrderType(resolveCampType(candidate), true),
        productTypeRaw: candidate.productType || "",
        orderId: candidate.orderId || "",
        amount: candidate.amount,
        amountText: candidate.amountText || "",
        productName: cleanText(candidate.productName || ""),
        detailProductName: "",
        orderTime: candidate.time || "",
        detailOpened: false,
        detailMode: "",
        detailOpenAttempts: Math.min(2, Math.max(1, Number(detailOpenAttempts || 1))),
        detailMatched: false,
        processed: true,
        error: failure.error,
        diagnosticRefs: failure.diagnosticRefs,
        pairs: [],
        bodyText: cleanText(candidate.rawText || ""),
        sourceTextSnippet: cleanText(candidate.rawText || "").slice(0, 1000),
        detailTextSnippet: "",
        redBox: normalizeSingleOrderRedBox({}),
        salesOwner: "",
        detail: normalizeOrderDetailData({}),
        text: [
          `订单${index + 1}（${normalizeOrderType(candidate.productType, true)}）`,
          candidate.orderId ? `主订单ID：${candidate.orderId}` : "",
          candidate.productName ? `商品名称：${candidate.productName}` : ""
        ].filter(Boolean).join("\n"),
        returnedToOrderList: false,
        refund: { found: false }
      };
      const existingIndex = details.findIndex((item) => item.index === index + 1);
      if (existingIndex >= 0) details[existingIndex] = { ...details[existingIndex], ...failedOrder };
      else details.push(failedOrder);
      if (options.onOrder) {
        try {
          await options.onOrder(details.slice());
        } catch {
          // 进度回调失败不能阻断后续订单。
        }
      }
    }
  }

  return dedupeOrderDetails(details);
}

async function enrichFormalOrderSchedules({ page, config, lookup, query, orders = [], trace = [], logger }) {
  const evidence = [];
  const trainingCampCache = new Map();
  const scheduleCache = new Map();
  const enrichedOrders = orders.map((order) => ({
    ...order,
    orderType: resolveCampType(order),
    orderTypeLabel: normalizeOrderType(resolveCampType(order), true),
    campType: resolveCampType(order),
    campTypeLabel: normalizeOrderType(resolveCampType(order), true),
    campSchedule: createCampSchedule({ requested: resolveCampType(order) === "formal" })
  }));
  const formalOrders = enrichedOrders.filter((order) => order.campType === "formal");
  if (!formalOrders.length) return { orders: enrichedOrders, evidence };

  await returnToOrderListAfterDetail(page);
  const trainingInfoReady = await openTrainingCampInfo(page, lookup.value);
  if (!trainingInfoReady) {
    for (const order of formalOrders) {
      await failCampSchedule({
        page,
        logger,
        query,
        order,
        evidence,
        stage: "training-camp-info-not-opened",
        message: "训练营信息 Tab 未打开"
      });
    }
    return { orders: enrichedOrders, evidence };
  }

  for (const order of formalOrders) {
    const orderNumber = order.index || enrichedOrders.indexOf(order) + 1;
    const category = cleanText(order.redBox?.category || "");
    const productName = cleanText(order.detailProductName || order.productName || "");
    if (!productName) {
      await failCampSchedule({
        page,
        logger,
        query,
        order,
        evidence,
        stage: `formal-order-fields-missing-${orderNumber}`,
        message: "正式营订单缺少商品名称"
      });
      continue;
    }

    const trainingCampCacheKey = buildTrainingCampCacheKey(category, productName, lookup.value);
    const cachedMembership = trainingCampCache.get(trainingCampCacheKey);
    if (cachedMembership) {
      trace.push(`所在期数匹配结果已复用#${orderNumber}`);
      if (cachedMembership.matched && cachedMembership.periodName) {
        assignOrderMembership(order, cachedMembership);
        evidence.push(buildMembershipEvidence(orderNumber, productName, category, cachedMembership, true));
      } else {
        await failCampSchedule({
          page,
          logger,
          query,
          order,
          evidence,
          stage: `training-camp-membership-cached-failure-${orderNumber}`,
          message: cachedMembership.error || "复用训练营所在期数匹配失败"
        });
      }
      continue;
    }

    const contextReady = await ensureTrainingCampInfoContext(page, lookup.value);
    trace.push(`训练营信息#${orderNumber}`);
    if (!contextReady) {
      trainingCampCache.set(trainingCampCacheKey, createTrainingCampCacheResult({
        matched: false,
        error: "学员档案或训练营信息上下文已丢失"
      }));
      await failCampSchedule({
        page,
        logger,
        query,
        order,
        evidence,
        stage: `training-camp-context-lost-${orderNumber}`,
        message: "学员档案或训练营信息上下文已丢失"
      });
      continue;
    }

    trace.push(`切换训练营#${orderNumber}`);
    const switchOpened = await openTrainingCampSwitch(page);
    if (!switchOpened) {
      const diagnostics = await probeTrainingCampSwitch(page);
      trainingCampCache.set(trainingCampCacheKey, createTrainingCampCacheResult({
        matched: false,
        error: "切换训练营弹窗未打开"
      }));
      await failCampSchedule({
        page,
        logger,
        query,
        order,
        evidence,
        stage: `training-camp-switch-not-opened-${orderNumber}`,
        message: "切换训练营弹窗未打开",
        diagnostics
      });
      continue;
    }
    trace.push(`切换训练营已打开#${orderNumber}`);

    let filterResult = { ok: false };
    let membership = { matched: false, error: "切换训练营筛选条件未能选择" };
    try {
      filterResult = await selectTrainingCampSwitchFilters(page, category, lookup.value);
      if (filterResult.categorySelected) trace.push(`品类已选择#${orderNumber}`);
      if (filterResult.categorySkipped) {
        trace.push(`新版训练营抽屉未提供品类筛选，已保留用户ID条件#${orderNumber}`);
      }
      if (filterResult.categoryOptional) {
        trace.push(`订单缺少品类，训练营抽屉已按用户ID和正式营继续匹配#${orderNumber}`);
      }
      if (filterResult.categoryCleared) {
        trace.push(`训练营历史品类已清除#${orderNumber}`);
      }
      if (filterResult.typeSelected) trace.push(`正式营已选择#${orderNumber}`);
      trace.push(`匹配所在期数#${orderNumber}`);
      membership = filterResult.ok
        ? await waitForMatchedTrainingCampMembership(page, {
          productName,
          category,
          expectedType: "正式营",
          typeFilterVerified: Boolean(filterResult.typeSelected)
        }, 5000)
        : { matched: false, error: filterResult.error || "切换训练营筛选条件未能选择" };
    } finally {
      if (!await closeTrainingCampSwitch(page)) {
        membership = {
          ...membership,
          matched: false,
          error: "切换训练营弹窗未能关闭，已取消复用本次筛选结果"
        };
      }
    }
    membership = createTrainingCampCacheResult(membership);
    trainingCampCache.set(trainingCampCacheKey, membership);
    if (Number(membership.scrolledMoves || 0) > 0) {
      trace.push(`切换训练营已下拉${membership.scrolledMoves}次#${orderNumber}`);
    }

    if (!membership.matched || !membership.periodName) {
      await failCampSchedule({
        page,
        logger,
        query,
        order,
        evidence,
        stage: `training-camp-membership-not-matched-${orderNumber}`,
        message: membership.error || "未匹配到正式营所在期数",
        diagnostics: {
          controls: filterResult.probe || await probeTrainingCampSwitch(page),
          membership: {
            scannedScreens: Number(membership.scannedScreens || 0),
            scrolledMoves: Number(membership.scrolledMoves || 0),
            candidateNames: (membership.candidateNames || []).slice(0, 80),
            candidateSummaries: (membership.candidateSummaries || []).slice(0, 80),
            rejectionStage: membership.rejectionStage || "",
            rejectionCounts: membership.rejectionCounts || {}
          }
        }
      });
      continue;
    }
    trace.push(`所在期数已匹配#${orderNumber}`);

    assignOrderMembership(order, membership);
    evidence.push(buildMembershipEvidence(orderNumber, productName, category, membership));
  }

  const schedulable = formalOrders.filter((order) => order.campSchedule?.membershipMatched && order.campSchedule?.periodName);
  if (!schedulable.length) return { orders: enrichedOrders, evidence };

  const campUrl = config.browser.contentCampUrl;
  await page.goto(campUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(Number(config.ui.afterGotoWaitMs || 1000)).catch(() => {});
  const campPageReady = await waitForCampManagementPage(page, 8000);
  if (!campPageReady) {
    for (const order of schedulable) {
      const orderNumber = order.index || enrichedOrders.indexOf(order) + 1;
      await failCampSchedule({
        page,
        logger,
        query,
        order,
        evidence,
        stage: `camp-management-not-opened-${orderNumber}`,
        message: "训练营管理页面未打开"
      });
    }
    return { orders: enrichedOrders, evidence };
  }

  for (const order of schedulable) {
    const orderNumber = order.index || enrichedOrders.indexOf(order) + 1;
    const category = cleanText(order.redBox?.category || "");
    const productName = cleanText(order.detailProductName || order.productName || "");
    trace.push(`训练营管理#${orderNumber}`);
    trace.push(`期数管理#${orderNumber}`);
    const scheduleKey = `${normalizeExactText(productName)}|${normalizeExactText(category)}|${normalizeExactText(order.campSchedule.periodName)}`;
    const schedule = scheduleCache.has(scheduleKey)
      ? { ...scheduleCache.get(scheduleKey), reused: true }
      : await queryFormalCampSchedule(page, {
        productName,
        category,
        periodName: order.campSchedule.periodName,
        orderTime: order.orderTime
      });
    // 期数筛选未清空时必须保留弹窗供下一单重新清理；此类失败不能
    // 缓存，否则同一训练营的下一单会直接复用失败而失去重试机会。
    if (schedule.canClosePeriodOverlay !== false) scheduleCache.set(scheduleKey, schedule);
    if (!schedule.matched) {
      await failCampSchedule({
        page,
        logger,
        query,
        order,
        evidence,
        stage: `camp-period-not-matched-${orderNumber}`,
        message: schedule.error || "训练营期数未匹配"
      });
      await closePeriodManagementOverlayIfSafe(page, schedule);
      continue;
    }

    if (schedule.matchStrategy === "unique-product-fallback") {
      trace.push(`期数管理按唯一商品名兜底匹配#${orderNumber}`);
    }

    trace.push(`提取开结营时间#${orderNumber}`);
    order.campSchedule = createCampSchedule({
      ...order.campSchedule,
      matched: true,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      campId: schedule.campId,
      periodId: schedule.periodId,
      periodName: schedule.periodName || order.campSchedule.periodName,
      matchStrategy: schedule.matchStrategy,
      categoryMatched: schedule.categoryMatched
    });
    evidence.push({
      source: `期数管理#${orderNumber}`,
      type: "formal-camp-schedule",
      text: [
        `商品名称：${productName}`,
        `所在期数：${order.campSchedule.periodName}`,
        `所在班级：${order.campSchedule.className || ""}`,
        `训练营匹配方式：${schedule.matchStrategy === "unique-product-fallback" ? "商品名唯一兜底" : "商品名与品类匹配"}`,
        `期数匹配方式：${schedule.periodMatchStrategy || "期数名称匹配"}`,
        `开营时间：${schedule.startTime}`,
        `结营时间：${schedule.endTime}`
      ].join("\n")
    });
    await closePeriodManagementOverlayIfSafe(page, schedule);
  }

  return { orders: enrichedOrders, evidence };
}

function createCampSchedule(value = {}) {
  return {
    requested: Boolean(value.requested),
    matched: Boolean(value.matched),
    membershipMatched: Boolean(value.membershipMatched),
    startTime: cleanText(value.startTime || ""),
    endTime: cleanText(value.endTime || ""),
    periodName: cleanText(value.periodName || ""),
    className: cleanText(value.className || ""),
    salesOwner: cleanMembershipPerson(value.salesOwner || ""),
    afterSalesReception: cleanMembershipPerson(value.afterSalesReception || ""),
    membershipCampName: cleanText(value.membershipCampName || ""),
    campId: cleanText(value.campId || ""),
    periodId: cleanText(value.periodId || ""),
    matchStrategy: cleanText(value.matchStrategy || ""),
    periodMatchStrategy: cleanText(value.periodMatchStrategy || ""),
    categoryMatched: Boolean(value.categoryMatched),
    error: cleanText(value.error || ""),
    debugLog: cleanText(value.debugLog || "")
  };
}

function cleanMembershipPerson(value) {
  // 抽屉卡片的 innerText 会把“售后接待”与下一行“下单时间”拼接；人员字段
  // 只应保留本标签的值，不能把后续时间或字段名称显示为老师信息。
  return cleanText(value)
    .replace(/\s*(?:下单时间|开营时间|结营时间|所在期数|所在班级|销售归属人|售后接待)\s*[:：][\s\S]*$/u, "")
    .trim();
}

export function buildTrainingCampCacheKey(category = "", productName = "", userId = "") {
  return [category, productName, userId].map((value) => normalizeExactText(value)).join("|");
}

export function normalizeTrainingCampCacheResult(result = {}) {
  return {
    ...result,
    matched: Boolean(result.matched && cleanText(result.periodName || "")),
    periodName: cleanText(result.periodName || ""),
    className: cleanText(result.className || ""),
    campName: cleanText(result.campName || ""),
    error: cleanText(result.error || "")
  };
}

const createTrainingCampCacheResult = normalizeTrainingCampCacheResult;

function assignOrderMembership(order, membership) {
  order.campSchedule = createCampSchedule({
    requested: true,
    periodName: membership.periodName,
    className: membership.className,
    salesOwner: membership.salesOwner,
    afterSalesReception: membership.afterSalesReception,
    membershipCampName: membership.campName,
    membershipMatched: true
  });
}

function buildMembershipEvidence(orderNumber, productName, category, membership, reused = false) {
  return {
    source: `训练营信息#${orderNumber}`,
    type: "formal-camp-membership",
    text: [
      `商品名称：${productName}`,
      `所属品类：${category}`,
      `所在期数：${membership.periodName}`,
      `所在班级：${membership.className || ""}`,
      `销售归属人：${membership.salesOwner || ""}`,
      `售后接待：${membership.afterSalesReception || ""}`,
      reused ? "匹配来源：复用同品类同商品的已验证结果" : ""
    ].filter(Boolean).join("\n")
  };
}

function normalizeExactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeCampNameForMatch(value) {
  // “切换训练营”抽屉的卡片标题会紧跟运营状态和等级徽标，例如
  // “【全面升级】养元活血太极营（销转中） B级 已领券”。这些不是训练营名称，
  // 不能让同一张卡片在后续的名称校验中被误判为不同训练营。
  return stripCampNameMarker(value)
    .replace(/\s*[（(]\s*(?:已结营|未开营|开营中|进行中|已结束|招生中|接量中|销转中)\s*[）)]\s*/gi, " ")
    .replace(/\s+(?=已结营|未开营|开营中|进行中|已结束|招生中|接量中|销转中)[\s\S]*$/i, "")
    // 徽标的 span 在 innerText 中可能没有空格（如“S级已领券完课59节”），
    // 因此从第一个可确认的徽标起整段截断，不要依赖徽标之间的空白。
    .replace(/\s+(?=[A-Z](?:\d+)?级|V\d+|已领券|未领券|已进群|未进群|已加好友|未加好友|完课\d+节|退款记录)[\s\S]*$/i, "")
    .replace(/\s+/g, "");
}

function campNameMatchType(actual, expected) {
  const left = normalizeCampNameForMatch(actual).replace(/[《》【】\[\]（）()<>「」“”‘’·，,。！？!?：:；;]/g, "");
  const right = normalizeCampNameForMatch(expected).replace(/[《》【】\[\]（）()<>「」“”‘’·，,。！？!?：:；;]/g, "");
  if (!left || !right) return "";
  if (left === right) return "normalized-exact";
  if (left.length >= 5 && right.length >= 5 && (left.includes(right) || right.includes(left))) {
    return "normalized-contains";
  }
  return "";
}

function stripCampNameMarker(value) {
  return normalizeExactText(value)
    .replace(/^(?:(?:new)\s*|[【[]\s*新\s*[】\]]\s*|[（(]\s*新\s*[）)]\s*)+/i, "")
    .replace(/^[（(]\s*内部\s*[）)]\s*/i, "")
    // 订单商品名偶尔带平台渠道前缀，但训练营管理使用不带前缀的真实营名。
    // 只在名称开头且有明确分隔符或书名括号时清理，避免误删真实营名中的“兴趣岛”。
    .replace(/^(?:【\s*兴趣岛\s*】|兴趣岛\s*[-‐‑‒–—―－_:：·])\s*/u, "");
}

export function mapTrainingCampCardFields(card = {}) {
  const sourceText = String(card.rawText || card.text || card.innerText || card.textContent || "");
  const lines = sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labels = ["训练营名称", "推广类型", "订单类型", "所属品类", "品类", "所在期数", "所在班级", "总期数", "期数总数", "销售归属人", "售后接待", "下单时间", "开营时间", "结营时间"];
  const keys = {
    "训练营名称": "campName",
    "推广类型": "type",
    "订单类型": "orderType",
    "所属品类": "category",
    "品类": "category",
    "所在期数": "periodName",
    "所在班级": "className",
    "总期数": "totalPeriods",
    "期数总数": "totalPeriods",
    "销售归属人": "salesOwner",
    "售后接待": "afterSalesReception"
  };
  const isLabelLine = (value) => labels.some((label) => new RegExp(`^${escapeRegExp(label)}(?:\\s*[:：]|\\s+|$)`).test(value));
  const readLabel = (label) => {
    const directValue = card[keys[label]];
    if (directValue !== undefined && directValue !== null && String(directValue).trim()) return normalizeExactText(directValue);
    const followingLabels = labels.map(escapeRegExp).join("|");
    const inlineMatch = sourceText.match(new RegExp(
      `${escapeRegExp(label)}\\s*(?::|：|\\s)\\s*([\\s\\S]*?)(?=(?:${followingLabels})\\s*(?::|：|\\s|$)|$)`
    ));
    if (inlineMatch?.[1] && normalizeExactText(inlineMatch[1])) return normalizeExactText(inlineMatch[1]);
    const index = lines.findIndex((line) => new RegExp(`^${escapeRegExp(label)}(?:\\s*[:：]|\\s+|$)`).test(line));
    if (index < 0) return "";
    const inline = lines[index].replace(new RegExp(`^${escapeRegExp(label)}\\s*(?::|：)?\\s*`), "");
    if (inline) return normalizeExactText(inline);
    const nextLine = lines[index + 1] || "";
    return isLabelLine(nextLine) ? "" : normalizeExactText(nextLine);
  };
  const fieldValues = new Set(labels.map(readLabel).filter(Boolean));
  const fallbackCampName = lines.find((line) => !isLabelLine(line) && !fieldValues.has(normalizeExactText(line))) || "";
  return {
    ...card,
    campName: normalizeExactText(card.campName || card.productName || readLabel("训练营名称") || fallbackCampName),
    type: readLabel("推广类型") || readLabel("订单类型"),
    category: normalizeExactText(card.category || readLabel("所属品类") || readLabel("品类")),
    periodName: normalizeExactText(card.periodName || readLabel("所在期数")),
    className: normalizeExactText(card.className || readLabel("所在班级")),
    totalPeriods: normalizeExactText(card.totalPeriods || card.periodCount || readLabel("总期数") || readLabel("期数总数")),
    salesOwner: cleanMembershipPerson(card.salesOwner || readLabel("销售归属人")),
    afterSalesReception: cleanMembershipPerson(card.afterSalesReception || readLabel("售后接待")),
    rawText: sourceText.slice(0, 1200),
    normalizedText: normalizeExactText(sourceText).slice(0, 1200)
  };
}

export function selectBestTrainingCampCandidate(candidates = [], criteria = {}) {
  const productName = typeof criteria === "string" ? criteria : criteria.productName;
  const expectedName = normalizeCampNameForMatch(productName);
  const expectedCategory = normalizeExactText(typeof criteria === "object" ? criteria.category : "").replace(/\s+/g, "");
  const expectedType = normalizeExactText(typeof criteria === "object" ? criteria.expectedType || "正式营" : "正式营").replace(/\s+/g, "");
  const evaluated = candidates.map((candidate, sourceIndex) => {
      const rawName = normalizeExactText(candidate.campName || candidate.name || "");
      const normalizedCampName = normalizeCampNameForMatch(rawName);
      const category = normalizeExactText(candidate.category || "").replace(/\s+/g, "");
      const type = normalizeExactText(candidate.type || candidate.orderType || "").replace(/\s+/g, "");
      const totalPeriods = Number.parseInt(String(candidate.totalPeriods ?? candidate.periodCount ?? "0"), 10) || 0;
      const internal = /^[（(]\s*内部\s*[）)]/i.test(rawName);
      const nameMatchType = campNameMatchType(rawName, expectedName);
      const nameMatched = Boolean(nameMatchType);
      const categoryMatched = Boolean(expectedCategory && category === expectedCategory);
      const formalTypeMatched = type === expectedType;
      const score = (nameMatchType === "normalized-exact" ? 10000 : (nameMatched ? 6500 : 0))
        + (categoryMatched ? 3000 : 0)
        + (internal ? -1800 : 1200)
        + Math.min(totalPeriods, 500)
        - sourceIndex / 1000;
      return {
        ...candidate,
        sourceIndex,
        rawCampName: rawName,
        normalizedCampName,
        type,
        category,
        totalPeriods,
        internal,
        nameMatched,
        nameMatchType,
        categoryMatched,
        formalTypeMatched,
        score
      };
    });
  const candidateSummaries = evaluated.map((candidate) => ({
    rawCampName: candidate.rawCampName,
    normalizedCampName: candidate.normalizedCampName,
    type: candidate.type,
    typeSource: candidate.typeSource || "card",
    category: candidate.category,
    periodName: candidate.periodName || "",
    className: candidate.className || "",
    nameMatchType: candidate.nameMatchType || "",
    rejectedBy: !candidate.nameMatched
      ? "name"
      : (!candidate.formalTypeMatched ? "type" : (expectedCategory && !candidate.categoryMatched ? "category" : ""))
  }));
  if (!evaluated.length) {
    return {
      matched: false,
      candidates: [],
      candidateSummaries,
      rejectionStage: "no-cards",
      rejectionCounts: { cards: 0 },
      error: "未读取到训练营卡片"
    };
  }

  const exactNameCandidates = evaluated.filter((candidate) => candidate.nameMatchType === "normalized-exact");
  const containsNameCandidates = evaluated.filter((candidate) => candidate.nameMatchType === "normalized-contains");
  let nameCandidates = exactNameCandidates;
  if (!nameCandidates.length && containsNameCandidates.length) {
    const distinctNames = new Set(containsNameCandidates.map((candidate) => candidate.normalizedCampName));
    if (distinctNames.size > 1) {
      return {
        matched: false,
        candidates: [],
        evaluatedCandidates: evaluated,
        candidateSummaries,
        rejectionStage: "name-ambiguous",
        rejectionCounts: { cards: evaluated.length, containsMatches: containsNameCandidates.length, distinctNames: distinctNames.size },
        error: "已读取训练营卡片，但名称包含匹配不唯一"
      };
    }
    nameCandidates = containsNameCandidates;
  }
  if (!nameCandidates.length) {
    return {
      matched: false,
      candidates: [],
      evaluatedCandidates: evaluated,
      candidateSummaries,
      rejectionStage: "name",
      rejectionCounts: { cards: evaluated.length, nameMatches: 0 },
      error: "已读取训练营卡片，但名称未匹配"
    };
  }

  const typeCandidates = nameCandidates.filter((candidate) => candidate.formalTypeMatched);
  if (!typeCandidates.length) {
    return {
      matched: false,
      candidates: [],
      evaluatedCandidates: evaluated,
      candidateSummaries,
      rejectionStage: "type",
      rejectionCounts: { cards: evaluated.length, nameMatches: nameCandidates.length, typeMatches: 0 },
      error: "名称匹配，但正式营身份冲突"
    };
  }

  const categoryCandidates = expectedCategory
    ? typeCandidates.filter((candidate) => candidate.categoryMatched)
    : typeCandidates;
  if (!categoryCandidates.length) {
    return {
      matched: false,
      candidates: [],
      evaluatedCandidates: evaluated,
      candidateSummaries,
      rejectionStage: "category",
      rejectionCounts: { cards: evaluated.length, nameMatches: nameCandidates.length, typeMatches: typeCandidates.length, categoryMatches: 0 },
      error: "名称匹配，但订单品类与候选品类冲突"
    };
  }

  const ranked = categoryCandidates
    .sort((a, b) => b.score - a.score || b.totalPeriods - a.totalPeriods || a.sourceIndex - b.sourceIndex);
  const selected = ranked[0];
  return {
    matched: true,
    ...selected,
    candidateCount: ranked.length,
    candidates: ranked,
    evaluatedCandidates: evaluated,
    candidateSummaries,
    rejectionStage: "",
    rejectionCounts: {
      cards: evaluated.length,
      nameMatches: nameCandidates.length,
      typeMatches: typeCandidates.length,
      categoryMatches: categoryCandidates.length
    },
    matchStrategy: `${selected.nameMatchType || "normalized-exact"}-${selected.categoryMatched ? "product-category" : "product"}`
  };
}

export function canProceedWithCampQueryAfterReset(filters = {}) {
  // “重置”按钮在部分后台版本不会稳定回显所有控件为空。训练营名称查询会
  // 重新收窄结果，所以仅回显失败不能取消本次查询；只有期数弹窗仍未清理时
  // 才可能把上一单期数条件带入本单，需要保守中止。
  return Boolean(filters.filtersReset || (!filters.clearFailed && filters.canClosePeriodOverlay !== false));
}

async function failCampSchedule({ page, logger, query, order, evidence, stage, message, diagnostics = null }) {
  const snapshot = await logger?.pageSnapshot?.(page, stage, query).catch(() => null);
  const contextLog = logger?.writeJson?.(`${stage}-context`, {
    orderIndex: order.index || 0,
    orderId: maskForTrace(order.orderId || ""),
    category: cleanText(order.redBox?.category || ""),
    productName: cleanText(order.detailProductName || order.productName || ""),
    periodName: cleanText(order.campSchedule?.periodName || ""),
    message,
    diagnostics
  });
  order.campSchedule = createCampSchedule({
    ...order.campSchedule,
    matched: false,
    error: message,
    debugLog: snapshot || contextLog || ""
  });
  evidence.push({
    source: `正式营期数#${order.index || ""}`,
    type: "camp-schedule-error",
    text: [message, snapshot ? `调试日志：${snapshot}` : "", contextLog ? `上下文：${contextLog}` : ""].filter(Boolean).join("\n")
  });
}

async function openTrainingCampInfo(page, userId = "") {
  const clicked = await clickStudentArchiveTab(page, "训练营信息");
  if (!clicked) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 6000) {
    const ready = await page.evaluate((expectedUserId) => {
      const text = String(document.body.innerText || "").replace(/\s+/g, " ").trim();
      return /训练营信息/.test(text) && /切换/.test(text) && (!expectedUserId || text.includes(String(expectedUserId)));
    }, userId).catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(250).catch(() => {});
  }
  return false;
}

async function ensureTrainingCampInfoContext(page, userId = "") {
  if (await isTrainingCampInfoReady(page, userId)) return true;
  if (await isTrainingCampSwitchOpen(page)) {
    await closeTrainingCampSwitch(page);
    if (await isTrainingCampInfoReady(page, userId)) return true;
  }

  let archiveState = await getStudentArchiveState(page, userId, 1200);
  if (!archiveState.ready) {
    const rowVisible = await hasChanceAssUserRow(page, userId);
    if (!rowVisible) return false;
    const reopened = await clickStudentProfileInMatchedRow(page, userId);
    if (!reopened) return false;
    await page.waitForTimeout(600).catch(() => {});
    archiveState = await getStudentArchiveState(page, userId, 4500);
    if (!archiveState.ready) return false;
  }

  return openTrainingCampInfo(page, userId);
}

async function isTrainingCampInfoReady(page, userId = "") {
  const archiveState = await getStudentArchiveState(page, userId, 600);
  if (!archiveState.ready) return false;
  return await page.evaluate(() => {
    const compact = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 12 && rect.height > 12 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    return [...document.body.querySelectorAll("button, a, [role='button'], span, div")]
      .filter(visible)
      .some((el) => {
        const text = compact(el.innerText || el.textContent || "");
        const rect = el.getBoundingClientRect();
        return /^(?:⇄|↔|⇆)?切换$/.test(text) && rect.left > window.innerWidth * 0.5;
      });
  }).catch(() => false);
}

async function clickStudentArchiveTab(page, tabText) {
  const clicked = await page.evaluate((expected) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const rendered = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const candidates = [...document.body.querySelectorAll("[role='tab'], .ant-tabs-tab, .el-tabs__item, .arco-tabs-tab, li, a, span, div")]
      .filter(rendered)
      .map((el) => {
        const text = normalize(el.innerText || el.textContent || "");
        const clickable = el.closest("[role='tab'], .ant-tabs-tab, .el-tabs__item, .arco-tabs-tab, li, a, button") || el;
        const rect = clickable.getBoundingClientRect();
        const className = String(clickable.className || "");
        let score = 0;
        if (text === normalize(expected)) score += 100;
        if (clickable.getAttribute("role") === "tab") score += 40;
        if (/tabs?-tab|tabs?-item/i.test(className)) score += 30;
        if (rect.width >= 40 && rect.width <= 220 && rect.height >= 20 && rect.height <= 80) score += 15;
        return { clickable, rect, score, text };
      })
      .filter((item) => item.text === normalize(expected))
      .sort((a, b) => b.score - a.score || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
    const target = candidates[0]?.clickable;
    if (!target) return false;
    target.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    target.click();
    return true;
  }, tabText).catch(() => false);
  if (!clicked) return false;
  await page.waitForTimeout(450).catch(() => {});
  return true;
}

async function openTrainingCampSwitch(page) {
  // 训练营抽屉的标题在部分后台版本中不处于标准 drawer/modal 容器内，
  // 不能只用标题判断。抽屉内两个筛选控件才是稳定的可见状态标识。
  if (await isTrainingCampSwitchOpen(page)) {
    if (await waitForTrainingCampSwitchReady(page, 1800)) return true;
    await closeTrainingCampSwitch(page);
    await page.waitForTimeout(450).catch(() => {});
  }
  const clicked = await page.evaluate(() => {
    const compact = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const archive = [...document.body.querySelectorAll("[role='dialog'], .drawer, .el-drawer, .ant-drawer, aside, section, div")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = compact(el.innerText || el.textContent || "");
        let score = 0;
        if (text.includes("学员档案")) score += 40;
        if (text.includes("训练营信息")) score += 30;
        if (text.includes("订单信息")) score += 15;
        if (text.includes("所在期数")) score += 20;
        if (rect.left > 180 && rect.width > 480 && rect.height > 300) score += 20;
        return { el, rect, score };
      })
      .filter((item) => item.score >= 90)
      .sort((a, b) => b.score - a.score || a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.el
      || document.body;

    const candidates = [...archive.querySelectorAll("button, a, [role='button'], span, div")]
      .filter(visible)
      .map((el) => {
        const text = compact(el.innerText || el.textContent || "");
        let clickable = el.closest("button, a, [role='button'], [tabindex]") || el;
        let current = el;
        while (current && current !== archive) {
          const style = window.getComputedStyle(current);
          const cls = String(current.className || "");
          if (current.onclick || style.cursor === "pointer" || /switch|change|link|button|btn/i.test(cls)) {
            clickable = current;
            break;
          }
          current = current.parentElement;
        }
        const rect = clickable.getBoundingClientRect();
        let score = 0;
        if (text === "切换") score += 120;
        if (/^(?:⇄|↔|⇆)?切换$/.test(text)) score += 100;
        if (rect.left > window.innerWidth * 0.55) score += 35;
        if (rect.top < window.innerHeight * 0.6) score += 15;
        if (window.getComputedStyle(clickable).cursor === "pointer") score += 15;
        return { clickable, rect, score, text };
      })
      .filter((item) => item.score >= 100)
      .sort((a, b) => b.score - a.score || b.rect.left - a.rect.left || a.rect.top - b.rect.top);
    const target = candidates[0]?.clickable;
    if (!target) return false;
    target.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    target.click();
    return true;
  }).catch(() => false);
  if (!clicked) return false;
  const opened = await waitForTrainingCampSwitchOpen(page, 5000);
  if (!opened) return false;
  return waitForTrainingCampSwitchReady(page, 3500);
}

export function trainingCampSwitchControlsIndicateOpen(category, type) {
  return Boolean(category?.found && type?.found);
}

async function isTrainingCampSwitchOpen(page) {
  if (await isOverlayTitleOpen(page, "切换训练营")) return true;
  const [category, type] = await Promise.all([
    interactTrainingCampSwitchControl(page, "category", "inspect"),
    interactTrainingCampSwitchControl(page, "type", "inspect")
  ]);
  return trainingCampSwitchControlsIndicateOpen(category, type);
}

async function waitForTrainingCampSwitchOpen(page, maxWaitMs = 4000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    if (await isTrainingCampSwitchOpen(page)) return true;
    await page.waitForTimeout(150).catch(() => {});
  }
  return false;
}

async function waitForTrainingCampSwitchReady(page, maxWaitMs = 3500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const [category, type] = await Promise.all([
      interactTrainingCampSwitchControl(page, "category", "inspect"),
      interactTrainingCampSwitchControl(page, "type", "inspect")
    ]);
    if (category?.found && type?.found) return true;
    await page.waitForTimeout(150).catch(() => {});
  }
  return false;
}

export function isTrainingCampIdentityControlValue(value, userId = "") {
  const current = normalizeExactText(value).replace(/\s+/g, "");
  const expected = normalizeExactText(userId).replace(/\s+/g, "");
  if (!current) return false;
  return /^\d{5,}$/.test(current) || Boolean(expected && current === expected);
}

async function selectTrainingCampSwitchFilters(page, category, userId = "") {
  const firstControl = await interactTrainingCampSwitchControl(page, "category", "inspect");
  const normalizedCategory = normalizeExactText(category).replace(/\s+/g, "");
  const categorySkipped = isTrainingCampCategoryIdentityControl(firstControl, userId);
  // 新版“切换训练营”抽屉有时不提供所属品类，或订单详情本身没有
  // 可靠的品类字段。此时仍可用用户 ID + 正式营类型 + 商品名称匹配
  // 所在期数；不能因为品类为空就提前终止整个正式营期数查询。
  const categoryOptional = isTrainingCampCategoryOptional(category, categorySkipped);
  const categoryCleared = !categorySkipped && !normalizedCategory
    ? await clearTrainingCampSwitchControl(page, "category")
    : false;
  if (!categorySkipped && !normalizedCategory && !categoryCleared) {
    return {
      ok: false,
      categorySelected: false,
      categorySkipped: false,
      categoryOptional: true,
      categoryCleared: false,
      typeSelected: false,
      error: "订单缺少所属品类，且训练营弹窗的历史品类未能清除",
      probe: await probeTrainingCampSwitch(page)
    };
  }
  const categorySelected = categorySkipped
    ? false
    : (normalizedCategory
      ? await selectTrainingCampSwitchControl(page, "category", category)
      : false);
  if (!categorySkipped && normalizedCategory && !categorySelected) {
    return {
      ok: false,
      categorySelected: false,
      categorySkipped: false,
      categoryOptional: false,
      categoryCleared: false,
      typeSelected: false,
      error: `所属品类未能选择：${category}`,
      probe: await probeTrainingCampSwitch(page)
    };
  }
  const typeSelected = await selectTrainingCampSwitchControl(page, "type", "正式营");
  if (!typeSelected) {
    return {
      ok: false,
      categorySelected,
      categorySkipped,
      categoryOptional,
      categoryCleared,
      typeSelected: false,
      error: "营类型未能选择：正式营",
      probe: await probeTrainingCampSwitch(page)
    };
  }
  await page.waitForTimeout(500).catch(() => {});
  return {
    ok: true,
    categorySelected,
    categorySkipped,
    categoryOptional,
    categoryCleared,
    typeSelected: true,
    probe: await probeTrainingCampSwitch(page)
  };
}

export function isTrainingCampCategoryIdentityControl(controlState, userId = "") {
  return Boolean(controlState?.found && isTrainingCampIdentityControlValue(controlState.value, userId));
}

export function isTrainingCampCategoryOptional(category, categorySkipped = false) {
  return Boolean(categorySkipped || !normalizeExactText(category).replace(/\s+/g, ""));
}

async function selectTrainingCampSwitchControl(page, role, value) {
  let state = await interactTrainingCampSwitchControl(page, role, "inspect");
  if (!state?.found) return false;
  if (trainingCampControlMatches(state, value)) return true;

  const clicked = await interactTrainingCampSwitchControl(page, role, "click");
  if (!clicked?.found) return false;
  let optionClicked = await waitAndClickExactVisibleOption(page, value, role === "category" ? 4500 : 1800);
  if (!optionClicked && role === "category") {
    const filled = await interactTrainingCampSwitchControl(page, role, "fill", value);
    if (filled?.found) {
      optionClicked = await waitAndClickExactVisibleOption(page, value, 5000);
    }
  }
  if (!optionClicked) {
    await interactTrainingCampSwitchControl(page, role, "click");
    return false;
  }
  await page.waitForTimeout(350).catch(() => {});
  state = await interactTrainingCampSwitchControl(page, role, "inspect");
  if (trainingCampControlMatches(state, value)) return true;

  // 只接受控件实际显示的选中标签；内部 ID 或候选列表名称都不能算成功。
  return trainingCampControlMatches(state, value);
}

async function clearTrainingCampSwitchControl(page, role) {
  let state = await interactTrainingCampSwitchControl(page, role, "inspect");
  if (!state?.found) return false;
  if (trainingCampControlIsEmpty(state)) return true;

  const cleared = await interactTrainingCampSwitchControl(page, role, "clear");
  if (!cleared?.found) return false;
  await page.waitForTimeout(500).catch(() => {});
  state = await interactTrainingCampSwitchControl(page, role, "inspect");
  return trainingCampControlIsEmpty(state);
}

export function trainingCampControlIsEmpty(state) {
  if (!state?.found) return false;
  return !readSelectedControlValue(state);
}

export function trainingCampControlMatches(state, expectedValue) {
  const expected = normalizeExactText(expectedValue).replace(/\s+/g, "");
  if (!expected || !state) return false;
  return normalizeExactText(readSelectedControlValue(state)).replace(/\s+/g, "") === expected;
}

export function readSelectedControlValue(control = {}) {
  const candidates = [
    control.selectedText,
    control.selectedChipText,
    control.explicitValue,
    control.componentLabel,
    control.inputValue,
    control.rawValue
  ];
  for (const candidate of candidates) {
    const value = normalizeExactText(candidate);
    if (!value || /^(?:请选择|全部|不限)$/.test(value.replace(/\s+/g, ""))) continue;
    return value;
  }
  return "";
}

async function interactTrainingCampSwitchControl(page, role, action, expectedValue = "") {
  return await page.evaluate(({ role, action, expectedValue }) => {
    const compact = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const rendered = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const overlay = findOverlay();
    if (!overlay) return { found: false, reason: "overlay-not-found" };
    const controls = findControls(overlay);
    const target = role === "category" ? controls[0] : controls[1];
    if (!target) return { found: false, reason: `${role}-control-not-found`, controlCount: controls.length };
    if (action === "click") {
      target.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      target.el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      target.el.click();
    }
    if (action === "fill") {
      const input = target.el.matches("input") ? target.el : target.el.querySelector("input");
      if (!input || input.disabled || input.readOnly) {
        return { found: false, reason: `${role}-native-input-not-found`, controlCount: controls.length };
      }
      input.focus();
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(input, String(expectedValue));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(expectedValue) }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (action === "clear") {
      const input = target.el.matches("input") ? target.el : target.el.querySelector("input");
      const visited = new Set();
      let clearedByComponent = false;
      let node = input || target.el;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        let vm = node.__vue__;
        for (let parentDepth = 0; vm && parentDepth < 5; parentDepth += 1, vm = vm.$parent) {
          if (visited.has(vm)) continue;
          visited.add(vm);
          const name = String(vm.$options?.name || vm.$options?._componentTag || "");
          if (!/select/i.test(name)) continue;
          if (typeof vm.deleteSelected === "function") {
            vm.deleteSelected({ stopPropagation() {} });
            clearedByComponent = true;
          } else if (typeof vm.handleClear === "function") {
            vm.handleClear({ stopPropagation() {} });
            clearedByComponent = true;
          }
          if (typeof vm.$emit === "function") {
            vm.$emit("input", "");
            vm.$emit("change", "");
            clearedByComponent = true;
          }
        }
      }
      const clearIcon = target.el.querySelector(
        ".el-icon-circle-close, .el-select__caret[class*='close'], [class*='clear']"
      );
      if (clearIcon && visible(clearIcon)) {
        clearIcon.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        clearIcon.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        clearIcon.click();
        clearedByComponent = true;
      }
      if (input) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (descriptor?.set) descriptor.set.call(input, "");
        else input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (!clearedByComponent && !input) {
        return { found: false, reason: `${role}-clear-not-supported`, controlCount: controls.length };
      }
    }
    const controlState = readControlState(target.el);
    return {
      found: true,
      value: controlState.value,
      ...controlState,
      tag: target.el.tagName,
      className: String(target.el.className || ""),
      rect: rectData(target.rect)
    };

    function findOverlay() {
      return [...document.body.querySelectorAll("[role='dialog'], .ant-modal, .el-dialog, .arco-modal, .drawer, .el-drawer, div")]
        .filter(visible)
        .map((el) => ({ el, rect: el.getBoundingClientRect(), text: compact(el.innerText || el.textContent || "") }))
        .filter((item) => item.text.includes("切换训练营") && item.rect.width > 420 && item.rect.height > 120)
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.el || null;
    }
    function findControls(root) {
      const overlayRect = root.getBoundingClientRect();
      const selector = "input, [role='combobox'], .ant-select, .ant-select-selector, .el-select, .el-input, .el-select__wrapper, .el-input__wrapper, .arco-select, [class*='select']";
      const candidates = [...root.querySelectorAll(selector)]
        .filter(rendered)
        .map((el) => {
          const outer = el.closest(".ant-select, .el-select, .arco-select, [role='combobox']") || el;
          return { el: outer, rect: outer.getBoundingClientRect() };
        })
        .filter((item) => item.el.getAttribute("aria-disabled") !== "true" && !item.el.disabled)
        .filter((item) => item.rect.width > 120 && item.rect.height >= 24 && item.rect.height <= 90)
        .filter((item) => item.rect.top >= overlayRect.top + 45 && item.rect.top <= overlayRect.top + 260)
        .filter((item) => item.rect.left >= overlayRect.left && item.rect.right <= overlayRect.right + 2)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      const unique = [];
      for (const item of candidates) {
        if (unique.some((saved) => sameRect(saved.rect, item.rect))) continue;
        unique.push(item);
      }
      if (unique.length < 2) return unique;
      const rows = [];
      for (const item of unique) {
        const center = item.rect.top + item.rect.height / 2;
        let row = rows.find((entry) => Math.abs(entry.center - center) < 24);
        if (!row) {
          row = { center, items: [] };
          rows.push(row);
        }
        row.items.push(item);
      }
      const selectedRow = rows
        .filter((row) => row.items.length >= 2)
        .sort((a, b) => a.center - b.center || b.items.length - a.items.length)[0];
      if (!selectedRow) return unique.slice(0, 2);
      return selectedRow.items.sort((a, b) => a.rect.left - b.rect.left).slice(0, 2);
    }
    function readControlState(el) {
      const input = el.matches("input") ? el : el.querySelector("input");
      const selected = el.querySelector(".ant-select-selection-item, .el-select__selected-item, .arco-select-view-value, [data-selected-value]");
      const selectedText = String(selected?.innerText || selected?.textContent || "").trim();
      const selectedChipText = [...el.querySelectorAll(".ant-select-selection-item, .el-tag, .arco-tag, [data-selected-chip]")]
        .map((item) => String(item.innerText || item.textContent || "").trim())
        .find(Boolean) || "";
      const inputValue = String(input?.value || "").trim();
      const explicitValue = String(el.getAttribute("data-selected-value") || el.getAttribute("title") || "").trim();
      const selectedOptionLabels = [];
      const availableOptionLabels = [];
      let componentLabel = "";
      const visited = new Set();
      let node = input || el;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        let vm = node.__vue__;
        for (let parentDepth = 0; vm && parentDepth < 5; parentDepth += 1, vm = vm.$parent) {
          if (visited.has(vm)) continue;
          visited.add(vm);
          const labels = [
            vm.selectedLabel,
            vm.selected?.currentLabel,
            vm.selected?.label,
            vm.currentLabel
          ].map((item) => String(item || "").trim()).filter(Boolean);
          for (const label of labels) {
            if (!selectedOptionLabels.includes(label)) selectedOptionLabels.push(label);
          }
          if (!componentLabel && labels[0]) componentLabel = labels[0];

          const modelValue = vm.value ?? vm.modelValue ?? vm.$props?.value;
          const options = [
            ...(Array.isArray(vm.options) ? vm.options : []),
            ...(Array.isArray(vm.cachedOptions) ? vm.cachedOptions : [])
          ];
          for (const option of options) {
            const optionValue = option?.value ?? option?.item?.value;
            const optionLabel = String(option?.label ?? option?.currentLabel ?? option?.item?.label ?? "").trim();
            if (!optionLabel) continue;
            if (!availableOptionLabels.includes(optionLabel)) availableOptionLabels.push(optionLabel);
            const modelSelected = modelValue !== undefined && modelValue !== null && String(modelValue) !== ""
              && String(optionValue) === String(modelValue);
            if (!componentLabel && modelSelected) componentLabel = optionLabel;
            if (modelSelected
              && !selectedOptionLabels.includes(optionLabel)) selectedOptionLabels.push(optionLabel);
          }
        }
      }
      const controlState = {
        inputValue,
        selectedText,
        selectedChipText,
        explicitValue,
        rawValue: inputValue,
        componentLabel,
        selectedOptionLabels,
        availableOptionLabels
      };
      return {
        ...controlState,
        displayValue: readSelected(controlState),
        value: readSelected(controlState)
      };
    }
    function readSelected(control) {
      const candidates = [
        control.selectedText,
        control.selectedChipText,
        control.explicitValue,
        control.componentLabel,
        control.inputValue,
        control.rawValue
      ];
      for (const candidate of candidates) {
        const value = String(candidate || "").replace(/\s+/g, " ").trim();
        if (!value || /^(?:请选择|全部|不限)$/.test(value.replace(/\s+/g, ""))) continue;
        return value;
      }
      return "";
    }
    function sameRect(a, b) {
      return Math.abs(a.left - b.left) < 4 && Math.abs(a.top - b.top) < 4
        && Math.abs(a.width - b.width) < 8 && Math.abs(a.height - b.height) < 8;
    }
    function rectData(rect) {
      return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
    }
  }, { role, action, expectedValue }).catch(() => ({ found: false, reason: "control-dom-error" }));
}

async function waitAndClickExactVisibleOption(page, value, maxWaitMs = 3500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    if (await clickExactVisibleOption(page, value)) return true;
    await page.waitForTimeout(200).catch(() => {});
  }
  return false;
}

async function clickExactVisibleOption(page, value) {
  const marker = `codex-option-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marked = await page.evaluate(({ expected, marker }) => {
    const compact = (input) => String(input || "").replace(/\s+/g, "").trim();
    const rendered = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 16
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const candidates = [...document.body.querySelectorAll("[role='option'], .ant-select-item-option, .el-select-dropdown__item, .arco-select-option, .ivu-select-item, li")]
      .filter(rendered)
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const zIndex = Number(window.getComputedStyle(el.closest("[class*='dropdown'], [class*='select']") || el).zIndex || 0);
        return { el, rect, index, zIndex, text: compact(el.innerText || el.textContent || "") };
      })
      .filter((item) => item.text === compact(expected))
      .sort((a, b) => b.zIndex - a.zIndex || b.index - a.index);
    const target = candidates[0]?.el;
    if (!target) return false;
    target.setAttribute("data-codex-exact-visible-option", marker);
    return true;
  }, { expected: value, marker }).catch(() => false);
  if (!marked) return false;

  const option = page.locator(`[data-codex-exact-visible-option="${marker}"]`).first();
  const clicked = await option.scrollIntoViewIfNeeded()
    .then(() => option.click({ force: true, timeout: 1500 }))
    .then(() => true)
    .catch(() => false);
  await page.evaluate((currentMarker) => {
    document.querySelectorAll("[data-codex-exact-visible-option]").forEach((el) => {
      if (el.getAttribute("data-codex-exact-visible-option") === currentMarker) {
        el.removeAttribute("data-codex-exact-visible-option");
      }
    });
  }, marker).catch(() => {});
  return clicked;
}

async function closeTrainingCampSwitch(page) {
  if (!await isTrainingCampSwitchOpen(page)) return true;
  const clicked = await page.evaluate(() => {
    const compact = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const overlay = [...document.body.querySelectorAll("[role='dialog'], .ant-modal, .el-dialog, .arco-modal, .drawer, .el-drawer, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: compact(el.innerText || el.textContent || "") }))
      .filter((item) => item.text.includes("切换训练营") && item.rect.width > 420 && item.rect.height > 120)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
    if (!overlay) return false;
    const target = [...overlay.el.querySelectorAll("button, [role='button'], [class*='close'], i, svg, span")]
      .filter(visible)
      .map((el) => ({
        el,
        rect: el.getBoundingClientRect(),
        text: compact(el.innerText || el.textContent || ""),
        marker: compact(`${el.getAttribute("aria-label") || ""} ${String(el.className?.baseVal || el.className || "")}`)
      }))
      .filter((item) => /close|关闭|el-icon-close|arco-icon-close/i.test(`${item.text}${item.marker}`) || /^[×x]$/i.test(item.text))
      .filter((item) => item.rect.top <= overlay.rect.top + 100)
      .sort((a, b) => b.rect.left - a.rect.left || a.rect.top - b.rect.top)[0]?.el;
    if (!target) return false;
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    target.click();
    return true;
  }).catch(() => false);
  if (!clicked) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2200) {
    if (!await isTrainingCampSwitchOpen(page)) return true;
    await page.waitForTimeout(150).catch(() => {});
  }
  return false;
}

async function probeTrainingCampSwitch(page) {
  const [category, type, dom] = await Promise.all([
    interactTrainingCampSwitchControl(page, "category", "inspect"),
    interactTrainingCampSwitchControl(page, "type", "inspect"),
    page.evaluate(() => {
      const compact = (value) => String(value || "").replace(/\s+/g, "").trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
          && rect.right > 0 && rect.left < window.innerWidth
          && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
      };
      const switches = [...document.body.querySelectorAll("button, a, [role='button'], [tabindex], span, div")]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            className: String(el.className || "").slice(0, 240),
            text: compact(el.innerText || el.textContent || "").slice(0, 80),
            cursor: window.getComputedStyle(el).cursor,
            rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
          };
        })
        .filter((item) => /(?:⇄|↔|⇆)?切换$/.test(item.text))
        .slice(0, 20);
      return { overlayOpen: compact(document.body.innerText || "").includes("切换训练营"), switches };
    }).catch(() => ({ overlayOpen: false, switches: [] }))
  ]);
  return { category, type, ...dom };
}

export async function readMatchedTrainingCampMembership(page, criteria) {
  const expected = typeof criteria === "string"
    ? { productName: criteria, category: "", expectedType: "正式营", typeFilterVerified: false }
    : {
      ...criteria,
      expectedType: criteria?.expectedType || "正式营",
      typeFilterVerified: Boolean(criteria?.typeFilterVerified)
    };
  const extracted = await page.evaluate((expectedCriteria) => {
    const overlay = findOverlay("切换训练营");
    if (!overlay) return { matched: false, error: "切换训练营弹窗已关闭" };
    const allCards = [...overlay.querySelectorAll("section, article, li, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), raw: String(el.innerText || el.textContent || "").trim() }))
      .map((item) => ({ ...item, fields: readCardFields(item.raw) }))
      .filter((item) => item.fields.periodName && item.fields.className)
      // 外层滚动容器也会汇总多张卡片的文本；它不是一张可归属的训练营卡片。
      .filter((item) => labelCount(item.raw, "所在期数") <= 1 && labelCount(item.raw, "所在班级") <= 1)
      .map((item) => ({ ...item, campName: extractCampName(item.el, item.raw, item.fields.campName) }));
    const candidateNames = [...new Set(allCards.map((item) => item.campName).filter(Boolean))];
    // DOM 只负责隔离卡片和读取字段，不再用第二套名称规则预先删除候选。
    // 所有隔离后的卡片都交给 Node 侧的唯一评分器，避免 S 级等徽标在评分前导致误删。
    const cards = allCards.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
    const unique = [];
    for (const item of cards) {
      const key = `${normalize(item.campName)}|${item.fields.periodName}|${item.fields.className}`;
      if (unique.some((saved) => saved.key === key)) continue;
      unique.push({ ...item, key });
    }
    const matches = unique.map((item) => {
      const explicitType = /^(?:正式营|体验营)$/.test(normalize(item.fields.type))
        ? normalizeSpaces(item.fields.type)
        : "";
      const contextualType = expectedCriteria.typeFilterVerified
        ? normalizeSpaces(expectedCriteria.expectedType)
        : "";
      return {
        campName: item.campName,
        category: item.fields.category,
        // 卡片明确标注的营类型始终优先；卡片缺失时只能使用已读回验证的顶部筛选上下文。
        type: explicitType || contextualType,
        typeSource: explicitType ? "card" : (contextualType ? "verified-filter" : "missing"),
        totalPeriods: item.fields.totalPeriods,
        periodName: item.fields.periodName,
        className: item.fields.className,
        salesOwner: item.fields.salesOwner,
        afterSalesReception: item.fields.afterSalesReception,
        rawText: item.raw.slice(0, 1200),
        normalizedText: normalizeSpaces(item.raw).slice(0, 1200)
      };
    });
    return { matched: matches.length > 0, matches, candidateNames };

    function extractCampName(element, raw, mappedCampName = "") {
      const descendants = [...element.querySelectorAll(
        "h1, h2, h3, h4, strong, b, [class*='camp-name'], [class*='campName'], [class*='title'], [class*='name']"
      )]
        .filter(visible)
        .map((el) => normalizeSpaces(String(el.innerText || el.textContent || "")))
        .filter((value) => value && value.length >= 4 && value.length <= 180)
        .filter((value) => !/^(?:所在期数|所在班级|销售归属人|售后接待|已领券|未领券|已进群|未进群|已加好友|未加好友|完课\d+节|退款记录|[A-Z](?:\d+)?级|V\d+)/i.test(value));
      if (descendants[0]) return descendants[0];
      if (mappedCampName) return mappedCampName;
      return normalizeSpaces(String(raw || "").split(/所在期数|所在班级|销售归属人|售后接待/)[0]);
    }
    function labelCount(text, label) {
      return (String(text || "").match(new RegExp(escape(label), "g")) || []).length;
    }
    function readCardFields(text) {
      const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const labels = ["训练营名称", "推广类型", "订单类型", "所属品类", "品类", "所在期数", "所在班级", "总期数", "期数总数", "销售归属人", "售后接待", "下单时间", "开营时间", "结营时间"];
      const read = (label) => {
        const followingLabels = labels.map(escape).join("|");
        const inlineMatch = String(text || "").match(new RegExp(
          `${escape(label)}\\s*(?::|：|\\s)\\s*([\\s\\S]*?)(?=(?:${followingLabels})\\s*(?::|：|\\s|$)|$)`
        ));
        if (inlineMatch?.[1] && normalizeSpaces(inlineMatch[1])) return normalizeSpaces(inlineMatch[1]);
        const index = lines.findIndex((line) => new RegExp(`^${escape(label)}(?:\\s*[:：]|\\s+|$)`).test(line));
        if (index < 0) return "";
        const inline = lines[index].replace(new RegExp(`^${escape(label)}\\s*(?::|：)?\\s*`), "");
        if (inline) return normalizeSpaces(inline);
        const next = lines[index + 1] || "";
        return labels.some((name) => new RegExp(`^${escape(name)}(?:\\s*[:：]|\\s+|$)`).test(next)) ? "" : normalizeSpaces(next);
      };
      return {
        campName: read("训练营名称") || normalizeSpaces(String(text || "").split(/推广类型|订单类型|所属品类|所在期数/)[0]),
        type: read("推广类型") || read("订单类型"),
        category: read("所属品类") || read("品类"),
        periodName: read("所在期数"),
        className: read("所在班级"),
        totalPeriods: read("总期数") || read("期数总数"),
        salesOwner: read("销售归属人"),
        afterSalesReception: cleanPerson(read("售后接待"))
      };
    }
    function cleanPerson(value) {
      return normalizeSpaces(value)
        .replace(/\s*(?:下单时间|开营时间|结营时间|所在期数|所在班级|销售归属人|售后接待)\s*[:：][\s\S]*$/u, "")
        .trim();
    }
    function findOverlay(title) {
      return [...document.body.querySelectorAll("[role='dialog'], .ant-modal, .el-dialog, .arco-modal, .drawer, div")]
        .filter(visible)
        .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
        .filter((item) => item.text.includes(normalize(title)) && item.rect.width > 420 && item.rect.height > 120)
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.el || null;
    }
    function escape(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    function normalize(value) {
      return String(value || "").replace(/\s+/g, "").trim();
    }
    function normalizeSpaces(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 12 && rect.height > 12
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }
  }, expected).catch(() => ({ matched: false, matches: [], candidateNames: [], error: "训练营信息 DOM 提取失败" }));
  if (!extracted?.matches?.length) return extracted;
  const matches = extracted.matches.map(mapTrainingCampCardFields);
  const selected = selectBestTrainingCampCandidate(matches, expected);
  if (!selected.matched) {
    return {
      ...extracted,
      matches,
      matched: false,
      error: selected.error,
      candidateSummaries: selected.candidateSummaries || [],
      rejectionStage: selected.rejectionStage || "",
      rejectionCounts: selected.rejectionCounts || {}
    };
  }
  return {
    ...extracted,
    matches,
    matched: true,
    ...selected,
    candidateNames: extracted.candidateNames || []
  };
}

async function waitForMatchedTrainingCampMembership(page, criteria, maxWaitMs = 5000) {
  const startedAt = Date.now();
  const collected = new Map();
  const candidateNames = new Set();
  const candidateSummaries = new Map();
  let scannedScreens = 0;
  let scrolledMoves = 0;
  let stableEndCount = 0;

  await setTrainingCampSwitchScrollTop(page, 0);
  await page.waitForTimeout(300).catch(() => {});

  while (Date.now() - startedAt < Math.max(maxWaitMs, 18000) && scannedScreens < 80) {
    const current = await readMatchedTrainingCampMembership(page, criteria);
    for (const item of current.matches || []) {
      const key = [item.campName, item.periodName, item.className].map(normalizeExactText).join("|");
      if (!collected.has(key)) collected.set(key, item);
    }
    for (const name of current.candidateNames || []) candidateNames.add(name);
    for (const summary of current.candidateSummaries || []) {
      const key = [summary.rawCampName, summary.periodName, summary.className, summary.type, summary.category]
        .map(normalizeExactText).join("|");
      candidateSummaries.set(key, summary);
    }

    const scroll = await advanceTrainingCampSwitchScroll(page);
    scannedScreens += 1;
    if (scroll.moved) scrolledMoves += 1;
    if (scroll.loading || !scroll.contentReady) {
      stableEndCount = 0;
      await page.waitForTimeout(350).catch(() => {});
      continue;
    }
    if (scroll.empty) break;
    if (!scroll.found || scroll.atEnd || !scroll.moved) {
      stableEndCount += 1;
      if (stableEndCount >= 2) break;
    } else {
      stableEndCount = 0;
    }
    await page.waitForTimeout(scroll.moved ? 220 : 350).catch(() => {});
  }

  const matches = [...collected.values()].map(mapTrainingCampCardFields);
  if (!matches.length && !candidateNames.size) {
    return {
      matched: false,
      scannedScreens,
      scrolledMoves,
      candidateNames: [],
      candidateSummaries: [],
      rejectionStage: "no-cards",
      rejectionCounts: { cards: 0 },
      error: "未读取到训练营卡片"
    };
  }
  const selected = selectBestTrainingCampCandidate(matches, criteria);
  if (!selected.matched) {
    return {
      matched: false,
      scannedScreens,
      scrolledMoves,
      candidateNames: [...candidateNames],
      candidateSummaries: selected.candidateSummaries?.length
        ? selected.candidateSummaries
        : [...candidateSummaries.values()],
      rejectionStage: selected.rejectionStage || "",
      rejectionCounts: selected.rejectionCounts || {},
      error: selected.error
    };
  }
  return {
    matched: true,
    ...selected,
    scannedScreens,
    scrolledMoves,
    candidateNames: [...candidateNames],
    candidateSummaries: selected.candidateSummaries || [...candidateSummaries.values()]
  };
}

async function setTrainingCampSwitchScrollTop(page, top = 0) {
  return interactTrainingCampSwitchScroll(page, "set", top);
}

async function advanceTrainingCampSwitchScroll(page) {
  return interactTrainingCampSwitchScroll(page, "advance");
}

async function interactTrainingCampSwitchScroll(page, action, top = 0) {
  return await page.evaluate(({ action, top }) => {
    const overlay = findOverlay();
    if (!overlay) return { found: false, atEnd: true, moved: false, contentReady: false, loading: false, empty: false };
    const content = inspectContent(overlay);
    const container = findScrollContainer(overlay);
    if (!container) {
      return { found: false, atEnd: content.contentReady, moved: false, ...content };
    }
    const before = container.scrollTop;
    if (action === "set") {
      container.scrollTop = Math.max(0, Number(top || 0));
    } else {
      const step = Math.max(220, Math.floor(container.clientHeight * 0.78));
      container.scrollTop = Math.min(container.scrollHeight, before + step);
    }
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { ...scrollState(container, before), ...inspectContent(overlay) };

    function findScrollContainer(root) {
      const overlay = root;
      const overlayRect = overlay.getBoundingClientRect();
      const candidates = [overlay, ...overlay.querySelectorAll("*")]
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const range = el.scrollHeight - el.clientHeight;
          let score = range;
          if (/auto|scroll|overlay/i.test(style.overflowY || "")) score += 600;
          if (/body|content|list|scroll/i.test(String(el.className || ""))) score += 260;
          if (String(el.innerText || el.textContent || "").includes("所在期数")) score += 180;
          if (rect.top > overlayRect.top + 80) score += 80;
          score += Math.min(300, rect.height / 2);
          return { el, rect, range, score };
        })
        .filter((item) => item.range > 24 && item.rect.width > 320 && item.rect.height > 160)
        .filter((item) => item.rect.left >= overlayRect.left - 4 && item.rect.right <= overlayRect.right + 4)
        .sort((a, b) => b.score - a.score || b.range - a.range || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
      return candidates[0]?.el || null;
    }
    function inspectContent(root) {
      const text = String(root.innerText || root.textContent || "");
      const cardCount = Math.max(0, text.split("所在期数").length - 1);
      const loading = [...root.querySelectorAll(".el-loading-spinner, .el-loading-mask, .ant-spin-spinning, [role='progressbar'], [class*='loading']")]
        .some(rendered);
      const empty = /暂无数据|暂无训练营|没有数据|无匹配数据/.test(text);
      return { loading, empty, cardCount, contentReady: !loading && (cardCount > 0 || empty) };
    }
    function findOverlay() {
      const compact = (value) => String(value || "").replace(/\s+/g, "").trim();
      return [...document.body.querySelectorAll("[role='dialog'], .ant-modal, .el-dialog, .arco-modal, .drawer, .el-drawer, div")]
        .filter(rendered)
        .map((el) => ({ el, rect: el.getBoundingClientRect(), text: compact(el.innerText || el.textContent || "") }))
        .filter((item) => item.text.includes("切换训练营") && item.rect.width > 420 && item.rect.height > 120)
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.el || null;
    }
    function rendered(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }
    function scrollState(container, before) {
      return {
        found: true,
        moved: Math.abs(container.scrollTop - before) > 1,
        atEnd: container.scrollTop + container.clientHeight >= container.scrollHeight - 4,
        scrollTop: Math.round(container.scrollTop),
        clientHeight: Math.round(container.clientHeight),
        scrollHeight: Math.round(container.scrollHeight)
      };
    }
  }, { action, top }).catch(() => ({ found: false, atEnd: true, moved: false, contentReady: false, loading: false, empty: false }));
}

async function waitForCampManagementPage(page, maxWaitMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const ready = await page.evaluate(() => {
      const text = String(document.body.innerText || "").replace(/\s+/g, " ").trim();
      return /训练营/.test(text) && /期数管理/.test(text) && /推广类型/.test(text) && /所属品类/.test(text);
    }).catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(300).catch(() => {});
  }
  return false;
}

export async function queryFormalCampSchedule(page, criteria, operations = {}) {
  const resetFilters = operations.resetTrainingCampFilters || resetTrainingCampFilters;
  const filters = await resetFilters(page);
  if (!canProceedWithCampQueryAfterReset(filters)) {
    return {
      matched: false,
      error: "训练营筛选条件未能清理，已取消本次期数查询",
      clearFailed: filters.clearFailed,
      canClosePeriodOverlay: filters.canClosePeriodOverlay
    };
  }
  const modeReady = await ensureCampNameSearchMode(page);
  if (!modeReady) return { matched: false, error: "训练营名称筛选项未找到" };
  const filled = await fillCampManagementName(page, stripCampNameMarker(criteria.productName));
  if (!filled) return { matched: false, error: "训练营名称未填入" };
  const queried = await clickCampManagementQuery(page);
  if (!queried) return { matched: false, error: "训练营管理查询按钮未找到" };
  const campRow = await waitForExactCampRow(page, criteria, 6000);
  if (!campRow.matched) return campRow;
  const periodOpen = await openExactCampPeriodManagement(page, {
    ...criteria,
    campId: campRow.campId || ""
  });
  if (!periodOpen.opened) return { matched: false, error: periodOpen.error };
  let periodRow = { matched: false };
  let periodMatchStrategy = "period-name-normalized";

  // 订单中的“所在期数”与期数管理页的展示名并不总是一致，例如订单
  // 只带“1期”，后台展示为“3期（1.11）”。先尝试原有精确匹配，
  // 失败后按订单支付时间匹配开营/结营区间。
  if (criteria.periodName) {
    const periodFilled = await fillPeriodManagementName(page, criteria.periodName);
    if (periodFilled) {
      const periodQueried = await clickPeriodManagementQuery(page);
      if (periodQueried) periodRow = await waitForExactPeriodRow(page, criteria.periodName, 5000);
    }
  }

  if (!periodRow.matched && criteria.orderTime) {
    const cleared = await fillPeriodManagementName(page, "");
    const queriedAll = cleared && await clickPeriodManagementQuery(page);
    if (queriedAll) {
      const candidates = await collectPeriodRows(page, 8000);
      periodRow = choosePeriodByOrderTime(candidates, criteria.orderTime);
      periodMatchStrategy = periodRow.matched ? periodRow.matchStrategy : periodMatchStrategy;
    }
  }

  if (!periodRow.matched) {
    return {
      matched: false,
      error: periodRow.error || "未找到与订单时间对应的期数",
      periodName: criteria.periodName || ""
    };
  }
  return {
    matched: true,
    campId: campRow.campId || "",
    periodId: periodRow.periodId || "",
    periodName: periodRow.periodName || criteria.periodName || "",
    startTime: periodRow.startTime || "",
    endTime: periodRow.endTime || "",
    matchStrategy: campRow.matchStrategy || "product-category",
    periodMatchStrategy,
    categoryMatched: Boolean(campRow.categoryMatched)
  };
}

export async function resetTrainingCampFilters(page, operations = {}) {
  const isOpen = operations.isOverlayTitleOpen || isOverlayTitleOpen;
  const closeSwitch = operations.closeTrainingCampSwitch || closeTrainingCampSwitch;
  const clearPeriod = operations.clearPeriodManagementFilter || clearPeriodManagementFilter;
  const closeOverlay = operations.closeOverlayByTitle || closeOverlayByTitle;
  const clickReset = operations.clickReset || ((currentPage) => clickButtonByText(currentPage, "重置").catch(() => false));
  const fillCampName = operations.fillCampManagementName || fillCampManagementName;
  const inspectCampName = operations.inspectCampManagementName
    || ((currentPage) => interactCampManagementNameFilter(currentPage, "inspect"));
  const readCategory = operations.readCampManagementCategoryFilter || readCampManagementCategoryFilter;

  const result = ({ filtersReset = false, clearFailed = false, canClosePeriodOverlay = !clearFailed } = {}) => ({
    filtersReset,
    clearFailed,
    canClosePeriodOverlay
  });
  const switchClosed = !await isOpen(page, "切换训练营") || await closeSwitch(page);
  const periodOpenBeforeReset = await isOpen(page, "期数管理");
  const periodCleared = !periodOpenBeforeReset || await clearPeriod(page);
  if (!switchClosed) return result({ canClosePeriodOverlay: !periodOpenBeforeReset });
  if (!periodCleared) return result({ clearFailed: periodOpenBeforeReset, canClosePeriodOverlay: false });
  const periodClosed = !periodOpenBeforeReset || await closeOverlay(page, "期数管理");
  if (!periodClosed) return result({ canClosePeriodOverlay: false });

  const resetClicked = await clickReset(page);
  if (!resetClicked) return result();
  await page.waitForTimeout(250).catch(() => {});

  // 重置按钮在部分后台版本不会立刻同步受控输入，显式清空训练营名称后
  // 再读取控件，避免上一订单的筛选条件串入本次查询。
  const campCleared = await fillCampName(page, "");
  if (!campCleared) return result();
  const [campName, category, switchOpen, periodOpen] = await Promise.all([
    inspectCampName(page),
    readCategory(page),
    isOpen(page, "切换训练营"),
    isOpen(page, "期数管理")
  ]);
  const filtersReset = Boolean(
    !switchOpen
    && !periodOpen
    && campName?.found
    && !readSelectedControlValue({ inputValue: campName.value })
    && !readSelectedControlValue(category)
  );
  return result({ filtersReset, canClosePeriodOverlay: !periodOpen });
}

export async function closePeriodManagementOverlayIfSafe(page, schedule = {}, closeOverlay = closeOverlayByTitle) {
  if (schedule?.canClosePeriodOverlay === false) return false;
  return await closeOverlay(page, "期数管理");
}

async function clearPeriodManagementFilter(page) {
  const state = await interactPeriodManagement(page, "inspect");
  if (!state?.found) return false;
  if (isTrainingCampPeriodControlEmpty(state)) return true;
  const filled = await interactPeriodManagement(page, "fill", "");
  if (!filled?.found) return false;
  await page.waitForTimeout(150).catch(() => {});
  return isTrainingCampPeriodControlEmpty(await interactPeriodManagement(page, "inspect"));
}

export function isTrainingCampPeriodControlEmpty(state = {}) {
  return Boolean(state?.found && !normalizeExactText(state.value));
}

async function readCampManagementCategoryFilter(page) {
  return await page.evaluate(() => {
    const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 18 && rect.top >= 0 && rect.top < 380
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const labels = [...document.body.querySelectorAll("label, span, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: compact(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "所属品类");
    const controls = [...document.body.querySelectorAll("input, .el-select, .ant-select, .arco-select, [role='combobox']")]
      .filter(visible)
      .map((el) => {
        const outer = el.closest(".el-select, .ant-select, .arco-select, [role='combobox']") || el;
        const rect = outer.getBoundingClientRect();
        const input = outer.matches("input") ? outer : outer.querySelector("input");
        const selected = outer.querySelector(".ant-select-selection-item, .el-select__selected-item, .arco-select-view-value, [data-selected-value]");
        return {
          outer,
          rect,
          inputValue: String(input?.value || "").trim(),
          selectedText: String(selected?.innerText || selected?.textContent || "").trim(),
          explicitValue: String(outer.getAttribute("data-selected-value") || outer.getAttribute("title") || "").trim()
        };
      });
    const candidate = controls
      .map((control) => ({
        ...control,
        distance: Math.min(...labels.map((label) => Math.abs(label.rect.top + label.rect.height / 2 - (control.rect.top + control.rect.height / 2))
          + Math.max(0, control.rect.left - label.rect.right)))
      }))
      .filter((control) => Number.isFinite(control.distance) && control.distance < 420)
      .sort((a, b) => a.distance - b.distance || a.rect.left - b.rect.left)[0];
    if (!candidate) return { inputValue: "", selectedText: "", explicitValue: "" };
    return candidate;
  }).catch(() => ({ inputValue: "", selectedText: "", explicitValue: "" }));
}

async function openExactCampPeriodManagement(page, criteria) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const clicked = await clickExactCampPeriodManagement(page, criteria);
    if (!clicked) {
      if (attempt === 2) {
        return { opened: false, error: "精确匹配训练营所在行的期数管理未能点击" };
      }
      await page.waitForTimeout(500).catch(() => {});
      continue;
    }
    if (await waitForPeriodManagementOverlay(page, attempt === 1 ? 4200 : 6000)) {
      return { opened: true, attempts: attempt };
    }
    if (attempt === 1) await page.waitForTimeout(650).catch(() => {});
  }
  return { opened: false, error: "期数管理弹窗未打开（已重新定位订单行并补点1次）" };
}

export async function clickExactCampPeriodManagement(page, criteria) {
  // 精确行的操作列可能在横向滚动区域之外。先定位并标记这一行的真实可点击元素，
  // 滚动到可视区后走 Playwright 点击；只有该路径失败时才回退为坐标点击。
  const row = await findExactCampRow(page, criteria);
  if (!row?.matched) return false;
  const marked = page.locator?.("[data-codex-period-management-action='1']").first?.();
  if (marked) {
    await marked.scrollIntoViewIfNeeded?.().catch(() => {});
    const clicked = await marked.click?.({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
    if (clicked) return true;
  }
  if (!Number.isFinite(row.x) || !Number.isFinite(row.y)) return false;
  if (page.mouse?.click) {
    return await page.mouse.click(row.x, row.y).then(() => true).catch(() => false);
  }
  return await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    const clickable = target?.closest?.("button, a, [role='button'], [tabindex]") || target;
    if (!clickable) return false;
    clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    clickable.click();
    return true;
  }, { x: row.x, y: row.y }).catch(() => false);
}

async function waitForPeriodManagementOverlay(page, maxWaitMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    if (await isPeriodManagementOverlayReady(page)) return true;
    await page.waitForTimeout(200).catch(() => {});
  }
  return false;
}

async function isPeriodManagementOverlayReady(page) {
  return await page.evaluate(() => {
    const compact = (input) => String(input || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const titleNodes = [...document.body.querySelectorAll("h1, h2, h3, h4, header, span, div")]
      .filter(visible)
      .filter((el) => compact(el.innerText || el.textContent || "") === "期数管理");
    for (const title of titleNodes) {
      let current = title;
      while (current && current !== document.body) {
        const rect = current.getBoundingClientRect();
        const text = compact(current.innerText || current.textContent || "");
        if (rect.width > 520 && rect.height > 240 && text.includes("期数名称")
          && text.includes("开营时间") && text.includes("结营时间")) return true;
        current = current.parentElement;
      }
    }
    return false;
  }).catch(() => false);
}

async function fillPeriodManagementName(page, periodName) {
  const focused = await interactPeriodManagement(page, "focus");
  if (!focused?.found) return false;
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.type(String(periodName), { delay: 12 }).catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(500).catch(() => {});
  const state = await interactPeriodManagement(page, "inspect");
  return Boolean(state?.found && normalizeExactText(state.value) === normalizeExactText(periodName));
}

async function clickPeriodManagementQuery(page) {
  const result = await interactPeriodManagement(page, "query");
  if (!result?.found || !result.marker) return false;
  return await page.locator("[data-codex-period-query='1']").first()
    .click({ force: true, timeout: 2500 })
    .then(() => true)
    .catch(() => false);
}

async function interactPeriodManagement(page, action, value = "") {
  return await page.evaluate(({ action, value }) => {
    const compact = (input) => String(input || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const root = findPeriodRoot();
    if (!root) return { found: false, reason: "period-management-root-not-found" };
    root.querySelectorAll("[data-codex-period-query='1']").forEach((el) => el.removeAttribute("data-codex-period-query"));
    const rootRect = root.getBoundingClientRect();
    const inputs = [...root.querySelectorAll("input")]
      .filter(visible)
      .filter((input) => !input.disabled && !input.readOnly)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), placeholder: compact(el.getAttribute("placeholder") || "") }));
    const labels = [...root.querySelectorAll("label, span, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: compact(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "期数名称");
    const ranked = [];
    for (const input of inputs) {
      const parentText = compact(input.el.parentElement?.parentElement?.innerText || input.el.parentElement?.innerText || "");
      let score = input.rect.top - rootRect.top;
      if (input.placeholder.includes("期数") || parentText.includes("期数名称")) score -= 300;
      for (const label of labels) {
        const sameRow = Math.abs(centerY(label.rect) - centerY(input.rect));
        const nearby = input.rect.left >= label.rect.left - 10 && input.rect.left - label.rect.right < 360;
        if (sameRow < 32 && nearby) score -= 200 - sameRow;
      }
      ranked.push({ input, score });
    }
    const targetInput = ranked.sort((a, b) => a.score - b.score)[0]?.input?.el;
    if (!targetInput) return { found: false, reason: "period-name-input-not-found" };

    if (action === "focus") targetInput.focus();
    if (action === "fill") {
      targetInput.focus();
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(targetInput, String(value));
      targetInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
      targetInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (action === "query") {
      const inputRect = targetInput.getBoundingClientRect();
      const button = [...root.querySelectorAll("button, a, [role='button'], span")]
        .filter(visible)
        .map((el) => ({ el, rect: el.getBoundingClientRect(), text: compact(el.innerText || el.textContent || "") }))
        .filter((item) => item.text === "查询")
        .filter((item) => Math.abs(centerY(item.rect) - centerY(inputRect)) < 50)
        .sort((a, b) => a.rect.left - b.rect.left)[0]?.el;
      if (!button) return { found: false, reason: "period-query-button-not-found" };
      button.setAttribute("data-codex-period-query", "1");
      return {
        found: true,
        marker: true,
        value: String(targetInput.value || "").trim()
      };
    }
    return { found: true, value: String(targetInput.value || "").trim() };

    function findPeriodRoot() {
      const titleNodes = [...document.body.querySelectorAll("h1, h2, h3, h4, header, span, div")]
        .filter(visible)
        .filter((el) => compact(el.innerText || el.textContent || "") === "期数管理");
      const roots = [];
      for (const title of titleNodes) {
        let current = title;
        while (current && current !== document.body) {
          const rect = current.getBoundingClientRect();
          const text = compact(current.innerText || current.textContent || "");
          if (rect.width > 520 && rect.height > 240 && text.includes("期数名称")
            && text.includes("开营时间") && text.includes("结营时间")) {
            roots.push({ el: current, rect });
            break;
          }
          current = current.parentElement;
        }
      }
      return roots.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.el || null;
    }
    function centerY(rect) {
      return rect.top + rect.height / 2;
    }
  }, { action, value }).catch(() => ({ found: false, reason: "period-management-dom-error" }));
}

async function ensureCampNameSearchMode(page) {
  let state = await interactCampManagementNameFilter(page, "inspect");
  if (!state?.found) return false;
  if (normalizeExactText(state.mode).replace(/\s+/g, "").includes("训练营名称")) return true;

  const clicked = await interactCampManagementNameFilter(page, "click-mode");
  if (!clicked?.found) return false;
  await page.waitForTimeout(200).catch(() => {});
  const optionClicked = await waitAndClickExactVisibleOption(page, "训练营名称", 2500);
  if (!optionClicked) return false;
  await page.waitForTimeout(200).catch(() => {});
  state = await interactCampManagementNameFilter(page, "inspect");
  return Boolean(state?.found && normalizeExactText(state.mode).replace(/\s+/g, "").includes("训练营名称"));
}

async function fillCampManagementName(page, productName) {
  // 训练营后台使用受控输入。仅通过 DOM value setter 写值时，画面上的值会变，
  // 但 Vue/Element 的查询条件可能仍是上一单的值，导致第二个正式营仍查询到第一单。
  // 先用 DOM 定位唯一输入，再由 Playwright 原生 fill 触发完整输入事件链，并读回校验。
  const marked = await interactCampManagementNameFilter(page, "mark-input");
  if (!marked?.found) return false;
  const input = page.locator("[data-codex-camp-name-input='1']").first();
  if (!await input.isVisible().catch(() => false)) return false;
  await input.fill(String(productName || "")).catch(() => {});
  await input.press("Tab").catch(() => {});
  await page.waitForTimeout(250).catch(() => {});
  const state = await interactCampManagementNameFilter(page, "inspect");
  return Boolean(state?.found && normalizeExactText(state.value) === normalizeExactText(productName));
}

async function interactCampManagementNameFilter(page, action, value = "") {
  return await page.evaluate(({ action, value }) => {
    const compact = (input) => String(input || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 30 && rect.height > 20 && rect.top >= 0 && rect.top < 360
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const inputs = [...document.body.querySelectorAll("input")]
      .filter(visible)
      .filter((input) => !input.disabled && !input.readOnly)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), placeholder: compact(el.getAttribute("placeholder") || "") }));
    const selectors = [...document.body.querySelectorAll(".el-select, .ant-select, .arco-select, [role='combobox'], .el-select__wrapper, .ant-select-selector")]
      .filter(visible)
      .map((el) => {
        const outer = el.closest(".el-select, .ant-select, .arco-select, [role='combobox']") || el;
        return { el: outer, rect: outer.getBoundingClientRect(), text: compact(outer.innerText || outer.textContent || "") };
      });
    const pairs = [];
    for (const input of inputs) {
      for (const selector of selectors) {
        const sameRow = Math.abs(centerY(input.rect) - centerY(selector.rect)) < 24;
        const leftNeighbor = selector.rect.right <= input.rect.left + 14 && input.rect.left - selector.rect.right < 40;
        if (!sameRow || !leftNeighbor) continue;
        let score = Math.abs(centerY(input.rect) - centerY(selector.rect)) + Math.max(0, input.rect.left - selector.rect.right);
        if (input.placeholder.includes("请输入内容")) score -= 100;
        if (selector.text.includes("训练营名称")) score -= 200;
        pairs.push({ input, selector, score });
      }
    }
    const pair = pairs.sort((a, b) => a.score - b.score || b.input.rect.left - a.input.rect.left)[0];
    if (!pair) return { found: false, reason: "camp-name-filter-pair-not-found" };
    document.querySelectorAll("[data-codex-camp-name-input]")
      .forEach((el) => el.removeAttribute("data-codex-camp-name-input"));
    if (action === "click-mode") {
      pair.selector.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      pair.selector.el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      pair.selector.el.click();
    }
    if (action === "mark-input") pair.input.el.setAttribute("data-codex-camp-name-input", "1");
    if (action === "fill") {
      pair.input.el.focus();
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(pair.input.el, String(value));
      pair.input.el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
      pair.input.el.dispatchEvent(new Event("change", { bubbles: true }));
      pair.input.el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    }
    return {
      found: true,
      mode: String(pair.selector.el.innerText || pair.selector.el.textContent || "").trim(),
      value: String(pair.input.el.value || "").trim(),
      placeholder: pair.input.placeholder,
      inputRect: rectData(pair.input.rect),
      selectorRect: rectData(pair.selector.rect)
    };

    function centerY(rect) {
      return rect.top + rect.height / 2;
    }
    function rectData(rect) {
      return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
    }
  }, { action, value }).catch(() => ({ found: false, reason: "camp-name-filter-dom-error" }));
}

async function clickCampManagementQuery(page) {
  const marked = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 30 && rect.height > 20 && rect.top >= 0 && rect.top < 420
        && style.display !== "none" && style.visibility !== "hidden";
    };
    document.querySelectorAll("[data-codex-camp-query]")
      .forEach((el) => el.removeAttribute("data-codex-camp-query"));
    const items = [...document.body.querySelectorAll("button, [role='button'], a")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "查询")
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const target = items[0];
    if (!target) return false;
    target.el.setAttribute("data-codex-camp-query", "1");
    return true;
  }).catch(() => false);
  if (!marked) return false;
  return page.locator("[data-codex-camp-query='1']").first()
    .click({ force: true, timeout: 2500 }).then(() => true).catch(() => false);
}

export async function findExactCampRow(page, criteria) {
  return await page.evaluate(({ productName, category, campId }) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const compact = (value) => normalize(value).replace(/\s+/g, "");
    const campName = (value) => normalize(value)
      .replace(/^(?:(?:new)\s*|[【[]\s*新\s*[】\]]\s*|[（(]\s*新\s*[）)]\s*)+/i, "")
      .replace(/^[（(]\s*内部\s*[）)]\s*/i, "")
      .replace(/^(?:【\s*兴趣岛\s*】|兴趣岛\s*[-‐‑‒–—―－_:：·])\s*/u, "")
      .replace(/\s*[（(]\s*(?:已结营|未开营|开营中|进行中|已结束|招生中|接量中|销转中)\s*[）)]\s*/gi, " ")
      .replace(/\s+(?=已结营|未开营|开营中|进行中|已结束|招生中|接量中|销转中)[\s\S]*$/i, "")
      .replace(/\s+(?=[A-Z](?:\d+)?级|V\d+|已领券|未领券|已进群|未进群|已加好友|未加好友|完课\d+节|退款记录)[\s\S]*$/i, "")
      .replace(/\s+/g, "");
    const campMatchType = (actual, expected) => {
      const left = campName(actual).replace(/[《》【】\[\]（）()<>「」“”‘’·，,。！？!?：:；;]/g, "");
      const right = campName(expected).replace(/[《》【】\[\]（）()<>「」“”‘’·，,。！？!?：:；;]/g, "");
      if (!left || !right) return "";
      if (left === right) return "normalized-exact";
      if (left.length >= 5 && right.length >= 5 && (left.includes(right) || right.includes(left))) return "normalized-contains";
      return "";
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const actions = [...document.body.querySelectorAll("button, a, [role='button'], span, div")]
      .filter(visible)
      .filter((el) => compact(el.innerText || el.textContent || "") === "期数管理");
    const rows = collectCampRows(actions);
    const candidates = rows.filter((item) => /正式营/.test(item.text));
    const expectedName = campName(productName);
    const expectedCategory = compact(category);
    const expectedId = compact(campId);
    const evaluated = candidates.map((row, sourceIndex) => {
      const rowCampId = row.cells.find((cell) => /^\d{5,}$/.test(compact(cell))) || "";
      const normalizedNames = row.cells.map(campName).filter(Boolean);
      const nameMatchType = row.cells.map((cell) => campMatchType(cell, productName)).find(Boolean)
        || campMatchType(row.text, productName) || "";
      const nameMatched = Boolean(nameMatchType);
      const categoryMatched = Boolean(expectedCategory && row.cells.some((cell) => compact(cell) === expectedCategory));
      const internal = row.cells.some((cell) => /^[（(]\s*内部\s*[）)]/i.test(normalize(cell)));
      const smallNumbers = row.cells.map((cell) => Number.parseInt(compact(cell), 10))
        .filter((value) => Number.isFinite(value) && value >= 0 && value < 1000);
      const totalPeriods = smallNumbers.length ? Math.max(...smallNumbers) : 0;
      const idMatched = Boolean(expectedId && compact(rowCampId) === expectedId);
      const score = (idMatched ? 20000 : 0) + (nameMatchType === "normalized-exact" ? 10000 : (nameMatched ? 6500 : 0))
        + (categoryMatched ? 3000 : 0) + (internal ? -1800 : 1200)
        + Math.min(totalPeriods, 500) - sourceIndex / 1000;
      return { ...row, rowCampId: compact(rowCampId), nameMatched, nameMatchType, categoryMatched,
        normalizedNames, internal, totalPeriods, idMatched, score };
    });
    const idMatches = expectedId ? evaluated.filter((row) => row.idMatched) : [];
    const exactMatches = evaluated.filter((row) => row.nameMatchType === "normalized-exact");
    const containsMatches = evaluated.filter((row) => row.nameMatchType === "normalized-contains");
    let eligible = idMatches.length ? idMatches : exactMatches;
    if (!eligible.length && containsMatches.length) {
      const distinctNames = new Set(containsMatches.flatMap((row) => row.normalizedNames)
        .filter((name) => name && (name.includes(expectedName) || expectedName.includes(name))));
      if (distinctNames.size > 1) {
        return { matched: false, error: "训练营列表名称包含匹配不唯一" };
      }
      eligible = containsMatches;
    }
    if (expectedCategory) eligible = eligible.filter((row) => row.categoryMatched);
    const ranked = eligible
      .sort((a, b) => b.score - a.score || b.totalPeriods - a.totalPeriods || a.rect.top - b.rect.top);
    const target = ranked[0];
    if (!target) return { matched: false, error: "训练营列表没有匹配的正式营记录" };
    const action = target.action || actions
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter((item) => Math.abs((item.rect.top + item.rect.height / 2) - (target.rect.top + target.rect.height / 2)) < Math.max(30, target.rect.height / 2))[0]?.el;
    if (!action) return { matched: false, error: "精确匹配训练营所在行未找到期数管理" };
    const clickTarget = action.closest("button, a, [role='button'], [tabindex]") || action;
    document.querySelectorAll("[data-codex-period-management-action]")
      .forEach((el) => el.removeAttribute("data-codex-period-management-action"));
    clickTarget.setAttribute("data-codex-period-management-action", "1");
    const actionRect = clickTarget.getBoundingClientRect();
    return {
      matched: true,
      campId: target.rowCampId,
      categoryMatched: Boolean(target.categoryMatched),
      matchStrategy: target.idMatched
        ? "camp-id-product-category"
        : (target.categoryMatched ? "product-category-non-internal-periods" : "product-non-internal-periods"),
      x: actionRect.left + actionRect.width / 2,
      y: actionRect.top + actionRect.height / 2
    };

    function collectCampRows(actionNodes) {
      const result = [];
      const saved = new Set();
      const add = (row, action = null) => {
        if (!row || !visible(row)) return;
        if (saved.has(row)) {
          // 标准 table 行会先被收集，随后才从“期数管理”反向找到其操作元素。
          // 必须回填这个元素，否则只能退化为全局同一横坐标的文本节点。
          if (action) {
            const existing = result.find((item) => item.row === row);
            if (existing && !existing.action) existing.action = action;
          }
          return;
        }
        const rect = row.getBoundingClientRect();
        const text = normalize(row.innerText || row.textContent || "");
        if (!text || rect.height < 24 || rect.height > 360 || rect.width < 280) return;
        let cells = [...row.querySelectorAll("td, .el-table__cell, [class*='table-cell'], [class*='cell']")]
          .filter(visible)
          .map((cell) => normalize(cell.innerText || cell.textContent || ""))
          .filter(Boolean);
        // 虚拟列表的行可能只用普通 div/span 组成，没有标准 cell 类名。
        // 此时使用直属子节点保留列边界，不把整行拼成一个“名称”去匹配。
        if (!cells.length) {
          cells = [...row.children]
            .filter(visible)
            .map((cell) => normalize(cell.innerText || cell.textContent || ""))
            .filter(Boolean);
        }
        saved.add(row);
        result.push({ row, action, rect, text, cells: cells.length ? cells : [text] });
      };
      document.body.querySelectorAll("tbody tr, .el-table__row, [class*='table-row'], [class*='list-row']")
        .forEach((row) => add(row));
      for (const action of actionNodes) {
        let node = action.parentElement;
        for (let depth = 0; node && node !== document.body && depth < 12; depth += 1, node = node.parentElement) {
          const rect = node.getBoundingClientRect();
          const text = normalize(node.innerText || node.textContent || "");
          const rowish = node.matches("tr, .el-table__row, [class*='table-row'], [class*='list-row'], [class*='row']");
          const singleAction = [...node.querySelectorAll("button, a, [role='button'], span, div")]
            .filter(visible)
            .filter((el) => compact(el.innerText || el.textContent || "") === "期数管理").length === 1;
          if (rect.width > 280 && rect.height >= 24 && rect.height <= 360 && /正式营/.test(text) && (rowish || singleAction)) {
            add(node, action);
            break;
          }
        }
      }
      return result;
    }
  }, criteria).catch(() => ({ matched: false, error: "训练营表格 DOM 提取失败" }));
}

async function waitForExactCampRow(page, criteria, maxWaitMs = 6000) {
  const startedAt = Date.now();
  let lastResult = { matched: false, error: "训练营列表没有完全一致的正式营" };
  while (Date.now() - startedAt < maxWaitMs) {
    lastResult = await findExactCampRow(page, criteria);
    if (lastResult.matched) return lastResult;
    await page.waitForTimeout(250).catch(() => {});
  }
  return lastResult;
}

async function fillOverlayInputNearLabel(page, title, label, value) {
  const marked = await page.evaluate(({ title, label }) => {
    const normalize = (input) => String(input || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const overlay = [...document.body.querySelectorAll("[role='dialog'], .ant-modal, .el-dialog, .arco-modal, .drawer, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text.includes(normalize(title)) && item.rect.width > 420 && item.rect.height > 180)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.el;
    if (!overlay) return null;
    const labels = [...overlay.querySelectorAll("label, span, div")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === normalize(label));
    const inputs = [...overlay.querySelectorAll("input")]
      .filter(visible)
      .filter((el) => !el.disabled && !el.readOnly)
      .map((el) => ({ el, rect: el.getBoundingClientRect() }));
    const ranked = [];
    for (const labelItem of labels) {
      for (const input of inputs) {
        const sameRow = Math.abs((labelItem.rect.top + labelItem.rect.height / 2) - (input.rect.top + input.rect.height / 2));
        if (sameRow > 34 || input.rect.left < labelItem.rect.left) continue;
        ranked.push({ input, score: sameRow * 4 + Math.max(0, input.rect.left - labelItem.rect.right) });
      }
    }
    const target = ranked.sort((a, b) => a.score - b.score)[0]?.input?.el;
    document.querySelectorAll("[data-codex-overlay-input]").forEach((el) => el.removeAttribute("data-codex-overlay-input"));
    if (!target) return false;
    target.setAttribute("data-codex-overlay-input", "1");
    return true;
  }, { title, label }).catch(() => null);
  if (!marked) return false;
  const input = page.locator("[data-codex-overlay-input='1']").first();
  if (!await input.isVisible().catch(() => false)) return false;
  await input.fill(String(value)).catch(() => {});
  await input.dispatchEvent("input").catch(() => {});
  await input.dispatchEvent("change").catch(() => {});
  await input.blur().catch(() => {});
  return await page.evaluate(({ title, expected }) => {
    const normalize = (input) => String(input || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const overlay = [...document.body.querySelectorAll("[role='dialog'], .ant-modal, .el-dialog, .arco-modal, .drawer, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text.includes(normalize(title)) && item.rect.width > 420 && item.rect.height > 180)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.el;
    return Boolean(overlay && [...overlay.querySelectorAll("input")]
      .filter(visible)
      .some((input) => normalize(input.value) === normalize(expected)));
  }, { title, expected: value }).catch(() => false);
}

async function clickOverlayButton(page, title, buttonText) {
  const marked = await page.evaluate(({ title, buttonText }) => {
    const normalize = (input) => String(input || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 16 && rect.bottom > 0 && rect.top < window.innerHeight
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const overlay = [...document.body.querySelectorAll("[role='dialog'], .ant-modal, .el-dialog, .arco-modal, .drawer, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text.includes(normalize(title)) && item.rect.width > 420 && item.rect.height > 180)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.el;
    if (!overlay) return null;
    const candidates = [...overlay.querySelectorAll("button, a, [role='button']")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === normalize(buttonText))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const target = candidates[0]?.el;
    document.querySelectorAll("[data-codex-overlay-button]").forEach((el) => el.removeAttribute("data-codex-overlay-button"));
    if (!target) return false;
    target.setAttribute("data-codex-overlay-button", "1");
    return true;
  }, { title, buttonText }).catch(() => null);
  if (!marked) return false;
  const button = page.locator("[data-codex-overlay-button='1']").first();
  if (!await button.isVisible().catch(() => false)) return false;
  return await button.click({ force: true }).then(() => true).catch(() => false);
}

async function readExactPeriodRow(page, periodName) {
  return await page.evaluate((expectedName) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const compact = (value) => normalize(value).replace(/\s+/g, "");
    const comparablePeriod = (value) => compact(value)
      .replace(/[【】\[\]（）()《》<>「」『』]/g, "")
      .replace(/[：:、，,。._\-—\s]/g, "")
      .toLowerCase();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const overlay = findPeriodRoot();
    if (!overlay) return { matched: false, error: "期数管理弹窗已关闭" };

    // Element UI may render the main table and fixed columns as separate tables.
    // Resolve each header independently and use its horizontal position to read
    // the matching cell from the exact period row.
    const headers = {};
    for (const label of ["ID", "期数名称", "开营时间", "结营时间"]) {
      headers[label] = findHeader(label);
    }
    if (!headers["期数名称"] || !headers["开营时间"] || !headers["结营时间"]) {
      return { matched: false, error: "期数管理表头未识别" };
    }

    const rows = [...overlay.querySelectorAll("tbody tr, [role='row'], .el-table__row")]
      .filter(visible)
      .map((row) => {
        const cells = getRowCells(row);
        const nameCell = cells.find((cell) => overlapsColumn(cell.rect, headers["期数名称"].rect));
        if (!nameCell) return null;
        const actual = comparablePeriod(nameCell.text);
        const expected = comparablePeriod(expectedName);
        const exact = actual === expected;
        const relaxed = !exact && expected.length >= 4 && actual.length >= 4
          && (actual.includes(expected) || expected.includes(actual));
        return (exact || relaxed) ? { row, cells, rect: row.getBoundingClientRect(), matchType: exact ? "normalized-exact" : "normalized-contains" } : null;
      })
      .filter(Boolean);
    const unique = [];
    for (const item of rows) {
      const periodId = compact(readColumn(item.cells, headers.ID)?.text || "");
      const name = normalize(readColumn(item.cells, headers["期数名称"])?.text || "");
      const startTime = normalize(readColumn(item.cells, headers["开营时间"])?.text || "");
      const endTime = normalize(readColumn(item.cells, headers["结营时间"])?.text || "");
      const key = periodId || `${compact(name)}|${compact(startTime)}|${compact(endTime)}`;
      if (unique.some((item) => item.key === key)) continue;
      unique.push({ key, periodId, name, startTime, endTime, matchType: item.matchType });
    }
    if (unique.length !== 1) {
      return { matched: false, error: unique.length ? `期数名称存在${unique.length}个规范化匹配项` : "未找到规范化匹配的期数名称" };
    }
    const row = unique[0];
    if (!row.startTime || !row.endTime) return { matched: false, error: "期数行缺少开营时间或结营时间" };
    return { matched: true, periodId: row.periodId, periodName: row.name, startTime: row.startTime, endTime: row.endTime, matchType: row.matchType };

    function findPeriodRoot() {
      const titles = [...document.body.querySelectorAll("h1, h2, h3, h4, header, span, div")]
        .filter(visible)
        .filter((el) => compact(el.innerText || el.textContent || "") === "期数管理");
      const roots = [];
      for (const title of titles) {
        let current = title;
        while (current && current !== document.body) {
          const rect = current.getBoundingClientRect();
          const text = compact(current.innerText || current.textContent || "");
          if (rect.width > 520 && rect.height > 240 && text.includes("期数名称")
            && text.includes("开营时间") && text.includes("结营时间")) {
            roots.push({ el: current, rect });
            break;
          }
          current = current.parentElement;
        }
      }
      return roots.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.el || null;
    }

    function findHeader(label) {
      const candidates = [...overlay.querySelectorAll("th, [role='columnheader'], thead td, .el-table__header-wrapper .cell")]
        .filter(visible)
        .map((el) => {
          const cell = el.closest("th, [role='columnheader'], td") || el;
          return { el: cell, rect: cell.getBoundingClientRect(), text: compact(cell.innerText || cell.textContent || "") };
        })
        .filter((item) => item.text === label);
      return candidates.sort((a, b) => a.rect.top - b.rect.top || a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0] || null;
    }

    function getRowCells(row) {
      const direct = [...row.children].filter((el) => el.matches("td, [role='cell'], .el-table__cell"));
      const elements = direct.length ? direct : [...row.querySelectorAll("td, [role='cell'], .el-table__cell")];
      return elements.filter(visible).map((el) => ({
        el,
        rect: el.getBoundingClientRect(),
        text: normalize(el.innerText || el.textContent || "")
      }));
    }

    function readColumn(cells, header) {
      if (!header) return null;
      return cells
        .map((cell) => ({ cell, distance: columnDistance(cell.rect, header.rect) }))
        .sort((a, b) => a.distance - b.distance)[0]?.cell || null;
    }

    function overlapsColumn(cellRect, headerRect) {
      return Math.min(cellRect.right, headerRect.right) - Math.max(cellRect.left, headerRect.left) > 2
        || columnDistance(cellRect, headerRect) < 24;
    }

    function columnDistance(cellRect, headerRect) {
      return Math.abs((cellRect.left + cellRect.right) / 2 - (headerRect.left + headerRect.right) / 2);
    }
  }, periodName).catch(() => ({ matched: false, error: "期数表格 DOM 提取失败" }));
}

async function waitForExactPeriodRow(page, periodName, maxWaitMs = 5000) {
  const startedAt = Date.now();
  let lastResult = { matched: false, error: "未找到完全一致的期数名称" };
  while (Date.now() - startedAt < maxWaitMs) {
    lastResult = await readExactPeriodRow(page, periodName);
    if (lastResult.matched || /存在\d+个精确匹配项/.test(lastResult.error || "")) return lastResult;
    await page.waitForTimeout(250).catch(() => {});
  }
  return lastResult;
}

async function collectPeriodRows(page, maxWaitMs = 8000) {
  const startedAt = Date.now();
  const rows = new Map();
  while (Date.now() - startedAt < maxWaitMs) {
    const snapshot = await readVisiblePeriodRows(page);
    for (const row of snapshot.rows || []) {
      const key = row.periodId || `${row.periodName}|${row.startTime}|${row.endTime}`;
      if (key && !rows.has(key)) rows.set(key, row);
    }
    if (snapshot.atEnd) break;
    const moved = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 300 && rect.height > 160 && rect.bottom > 0 && rect.top < window.innerHeight
          && style.display !== "none" && style.visibility !== "hidden";
      };
      const roots = [...document.querySelectorAll("[role='dialog'], .el-dialog, .ant-modal, .drawer, body")].filter(visible);
      const scrollables = roots.flatMap((root) => [root, ...root.querySelectorAll("div, section")])
        .filter((el) => el.scrollHeight > el.clientHeight + 8 && el.clientHeight > 120)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      const target = scrollables[0];
      if (!target) return { moved: false, atEnd: true };
      const before = target.scrollTop;
      target.scrollTop = Math.min(target.scrollTop + Math.max(260, target.clientHeight * 0.8), target.scrollHeight);
      return { moved: target.scrollTop > before + 1, atEnd: target.scrollTop + target.clientHeight >= target.scrollHeight - 4 };
    }).catch(() => ({ moved: false, atEnd: true }));
    if (!moved.moved) break;
    await page.waitForTimeout(300).catch(() => {});
  }
  return [...rows.values()];
}

async function readVisiblePeriodRows(page) {
  return await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const compact = (value) => normalize(value).replace(/\s+/g, "");
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const title = [...document.body.querySelectorAll("h1,h2,h3,h4,header,span,div")]
      .filter(visible).find((el) => compact(el.innerText || el.textContent) === "期数管理");
    let overlay = null;
    for (let current = title; current && current !== document.body; current = current.parentElement) {
      const text = compact(current.innerText || current.textContent || "");
      const rect = current.getBoundingClientRect();
      if (rect.width > 520 && rect.height > 240 && text.includes("期数名称") && text.includes("开营时间") && text.includes("结营时间")) {
        overlay = current;
        break;
      }
    }
    if (!overlay) return { rows: [], atEnd: true };
    const header = (label) => [...overlay.querySelectorAll("th,[role='columnheader'],thead td,.el-table__header-wrapper .cell")]
      .map((el) => el.closest("th,[role='columnheader'],td") || el)
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: compact(el.innerText || el.textContent || "") }))
      .find((item) => item.text === label);
    const headers = { id: header("ID"), name: header("期数名称"), start: header("开营时间"), end: header("结营时间") };
    if (!headers.name || !headers.start || !headers.end) return { rows: [], atEnd: true };
    const distance = (a, b) => Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2);
    const rowCells = (row) => [...row.children].filter((el) => el.matches("td,[role='cell'],.el-table__cell"))
      .filter(visible).map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }));
    const read = (cells, head) => cells.sort((a, b) => distance(a.rect, head.rect) - distance(b.rect, head.rect))[0]?.text || "";
    const rows = [...overlay.querySelectorAll("tbody tr,[role='row'],.el-table__row")].filter(visible).map((row) => {
      const cells = rowCells(row);
      return {
        periodId: compact(headers.id ? read(cells, headers.id) : ""),
        periodName: read(cells, headers.name),
        startTime: read(cells, headers.start),
        endTime: read(cells, headers.end)
      };
    }).filter((row) => row.periodName || row.startTime || row.endTime);
    const scrollers = [overlay, ...overlay.querySelectorAll("div,section")].filter((el) => el.scrollHeight > el.clientHeight + 8);
    const scroller = scrollers.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    return { rows, atEnd: !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4 };
  }).catch(() => ({ rows: [], atEnd: true }));
}

function choosePeriodByOrderTime(rows, orderTime) {
  const reference = parseDateValue(orderTime);
  if (!reference) return { matched: false, error: "订单支付时间无法解析，无法按时间匹配期数" };
  const candidates = (rows || []).map((row) => ({ ...row, start: parseDateValue(row.startTime), end: parseDateValue(row.endTime) }))
    .filter((row) => row.start && row.end);
  const inRange = candidates.filter((row) => row.start <= reference && reference <= row.end);
  if (inRange.length === 1) return { matched: true, ...inRange[0], matchStrategy: "payment-time-range" };
  if (inRange.length > 1) {
    inRange.sort((a, b) => (a.end - a.start) - (b.end - b.start) || b.start - a.start);
    return { matched: true, ...inRange[0], matchStrategy: "payment-time-range" };
  }

  // 订单常在开营前购买，支付时间可能早于期数的开营时间。
  // 仅在最近候选唯一且距离不超过 180 天时兜底，避免把订单随意归到第一条期数。
  const nearest = candidates
    .map((row) => ({ ...row, distance: reference < row.start ? row.start - reference : reference - row.end }))
    .filter((row) => row.distance >= 0)
    .sort((a, b) => a.distance - b.distance || b.start - a.start);
  if (nearest.length > 0 && nearest[0].distance <= 180 * 24 * 60 * 60 * 1000
    && (nearest.length === 1 || nearest[1].distance > nearest[0].distance)) {
    return { matched: true, ...nearest[0], matchStrategy: "nearest-period-fallback" };
  }
  return { matched: false, error: `未找到支付时间${formatDateValue(reference)}所在的期数区间，且无合理最近期数` };
}

function parseDateValue(value) {
  const text = cleanText(value).replace(/年/g, "-").replace(/月/g, "-").replace(/日/g, "");
  const match = text.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?)?/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateValue(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : "未知时间";
}

async function waitForOverlayTitle(page, title, maxWaitMs = 4000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const opened = await isOverlayTitleOpen(page, title);
    if (opened) return true;
    await page.waitForTimeout(200).catch(() => {});
  }
  return false;
}

async function isOverlayTitleOpen(page, title) {
  return await page.evaluate((expected) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 200 && rect.height > 100 && rect.bottom > 0 && rect.top < window.innerHeight
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    // 页面列表本身也有“期数管理”操作按钮，不能把普通表格容器误判为已打开的
    // 期数抽屉。只接受标题节点位于真实 dialog/drawer/modal 容器内的情况。
    return [...document.body.querySelectorAll("h1, h2, h3, h4, header, .el-drawer__title, .el-dialog__title, .ant-drawer-title, .ant-modal-title, .arco-drawer-title, .arco-modal-title, span, div")]
      .filter((el) => normalize(el.innerText || el.textContent || "") === normalize(expected))
      .some((titleNode) => {
        const overlay = titleNode.closest("[role='dialog'], .ant-modal, .el-dialog, .arco-modal, .drawer, .el-drawer, [class*='drawer'], [class*='modal'], [class*='dialog']");
        return Boolean(overlay && visible(overlay));
      });
  }, title).catch(() => false);
}

async function closeOverlayByTitle(page, title) {
  const marked = await page.evaluate((expected) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const titleNodes = [...document.body.querySelectorAll("h1, h2, h3, h4, header, .el-drawer__title, .el-dialog__title, .ant-drawer-title, .ant-modal-title, .arco-drawer-title, .arco-modal-title, span, div")]
      .filter((el) => normalize(el.innerText || el.textContent || "") === normalize(expected));
    const overlay = titleNodes
      .map((titleNode) => titleNode.closest("[role='dialog'], .ant-modal, .el-dialog, .arco-modal, .drawer, .el-drawer, [class*='drawer'], [class*='modal'], [class*='dialog']"))
      .filter(Boolean)
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 320 && item.rect.height > 120)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
    if (!overlay) return null;
    const close = [...overlay.el.querySelectorAll("button, [role='button'], .ant-modal-close, .el-dialog__headerbtn, .arco-modal-close-icon, span")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || ""), aria: normalize(el.getAttribute("aria-label") || "") }))
      .filter((item) => /^(关闭|close|×|x)$/i.test(item.text) || /close|关闭/i.test(item.aria) || /close/i.test(String(item.el.className || "")))
      .sort((a, b) => b.rect.left - a.rect.left || a.rect.top - b.rect.top)[0];
    document.querySelectorAll("[data-codex-overlay-close]").forEach((el) => el.removeAttribute("data-codex-overlay-close"));
    if (!close?.el) return false;
    close.el.setAttribute("data-codex-overlay-close", "1");
    return true;
  }, title).catch(() => null);
  if (marked) {
    const close = page.locator("[data-codex-overlay-close='1']").first();
    await close.click({ force: true }).catch(() => {});
  } else {
    await page.keyboard.press("Escape").catch(() => {});
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1800) {
    if (!await isOverlayTitleOpen(page, title)) return true;
    await page.waitForTimeout(150).catch(() => {});
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250).catch(() => {});
  return !await isOverlayTitleOpen(page, title);
}

async function getStudentArchiveState(page, userId = "", maxWaitMs = 5000) {
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
    await page.waitForTimeout(250).catch(() => {});
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
  const userMatched = !userId || normalized.includes(String(userId));
  const ready = hasArchiveTitle && hasTopIdentity && hasArchiveTabs && userMatched;
  let reason = "学员档案页验证失败";
  if (ready) reason = "已进入学员档案页";
  else if (stillOnChanceList) reason = "仍停留机会管理列表页";
  else if (!hasArchiveTitle) reason = "未出现学员档案标题";
  else if (!hasTopIdentity) reason = "未出现档案页顶部身份信息";
  else if (!hasArchiveTabs) reason = "未出现档案页Tab";
  else if (!userMatched) reason = "档案页未匹配当前用户ID";
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
  const marked = await page.evaluate((targetText) => {
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
        const nodeText = normalize(el.innerText || el.textContent || "");
        const className = String(el.className || "");
        let score = 0;
        if (nodeText === targetText) score += 80;
        if (rect.top < window.innerHeight * 0.55) score += 20;
        if (rect.width >= 28 && rect.width <= 220 && rect.height >= 20 && rect.height <= 90) score += 15;
        if (/tab|tabs|nav|menu|item/i.test(className) || el.getAttribute("role") === "tab") score += 12;
        if (nodeText.length > targetText.length + 8) score -= 30;
        return { el, rect, text: nodeText, score };
      })
      .filter((item) => item.text === targetText)
      .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const best = candidates[0];
    if (!best) return null;
    document.querySelectorAll("[data-codex-tab-text]").forEach((el) => el.removeAttribute("data-codex-tab-text"));
    best.el.setAttribute("data-codex-tab-text", "1");
    return true;
  }, text).catch(() => null);
  if (marked) {
    const tab = page.locator("[data-codex-tab-text='1']").first();
    if (!await tab.isVisible().catch(() => false)) return false;
    await tab.click({ force: true }).catch(() => {});
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
    await page.waitForTimeout(250).catch(() => {});
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
  let reason = "订单信息页验证失败";
  if (ready) reason = "订单信息页已打开";
  else if (stillOnChanceList) reason = "仍停留机会管理列表页";
  else if (!hasOrderTab) reason = "未出现订单信息Tab";
  else if (!hasCourseOrder) reason = "未出现课程订单";
  else if (!hasOrderCards) reason = "未出现课程订单卡片";
  else if (!hasDetailButton) reason = "未出现查看详情按钮";
  return {
    ready,
    stillOnChanceList,
    reason,
    textSnippet: normalized.slice(0, 2500)
  };
}

async function collectOrderPageText(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  const start = Math.max(0, text.indexOf("课程订单"));
  return cleanText(text.slice(start || 0, start + 3000));
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
  let truncated = false;
  await setOrderScrollTop(page, 0);
  await page.waitForTimeout(250).catch(() => {});

  for (let step = 0; step < 16; step += 1) {
    const before = await getOrderScrollInfo(page);
    const orders = await extractDomOrders(page);
    for (const order of orders) {
      const key = order.orderId || `${order.productType || ""}|${order.productName || ""}|${order.time || ""}`;
      if (!key || seen.has(key)) continue;
      if (seen.size >= MAX_ORDERS_PER_QUERY) {
        truncated = true;
        continue;
      }
      seen.set(key, {
        ...order,
        index: seen.size,
        sourceScrollTop: before.scrollTop
      });
    }

    samples.push({
      step,
      visibleOrders: orders.length,
      totalOrders: seen.size,
      scrollTop: before.scrollTop,
      scrollHeight: before.scrollHeight,
      clientHeight: before.clientHeight,
      domDiagnostics: orders.domDiagnostics || null
    });
    if (!before.canScrollMore) break;

    const moved = await scrollOrderPageBy(page, Math.max(520, Math.floor((before.clientHeight || 700) * 0.78)));
    await page.waitForTimeout(320).catch(() => {});
    const after = await getOrderScrollInfo(page);
    if (!moved || Math.abs((after.scrollTop || 0) - (before.scrollTop || 0)) < 8) break;
  }

  return {
    orders: [...seen.values()],
    summary: {
      completed: true,
      scanSteps: samples.length,
      foundOrders: seen.size,
      truncated,
      limit: MAX_ORDERS_PER_QUERY,
      samples: samples.slice(0, 8)
    }
  };
}

export async function extractDomOrders(page) {
  const captured = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
    const compact = (value) => normalize(value).replace(/\s+/g, "");
    const maskDiagnosticText = (value) => normalize(value).replace(/[0-9]{7,20}/g, (token) => (
      `${token.slice(0, 3)}***${token.slice(-2)}`
    ));
    const rectOf = (element) => {
      const rect = element?.getBoundingClientRect?.();
      return rect
        ? { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
        : null;
    };
    const domPath = (element) => {
      const parts = [];
      let current = element;
      while (current && current !== document.body && parts.length < 10) {
        const parent = current.parentElement;
        const siblings = parent ? [...parent.children].filter((item) => item.tagName === current.tagName) : [];
        const index = siblings.indexOf(current);
        const id = current.id ? `#${current.id}` : "";
        const classes = String(current.className || "").split(/\s+/).filter(Boolean).slice(0, 3).map((name) => `.${name}`).join("");
        parts.unshift(`${current.tagName.toLowerCase()}${id}${classes}${siblings.length > 1 ? `:nth-of-type(${index + 1})` : ""}`);
        current = parent;
      }
      return parts.join(" > ");
    };
    const isVisible = (element) => {
      if (!element || typeof element.getBoundingClientRect !== "function") return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 4 || rect.height <= 4) return false;
      let current = element;
      while (current && current !== document.documentElement) {
        const style = window.getComputedStyle(current);
        if (
          style.display === "none"
          || style.visibility === "hidden"
          || Number(style.opacity) === 0
          || current.getAttribute("aria-hidden") === "true"
          || current.hidden
        ) return false;
        current = current.parentElement;
      }
      return true;
    };
    const readInlineLabelValue = (root, label) => {
      const labelPattern = new RegExp(`^${label}\\s*[:：]?\\s*(.*)$`);
      const candidates = [...root.querySelectorAll("dt, dd, label, span, strong, b, div, p, li, td, th")]
        .filter((element) => isVisible(element))
        .map((element) => ({
          element,
          text: normalize(element.innerText || element.textContent || "")
        }))
        .filter(({ text }) => labelPattern.test(text))
        .sort((a, b) => a.text.length - b.text.length);
      for (const { element, text } of candidates) {
        const inline = text.match(labelPattern)?.[1] || "";
        if (inline && inline !== text && !element.children.length) return normalize(inline);
        if (inline && inline !== text && element.childElementCount <= 1 && text.length <= 240) return normalize(inline);
      }
      return "";
    };
    const readOrderIds = (text) => {
      const labeled = [...text.matchAll(/(?:主订单|订单)\s*ID\s*[:：]?\s*([0-9]{6,20})/g)].map((match) => match[1]);
      if (labeled.length) return [...new Set(labeled)];
      const naked = [...text.matchAll(/(?:^|[\s：:])([0-9]{10,20})(?=$|[\s，,])/g)].map((match) => match[1]);
      return [...new Set(naked)];
    };
    const readProductTypes = (text) => {
      const purchased = [...text.matchAll(/购买\s*(体验营|正式营)/g)].map((match) => match[1]);
      if (purchased.length) return [...new Set(purchased)];
      const standalone = text.split(/\n+/).map(normalize).filter((line) => /^(体验营|正式营)$/.test(line));
      return [...new Set(standalone)];
    };
    const isDetailAction = (element) => compact(element?.innerText || element?.textContent || "") === "查看详情";
    const allExactActions = [...document.body.querySelectorAll("button, a, [role='button'], span, div")]
      .filter((element) => isVisible(element) && isDetailAction(element));
    const interactiveCandidates = allExactActions.filter((element) => (
      /^(BUTTON|A)$/.test(element.tagName) || element.getAttribute("role") === "button"
    ));
    const interactiveActions = interactiveCandidates.filter((element) => (
      !interactiveCandidates.some((other) => other !== element && element.contains(other))
    ));
    const textOnlyActions = allExactActions.filter((element) => (
      !interactiveActions.some((interactive) => interactive.contains(element))
      && ![...element.children].some((child) => isVisible(child) && isDetailAction(child))
    ));
    const uniqueActions = [...interactiveActions, ...textOnlyActions].filter((element, index, items) => (
      items.indexOf(element) === index
    ));
    const snapshots = [];
    const rejected = [];

    for (const action of uniqueActions) {
      let current = action.parentElement;
      let selected = null;
      let level = 0;
      while (current && current !== document.body && level < 14) {
        const text = normalize(current.innerText || current.textContent || "");
        const containedActions = uniqueActions.filter((candidate) => current.contains(candidate)).length;
        const uniqueOrderIds = readOrderIds(text);
        const uniqueProductTypes = readProductTypes(text);
        const hasTime = /[0-9]{4}[.-][0-9]{2}[.-][0-9]{2}(?:\s+[0-9:]{5,8})?/.test(text);
        const hasProductSignal = /商品名称\s*[:：]/.test(text)
          || /订单金额\s*[:：]/.test(text)
          || /购买\s*(?:体验营|正式营)/.test(text);
        const bounded = text.length >= 20 && text.length <= 3200;
        if (
          containedActions === 1
          && uniqueOrderIds.length === 1
          && uniqueProductTypes.length === 1
          && hasTime
          && hasProductSignal
          && bounded
        ) {
          selected = {
            text,
            orderId: uniqueOrderIds[0],
            productType: uniqueProductTypes[0],
            fields: {
              "主订单ID": readInlineLabelValue(current, "主订单ID") || uniqueOrderIds[0],
              "商品名称": readInlineLabelValue(current, "商品名称"),
              "订单金额": readInlineLabelValue(current, "订单金额"),
              "下单时间": readInlineLabelValue(current, "下单时间"),
              "订单类型": readInlineLabelValue(current, "订单类型") || uniqueProductTypes[0]
            },
            level,
            rect: (() => {
              const rect = current.getBoundingClientRect();
              return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
            })(),
            probe: {
              orderId: maskDiagnosticText(uniqueOrderIds[0]),
              action: {
                path: domPath(action),
                tag: action.tagName,
                className: String(action.className || "").slice(0, 180),
                attributes: {
                  role: action.getAttribute("role") || "",
                  title: action.getAttribute("title") || "",
                  ariaLabel: action.getAttribute("aria-label") || "",
                  dataAction: action.getAttribute("data-action") || "",
                  dataTestid: action.getAttribute("data-testid") || ""
                },
                rect: rectOf(action)
              },
              selectedRoot: {
                path: domPath(current),
                tag: current.tagName,
                className: String(current.className || "").slice(0, 180),
                rect: rectOf(current),
                text: maskDiagnosticText(text).slice(0, 1200)
              },
              ancestorTrail: (() => {
                const trail = [];
                let ancestor = action.parentElement;
                while (ancestor && ancestor !== document.body && trail.length < 10) {
                  const ancestorText = normalize(ancestor.innerText || ancestor.textContent || "");
                  trail.push({
                    path: domPath(ancestor),
                    tag: ancestor.tagName,
                    className: String(ancestor.className || "").slice(0, 180),
                    rect: rectOf(ancestor),
                    detailActionCount: uniqueActions.filter((candidate) => ancestor.contains(candidate)).length,
                    orderIds: readOrderIds(ancestorText).map(maskDiagnosticText),
                    productTypes: readProductTypes(ancestorText),
                    text: maskDiagnosticText(ancestorText).slice(0, 500)
                  });
                  ancestor = ancestor.parentElement;
                }
                return trail;
              })(),
              nearbyNodes: [...document.body.querySelectorAll("span, strong, b, p, div, li, td, dd")]
                .filter(isVisible)
                .map((element) => ({ element, rect: rectOf(element), text: normalize(element.innerText || element.textContent || "") }))
                .filter(({ rect, text: nodeText }) => rect && nodeText && nodeText.length <= 180
                  && Math.abs((rect.top + rect.height / 2) - (action.getBoundingClientRect().top + action.getBoundingClientRect().height / 2)) <= 180)
                .sort((a, b) => Math.abs((a.rect.top + a.rect.height / 2) - (action.getBoundingClientRect().top + action.getBoundingClientRect().height / 2))
                  - Math.abs((b.rect.top + b.rect.height / 2) - (action.getBoundingClientRect().top + action.getBoundingClientRect().height / 2)))
                .slice(0, 80)
                .map(({ element, rect, text: nodeText }) => ({
                  path: domPath(element),
                  tag: element.tagName,
                  className: String(element.className || "").slice(0, 160),
                  rect,
                  text: maskDiagnosticText(nodeText)
                }))
            }
          };
          break;
        }
        current = current.parentElement;
        level += 1;
      }
      if (selected) snapshots.push(selected);
      else {
        rejected.push({
          reason: "未找到只包含一个订单ID和一个查看详情按钮的订单卡片",
          actionText: normalize(action.innerText || action.textContent || ""),
          parentTag: action.parentElement?.tagName || "",
          parentClass: String(action.parentElement?.className || "").slice(0, 160),
          parentText: maskDiagnosticText(action.parentElement?.innerText || action.parentElement?.textContent || "").slice(0, 240)
        });
      }
    }

    return {
      mode: "order-card-dom",
      snapshots,
      rejected,
      detailActionCount: uniqueActions.length
    };
  }).catch(() => null);

  // 兼容只返回字符串的旧测试桩；真实浏览器不再使用整页文本切块。
  if (typeof captured === "string") return parseOrderListText(captured);
  if (!captured || captured.mode !== "order-card-dom") return [];

  const seen = new Set();
  const orders = captured.snapshots.flatMap((snapshot) => {
    const cardDetail = parseInlineOrderCardDetail({
      rawText: snapshot.text,
      orderId: snapshot.orderId,
      productType: snapshot.productType,
      productName: snapshot.fields?.["商品名称"],
      amountText: snapshot.fields?.["订单金额"],
      time: snapshot.fields?.["下单时间"]
    });
    const parsed = parseOrderCardFields({
      rawText: snapshot.text,
      orderId: snapshot.orderId,
      productType: snapshot.productType,
      productName: cardDetail.productName,
      amountText: cardDetail.amountText,
      time: cardDetail.orderTime
    });
    const orderId = cleanText(parsed.orderId);
    if (!orderId || seen.has(orderId)) return [];
    seen.add(orderId);
    const parsedProductName = cleanText(parsed.productName || "");
    const safeProductName = !parsedProductName
      || parsedProductName.includes(orderId)
      || /查看详情|复制发票链接/.test(parsedProductName)
      ? extractTitleProductName(snapshot.text)
      : parsedProductName;
    return [{
      index: seen.size - 1,
      ...parsed,
      productType: cleanText(snapshot.productType || parsed.productType || ""),
      campType: normalizeOrderType(snapshot.productType || snapshot.text || ""),
      campTypeLabel: normalizeOrderType(snapshot.productType || snapshot.text || "", true),
      productName: cleanText(safeProductName),
      amount: Number.isFinite(cardDetail.amount) ? cardDetail.amount : parsed.amount,
      amountText: cleanText(cardDetail.amountText || parsed.amountText || ""),
      time: cleanText(cardDetail.orderTime || parsed.time || ""),
      cardDetail,
      hasRefundRecord: /退款记录|退款金额|退款类型|退款状态/.test(snapshot.text),
      rawText: snapshot.text.slice(0, 1400),
      domSource: {
        mode: captured.mode,
        ancestorLevel: snapshot.level,
        rect: snapshot.rect
      }
    }];
  });
  Object.defineProperty(orders, "domDiagnostics", {
    value: {
      detailActionCount: captured.detailActionCount,
      capturedCount: captured.snapshots.length,
      rejected: captured.rejected,
      snapshots: captured.snapshots.map((snapshot) => snapshot.probe)
    },
    enumerable: false
  });
  return orders;
}

export function parseOrderListText(visible = "") {
  const start = Math.max(0, visible.indexOf("课程订单"));
  const endCandidates = ["审核记录", "礼品配送", "投诉反馈", "学员动态", "录屏能力"]
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
    const key = chunk.match(/主订单ID[:：]\s*([0-9]+)/)?.[1] || chunk.slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueChunks.push(chunk);
  }
  const parsedOrders = uniqueChunks.map((text, index) => {
    const parsed = parseOrderCardFields(text);
    return {
      index,
      ...parsed,
      productName: cleanText(parsed.productName || extractTitleProductName(text)),
      hasRefundRecord: /退款记录|退款金额|退款类型|退款状态/.test(text),
      rawText: text.slice(0, 1400)
    };
  });
  return parsedOrders;
}

function splitOrderChunks(text) {
  const matches = [...text.matchAll(/[0-9]{4}[.-][0-9]{2}[.-][0-9]{2}[^\n]{0,100}购买\s*(?:体验营|正式营)|购买\s*(?:体验营|正式营)/g)];
  if (!matches.length) return [];
  return matches.map((match, index) => text.slice(match.index, index + 1 < matches.length ? matches[index + 1].index : text.length));
}

function extractTitleProductName(text) {
  const line = text.split(/\n+/).map((item) => item.trim()).find((item) => /购买\s*(体验营|正式营)/.test(item)) || "";
  return line
    .replace(/[0-9]{4}[.-][0-9]{2}[.-][0-9]{2}(?:\s+[0-9:]{5,8})?/, "")
    .replace(/购买\s*(体验营|正式营)/, "")
    .replace(/^\s*商品名称\s*[:：]\s*/, "")
    .replace(/(?:^|\s+)订单金额\s*[:：]\s*\d+(?:\.\d{1,2})?.*$/, "")
    .replace(/(?:^|\s+)(?:主订单ID|下单时间|支付方式)\s*[:：].*$/, "")
    .replace(/查看详情|复制发票链接/g, "")
    .trim();
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
        .sort((a, b) => score(b) - score(a))[0] || null;
    }

    function score(el) {
      const text = String(el.innerText || el.textContent || "");
      const style = window.getComputedStyle(el);
      const detailCount = [...el.querySelectorAll("button, a, [role='button'], span, div")]
        .filter((item) => String(item.innerText || item.textContent || "").replace(/\s+/g, "").includes("查看详情")).length;
      let value = 0;
      if (/课程订单/.test(text)) value += 30;
      if (/购买\s*(体验营|正式营)/.test(text)) value += 40;
      if (/查看详情/.test(text)) value += 20;
      if (/auto|scroll/i.test(`${style.overflowY} ${style.overflow}`)) value += 80;
      value += Math.min(detailCount, 40) * 4;
      value -= Math.min(30, (el.getBoundingClientRect().width * el.getBoundingClientRect().height) / 100000);
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
      const style = window.getComputedStyle(el);
      const detailCount = [...el.querySelectorAll("button, a, [role='button'], span, div")]
        .filter((item) => String(item.innerText || item.textContent || "").replace(/\s+/g, "").includes("查看详情")).length;
      let value = 0;
      if (/课程订单/.test(text)) value += 30;
      if (/购买\s*(体验营|正式营)/.test(text)) value += 40;
      if (/查看详情/.test(text)) value += 20;
      if (/auto|scroll/i.test(`${style.overflowY} ${style.overflow}`)) value += 80;
      value += Math.min(detailCount, 40) * 4;
      value -= Math.min(30, (el.getBoundingClientRect().width * el.getBoundingClientRect().height) / 100000);
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
    if (target === document.scrollingElement || target === document.documentElement) window.scrollBy(0, delta);
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
      const style = window.getComputedStyle(el);
      const detailCount = [...el.querySelectorAll("button, a, [role='button'], span, div")]
        .filter((item) => String(item.innerText || item.textContent || "").replace(/\s+/g, "").includes("查看详情")).length;
      let value = 0;
      if (/课程订单/.test(text)) value += 30;
      if (/购买\s*(体验营|正式营)/.test(text)) value += 40;
      if (/查看详情/.test(text)) value += 20;
      if (/auto|scroll/i.test(`${style.overflowY} ${style.overflow}`)) value += 80;
      value += Math.min(detailCount, 40) * 4;
      value -= Math.min(30, (el.getBoundingClientRect().width * el.getBoundingClientRect().height) / 100000);
      return value;
    }
  }, deltaY).catch(() => false);
}

export function validateOrderDetailPanel(snapshot, candidate = {}) {
  if (!snapshot || snapshot.visible !== true) {
    return { ok: false, identityHits: 0, schemaHits: 0, reason: "详情面板不可见" };
  }
  const text = cleanText([
    snapshot.text,
    snapshot.orderId && `主订单ID：${snapshot.orderId}`,
    snapshot.productName && `商品名称：${snapshot.productName}`,
    snapshot.orderTime && `下单时间：${snapshot.orderTime}`
  ].filter(Boolean).join("\n"));
  const identityHits = countOrderIdentityHits(text, candidate);
  const schemaHits = Number.isFinite(Number(snapshot.schemaHits))
    ? Number(snapshot.schemaHits)
    : countOrderDetailSchemaHits(text);
  const candidateOrderId = cleanText(candidate.orderId || "");
  const panelOrderId = cleanText(snapshot.orderId || extractMainOrderId(text));
  if (!text) {
    return { ok: false, identityHits, schemaHits, reason: "详情面板不可见" };
  }
  if (candidateOrderId && panelOrderId !== candidateOrderId) {
    return { ok: false, identityHits, schemaHits, reason: panelOrderId ? "详情订单ID不一致" : "详情缺少主订单ID" };
  }
  if (identityHits < 2) {
    return { ok: false, identityHits, schemaHits, reason: "订单身份信息不足" };
  }
  if (schemaHits < 2) {
    return { ok: false, identityHits, schemaHits, reason: "详情面板字段结构不足" };
  }
  return { ok: true, identityHits, schemaHits, reason: "" };
}

async function captureOrderDetailPanelProbe(page) {
  return await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const mask = (value) => normalize(value).replace(/[0-9]{7,20}/g, (token) => `${token.slice(0, 3)}***${token.slice(-2)}`);
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 120 && rect.height > 80
        && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const pathOf = (element) => {
      const parts = [];
      let current = element;
      while (current && current !== document.body && parts.length < 10) {
        const parent = current.parentElement;
        const siblings = parent ? [...parent.children].filter((item) => item.tagName === current.tagName) : [];
        const index = siblings.indexOf(current);
        parts.unshift(`${current.tagName.toLowerCase()}${current.id ? `#${current.id}` : ""}${siblings.length > 1 ? `:nth-of-type(${index + 1})` : ""}`);
        current = parent;
      }
      return parts.join(" > ");
    };
    const panels = [...document.body.querySelectorAll("aside, [role='dialog'], .el-drawer, .el-dialog, div, section")]
      .filter(visible)
      .map((element) => {
        const text = normalize(element.innerText || element.textContent || "");
        const rect = element.getBoundingClientRect();
        const schemaHits = ["主订单ID", "商品名称", "订单金额", "支付方式", "下单时间", "销售归属人"]
          .filter((label) => text.includes(label)).length;
        return {
          element,
          text,
          schemaHits,
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        };
      })
      .filter((item) => item.schemaHits >= 2)
      .sort((a, b) => b.schemaHits - a.schemaHits || b.rect.left - a.rect.left || a.rect.width * a.rect.height - b.rect.width * b.rect.height)
      .slice(0, 6)
      .map(({ element, text, schemaHits, rect }) => ({
        path: pathOf(element),
        tag: element.tagName,
        className: String(element.className || "").slice(0, 180),
        schemaHits,
        rect,
        fingerprint: mask(text).slice(0, 1600)
      }));
    return { capturedAt: Date.now(), panels };
  }).catch(() => ({ capturedAt: Date.now(), panels: [], error: "panel-probe-evaluate-failed" }));
}

export async function findOrderDetailTarget(page, candidate = {}) {
  return await page.evaluate((selected) => {
    const marker = "data-codex-order-detail-target";
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const compact = (value) => normalize(value).replace(/[\s.\-/:：]/g, "");
    const identityValues = [selected.orderId, selected.productName, selected.orderTime || selected.time]
      .map(normalize)
      .filter(Boolean);
    const identityHits = (text) => identityValues.reduce((hits, value) => {
      const normalizedText = normalize(text);
      return hits + (normalizedText.includes(value) || compact(normalizedText).includes(compact(value)) ? 1 : 0);
    }, 0);
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 12 && rect.height > 10 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const controlText = (el) => normalize(`${el.innerText || el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`);
    const isDetailControl = (el) => {
      const text = controlText(el);
      const data = `${el.getAttribute("data-action") || ""} ${el.getAttribute("data-testid") || ""} ${el.className || ""}`;
      return /^(?:查看)?(?:订单)?详情$/.test(text.replace(/\s+/g, ""))
        || /查看\s*详情|订单详情/.test(text)
        || /detail|详情/i.test(data);
    };
    const readOrderIds = (text) => [...new Set(
      [...normalize(text).matchAll(/(?:主订单|订单)\s*ID\s*[:：]?\s*([0-9A-Za-z_-]{1,40})/g)].map((match) => match[1])
    )];
    const findScopedCard = (control) => {
      let current = control.parentElement;
      while (current && current !== document.body) {
        const text = normalize(current.innerText || current.textContent || "");
        const orderIds = readOrderIds(text);
        if (selected.orderId && orderIds.length === 1 && orderIds[0] === String(selected.orderId)) return current;
        current = current.parentElement;
      }
      return null;
    };
    const controls = [...document.querySelectorAll("button, a, [role='button']")]
      .filter(visible)
      .filter(isDetailControl)
      .map((control) => {
        const card = findScopedCard(control);
        const cardText = normalize(card?.innerText || card?.textContent || "");
        const stable = /data-action|data-testid|data-.*detail/i.test(control.outerHTML)
          || /detail|详情/i.test(`${control.getAttribute("aria-label") || ""} ${control.getAttribute("title") || ""}`);
        return { control, card, cardText, stable, identityHits: identityHits(cardText) };
      })
      .filter((item) => item.card && (!selected.orderId || readOrderIds(item.cardText)[0] === String(selected.orderId)));
    if (!controls.length) return null;
    controls.sort((a, b) => b.identityHits - a.identityHits || Number(b.stable) - Number(a.stable));
    document.querySelectorAll(`[${marker}]`).forEach((el) => el.removeAttribute(marker));
    const target = controls[0];
    target.control.setAttribute(marker, "1");
    return {
      strategy: target.stable ? "stable-attribute-detail-control" : "scoped-card-detail-control",
      locator: `[${marker}='1']`,
      candidateCount: controls.length,
      identityHits: target.identityHits
    };
  }, candidate).catch(() => null);
}

async function clickOrderDetail(page, selected) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt === 0) {
      await setOrderScrollTop(page, Math.max(0, Number(selected.sourceScrollTop || 0)));
      await page.waitForTimeout(350).catch(() => {});
    }
    const target = await findOrderDetailTarget(page, selected);
    if (target?.identityHits >= 2) {
      const locator = page.locator(target.locator).first();
      if (await locator.isVisible().catch(() => false)
        && await locator.click({ force: true }).then(() => true).catch(() => false)) return true;
    }
    await scrollOrderPageBy(page, 720).catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
  }
  return false;
}

async function legacyClickOrderDetail(page, selected) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt === 0) {
      await setOrderScrollTop(page, Math.max(0, Number(selected.sourceScrollTop || 0)));
      await page.waitForTimeout(350).catch(() => {});
    }
    const prepared = await page.evaluate((selected) => {
      const anchor = findOrderAnchor(selected);
      if (!anchor) return { found: false };
      anchor.scrollIntoView({ block: "center", inline: "nearest" });
      return { found: true };

      function findOrderAnchor(selected) {
        const needles = [selected.orderId, selected.productName, selected.orderTime || selected.time].filter(Boolean);
        const elements = [...document.body.querySelectorAll("div, section, article, li, span, p")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
          .filter(({ rect, text }) => rect.width > 20 && rect.height > 10
            && needles.filter((needle) => text.includes(needle)).length >= 2)
          .sort((a, b) => {
            const aOrder = selected.orderId && a.text.includes(selected.orderId) ? 0 : 1;
            const bOrder = selected.orderId && b.text.includes(selected.orderId) ? 0 : 1;
            return aOrder - bOrder || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
          });
        return elements[0]?.el || null;
      }

      function normalize(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }
    }, selected).catch(() => ({ found: false }));
    if (!prepared?.found && attempt === 0) {
      await page.mouse.wheel(0, Math.max(700, Number(selected.index || 0) * 420)).catch(() => {});
    }
    await page.waitForTimeout(300).catch(() => {});

    const clicked = await page.evaluate((selected) => {
      const anchor = findOrderAnchor(selected);
      if (!anchor) return false;
      const card = findOrderCard(anchor, selected);
      const button = findDetailButtonInCard(card, anchor);
      if (!button) return false;
      button.scrollIntoView({ block: "center", inline: "center" });
      document.querySelectorAll("[data-codex-order-detail-link]").forEach((el) => el.removeAttribute("data-codex-order-detail-link"));
      button.setAttribute("data-codex-order-detail-link", "1");
      return true;

      function findOrderAnchor(selected) {
        const needles = [selected.orderId, selected.productName, selected.orderTime || selected.time].filter(Boolean);
        const elements = [...document.body.querySelectorAll("div, section, article, li, span, p")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
          .filter(({ rect, text }) => rect.width > 20 && rect.height > 10
            && needles.filter((needle) => text.includes(needle)).length >= 2)
          .sort((a, b) => {
            const aOrder = selected.orderId && a.text.includes(selected.orderId) ? 0 : 1;
            const bOrder = selected.orderId && b.text.includes(selected.orderId) ? 0 : 1;
            const aVisible = isVisibleRect(a.rect) ? 0 : 1;
            const bVisible = isVisibleRect(b.rect) ? 0 : 1;
            return aVisible - bVisible || aOrder - bOrder || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
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
          const plausible = rect.width > 300 && rect.height > 80 && rect.height < 1000;
          if (hasSelected && hasDetail && plausible) return current;
          current = current.parentElement;
        }
        return anchor;
      }

      function findDetailButtonInCard(card, anchor) {
        const anchorRect = anchor.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const buttonsInCard = [...card.querySelectorAll("button, a, span, div")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || ""), aria: `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}` }))
          .filter(({ rect, text, aria }) => /^(?:查看)?(?:订单)?详情$/.test(text.replace(/\s+/g, "")) || /detail|详情/i.test(aria))
          .filter(({ rect }) => rect.width > 20 && rect.height > 15 && isVisibleRect(rect))
          .sort((a, b) => Math.abs(centerY(a.rect) - centerY(anchorRect)) - Math.abs(centerY(b.rect) - centerY(anchorRect)));
        if (buttonsInCard[0]) return buttonsInCard[0].el;

        const allButtons = [...document.body.querySelectorAll("button, a, span, div")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || ""), aria: `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}` }))
          .filter(({ rect, text, aria }) => (/(查看\s*详情|订单详情|详情)/.test(text) || /detail|详情/i.test(aria)) && rect.width > 20 && rect.height > 15 && isVisibleRect(rect))
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
    }, selected).catch(() => false);
    if (clicked) {
      const button = page.locator("[data-codex-order-detail-link='1']").first();
      if (await button.isVisible().catch(() => false) && await button.click({ force: true }).then(() => true).catch(() => false)) return true;
    }
    await scrollOrderPageBy(page, 720).catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
  }
  // 虚拟列表在回退详情页后可能恢复到错误的滚动容器，最后从列表顶部重新扫描一次。
  await setOrderScrollTop(page, 0);
  for (let scan = 0; scan < 24; scan += 1) {
    const clicked = await page.evaluate((selected) => {
      const anchor = findOrderAnchor(selected);
      if (!anchor) return false;
      const card = findOrderCard(anchor, selected);
      const button = findDetailButtonInCard(card, anchor);
      if (!button) return false;
      button.scrollIntoView({ block: "center", inline: "center" });
      document.querySelectorAll("[data-codex-order-detail-link]").forEach((el) => el.removeAttribute("data-codex-order-detail-link"));
      button.setAttribute("data-codex-order-detail-link", "1");
      return true;

      function findOrderAnchor(selected) {
        const needles = [selected.orderId, selected.productName].filter(Boolean);
        return [...document.body.querySelectorAll("div, section, article, li, span, p")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
          .filter(({ rect, text }) => rect.width > 20 && rect.height > 10 && isVisibleRect(rect)
            && needles.some((needle) => text.includes(needle)))
          .sort((a, b) => {
            const aOrder = selected.orderId && a.text.includes(selected.orderId) ? 0 : 1;
            const bOrder = selected.orderId && b.text.includes(selected.orderId) ? 0 : 1;
            return aOrder - bOrder || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
          })[0]?.el || null;
      }

      function findOrderCard(anchor, selected) {
        let current = anchor;
        while (current && current !== document.body) {
          const rect = current.getBoundingClientRect();
          const text = normalize(current.innerText || current.textContent || "");
          const hasSelected = (selected.orderId && text.includes(selected.orderId))
            || (selected.productName && text.includes(selected.productName));
          if (hasSelected && /查看\s*详情|订单详情|详情/.test(text) && rect.width > 260 && rect.height > 60 && rect.height < 1200) return current;
          current = current.parentElement;
        }
        return anchor;
      }

      function findDetailButtonInCard(card, anchor) {
        const anchorY = anchor.getBoundingClientRect().top + anchor.getBoundingClientRect().height / 2;
        const candidates = [...card.querySelectorAll("button, a, [role='button'], span, div")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || ""), aria: `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}` }))
          .filter(({ rect, text, aria }) => isVisibleRect(rect) && rect.width > 20 && rect.height > 14
            && (/^(?:查看)?(?:订单)?详情$/.test(text.replace(/\s+/g, "")) || /detail|详情/i.test(aria)))
          .sort((a, b) => Math.abs((a.rect.top + a.rect.height / 2) - anchorY) - Math.abs((b.rect.top + b.rect.height / 2) - anchorY));
        return candidates[0]?.el || null;
      }

      function isVisibleRect(rect) {
        return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
      }

      function normalize(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }
    }).catch(() => false);
    if (clicked) {
      const button = page.locator("[data-codex-order-detail-link='1']").first();
      if (await button.isVisible().catch(() => false) && await button.click({ force: true }).then(() => true).catch(() => false)) return true;
    }
    const moved = await scrollOrderPageBy(page, 720);
    if (!moved) break;
    await page.waitForTimeout(280).catch(() => {});
  }
  return false;
}

async function clickRefundRecord(page, selected) {
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
            return aOrder - bOrder || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
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

    const clicked = await page.evaluate((selected) => {
      const anchor = findOrderAnchor(selected);
      if (!anchor) return false;
      const card = findOrderCard(anchor, selected);
      const button = findRefundButtonInCard(card, anchor);
      if (!button) return false;
      button.scrollIntoView({ block: "center", inline: "center" });
      document.querySelectorAll("[data-codex-refund-link]").forEach((el) => el.removeAttribute("data-codex-refund-link"));
      button.setAttribute("data-codex-refund-link", "1");
      return true;

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
            return aVisible - bVisible || aOrder - bOrder || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
          });
        return elements[0]?.el || null;
      }

      function findOrderCard(anchor, selected) {
        let current = anchor;
        while (current && current !== document.body) {
          const rect = current.getBoundingClientRect();
          const text = normalize(current.innerText || current.textContent || "");
          const hasSelected = (selected.orderId && text.includes(selected.orderId)) || (selected.productName && text.includes(selected.productName));
          const hasRefund = /退款记录/.test(text);
          const plausible = rect.width > 300 && rect.height > 80 && rect.height < 1000;
          if (hasSelected && hasRefund && plausible) return current;
          current = current.parentElement;
        }
        return anchor;
      }

      function findRefundButtonInCard(card, anchor) {
        const anchorRect = anchor.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const buttonsInCard = [...card.querySelectorAll("button, a, span, div")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "").replace(/\s+/g, "") }))
          .filter(({ rect, text }) => text === "退款记录" && rect.width > 20 && rect.height > 15)
          .sort((a, b) => Math.abs(centerY(a.rect) - centerY(anchorRect)) - Math.abs(centerY(b.rect) - centerY(anchorRect)));
        if (buttonsInCard[0]) return buttonsInCard[0].el;

        const allButtons = [...document.body.querySelectorAll("button, a, span, div")]
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "").replace(/\s+/g, "") }))
          .filter(({ rect, text }) => text === "退款记录" && rect.width > 20 && rect.height > 15)
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
    }, selected).catch(() => false);
    if (clicked) {
      const button = page.locator("[data-codex-refund-link='1']").first();
      if (await button.isVisible().catch(() => false) && await button.click({ force: true }).then(() => true).catch(() => false)) return true;
    }
    await page.mouse.wheel(0, 260).catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
  }
  return false;
}

async function waitForRefundRecord(page, selected = {}, maxWaitMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const matched = await page.evaluate((selected) => {
      const panel = findRefundPanel();
      if (!panel) return false;
      const text = normalize(panel.innerText || panel.textContent || "");
      const identityMatched = (selected.orderId && text.includes(String(selected.orderId)))
        || (selected.productName && text.includes(String(selected.productName)));
      if ((selected.orderId || selected.productName) && !identityMatched) return false;
      return /退款状态|申请退款金额|申请时间|退款时间|企微审核状态|是否保留听课权限/.test(text);

      function findRefundPanel() {
        const panels = [...document.body.querySelectorAll("div, section, aside, [role='dialog']")]
          .filter(visible)
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
          .filter((item) => item.rect.left > window.innerWidth * 0.25
            && /订单ID|主订单ID/.test(item.text)
            && /退款状态|申请退款金额|申请时间|退款时间|企微审核状态|是否保留听课权限/.test(item.text))
          .sort((a, b) => b.rect.left - a.rect.left || b.rect.width * b.rect.height - a.rect.width * a.rect.height);
        return panels[0]?.el || null;
      }

      function visible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.top < window.innerHeight
          && rect.right > 0 && rect.left < window.innerWidth
          && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
      }

      function normalize(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }
    }, selected).catch(() => false);
    if (matched) return true;
    await page.waitForTimeout(250).catch(() => {});
  }
  return false;
}

async function extractRefundRecord(page, selected = {}) {
  return await page.evaluate((selected) => {
    const panel = findRefundPanel(selected);
    if (!panel) return { found: false };
    const text = normalize(panel.innerText || panel.textContent || "");
    const stops = ["审核编号", "申请退款金额", "申请人", "退款原因", "退款状态", "是否保留听课权限", "申请时间", "企微审核状态", "企微审核人", "最终完成审核时间", "退款时间", "订单ID", "订单金额"];
    const orderId = extractValue(text, ["订单ID", "主订单ID"], stops.filter((item) => !["订单ID", "主订单ID"].includes(item)));
    if (selected.orderId && orderId && !text.includes(String(selected.orderId))) return { found: false };
    const data = {
      found: true,
      orderId: clean(orderId || selected.orderId || ""),
      refundAmount: extractValue(text, ["申请退款金额"], stops.filter((item) => item !== "申请退款金额")),
      keepListenPermission: extractValue(text, ["是否保留听课权限"], stops.filter((item) => item !== "是否保留听课权限")),
      applyTime: extractValue(text, ["申请时间"], stops.filter((item) => item !== "申请时间")),
      weworkAuditStatus: extractValue(text, ["企微审核状态"], stops.filter((item) => item !== "企微审核状态")),
      refundStatus: extractValue(text, ["退款状态"], stops.filter((item) => item !== "退款状态")),
      refundTime: extractValue(text, ["退款时间"], stops.filter((item) => item !== "退款时间")),
      rawText: text.slice(0, 2000)
    };
    data.text = [
      `申请退款金额：${data.refundAmount || ""}`,
      `是否保留听课权限：${data.keepListenPermission || ""}`,
      `申请时间：${data.applyTime || ""}`,
      `企微审核状态：${data.weworkAuditStatus || ""}`,
      `退款状态：${data.refundStatus || ""}`,
      `退款时间：${data.refundTime || ""}`
    ].join("\n");
    return data;

    function findRefundPanel(selected) {
      const panels = [...document.body.querySelectorAll("div, section, aside, [role='dialog']")]
        .filter(visible)
        .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
        .filter((item) => item.rect.left > window.innerWidth * 0.25
          && /订单ID|主订单ID/.test(item.text)
          && /退款状态|申请退款金额|申请时间|退款时间|企微审核状态|是否保留听课权限/.test(item.text))
        .map((item) => {
          let score = 0;
          if (selected.orderId && item.text.includes(String(selected.orderId))) score += 100;
          if (/申请退款金额/.test(item.text)) score += 20;
          if (/退款状态/.test(item.text)) score += 20;
          score += Math.min(30, item.rect.left / 50);
          return { ...item, score };
        })
        .sort((a, b) => b.score - a.score || b.rect.left - a.rect.left || b.rect.width * b.rect.height - a.rect.width * a.rect.height);
      const best = panels[0];
      if (best && selected.orderId && !best.text.includes(String(selected.orderId))) return null;
      return best?.el || null;
    }

    function extractValue(text, labels, stops) {
      for (const label of labels) {
        for (const token of [`${label}：`, `${label}:`]) {
          const found = text.indexOf(token);
          if (found < 0) continue;
          const start = found + token.length;
          let end = text.length;
          for (const stop of stops) {
            const next = findStopPositions(text, stop, start).sort((a, b) => a - b)[0];
            if (next !== undefined && next < end) end = next;
          }
          return trimValue(text.slice(start, end));
        }
      }
      return "";
    }

    function findStopPositions(text, stop, start) {
      const escaped = stop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?:^|\\s)${escaped}(?:[:：\\s]|$)`, "g");
      const positions = [];
      for (const token of [`${stop}：`, `${stop}:`]) {
        const index = text.indexOf(token, start);
        if (index >= 0) positions.push(index);
      }
      pattern.lastIndex = start;
      let match = pattern.exec(text);
      while (match) {
        positions.push(match.index + (match[0].startsWith(" ") ? 1 : 0));
        match = pattern.exec(text);
      }
      return positions.filter((index) => index >= start);
    }

    function trimValue(value) {
      return clean(value).replace(/[，,。；;]+$/, "");
    }

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }

    function normalize(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
  }, selected).catch(() => ({ found: false }));
}

async function waitForOrderDetail(page, selected = {}, maxWaitMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const snapshot = await readOrderDetailSnapshot(page, selected);
    if (validateOrderDetailPanel(snapshot, selected).ok) return true;
    await page.waitForTimeout(250).catch(() => {});
  }
  return false;
}

export async function captureOpenedOrderDetail({
  sourcePage,
  candidate = {},
  beforePages = new Set(),
  beforeUrl = "",
  popupPromise = null,
  maxWaitMs = 8000
}) {
  const context = sourcePage.context();
  const startedAt = Date.now();
  let lastFailure = null;
  let observedPopup = null;
  popupPromise?.then((target) => {
    observedPopup = target;
  }).catch(() => {});
  while (Date.now() - startedAt < maxWaitMs) {
    const newPages = [...new Set([observedPopup, ...context.pages()])]
      .filter((item) => item && !beforePages.has(item) && !item.isClosed());
    for (const targetPage of newPages) {
      await targetPage.waitForLoadState?.("domcontentloaded", { timeout: 1200 }).catch(() => {});
      const standalone = await readStandaloneOrderDetailSnapshot(targetPage, candidate);
      const validation = validateStandaloneOrderDetail(standalone, candidate);
      if (validation.ok) {
        const snapshot = snapshotFromStandaloneDetail(standalone);
        const targetUrl = targetPage.url();
        await targetPage.close().catch(() => {});
        return { opened: true, mode: "popup", snapshot, validation, targetUrl };
      }
      if (standalone.schemaHits >= 2 || standalone.mainOrderId) {
        lastFailure = {
          opened: false,
          mode: "popup",
          validation,
          targetUrl: targetPage.url(),
          error: validation.reason
        };
        await targetPage.close().catch(() => {});
        return lastFailure;
      }
    }

    const currentUrl = sourcePage.url();
    if (currentUrl && beforeUrl && currentUrl !== beforeUrl) {
      const standalone = await readStandaloneOrderDetailSnapshot(sourcePage, candidate);
      const validation = validateStandaloneOrderDetail(standalone, candidate);
      if (validation.ok) {
        const snapshot = snapshotFromStandaloneDetail(standalone);
        const targetUrl = currentUrl;
        await sourcePage.goBack({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
        return { opened: true, mode: "same-tab", snapshot, validation, targetUrl };
      }
      if (standalone.schemaHits >= 2 || standalone.mainOrderId) {
        lastFailure = {
          opened: false,
          mode: "same-tab",
          validation,
          targetUrl: currentUrl,
          error: validation.reason
        };
        await sourcePage.goBack({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
        return lastFailure;
      }
    }

    const panelSnapshot = await readOrderDetailSnapshot(sourcePage, candidate);
    const panelValidation = validateOrderDetailPanel(panelSnapshot, candidate);
    if (panelValidation.ok) {
      const snapshot = await extractOrderDetail(sourcePage, candidate);
      snapshot.detailPanelValidation = panelValidation;
      return {
        opened: Boolean(snapshot.matched),
        mode: "panel",
        snapshot,
        validation: panelValidation,
        targetUrl: sourcePage.url(),
        error: snapshot.matched ? "" : "详情面板字段解析失败"
      };
    }
    await sourcePage.waitForTimeout(250).catch(() => {});
  }
  return lastFailure || {
    opened: false,
    mode: "",
    validation: { ok: false, reason: "详情按钮点击后未出现独立详情页或可识别详情面板" },
    targetUrl: sourcePage.url(),
    error: "详情按钮点击后未出现独立详情页或可识别详情面板"
  };
}

export async function readStandaloneOrderDetailSnapshot(page, candidate = {}) {
  return page.evaluate(({ aliases, selected }) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const normalizeLabel = (value) => normalize(value).replace(/[：:]\s*$/, "");
    const aliasLookup = new Map();
    for (const [key, labels] of Object.entries(aliases)) {
      for (const label of labels) aliasLookup.set(label, key);
    }
    const visible = (element) => {
      if (!element || !element.getBoundingClientRect) return false;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      for (let current = element; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0) return false;
      }
      return true;
    };
    const pageText = normalize(document.body.innerText || document.body.textContent || "");
    const sectionHits = ["订单信息", "渠道信息", "商品信息", "用户信息"]
      .filter((label) => pageText.includes(label)).length;
    const expectedId = normalize(selected.orderId || "");
    const rootCandidates = [...document.querySelectorAll("main, article, section, div, body")]
      .filter(visible)
      .map((element) => {
        const text = normalize(element.innerText || element.textContent || "");
        const rect = element.getBoundingClientRect();
        const schemaHits = ["订单信息", "商品信息", "用户信息", "主订单ID", "商品名称"]
          .filter((label) => text.includes(label)).length;
        const identity = expectedId && text.includes(expectedId) ? 1 : 0;
        return { element, text, schemaHits, identity, area: rect.width * rect.height };
      })
      .filter((item) => item.schemaHits >= 3)
      .sort((a, b) => b.identity - a.identity || b.schemaHits - a.schemaHits || a.area - b.area);
    const root = rootCandidates[0]?.element || document.body;
    const rootText = normalize(root.innerText || root.textContent || "");
    const pairs = [];
    const seen = new Set();
    const addPair = (label, value, source) => {
      const normalizedLabel = normalizeLabel(label);
      const key = aliasLookup.get(normalizedLabel);
      const normalizedValue = normalize(value).replace(/^[-：:\s]+/, "");
      if (!key || !normalizedValue || normalizedValue === normalizedLabel) return;
      const signature = `${key}\u0000${normalizedValue}`;
      if (seen.has(signature)) return;
      seen.add(signature);
      pairs.push({ key, label: normalizedLabel, value: normalizedValue, source });
    };
    const findNearbyValue = (labelElement, label) => {
      const ownText = normalize(labelElement.innerText || labelElement.textContent || "");
      const inline = ownText.match(new RegExp(`^${escapeRegExp(label)}\\s*[:：]\\s*(.+)$`));
      if (inline?.[1]) return inline[1];
      const directSibling = labelElement.nextElementSibling;
      if (directSibling && visible(directSibling)) {
        const value = normalize(directSibling.innerText || directSibling.textContent || "");
        if (value && !aliasLookup.has(normalizeLabel(value))) return value;
      }
      const parent = labelElement.parentElement;
      if (parent) {
        const children = [...parent.children].filter(visible);
        const index = children.indexOf(labelElement);
        for (let offset = index + 1; offset < children.length; offset += 1) {
          const value = normalize(children[offset].innerText || children[offset].textContent || "");
          if (!value) continue;
          if (aliasLookup.has(normalizeLabel(value))) break;
          return value;
        }
        const parentText = normalize(parent.innerText || parent.textContent || "");
        const parentInline = parentText.match(new RegExp(`${escapeRegExp(label)}\\s*[:：]?\\s+(.+)$`));
        if (parentInline?.[1] && !aliasLookup.has(normalizeLabel(parentInline[1]))) return parentInline[1];
      }
      return "";
    };
    for (const element of root.querySelectorAll("*")) {
      if (!visible(element)) continue;
      const text = normalize(element.innerText || element.textContent || "");
      if (!text || text.length > 180) continue;
      for (const label of aliasLookup.keys()) {
        const nestedLabel = [...element.children].some((child) => normalizeLabel(child.innerText || child.textContent || "") === label);
        if (nestedLabel) continue;
        if (normalizeLabel(text) === label || new RegExp(`^${escapeRegExp(label)}\\s*[:：]`).test(text)) {
          addPair(label, findNearbyValue(element, label), "standalone-detail-dom");
          break;
        }
      }
    }
    const fields = {};
    for (const pair of pairs) {
      if (!fields[pair.key]) fields[pair.key] = pair.value;
    }
    return {
      visible: true,
      standalone: true,
      text: rootText.slice(0, 5000),
      sectionHits,
      schemaHits: rootCandidates[0]?.schemaHits || 0,
      mainOrderId: fields.mainOrderId || "",
      fields,
      pairs: pairs.slice(0, 200)
    };

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }, { aliases: ORDER_DETAIL_FIELD_ALIASES, selected: candidate }).catch(() => ({
    visible: false,
    standalone: false,
    text: "",
    sectionHits: 0,
    schemaHits: 0,
    mainOrderId: "",
    fields: {},
    pairs: []
  }));
}

function validateStandaloneOrderDetail(snapshot = {}, candidate = {}) {
  const expected = cleanText(candidate.orderId || "");
  const actual = cleanText(snapshot.mainOrderId || snapshot.fields?.mainOrderId || "");
  if (!snapshot.visible || snapshot.schemaHits < 3) {
    return { ok: false, reason: "独立详情页结构未加载完成", expectedOrderId: maskForTrace(expected), actualOrderId: "" };
  }
  if (!actual) {
    return { ok: false, reason: "详情页缺少主订单ID", expectedOrderId: maskForTrace(expected), actualOrderId: "" };
  }
  if (expected && actual !== expected) {
    return {
      ok: false,
      reason: "详情页主订单ID与列表订单ID不一致",
      expectedOrderId: maskForTrace(expected),
      actualOrderId: maskForTrace(actual)
    };
  }
  return {
    ok: true,
    reason: "独立详情页订单身份校验通过",
    expectedOrderId: maskForTrace(expected),
    actualOrderId: maskForTrace(actual)
  };
}

function snapshotFromStandaloneDetail(snapshot = {}) {
  const detail = normalizeOrderDetailData(snapshot.fields || {});
  const amountText = cleanText(detail.amountText || "");
  const pairs = (snapshot.pairs || []).map((pair) => ({
    label: pair.label,
    value: pair.value,
    source: pair.source || "standalone-detail-dom"
  }));
  return {
    visible: true,
    text: cleanText(snapshot.text || ""),
    pairs,
    trainingName: cleanText(detail.trainingName || ""),
    productName: cleanText(detail.productName || ""),
    category: cleanText(detail.category || ""),
    startTime: cleanText(detail.orderTime || detail.startTime || ""),
    salesOwner: cleanText(detail.salesOwner || ""),
    mainOrderId: cleanText(detail.mainOrderId || ""),
    matched: true,
    schemaHits: Number(snapshot.schemaHits || 0),
    detail: {
      ...detail,
      amountText,
      amount: parseOrderAmount(amountText)
    }
  };
}

function normalizeOrderDetailData(value = {}) {
  const normalized = {};
  for (const key of Object.keys(ORDER_DETAIL_FIELD_ALIASES)) normalized[key] = cleanText(value?.[key] || "");
  if (typeof value.amount === "number" && Number.isFinite(value.amount)) normalized.amount = value.amount;
  else normalized.amount = parseOrderAmount(normalized.amountText);
  return normalized;
}

function parseOrderAmount(value) {
  const match = cleanText(value || "").replace(/,/g, "").match(/-?\d+(?:\.\d{1,2})?/);
  return match ? Number(match[0]) : null;
}

function sanitizeUrlForTrace(value) {
  try {
    const parsed = new URL(String(value || ""));
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

async function legacyWaitForOrderDetail(page, selected = {}, maxWaitMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const matched = await page.evaluate((selected) => {
      const detail = findOrderDetailPanel();
      if (!detail) return false;
      const text = normalize(detail.innerText || detail.textContent || "");
      const detailSignals = [
        /订单详情/.test(text),
        /订单信息/.test(text),
        /商品信息/.test(text),
        /付款信息|支付金额/.test(text),
        /主订单ID|订单ID/.test(text),
        /商品名称/.test(text),
        /所属品类/.test(text),
        /销售归属人/.test(text)
      ].filter(Boolean).length;
      const hasDetailShape = detailSignals >= 2;
      if (!hasDetailShape) return false;
      const identityMatched = (selected.orderId && text.includes(String(selected.orderId)))
        || (selected.productName && text.includes(String(selected.productName)));
      if ((selected.orderId || selected.productName) && !identityMatched) return false;
      return true;

      function findOrderDetailPanel() {
        const panels = [...document.body.querySelectorAll("div, section, aside, [role='dialog']")]
          .filter(visible)
          .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
          .filter((item) => item.rect.left > window.innerWidth * 0.34
            && (!(selected.orderId || selected.productName)
              || (selected.orderId && item.text.includes(String(selected.orderId)))
              || (selected.productName && item.text.includes(String(selected.productName))))
            && detailSignalCount(item.text) >= 2)
          .sort((a, b) => b.rect.left - a.rect.left || b.rect.width * b.rect.height - a.rect.width * a.rect.height);
        return panels[0]?.el || null;
      }

      function detailSignalCount(text) {
        return [
          /订单详情/.test(text),
          /订单信息/.test(text),
          /商品信息/.test(text),
          /付款信息|支付金额/.test(text),
          /主订单ID|订单ID/.test(text),
          /商品名称/.test(text),
          /所属品类/.test(text),
          /销售归属人/.test(text)
        ].filter(Boolean).length;
      }

      function visible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.top < window.innerHeight
          && rect.right > 0 && rect.left < window.innerWidth
          && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
      }

      function normalize(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }
    }, selected).catch(() => false);
    if (matched) return true;
    await page.waitForTimeout(250).catch(() => {});
  }
  return false;
}

async function probeOrderDetailOpen(page, selected = {}) {
  return await page.evaluate((selected) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 10 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const needles = [selected.orderId, selected.productName].filter(Boolean);
    const anchors = [...document.querySelectorAll("div, section, article, li, span, p")]
      .filter(visible)
      .map((el) => normalize(el.innerText || el.textContent || ""))
      .filter((text) => needles.some((needle) => text.includes(needle)));
    const detailButtons = [...document.querySelectorAll("button, a, [role='button'], span, div")]
      .filter(visible)
      .map((el) => normalize(el.innerText || el.textContent || ""))
      .filter((text) => /查看\s*详情|订单详情|详情/.test(text));
    return {
      reason: anchors.length === 0
        ? "未找到订单行"
        : detailButtons.length === 0
          ? "订单行存在但未找到详情按钮"
          : "详情按钮点击后未出现可识别详情面板",
      anchorCount: anchors.length,
      detailButtonCount: detailButtons.length,
      bodySnippet: normalize(document.body.innerText || "").slice(0, 1200)
    };
  }, selected).catch((error) => ({
    reason: `DOM探针失败：${error.message || String(error)}`,
    anchorCount: 0,
    detailButtonCount: 0,
    bodySnippet: ""
  }));
}

async function extractOrderDetail(page, selected = {}) {
  const panelSnapshot = await readOrderDetailSnapshot(page, selected);
  if (!validateOrderDetailPanel(panelSnapshot, selected).ok) return createEmptyOrderDetailSnapshot();
  return await page.evaluate(({ selected, strictPanelText }) => {
    const panel = { innerText: strictPanelText };
    const text = String(strictPanelText || "").replace(/\r/g, "").trim();
    const compactText = text.replace(/[ \t]+/g, " ");
    const detailText = extractLikelyDetailText(compactText);
    const commonStops = ["正式营ID", "体验营ID", "训练营ID", "营ID", "商品ID", "商品名称", "所在期数", "开营时间", "下单时间", "支付时间", "支付方式", "订单状态", "订单类型", "支付金额", "训练营名称", "营名称", "所属品类", "课程品类", "品类名称", "销售归属人", "所属部门", "分销人ID", "分销人名称", "退款类型", "退款金额", "是否代付", "是否换营", "订单信息", "商品信息", "用户信息", "用户ID", "用户昵称", "手机号", "订单链接", "下单链接", "渠道信息", "渠道一级类型", "渠道二级类型", "渠道三级类型"];
    const trainingName = extractValue(detailText, ["训练营名称", "营名称"], commonStops.filter((item) => !["训练营名称", "营名称"].includes(item)));
    const productName = extractValue(detailText, ["商品名称"], commonStops.filter((item) => item !== "商品名称"));
    const category = extractValue(detailText, ["所属品类", "课程品类", "品类名称"], commonStops.filter((item) => !["所属品类", "课程品类", "品类名称"].includes(item)));
    const startTime = extractValue(detailText, ["支付时间", "下单时间"], commonStops.filter((item) => !["支付时间", "下单时间"].includes(item)));
    const salesOwner = extractValue(detailText, ["销售归属人"], commonStops.filter((item) => item !== "销售归属人"));
    const mainOrderId = extractValue(detailText, ["主订单ID", "订单ID"], commonStops.filter((item) => !["主订单ID", "订单ID"].includes(item)));
    const identityValues = [selected.orderId, selected.productName, selected.orderTime || selected.time]
      .map((value) => clean(value))
      .filter(Boolean);
    const compactDetailText = detailText.replace(/[\s.\-/:：]/g, "");
    const identityHits = identityValues.reduce((hits, value) => hits + (
      detailText.includes(value) || compactDetailText.includes(value.replace(/[\s.\-/:：]/g, "")) ? 1 : 0
    ), 0);
    const matched = Boolean(panel && identityHits >= 2);
    const pairs = [];
    for (const [label, value] of [["所属品类", category], ["商品名称", productName], ["支付时间", startTime], ["训练营名称", trainingName], ["销售归属人", salesOwner]]) {
      if (value) pairs.push({ label, value, source: "order-detail-dom" });
    }
    return {
      text: detailText.slice(0, 3500),
      trainingName: clean(trainingName),
      productName: clean(productName),
      category: clean(category),
      startTime: clean(startTime),
      salesOwner: clean(salesOwner),
      mainOrderId: clean(mainOrderId),
      matched,
      pairs,
      hasTrainingName: /训练营名称|营名称/.test(detailText),
      hasCategory: /所属品类|课程品类|品类名称/.test(detailText)
    };

    function findOrderDetailPanel(selected) {
      const panels = [...document.body.querySelectorAll("div, section, aside, [role='dialog']")]
        .filter(visible)
        .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
        .filter((item) => item.rect.left > window.innerWidth * 0.34
          && (!(selected.orderId || selected.productName)
            || (selected.orderId && item.text.includes(String(selected.orderId)))
            || (selected.productName && item.text.includes(String(selected.productName))))
          && detailSignalCount(item.text) >= 2)
        .map((item) => {
          let score = 0;
          if (selected.orderId && item.text.includes(String(selected.orderId))) score += 100;
          if (/商品信息/.test(item.text)) score += 20;
          if (/付款信息/.test(item.text)) score += 10;
          score += Math.min(30, item.rect.left / 50);
          return { ...item, score };
        })
        .sort((a, b) => b.score - a.score || b.rect.left - a.rect.left || b.rect.width * b.rect.height - a.rect.width * a.rect.height);
      const best = panels[0];
      if (best && (selected.orderId || selected.productName)
        && !(selected.orderId && best.text.includes(String(selected.orderId)))
        && !(selected.productName && best.text.includes(String(selected.productName)))) return null;
      return best?.el || null;
    }

    function detailSignalCount(text) {
      return [
        /订单详情/.test(text),
        /订单信息/.test(text),
        /商品信息/.test(text),
        /付款信息|支付金额/.test(text),
        /主订单ID|订单ID/.test(text),
        /商品名称/.test(text),
        /所属品类/.test(text),
        /销售归属人/.test(text)
      ].filter(Boolean).length;
    }

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }

    function normalize(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function extractLikelyDetailText(text) {
      const productInfoIndexes = indexesOf(text, "商品信息");
      for (let i = productInfoIndexes.length - 1; i >= 0; i -= 1) {
        const index = productInfoIndexes[i];
        const before = text.slice(Math.max(0, index - 800), index);
        const after = text.slice(index, index + 2800);
        if (/订单ID|下单时间|订单状态|支付金额|支付方式/.test(before + after)
          && /(所属品类|训练营名称|商品名称|正式营ID|体验营ID)/.test(after)) {
          return clean(`${before.slice(-600)} ${after}`);
        }
      }
      const orderInfoIndexes = indexesOf(text, "订单信息");
      for (let i = orderInfoIndexes.length - 1; i >= 0; i -= 1) {
        const index = orderInfoIndexes[i];
        const slice = text.slice(index, index + 3400);
        if (/商品信息/.test(slice) && /(所属品类|训练营名称|商品名称|正式营ID|体验营ID)/.test(slice)) return clean(slice);
      }
      return clean(text);
    }

    function indexesOf(text, needle) {
      const indexes = [];
      let index = text.indexOf(needle);
      while (index >= 0) {
        indexes.push(index);
        index = text.indexOf(needle, index + needle.length);
      }
      return indexes;
    }

    function extractValue(text, labels, stops) {
      for (const label of labels) {
        for (const token of [`${label}：`, `${label}:`]) {
          const found = text.indexOf(token);
          if (found < 0) continue;
          const start = found + token.length;
          let end = text.length;
          for (const stop of stops) {
            const next = findStopPositions(text, stop, start).sort((a, b) => a - b)[0];
            if (next !== undefined && next < end) end = next;
          }
          return trimLabelValue(text.slice(start, end));
        }
      }
      return "";
    }

    function findStopPositions(text, stop, start) {
      const escaped = stop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?:^|\\s)${escaped}(?:[:：\\s]|$)`, "g");
      const positions = [];
      for (const token of [`${stop}：`, `${stop}:`]) {
        const index = text.indexOf(token, start);
        if (index >= 0) positions.push(index);
      }
      pattern.lastIndex = start;
      let match = pattern.exec(text);
      while (match) {
        positions.push(match.index + (match[0].startsWith(" ") ? 1 : 0));
        match = pattern.exec(text);
      }
      return positions.filter((index) => index >= start);
    }

    function trimLabelValue(value) {
      let text = clean(value);
      const labelPattern = /(正式营ID|体验营ID|训练营ID|营ID|商品ID|商品名称|所在期数|开营时间|训练营名称|营名称|销售归属人|所属部门|分销人ID|分销人名称|退款类型|退款金额|是否代付|是否换营|订单信息|商品信息|用户信息|用户ID|用户昵称|手机号|订单链接|下单链接|渠道信息|渠道一级类型|渠道二级类型|渠道三级类型)(?:[:：\s]|$)/;
      const match = text.match(labelPattern);
      if (match?.index > 0) text = text.slice(0, match.index);
      return clean(text);
    }

    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").replace(/[，,。；;]+$/, "").trim();
    }
  }, { selected, strictPanelText: panelSnapshot.text }).catch(() => createEmptyOrderDetailSnapshot());
}

export async function readOrderDetailSnapshot(page, candidate = {}) {
  return await page.evaluate((selected) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const compact = (value) => normalize(value).replace(/[\s.\-/:：]/g, "");
    const identityValues = [selected.orderId, selected.productName, selected.orderTime || selected.time]
      .map(normalize)
      .filter(Boolean);
    const identityHits = (text) => identityValues.reduce((hits, value) => hits + (
      normalize(text).includes(value) || compact(text).includes(compact(value)) ? 1 : 0
    ), 0);
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      if (!(rect.width > 20 && rect.height > 20 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth)) return false;
      for (let current = el; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        const opacity = Number.parseFloat(style.opacity || "1");
        if (style.display === "none" || style.visibility === "hidden" || opacity <= 0) return false;
      }
      return true;
    };
    const hasDetailPanelBoundary = (el, text) => {
      const className = String(el.className || "");
      const role = el.getAttribute("role") || "";
      const explicitMarker = el.getAttribute("data-order-detail-panel") !== null
        || el.getAttribute("data-order-detail") !== null;
      const isListContainer = /(?:^|\s)(?:order[-_]?detail[-_]?list|modal[-_]?list)(?:\s|$)/i.test(className);
      if (isListContainer) return false;
      const explicitBoundary = role === "dialog" || explicitMarker
        || /(?:dialog|drawer|modal|detail[-_]?panel|order[-_]?detail)/i.test(className);
      const hasDetailTitle = /订单详情|订单信息/.test(text);
      const containsOrderList = /课程订单|查看详情/.test(text);
      return explicitBoundary || (hasDetailTitle && !containsOrderList);
    };
    const scoreContainer = (el) => {
      const text = normalize(el.innerText || el.textContent || "");
      if (!text) return null;
      const orderIds = [...new Set(
        [...text.matchAll(/(?:主订单|订单)\s*ID\s*[:：]?\s*([0-9A-Za-z_-]{1,40})/g)].map((match) => match[1])
      )];
      if (selected.orderId && (orderIds.length !== 1 || orderIds[0] !== String(selected.orderId))) return null;
      const hits = [
        /订单信息/.test(text),
        /商品信息/.test(text),
        /用户信息/.test(text),
        /所属品类\s*[:：]/.test(text),
        /开营时间\s*[:：]/.test(text),
        /训练营名称\s*[:：]/.test(text),
        /订单ID\s*[:：]/.test(text)
      ].filter(Boolean).length;
      if (hits < 2 || identityHits(text) < 2) return null;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const zIndex = Number.parseInt(style.zIndex || "0", 10) || 0;
      const area = rect.width * rect.height;
      return { el, text, rect, hits, identityHits: identityHits(text), orderId: orderIds[0] || "", area, zIndex };
    };

    const preferred = [
      ...document.querySelectorAll(".el-dialog, .el-drawer, .ant-modal, .ant-drawer, [role='dialog'], .modal, .drawer, [data-order-detail-panel], .order-detail-panel")
    ].filter(visible).map(scoreContainer).filter(Boolean);
    const fallback = [...document.body.querySelectorAll("div, section, aside")]
      .filter(visible)
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(el.innerText || el.textContent || "");
        return rect.left > window.innerWidth * 0.25
          && hasDetailPanelBoundary(el, text)
          && (/订单详情|订单信息/.test(text))
          && !/课程订单\s+.*查看详情/.test(text);
      })
      .map(scoreContainer)
      .filter(Boolean);
    const target = [...preferred, ...fallback]
      .sort((a, b) => b.identityHits - a.identityHits || b.hits - a.hits || b.zIndex - a.zIndex || a.area - b.area)[0];
    if (!target) return { scoped: false, visible: false, text: "", schemaHits: 0, pairs: [] };
    const root = target.el;
    const text = normalize(root.innerText || root.textContent || "");
    const pairs = [];
    const pairPattern = /([^：:\s]{2,12})\s*[:：]\s*([^：:]+?)(?=\s+[^：:\s]{2,12}\s*[:：]|$)/g;
    let match;
    while ((match = pairPattern.exec(text))) {
      const label = normalize(match[1]);
      const value = normalize(match[2]);
      if (label && value) pairs.push({ label, value, source: "order-detail-scope" });
    }
    return {
      scoped: true,
      visible: true,
      text,
      orderId: target.orderId,
      schemaHits: target?.hits || 0,
      pairs: pairs.slice(0, 200)
    };
  }, candidate).catch(() => ({ scoped: false, visible: false, text: "", schemaHits: 0, pairs: [] }));
}

function createEmptyOrderDetailSnapshot() {
  return {
    visible: false,
    text: "",
    pairs: [],
    trainingName: "",
    productName: "",
    category: "",
    startTime: "",
    salesOwner: "",
    mainOrderId: "",
    matched: false,
    schemaHits: 0
  };
}

function countOrderIdentityHits(text, candidate = {}) {
  const source = cleanText(text);
  const compactSource = source.replace(/[\s.\-/:：]/g, "");
  const values = [candidate.orderId, candidate.productName, candidate.orderTime || candidate.time]
    .map((value) => cleanText(value))
    .filter(Boolean);
  return values.reduce((hits, value) => hits + (
    source.includes(value) || compactSource.includes(value.replace(/[\s.\-/:：]/g, "")) ? 1 : 0
  ), 0);
}

function extractMainOrderId(text) {
  return cleanText(text).match(/(?:主订单|订单)\s*ID\s*[:：]?\s*([0-9A-Za-z_-]{1,40})/)?.[1] || "";
}

function countOrderDetailSchemaHits(text) {
  return [
    /订单详情/.test(text),
    /订单信息/.test(text),
    /商品信息/.test(text),
    /付款信息|支付金额/.test(text),
    /主订单ID|订单ID/.test(text),
    /商品名称/.test(text),
    /所属品类/.test(text),
    /销售归属人/.test(text)
  ].filter(Boolean).length;
}

async function countVisibleOrderDetailButtons(page) {
  return await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.body.querySelectorAll("button, a, span, div")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "查看详情" && item.rect.top > 80)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
      .length;
  }).catch(() => 0);
}

async function clickVisibleOrderDetailByIndex(page, index) {
  const marked = await page.evaluate((targetIndex) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const buttons = [...document.body.querySelectorAll("button, a, span, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "查看详情" && item.rect.top > 80)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const target = buttons[targetIndex]?.el;
    document.querySelectorAll("[data-codex-order-detail-index]").forEach((el) => el.removeAttribute("data-codex-order-detail-index"));
    if (!target) return false;
    target.setAttribute("data-codex-order-detail-index", "1");
    return true;
  }, index).catch(() => null);
  if (!marked) return false;
  const target = page.locator("[data-codex-order-detail-index='1']").first();
  return await target.isVisible().catch(() => false) && await target.click({ force: true }).then(() => true).catch(() => false);
}

async function closeOrderDetailDialog(page) {
  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = [...document.body.querySelectorAll("button, i, svg, span, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: String(el.innerText || el.textContent || "").trim(), cls: el.className?.baseVal || el.className || "", aria: el.getAttribute("aria-label") || "" }))
      .filter((item) => item.rect.top < 120 && item.rect.left > window.innerWidth * 0.72 && /×|close|guanbi|关闭|el-icon-close/i.test(`${item.text} ${item.cls} ${item.aria}`))
      .sort((a, b) => b.rect.left - a.rect.left);
    const target = candidates[0];
    if (!target) return false;
    document.querySelectorAll("[data-codex-order-detail-close]").forEach((el) => el.removeAttribute("data-codex-order-detail-close"));
    target.el.setAttribute("data-codex-order-detail-close", "1");
    return true;
  }).catch(() => false);
  if (clicked) {
    const close = page.locator("[data-codex-order-detail-close='1']").first();
    if (!await close.click({ force: true }).then(() => true).catch(() => false)) {
      await page.keyboard.press("Escape").catch(() => {});
    }
  } else await page.keyboard.press("Escape").catch(() => {});
}

async function returnToOrderListAfterDetail(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!await isBlockingRecordPanelOpen(page) && (await getOrderPageState(page, 800)).ready) {
      return true;
    }

    const clickedArchive = await clickStudentArchiveOrderArea(page);
    if (clickedArchive) {
      await page.waitForTimeout(450).catch(() => {});
      if (!await isBlockingRecordPanelOpen(page) && (await getOrderPageState(page, 800)).ready) {
        return true;
      }
    }

    await closeOrderDetailDialog(page);
    await page.waitForTimeout(450).catch(() => {});
    if (!await isBlockingRecordPanelOpen(page) && (await getOrderPageState(page, 800)).ready) {
      return true;
    }

    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(350).catch(() => {});
  }
  return !await isBlockingRecordPanelOpen(page) && (await getOrderPageState(page, 800)).ready;
}

async function clickStudentArchiveOrderArea(page) {
  const marked = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 30 && rect.height > 20 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const detailLeft = findDetailLeft();
    const candidates = [...document.body.querySelectorAll("div, section, aside")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(el.innerText || el.textContent || "");
        let score = 0;
        if (/学员档案/.test(text)) score += 50;
        if (/课程订单/.test(text)) score += 35;
        if (/商品订单/.test(text)) score += 10;
        if (/购买\s*(体验营|正式营)|主订单ID|查看详情/.test(text)) score += 25;
        if (/订单详情/.test(text)) score -= 80;
        if (rect.left > 220) score += 8;
        if (detailLeft && rect.right <= detailLeft + 20) score += 25;
        if (rect.width > 220 && rect.width < 700 && rect.height > 220) score += 12;
        return { rect, text, score };
      })
      .filter((item) => item.score >= 80)
      .sort((a, b) => b.score - a.score || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
    const target = candidates[0];
    if (!target) return null;

    const orderTab = findClickableInRect(target.rect, /课程订单|订单信息|学员档案/);
    document.querySelectorAll("[data-codex-student-archive-order-area]").forEach((el) => el.removeAttribute("data-codex-student-archive-order-area"));
    if (!orderTab) return false;
    orderTab.setAttribute("data-codex-student-archive-order-area", "1");
    return true;

    function findDetailLeft() {
      const detail = [...document.body.querySelectorAll("div, section, aside")]
        .filter(visible)
        .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
        .filter((item) => /订单详情/.test(item.text) && /订单信息/.test(item.text) && item.rect.width > 400)
        .sort((a, b) => a.rect.left - b.rect.left)[0];
      return detail?.rect.left || 0;
    }

    function findClickableInRect(parentRect, pattern) {
      return [...document.body.querySelectorAll("button, a, span, div")]
        .filter(visible)
        .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
        .filter((item) => pattern.test(item.text)
          && item.rect.left >= parentRect.left - 5
          && item.rect.right <= parentRect.right + 5
          && item.rect.top >= parentRect.top - 5
          && item.rect.bottom <= parentRect.bottom + 5)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0]?.el || null;
    }
  }).catch(() => null);
  if (!marked) return false;
  const target = page.locator("[data-codex-student-archive-order-area='1']").first();
  return await target.isVisible().catch(() => false) && await target.click({ force: true }).then(() => true).catch(() => false);
}

async function isOrderDetailOpen(page) {
  return await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    return [...document.body.querySelectorAll("div, section, aside, [role='dialog']")]
      .filter(visible)
      .some((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(el.innerText || el.textContent || "");
        return rect.left > window.innerWidth * 0.34
          && /订单详情/.test(text)
          && /订单信息/.test(text)
          && /商品信息|付款信息|支付金额|主订单ID/.test(text);
      });
  }).catch(() => false);
}

async function isBlockingRecordPanelOpen(page) {
  return await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    return [...document.body.querySelectorAll("div, section, aside, [role='dialog']")]
      .filter(visible)
      .some((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(el.innerText || el.textContent || "");
        const isRightPanel = rect.left > window.innerWidth * 0.34;
        const isOrderDetail = /订单详情/.test(text) && /订单信息/.test(text) && /商品信息|付款信息|支付金额|主订单ID/.test(text);
        const isRefundRecord = /订单ID|主订单ID/.test(text) && /退款状态|申请退款金额|申请时间|退款时间|企微审核状态|是否保留听课权限/.test(text);
        return isRightPanel && (isOrderDetail || isRefundRecord);
      });
  }).catch(() => false);
}

function normalizeSingleOrderRedBox(redBox) {
  const value = {
    // 旧版订单详情 DOM 偶尔把“订单类型：正式营/体验营”错配到
    // “所属品类”字段。正式营不是训练营品类，不能拿它去选品类，
    // 否则后续“切换训练营”会被错误地判定为无法查询。
    category: normalizeOrderCategory(redBox?.category || ""),
    startTime: cleanText(redBox?.startTime || ""),
    trainingCampName: cleanText(redBox?.trainingCampName || "")
  };
  value.text = [
    `所属品类：${value.category || ""}`,
    `支付时间：${value.startTime || ""}`,
    `训练营名称：${value.trainingCampName || ""}`
  ].join("\n");
  return value;
}

export function normalizeOrderCategory(value) {
  const normalized = cleanText(value);
  if (/^(?:正式营|体验营|购买正式营|购买体验营)$/.test(normalized)) return "";
  return normalized;
}

function dedupeOrderDetails(details) {
  const seen = new Set();
  const unique = [];
  for (const item of details) {
    const key = item.orderId || `${item.orderType || ""}|${item.productName || ""}|${item.orderTime || ""}|${item.redBox?.text || ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...item, index: unique.length + 1 });
  }
  return unique;
}

function normalizeOrderType(value, label = false) {
  const text = cleanText(value);
  // 同时接受订单卡片原文和内部规范值。此前 formal/experience 再次
  // 传入本函数取中文标签时未被识别，错误落入“其他订单”。
  if (text === "formal" || /正式营/.test(text)) return label ? "正式营" : "formal";
  if (text === "experience" || /体验营/.test(text)) return label ? "体验营" : "experience";
  return label ? "其他订单" : "other";
}

function maskForTrace(value) {
  const token = String(value || "").trim();
  if (token.length <= 4) return token ? "****" : "";
  return `${token.slice(0, 2)}****${token.slice(-2)}`;
}

export async function clearChanceAssDateRange(page) {
  const before = await readChanceAssDateRangeState(page);
  const result = {
    attempted: false,
    cleared: false,
    before: before.text,
    after: "",
    strategy: "",
    error: ""
  };
  if (before.isCleared) {
    result.cleared = true;
    result.strategy = "no-date-range";
    result.after = before.text;
    return result;
  }

  result.attempted = true;
  try {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(120).catch(() => {});

    const referenceClear = await clearChanceDateRangeLikeReference(page);
    if (referenceClear.verified) {
      result.strategy = referenceClear.clearStrategy || "reference-clear";
      result.after = (referenceClear.visibleValues || []).join(" | ");
      result.cleared = true;
      return result;
    }
    result.strategy = referenceClear.clearStrategy ? `reference-${referenceClear.clearStrategy}` : "";

    const elementUiClear = await clearElementUiDateRange(page);
    if (elementUiClear.changed) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300).catch(() => {});
      result.strategy = result.strategy ? `${result.strategy}+element-ui-clear` : "element-ui-clear";
    }

    let state = await readChanceAssDateRangeState(page);
    if (state.isCleared) {
      result.after = state.text;
      result.cleared = true;
      return result;
    }

    const forced = await forceClearChanceAssDateRange(page);
    if (forced.changed) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(250).catch(() => {});
      result.strategy = result.strategy ? `${result.strategy}+dom-force-clear` : "dom-force-clear";
    }

    state = await readChanceAssDateRangeState(page);
    if (state.isCleared) {
      result.after = state.text;
      result.cleared = true;
      return result;
    }

    const clearPoint = await locateChanceAssDateClearButton(page);
    if (clearPoint) {
      await page.mouse.move(clearPoint.x, clearPoint.y).catch(() => {});
      await page.mouse.click(clearPoint.x, clearPoint.y).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(250).catch(() => {});
      result.strategy = result.strategy ? `${result.strategy}+clear-button` : "clear-button";
    }

    state = await readChanceAssDateRangeState(page);
    if (!state.isCleared && before.inputPoints.length) {
      for (const point of before.inputPoints) {
        await page.mouse.click(point.x, point.y).catch(() => {});
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
        await page.keyboard.press("Delete").catch(() => {});
        await page.waitForTimeout(120).catch(() => {});
      }
      await page.keyboard.press("Escape").catch(() => {});
      await page.keyboard.press("Tab").catch(() => {});
      await page.waitForTimeout(250).catch(() => {});
      result.strategy = result.strategy ? `${result.strategy}+keyboard-clear` : "keyboard-clear";
      state = await readChanceAssDateRangeState(page);
    }

    if (!state.isCleared && before.containerPoint) {
      await page.mouse.click(before.containerPoint.x, before.containerPoint.y).catch(() => {});
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(250).catch(() => {});
      result.strategy = result.strategy ? `${result.strategy}+container-clear` : "container-clear";
      state = await readChanceAssDateRangeState(page);
    }

    result.after = state.text;
    result.cleared = state.isCleared;
    return result;
  } catch (error) {
    result.error = error.message || String(error);
    const state = await readChanceAssDateRangeState(page);
    result.after = state.text;
    result.cleared = state.isCleared;
    return result;
  }
}

async function clearChanceDateRangeLikeReference(page) {
  const target = await findChanceDateRangeTarget(page);
  let cleared = { applied: false, values: [], placeholders: [], verified: false };

  if (target) {
    const directClear = await clearDateRangeByVisibleClearIcon(page, target);
    if (directClear.verified) {
      return {
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
        await page.keyboard.press("Escape").catch(() => {});
        const quickCheck = await readChanceDateRangeValues(page, target);
        if (quickCheck.verified) {
          return {
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
    const forced = await forceClearChanceDateInputs(page, target);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200).catch(() => {});
    cleared = await readChanceDateRangeValues(page, target);
    cleared.forced = forced;
  }

  return {
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

async function clearElementUiDateRange(page) {
  const target = await page.evaluate(() => {
    const dateRangePattern = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*至\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/;
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    document.querySelectorAll("[data-codex-date-range]").forEach((el) => el.removeAttribute("data-codex-date-range"));

    const candidates = [...document.body.querySelectorAll(".el-date-editor, .ant-picker, .el-input, div")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(el.value || el.innerText || el.textContent || "");
        const inputText = [...el.querySelectorAll?.("input") || []].map((input) => normalize(input.value || input.placeholder || "")).join(" ");
        return { el, rect, text: normalize(`${text} ${inputText}`) };
      })
      .filter((item) => item.rect.top < 180 && item.rect.width > 180 && (dateRangePattern.test(item.text) || /开始日期|结束日期/.test(item.text)))
      .sort((a, b) => a.rect.width - b.rect.width);
    const container = candidates[0]?.el;
    if (!container) return null;
    container.setAttribute("data-codex-date-range", "1");
    const rect = container.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      right: rect.right,
      top: rect.top,
      height: rect.height
    };
  }).catch(() => null);

  if (!target) return { changed: false };
  await page.mouse.move(target.x, target.y).catch(() => {});
  await page.waitForTimeout(150).catch(() => {});

  const clicked = await page.evaluate(() => {
    const container = document.querySelector("[data-codex-date-range]");
    if (!container) return false;
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const clear = [...container.querySelectorAll("i, svg, span, button")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || ""), cls: el.className?.baseVal || el.className || "", aria: el.getAttribute("aria-label") || "" }))
      .filter((item) => /close|clear|circle-close|el-icon-close|el-icon-circle-close|×|清空/i.test(`${item.text} ${item.cls} ${item.aria}`))
      .sort((a, b) => b.rect.left - a.rect.left)[0];
    if (!clear) return false;
    clear.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    clear.el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    clear.el.click();
    return true;
  }).catch(() => false);

  if (!clicked) {
    await page.mouse.click(target.right - 28, target.top + target.height / 2).catch(() => {});
  }
  await page.waitForTimeout(250).catch(() => {});
  return { changed: true, clicked };
}

async function forceClearChanceAssDateRange(page) {
  return await page.evaluate(() => {
    const dateRangePattern = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*至\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/;
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const items = [...document.body.querySelectorAll("input, span, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.value || el.innerText || el.textContent || "") }))
      .filter((item) => item.rect.top < 180 && dateRangePattern.test(item.text))
      .sort((a, b) => a.rect.width - b.rect.width);
    const target = items[0]?.el;
    if (!target) return { changed: false };
    const container = target.closest(".el-date-editor, .el-input, .ant-picker, .ant-calendar-picker, .el-form-item, div") || target.parentElement || target;
    const inputs = [...container.querySelectorAll("input")].filter((input) => !input.disabled && !input.readOnly);
    const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    let changed = false;
    for (const input of inputs) {
      if (input.value) {
        nativeValueSetter?.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
        changed = true;
      }
    }
    return { changed };
  }).catch(() => ({ changed: false }));
}

async function readChanceAssDateRangeState(page) {
  return await page.evaluate(() => {
    const dateRangePattern = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*至\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/;
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const topElements = [...document.body.querySelectorAll("input, span, div")]
      .filter(visible)
      .map((el) => ({
        el,
        rect: el.getBoundingClientRect(),
        text: normalize(el.value || el.innerText || el.textContent || ""),
        tag: el.tagName
      }))
      .filter((item) => item.rect.top < 180);
    const matches = topElements.filter((item) => dateRangePattern.test(item.text));
    const dateInputs = topElements
      .filter((item) => item.tag === "INPUT" && (dateRangePattern.test(item.text) || /开始日期|结束日期|\d{4}-\d{2}-\d{2}/.test(item.text)))
      .map((item) => item.text)
      .filter(Boolean);
    const inputPoints = topElements
      .filter((item) => item.tag === "INPUT" && (dateRangePattern.test(item.text) || /开始日期|结束日期|\d{4}-\d{2}-\d{2}/.test(item.text)))
      .map((item) => ({ x: item.rect.left + item.rect.width / 2, y: item.rect.top + item.rect.height / 2 }));
    const best = matches.sort((a, b) => a.rect.width - b.rect.width)[0] || null;
    const dirtyDateInputs = dateInputs.filter((text) => /\d{4}[-./]\d{2}[-./]\d{2}/.test(text));
    const isCleared = matches.length === 0 && dirtyDateInputs.length === 0;
    return {
      hasDateRange: matches.length > 0,
      hasDirtyDateInputs: dirtyDateInputs.length > 0,
      isCleared,
      text: [...matches.map((item) => item.text), ...dirtyDateInputs].join(" | "),
      inputPoints,
      containerPoint: best ? { x: best.rect.left + best.rect.width / 2, y: best.rect.top + best.rect.height / 2 } : null
    };
  }).catch(() => ({ hasDateRange: false, hasDirtyDateInputs: false, isCleared: true, text: "", inputPoints: [], containerPoint: null }));
}

async function locateChanceAssDateClearButton(page) {
  return await page.evaluate(() => {
    const dateRangePattern = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*至\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/;
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const rangeItems = [...document.body.querySelectorAll("input, span, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.value || el.innerText || el.textContent || "") }))
      .filter((item) => item.rect.top < 180 && dateRangePattern.test(item.text))
      .sort((a, b) => a.rect.width - b.rect.width);
    const range = rangeItems[0];
    if (!range) return null;
    const rect = range.rect;
    const candidates = [...document.body.querySelectorAll("i, svg, span, button")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || ""), cls: el.className?.baseVal || el.className || "", aria: el.getAttribute("aria-label") || "" }))
      .filter((item) => {
        const inBand = item.rect.top >= rect.top - 12 && item.rect.bottom <= rect.bottom + 12;
        const nearRight = item.rect.left >= rect.left + rect.width - 70 && item.rect.left <= rect.right + 12;
        const looksClear = /close|clear|circle-close|x|×|清空/i.test(`${item.text} ${item.cls} ${item.aria}`);
        return inBand && nearRight && looksClear;
      })
      .sort((a, b) => b.rect.left - a.rect.left);
    const target = candidates[0];
    if (!target) return { x: rect.right - 18, y: rect.top + rect.height / 2 };
    return { x: target.rect.left + target.rect.width / 2, y: target.rect.top + target.rect.height / 2 };
  }).catch(() => null);
}

function buildDateRangeEvidence(dateRange) {
  if (!dateRange?.attempted && dateRange?.cleared) return [];
  return [{
    source: "机会管理",
    type: "date-range",
    label: "日期范围清理",
    value: dateRange?.cleared
      ? `已清理${dateRange.strategy ? `（${dateRange.strategy}）` : ""}`
      : `未确认清理${dateRange?.before ? `，原值：${dateRange.before}` : ""}${dateRange?.error ? `，错误：${dateRange.error}` : ""}`
  }];
}

export async function ensureChanceAssIdentityFilter(page, lookup) {
  const expectedMode = lookup?.type === "phone" ? "手机号" : "用户ID";
  let state = await markChanceAssIdentityFilterPair(page, expectedMode);
  if (!state.found) return { ...state, confirmed: false };
  if (state.mode === expectedMode) return { ...state, confirmed: true, changed: false };

  const modeControl = page.locator("[data-codex-chance-identity-mode='1']").first();
  if (!await modeControl.count().catch(() => 0)) {
    return { ...state, confirmed: false, reason: `${expectedMode}筛选控件标记丢失` };
  }

  await modeControl.scrollIntoViewIfNeeded().catch(() => {});
  const opened = await modeControl.click({ force: true }).then(() => true).catch(() => false);
  if (!opened) return { ...state, confirmed: false, reason: `${expectedMode}筛选控件无法点击` };

  const selected = await waitAndClickExactVisibleOption(page, expectedMode, 3000);
  if (!selected) {
    await page.keyboard.press("Escape").catch(() => {});
    return { ...state, confirmed: false, reason: `${expectedMode}筛选选项未出现` };
  }

  await page.waitForTimeout(250).catch(() => {});
  state = await markChanceAssIdentityFilterPair(page, expectedMode);
  return {
    ...state,
    confirmed: state.found && state.mode === expectedMode,
    changed: true,
    reason: state.mode === expectedMode ? "" : `切换后控件值仍为${state.mode || "空"}`
  };
}

export async function verifyChanceAssIdentityFilter(page, lookup) {
  const expectedMode = lookup?.type === "phone" ? "手机号" : "用户ID";
  const state = await markChanceAssIdentityFilterPair(page, expectedMode);
  const expected = String(lookup?.value || "").replace(/\s+/g, "").trim();
  const actual = String(state.inputValue || "").replace(/\s+/g, "").trim();
  const valueConfirmed = actual === expected
    || actual.split(/[,，]/).map((item) => item.trim()).filter(Boolean).includes(expected);
  return {
    ...state,
    expected,
    valueConfirmed,
    confirmed: Boolean(state.found && state.mode === expectedMode && valueConfirmed),
    reason: !state.found
      ? state.reason
      : state.mode !== expectedMode
        ? `筛选类型为${state.mode || "空"}`
        : valueConfirmed ? "" : `${expectedMode}输入值与本次查询不一致`
  };
}

async function markChanceAssIdentityFilterPair(page, expectedMode) {
  return await page.evaluate((targetMode) => {
    const compact = (value) => String(value || "").replace(/\s+/g, "").trim();
    const normalizeIdentityMode = (value) => {
      const text = compact(value);
      if (/^(用户ID|用户id|UID|uid|id)$/i.test(text)) return "用户ID";
      if (text === "手机号") return "手机号";
      if (text === "微信昵称") return "微信昵称";
      if (text === "客户备注") return "客户备注";
      return "";
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const rectData = (rect) => ({
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });

    document.querySelectorAll("[data-codex-chance-identity-mode]")
      .forEach((el) => el.removeAttribute("data-codex-chance-identity-mode"));
    document.querySelectorAll("input[data-codex-chance-identity-value]")
      .forEach((el) => el.removeAttribute("data-codex-chance-identity-value"));

    const queryButton = [...document.body.querySelectorAll("button, [role='button'], span, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: compact(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "查询" && item.rect.top < 560)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0];
    const formBottom = (queryButton?.rect?.bottom || 520) + 24;
    const formTop = Math.max(0, (queryButton?.rect?.top || 450) - 420);

    const inputs = [...document.body.querySelectorAll("input")]
      .filter(visible)
      .filter((input) => !input.disabled && !input.readOnly)
      .map((input) => ({ input, rect: input.getBoundingClientRect() }))
      .filter((item) => item.rect.top >= formTop && item.rect.bottom <= formBottom && item.rect.width >= 90);

    const readControlValue = (el) => {
      const selected = el.querySelector(".ant-select-selection-item, .el-select__selected-item, .arco-select-view-value, [class*='selected-item']");
      const selectedText = compact(selected?.innerText || selected?.textContent || "");
      const selectedMode = normalizeIdentityMode(selectedText);
      if (selectedMode) return selectedMode;
      const input = el.matches("input") ? el : el.querySelector("input");
      const inputValue = compact(input?.value || input?.getAttribute("value") || "");
      const inputMode = normalizeIdentityMode(inputValue);
      if (inputMode) return inputMode;
      const ownText = compact(el.innerText || el.textContent || el.getAttribute("title") || el.getAttribute("aria-label") || "");
      return normalizeIdentityMode(ownText);
    };
    const rawControls = [...document.body.querySelectorAll([
      "[role='combobox']",
      ".ant-select",
      ".ant-select-selector",
      ".el-select",
      ".el-select__wrapper",
      ".arco-select",
      ".arco-select-view",
      ".ivu-select"
    ].join(","))]
      .filter(visible)
      .map((el) => {
        const rawText = compact(el.innerText || el.textContent || "");
        return {
          el,
          rect: el.getBoundingClientRect(),
          text: readControlValue(el),
          rawText,
          hasIdentityOptions: /用户ID/i.test(rawText) && /(手机号|微信昵称|客户备注)/.test(rawText)
        };
      })
      .filter((item) => item.rect.top >= formTop && item.rect.bottom <= formBottom && item.rect.width >= 55 && item.rect.width <= 260);

    const controls = rawControls.filter((item, index, all) => !all.some((other, otherIndex) => {
      if (index === otherIndex || !other.el.contains(item.el)) return false;
      const sameBox = Math.abs(other.rect.left - item.rect.left) < 4
        && Math.abs(other.rect.top - item.rect.top) < 4
        && Math.abs(other.rect.width - item.rect.width) < 8
        && Math.abs(other.rect.height - item.rect.height) < 8;
      return sameBox;
    }));

    const pairs = [];
    for (const control of controls) {
      const controlCenterY = control.rect.top + control.rect.height / 2;
      for (const input of inputs) {
        if (control.el.contains(input.input)) continue;
        const inputCenterY = input.rect.top + input.rect.height / 2;
        const rowDistance = Math.abs(controlCenterY - inputCenterY);
        const gap = input.rect.left - control.rect.right;
        if (rowDistance > 38 || gap < -30 || gap > 560) continue;
        const identityMode = Boolean(normalizeIdentityMode(control.text));
        const identityControl = identityMode || control.hasIdentityOptions;
        const placeholder = String(input.input.placeholder || "");
        const value = String(input.input.value || "");
        let score = rowDistance * 20 + Math.abs(gap);
        if (control.text === targetMode) score -= 1200;
        else if (identityMode) score -= 650;
        if (control.hasIdentityOptions) score -= 900;
        if (/^请输入内容$/.test(placeholder)) score -= 500;
        if (control.rect.width <= 100 && input.rect.width >= 120) score -= 180;
        if (/逗号|分隔|多选|请输入|输入/.test(placeholder)) score -= 160;
        if (/^\d{5,}$/.test(compact(value))) score -= 120;
        pairs.push({ control, input, score, identityMode, identityControl });
      }
    }

    const pair = pairs
      .filter((item) => item.identityControl
        || (/逗号|分隔|多选/.test(item.input.input.placeholder || "") && item.control.rect.width <= 120))
      .sort((a, b) => a.score - b.score)[0];
    if (!pair) {
      return {
        found: false,
        reason: `未找到同一行的筛选类型与${targetMode}输入框组合`,
        controls: controls.slice(0, 20).map((item) => ({
          text: item.text,
          rawText: item.rawText,
          hasIdentityOptions: item.hasIdentityOptions,
          className: String(item.el.className || ""),
          rect: rectData(item.rect)
        })),
        inputs: inputs.slice(0, 20).map((item) => ({
          value: String(item.input.value || ""),
          placeholder: String(item.input.placeholder || ""),
          rect: rectData(item.rect)
        }))
      };
    }

    pair.control.el.setAttribute("data-codex-chance-identity-mode", "1");
    pair.input.input.setAttribute("data-codex-chance-identity-value", "1");
    return {
      found: true,
      mode: pair.control.text,
      inputValue: String(pair.input.input.value || ""),
      inputPlaceholder: String(pair.input.input.placeholder || ""),
      controlRect: rectData(pair.control.rect),
      inputRect: rectData(pair.input.rect)
    };
  }, expectedMode).catch((error) => ({ found: false, reason: error.message || String(error) }));
}

export async function fillChanceAssIdentityValue(page, identityValue) {
  if (!identityValue) return false;
  const selector = "input[data-codex-chance-identity-value='1']";
  const point = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const target = [...document.querySelectorAll("input[data-codex-chance-identity-value='1']")]
      .find((input) => visible(input) && !input.readOnly && !input.disabled);
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      top: rect.top,
      left: rect.left,
      placeholder: target.placeholder || "",
      valueBefore: target.value || ""
    };
  }).catch(() => null);
  if (!point) return false;

  const locator = page.locator(selector).first();
  if (await locator.count().catch(() => 0)) {
    await locator.click({ force: true }).catch(() => {});
    await locator.fill("").catch(() => {});
    await locator.fill(String(identityValue)).catch(async () => {
      await page.mouse.click(point.x, point.y);
      await page.keyboard.press("Meta+A").catch(async () => page.keyboard.press("Control+A").catch(() => {}));
      await page.keyboard.press("Backspace").catch(() => {});
      await page.keyboard.type(String(identityValue), { delay: 10 }).catch(() => {});
    });
  } else {
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press("Meta+A").catch(async () => page.keyboard.press("Control+A").catch(() => {}));
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(String(identityValue), { delay: 10 }).catch(() => {});
  }
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(150).catch(() => {});
  const verified = await page.evaluate((expected) => {
    const input = document.querySelector("input[data-codex-chance-identity-value='1']");
    const actual = String(input?.value || "").replace(/\s+/g, "").trim();
    const target = String(expected || "").replace(/\s+/g, "").trim();
    return actual === target || actual.split(/[,，]/).map((item) => item.trim()).includes(target);
  }, String(identityValue)).catch(() => false);
  return Boolean(verified);
}

async function probeChanceAssInputs(page, userId) {
  return await page.evaluate((expected) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const inputs = [...document.body.querySelectorAll("input")]
      .filter(visible)
      .map((input, index) => {
        const rect = input.getBoundingClientRect();
        const container = input.closest(".el-input, .el-select, .ant-select, .el-form-item, .ant-form-item, div");
        return {
          index,
          value: normalize(input.value || ""),
          placeholder: input.placeholder || "",
          disabled: input.disabled,
          readOnly: input.readOnly,
          className: input.className || "",
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          containerText: normalize(container?.innerText || container?.textContent || "").slice(0, 120)
        };
      })
      .filter((item) => item.rect.top < 460);
    const labels = [...document.body.querySelectorAll("span, div, label")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: normalize(el.innerText || el.textContent || ""),
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      })
      .filter((item) => /用户ID|查询/.test(item.text) && item.rect.top < 460)
      .slice(0, 40);
    return {
      expected,
      url: location.href,
      inputs,
      labels,
      bodyHasExpected: normalize(document.body.innerText || document.body.textContent || "").includes(expected)
    };
  }, String(userId)).catch((error) => ({ expected: String(userId), error: error.message || String(error) }));
}

async function findChanceAssUserIdInput(page) {
  return await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const pointOf = (item) => ({
      x: item.rect.left + item.rect.width / 2,
      y: item.rect.top + item.rect.height / 2,
      value: normalize(item.input.value || ""),
      placeholder: item.input.placeholder || "",
      top: item.rect.top,
      left: item.rect.left
    });

    const queryButton = [...document.body.querySelectorAll("button, span, div")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "查询")
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0];
    const queryTop = queryButton?.rect?.top || 520;

    const labelNodes = [...document.body.querySelectorAll("span, div, label")]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => (item.text === "用户ID" || item.text === "用户id" || item.text.toLowerCase() === "uid") && item.rect.top < queryTop)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    const inputs = [...document.body.querySelectorAll("input")]
      .filter(visible)
      .filter((input) => !input.disabled && !input.readOnly)
      .map((input) => ({ input, rect: input.getBoundingClientRect(), value: input.value || "", placeholder: input.placeholder || "" }))
      .filter((item) => item.rect.top < queryTop);

    const commaInputs = inputs.filter((item) => /逗号|分隔|多选/.test(item.placeholder) && item.rect.top < queryTop);
    const ranked = [];
    for (const label of labelNodes) {
      const labelCenterY = label.rect.top + label.rect.height / 2;
      for (const item of commaInputs.length ? commaInputs : inputs) {
        const inputCenterY = item.rect.top + item.rect.height / 2;
        const sameRow = Math.abs(inputCenterY - labelCenterY);
        if (sameRow > 34) continue;
        if (item.rect.left < label.rect.left) continue;
        ranked.push({
          input: item.input,
          x: item.rect.left + item.rect.width / 2,
          y: item.rect.top + item.rect.height / 2,
          score: Math.abs(item.rect.left - label.rect.right) + sameRow * 4 + (/逗号|分隔|多选/.test(item.placeholder) ? 0 : 500),
          valueBefore: item.value,
          placeholder: item.placeholder
        });
      }
    }

    const target = ranked.sort((a, b) => a.score - b.score)[0];
    if (target) return pointOf({ input: target.input, rect: target.input.getBoundingClientRect() });

    const fallback = (commaInputs.length ? commaInputs : inputs)
      .filter((item) => item.rect.top < queryTop && item.rect.width > 100)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[2];
    if (!fallback) return null;
    return pointOf(fallback);
  }).catch(() => null);
}

async function isChanceAssUserIdFilled(page, userId) {
  return await page.evaluate((expected) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const queryButton = [...document.body.querySelectorAll("button, span, div")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "查询")
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0];
    const queryTop = queryButton?.rect?.top || 520;
    const labels = [...document.body.querySelectorAll("span, div, label")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "用户ID" && item.rect.top < queryTop);
    const inputs = [...document.body.querySelectorAll("input")]
      .filter(visible)
      .filter((input) => !input.disabled && !input.readOnly)
      .map((input) => ({ input, rect: input.getBoundingClientRect(), value: normalize(input.value || ""), placeholder: input.placeholder || "" }))
      .filter((item) => item.rect.top < queryTop);

    for (const label of labels) {
      const labelCenterY = label.rect.top + label.rect.height / 2;
      const matched = inputs
        .filter((item) => item.rect.left > label.rect.left && Math.abs(item.rect.top + item.rect.height / 2 - labelCenterY) <= 36)
        .sort((a, b) => a.rect.left - b.rect.left)[0];
      if (matched?.value?.includes(expected)) return true;
    }
    return inputs.some((item) => /逗号|分隔|多选/.test(item.placeholder) && item.value.includes(expected));
  }, String(userId)).catch(() => false);
}

async function forceFillChanceAssUserId(page, userId) {
  return await page.evaluate((expected) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const queryButton = [...document.body.querySelectorAll("button, span, div")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "查询")
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0];
    const queryTop = queryButton?.rect?.top || 520;
    const labels = [...document.body.querySelectorAll("span, div, label")]
      .filter(visible)
      .map((el) => ({ rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "用户ID" && item.rect.top < queryTop);
    const inputs = [...document.body.querySelectorAll("input")]
      .filter(visible)
      .filter((input) => !input.disabled && !input.readOnly)
      .map((input) => ({ input, rect: input.getBoundingClientRect(), placeholder: input.placeholder || "" }))
      .filter((item) => item.rect.top < queryTop);
    let target = null;
    for (const label of labels) {
      const labelCenterY = label.rect.top + label.rect.height / 2;
      target = inputs
        .filter((item) => item.rect.left > label.rect.left && Math.abs(item.rect.top + item.rect.height / 2 - labelCenterY) <= 36)
        .sort((a, b) => a.rect.left - b.rect.left)[0]?.input;
      if (target) break;
    }
    target ||= inputs.find((item) => /逗号|分隔|多选/.test(item.placeholder))?.input;
    if (!target) return false;
    const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    nativeValueSetter?.call(target, expected);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    target.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }, String(userId)).catch(() => false);
}

export async function clickChanceAssQueryButton(page, lookup) {
  const marked = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    document.querySelectorAll("[data-codex-chance-query]")
      .forEach((el) => el.removeAttribute("data-codex-chance-query"));
    const buttons = [...document.body.querySelectorAll("button, .el-button, .ant-btn")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          el,
          rect,
          text: normalize(el.innerText || el.textContent || ""),
          bg: style.backgroundColor,
          color: style.color
        };
      })
      .filter((item) => item.text === "查询" && item.rect.top < 760 && item.rect.left > 240)
      .map((item) => {
        const blue = /rgb\((\s*0|\s*[1-9]\d),\s*(1[0-9]{2}|2[0-4]\d|25[0-5]),\s*(1[0-9]{2}|2[0-4]\d|25[0-5])\)/.test(item.bg);
        return {
          el: item.el,
          score: item.rect.top + (blue ? 0 : 300) + (item.el.tagName === "BUTTON" ? 0 : 100)
        };
      })
      .sort((a, b) => a.score - b.score);
    const target = buttons[0]?.el;
    if (!target) return false;
    target.setAttribute("data-codex-chance-query", "1");
    return true;
  }).catch(() => null);
  if (!marked) return false;

  const expected = String(lookup?.value || "").trim();
  const requestPromise = page.waitForRequest((request) => {
    const resourceType = request.resourceType();
    if (!["xhr", "fetch"].includes(resourceType) || !/qlchat\.com/i.test(request.url())) return false;
    const requestText = `${request.url()} ${request.postData() || ""}`;
    try {
      return decodeURIComponent(requestText).includes(expected);
    } catch {
      return requestText.includes(expected);
    }
  }, { timeout: 6000 }).then(() => true).catch(() => false);
  const button = page.locator("[data-codex-chance-query='1']").first();
  const clicked = await button.click({ force: true }).then(() => true).catch(() => false);
  if (!clicked) return false;

  return requestPromise;
}

async function waitForChanceAssUserRow(page, lookup, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 2500));
  while (Date.now() < deadline) {
    const found = await hasChanceAssUserRow(page, lookup);
    if (found) return true;
    await page.waitForTimeout(250).catch(() => {});
  }
  return hasChanceAssUserRow(page, lookup);
}

function normalizeChanceLookup(lookup) {
  if (lookup && typeof lookup === "object") {
    const type = lookup.type === "phone" ? "phone" : "userId";
    return { type, value: String(lookup.value || "").trim() };
  }
  return { type: "userId", value: String(lookup || "").trim() };
}

async function hasChanceAssUserRow(page, lookup) {
  const normalizedLookup = normalizeChanceLookup(lookup);
  return await page.evaluate((target) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const matches = (text) => {
      const normalized = normalize(text);
      if (target.type === "userId") return normalized.includes(target.value);
      const digits = String(target.value || "").replace(/\D/g, "");
      if (digits.length !== 11) return false;
      if (normalized.replace(/\D/g, "").includes(digits)) return true;
      return normalized.includes(digits.slice(0, 3))
        && normalized.includes(digits.slice(-4))
        && /\*{2,}/.test(normalized);
    };
    const rows = [...document.body.querySelectorAll("tr, .el-table__row, .ant-table-row")]
      .filter((row) => {
        const rect = row.getBoundingClientRect();
        const style = window.getComputedStyle(row);
        return rect.width > 20 && rect.height > 12 && rect.bottom > 0 && rect.top < window.innerHeight
          && style.display !== "none" && style.visibility !== "hidden";
      })
      .filter((row) => matches(row.innerText || row.textContent || ""));
    // Element/Ant 表格的固定操作列会克隆行，同一用户出现多份是正常结构。
    return rows.length > 0;
  }, normalizedLookup).catch(() => false);
}

async function clickStudentProfileInMatchedRow(page, lookup) {
  const normalizedLookup = normalizeChanceLookup(lookup);
  const marked = await page.evaluate((targetLookup) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const matchesLookup = (text) => {
      const normalized = normalize(text);
      if (targetLookup.type === "userId") return normalized.includes(targetLookup.value);
      const digits = String(targetLookup.value || "").replace(/\D/g, "");
      if (digits.length !== 11) return false;
      if (normalized.replace(/\D/g, "").includes(digits)) return true;
      return normalized.includes(digits.slice(0, 3))
        && normalized.includes(digits.slice(-4))
        && /\*{2,}/.test(normalized);
    };
    document.querySelectorAll("[data-codex-student-archive-action]")
      .forEach((el) => el.removeAttribute("data-codex-student-archive-action"));

    const allRows = [...document.body.querySelectorAll("tr, .el-table__row, .ant-table-row")]
      .filter(visible)
      .filter((row) => row.getBoundingClientRect().height > 12);
    const matchedRows = allRows.filter((row) => matchesLookup(row.innerText || row.textContent || ""));
    if (!matchedRows.length) return false;

    const actionForRow = (row) => [...row.querySelectorAll("a, button, [role='button'], span, div")]
        .filter(visible)
        .map((el) => ({ el, rect: el.getBoundingClientRect(), text: normalize(el.innerText || el.textContent || "") }))
        .filter((item) => item.text === "学员档案" || item.text.includes("学员档案"))
        .sort((a, b) => b.rect.left - a.rect.left)[0];

    let target = matchedRows.map(actionForRow).find(Boolean);
    if (!target) {
      // 固定右侧操作列的克隆行通常不含用户ID，按同一可视行的纵向中心对应。
      const matchedCenters = matchedRows.map((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
      const actionRows = allRows
        .map((row) => ({ row, action: actionForRow(row) }))
        .filter((item) => item.action)
        .map((item) => {
          const rect = item.row.getBoundingClientRect();
          const center = rect.top + rect.height / 2;
          const distance = Math.min(...matchedCenters.map((value) => Math.abs(value - center)));
          return { ...item, distance };
        })
        .filter((item) => item.distance <= 28)
        .sort((a, b) => a.distance - b.distance || b.action.rect.left - a.action.rect.left);
      target = actionRows[0]?.action;
    }
    if (!target) return false;
    const clickable = target.el.closest("a,button,[role='button'],.el-button,.el-link") || target.el;
    clickable.setAttribute("data-codex-student-archive-action", "1");
    return true;
  }, normalizedLookup).catch(() => false);

  if (!marked) return false;
  const action = page.locator("[data-codex-student-archive-action='1']").first();
  return await action.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
}

async function resolveProfileUserId(profilePage, chance = {}) {
  if (profilePage && !profilePage.isClosed()) {
    const text = await findVisibleText(profilePage, 3500).catch(() => "");
    const pairs = await readLabelValuePairs(profilePage).catch(() => []);
    const userId = resolveUserIdFromContent(text, pairs);
    if (userId) return userId;
  }
  return String(chance.matchedUserId || "").trim()
    || resolveUserIdFromContent(chance.bodyText || "", chance.pairs || []);
}

export function resolveUserIdFromContent(text, pairs = []) {
  const fromPairs = (pairs || []).find((pair) => {
    const label = cleanText(pair?.label || "").replace(/[\s:：_-]/g, "").toLowerCase();
    return ["用户id", "uid", "会员id", "客户id", "学员id"].includes(label);
  })?.value || pickValue(pairs, ["用户ID", "用户id", "用户 Id", "UID", "uid"]);
  const pairDigits = String(fromPairs || "").replace(/\D/g, "");
  if (/^\d{6,20}$/.test(pairDigits)) return pairDigits;
  const normalized = cleanText(text);
  const match = normalized.match(/(?:用户|会员|客户|学员)\s*(?:ID|编号)\s*[:：]?\s*(\d{6,20})|(?:UID)\s*[:：]?\s*(\d{6,20})/i);
  return match?.[1] || match?.[2] || "";
}

function normalizeResolvedUserId(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return /^\d{6,20}$/.test(digits) ? digits : "";
}

export async function extractMatchedUserIds(page, lookup) {
  const target = normalizeChanceLookup(lookup);
  return page.evaluate((targetLookup) => {
    const compact = (value) => String(value || "").replace(/\s+/g, "").trim();
    const digits = (value) => String(value || "").replace(/\D/g, "");
    const phone = digits(targetLookup.value);
    const rows = [...document.querySelectorAll("tr, .el-table__row, .ant-table-row")]
      .filter((row) => {
        const text = compact(row.innerText || row.textContent || "");
        if (targetLookup.type === "userId") return text.includes(targetLookup.value);
        return phone.length === 11
          && (digits(text).includes(phone)
            || (text.includes(phone.slice(0, 3)) && text.includes(phone.slice(-4))));
      });
    const resolved = [];
    for (const row of rows) {
      const cells = [...row.querySelectorAll("td, [role='cell']")]
        .map((cell) => compact(cell.innerText || cell.textContent || ""))
        .filter(Boolean);
      const candidates = cells
        .flatMap((text) => text.match(/\d{6,20}/g) || [])
        .filter((value) => value !== phone && !/^1\d{10}$/.test(value));
      const preferred = candidates.find((value) => value.length >= 9 && value.length <= 15)
        || candidates.find((value) => value.length >= 6 && value.length <= 20);
      if (preferred) resolved.push(preferred);
    }
    return [...new Set(resolved)];
  }, target).catch(() => []);
}

async function extractMatchedUserId(page, lookup) {
  return (await extractMatchedUserIds(page, lookup))[0] || "";
}

function normalizeQuery(query) {
  return {
    userId: String(query.userId || "").trim(),
    phone: String(query.phone || "").trim(),
    mode: normalizeQueryMode(query.mode),
    progressId: normalizeProgressId(query.progressId)
  };
}

function normalizeProgressId(value) {
  const normalized = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(normalized) ? normalized : "";
}

function createProgressId() {
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function progressFromTraceStage(stage, extra = {}) {
  if (stage === "entered") return { state: "running", stage: "connect", label: "正在打开后台查询页面", detail: "准备读取用户信息" };
  if (stage === "login-check" || stage === "login-required" || stage === "login-required-after-goto") {
    return {
      state: stage === "login-required" || stage === "login-required-after-goto" ? "waiting" : "running",
      stage: "login",
      label: stage === "login-check" ? "正在检查后台登录态" : "等待后台登录验证",
      detail: extra.message || "请完成后台扫码/验证"
    };
  }
  if (stage === "chance-search-done") {
    return {
      state: "running",
      stage: "profile",
      label: extra.found ? "已查询到学员档案" : "已完成用户信息查询",
      detail: extra.error || (extra.found ? "正在进入订单和营期信息" : "未找到匹配的用户记录")
    };
  }
  if (stage === "profile-extract-done") {
    return {
      state: "running",
      stage: "orders",
      label: "已查询到订单信息",
      detail: extra.error || `订单记录 ${Number(extra.orderCount || 0)} 条，正在整理营期信息`
    };
  }
  if (stage === "complaint-isolated-start") {
    return { state: "running", stage: "complaints", label: "正在查询投诉信息", detail: "已打开独立投诉查询页" };
  }
  if (stage === "error") {
    return { state: "error", stage: "error", label: "查询遇到异常", detail: extra.message || "请查看查询结果中的错误说明" };
  }
  return null;
}

function progressSteps(stage = "idle", state = "idle") {
  const order = ["profile", "orders", "schedule", "complaints"];
  const current = order.indexOf(stage);
  const activeIndex = current >= 0 ? current : (state === "done" || state === "partial") ? order.length : -1;
  return [
    { key: "profile", label: "用户档案", status: stepStatus(0, activeIndex, state) },
    { key: "orders", label: "订单信息", status: stepStatus(1, activeIndex, state) },
    { key: "schedule", label: "营期信息", status: stepStatus(2, activeIndex, state) },
    { key: "complaints", label: "投诉信息", status: stepStatus(3, activeIndex, state) }
  ];
}

function progressCountsFromResult(result = {}) {
  const orders = result?.overview?.orders || [];
  const formal = orders.filter((order) => order.orderType === "formal");
  const complaints = result?.overview?.complaints;
  return {
    ordersFound: orders.length,
    ordersProcessed: orders.length,
    formalTotal: formal.length,
    formalProcessed: formal.filter((order) => order.campSchedule?.matched).length,
    complaints: Array.isArray(complaints) ? "done" : "pending"
  };
}

function stepStatus(index, activeIndex, state) {
  if (state === "done" || state === "partial") return "done";
  if (state === "error" && index >= activeIndex && activeIndex >= 0) return "error";
  if (activeIndex < 0) return "pending";
  if (index < activeIndex) return "done";
  if (index === activeIndex) return "active";
  return "pending";
}

export function resolveComplaintQueryUserId(lookup, profileUserId = "") {
  const directUserId = lookup?.type === "userId" ? normalizeResolvedUserId(lookup.value) : "";
  return directUserId || normalizeResolvedUserId(profileUserId);
}

function normalizeQueryMode(value) {
  return ["order", "schedule", "complaint", "all"].includes(value) ? value : "all";
}

function createEmptyOverview(query, lookup) {
  return {
    found: false,
    loginRequired: false,
    lookup,
    input: query,
    overview: {
      basic: {
        userId: "",
        phone: "",
        name: ""
      },
      chance: {
        status: "",
        owner: ""
      },
      course: {
        category: "",
        campName: ""
      },
      order: {
        status: "",
        paymentType: ""
      },
      redBox: {
        category: "",
        startTime: "",
        trainingCampName: "",
        text: ""
      },
      orders: [],
      orderGroups: {
        formal: [],
        experience: [],
        other: []
      },
      complaints: [],
      complaintSummary: {
        tabs: []
      },
      followUp: {
        latest: ""
      }
    },
    evidence: [],
    source: "chanceAssDom",
    fetchedAt: new Date().toISOString(),
    error: "",
    durationMs: 0
  };
}

function mergeOverview({ base, config, lookup, chance, profile, evidence }) {
  const allPairs = [...(chance.pairs || []), ...(profile?.pairs || [])];
  const allText = cleanText(`${chance.bodyText || ""}\n${profile?.bodyText || ""}`);
  const fields = { ...defaultFieldLabels(), ...(config.fields || {}) };
  const orders = normalizeOrderDetails(profile?.orders || []);
  const orderGroups = groupOrdersByType(orders);
  const redBox = normalizeRedBox(orders[0]?.redBox || profile?.redBox || {}, allPairs, allText, fields);

  const userId = firstNonEmpty(
    lookup.type === "userId" ? normalizeResolvedUserId(lookup.value) : "",
    normalizeResolvedUserId(profile?.resolvedUserId),
    normalizeResolvedUserId(chance.matchedUserId),
    normalizeResolvedUserId(pickValue(allPairs, fields.userIdLabels)),
    resolveUserIdFromContent(allText, allPairs)
  );
  const phone = pickValue(allPairs, fields.phoneLabels) || (lookup.type === "phone" ? lookup.value : "");
  const name = pickValue(allPairs, fields.nameLabels);
  const chanceStatus = pickValue(allPairs, fields.chanceLabels);
  const owner = pickValue(allPairs, fields.ownerLabels);
  const category = redBox.category || pickValue(allPairs, fields.categoryLabels);
  const campName = redBox.trainingCampName || pickValue(allPairs, fields.campLabels);
  const orderStatus = pickValue(allPairs, ["订单状态", "支付状态"]);
  const paymentType = pickValue(allPairs, ["付费类型", "购买类型", "购买体验营", "购买正式营"]);
  const latest = extractLatestFollowUp(allText);

  return {
    ...base,
    found: Boolean(chance.found || userId || phone || name || category || campName),
    overview: {
      basic: {
        userId,
        phone,
        name
      },
      chance: {
        status: chanceStatus,
        owner
      },
      course: {
        category,
        startTime: redBox.startTime || pickValue(allPairs, fields.startTimeLabels || ["订单支付时间", "支付时间", "下单时间", "开营时间"]),
        campName
      },
      order: {
        status: orderStatus,
        paymentType
      },
      redBox,
      orders,
      orderGroups,
      followUp: {
        latest
      }
    },
    evidence: prioritizeScheduleEvidence(evidence, 30),
    error: chance.error && !chance.found ? chance.error : (profile?.error || "")
  };
}

function normalizeOrderDetails(orders) {
  return (orders || []).map((order, index) => {
    const redBox = normalizeSingleOrderRedBox(order.redBox || {});
    const campType = resolveCampType(order);
    const campTypeLabel = normalizeOrderType(campType, true);
    const detail = normalizeOrderDetailData(order.detail || {});
    return {
      index: index + 1,
      // 对外保留 orderType/orderTypeLabel，实际均由卡片的购买营类型决定。
      orderType: campType,
      orderTypeLabel: campTypeLabel,
      campType,
      campTypeLabel,
      productTypeRaw: cleanText(order.productTypeRaw || order.productType || ""),
      orderId: cleanText(order.orderId || ""),
      amount: typeof order.amount === "number" ? order.amount : null,
      amountText: cleanText(order.amountText || ""),
      productName: cleanText(order.productName || ""),
      detailProductName: cleanText(order.detailProductName || ""),
      orderTime: cleanText(order.orderTime || order.time || ""),
      salesOwner: cleanText(order.salesOwner || ""),
      detail,
      detailOpened: Boolean(order.detailOpened),
      detailOpenAttempts: Number(order.detailOpenAttempts || 0),
      detailMatched: Boolean(order.detailMatched),
      processed: Boolean(order.processed),
      error: cleanText(order.error || (!order.detailOpened ? "订单详情打开失败" : "") || order.campSchedule?.error || ""),
      diagnosticRefs: Array.isArray(order.diagnosticRefs) ? order.diagnosticRefs.filter(Boolean) : [],
      refund: normalizeRefundRecord(order.refund),
      campSchedule: normalizeCampSchedule(order.campSchedule),
      sourceTextSnippet: cleanText(order.sourceTextSnippet || order.rawText || ""),
      detailTextSnippet: cleanText(order.detailTextSnippet || order.bodyText || ""),
      redBox,
      text: [
        `订单${index + 1}（${campTypeLabel}）`,
        order.orderId ? `主订单ID：${order.orderId}` : "",
        order.productName ? `商品名称：${order.productName}` : "",
        redBox.text,
        campType === "formal" ? `开营时间：${order.campSchedule?.startTime || detail.startTime || ""}` : "",
        campType === "formal" ? `结营时间：${order.campSchedule?.endTime || ""}` : ""
      ].filter(Boolean).join("\n")
    };
  });
}

function prioritizeScheduleEvidence(evidence, limit = 30) {
  const items = Array.isArray(evidence) ? evidence : [];
  const schedule = items.filter((item) => /formal-camp|camp-schedule/.test(String(item?.type || "")));
  const other = items.filter((item) => !schedule.includes(item));
  return [...schedule, ...other].slice(0, limit);
}

function groupOrdersByType(orders) {
  const groups = { formal: [], experience: [], other: [] };
  for (const order of orders || []) {
    const campType = resolveCampType(order);
    const key = campType === "formal" || campType === "experience" ? campType : "other";
    groups[key].push(order);
  }
  return groups;
}

function normalizeRefundRecord(refund) {
  const value = {
    found: Boolean(refund?.found),
    refundAmount: cleanText(refund?.refundAmount || ""),
    keepListenPermission: cleanText(refund?.keepListenPermission || ""),
    applyTime: cleanText(refund?.applyTime || ""),
    weworkAuditStatus: cleanText(refund?.weworkAuditStatus || ""),
    refundStatus: cleanText(refund?.refundStatus || ""),
    refundTime: cleanText(refund?.refundTime || ""),
    rawText: cleanText(refund?.rawText || "")
  };
  value.text = value.found ? [
    `申请退款金额：${value.refundAmount}`,
    `是否保留听课权限：${value.keepListenPermission}`,
    `申请时间：${value.applyTime}`,
    `企微审核状态：${value.weworkAuditStatus}`,
    `退款状态：${value.refundStatus}`,
    `退款时间：${value.refundTime}`
  ].join("\n") : "";
  return value;
}

function normalizeCampSchedule(schedule) {
  return createCampSchedule({
    requested: schedule?.requested,
    matched: schedule?.matched,
    membershipMatched: schedule?.membershipMatched,
    startTime: schedule?.startTime,
    endTime: schedule?.endTime,
    periodName: schedule?.periodName,
    className: schedule?.className,
    salesOwner: schedule?.salesOwner,
    afterSalesReception: schedule?.afterSalesReception,
    membershipCampName: schedule?.membershipCampName,
    campId: schedule?.campId,
    periodId: schedule?.periodId,
    periodMatchStrategy: schedule?.periodMatchStrategy,
    error: schedule?.error,
    debugLog: schedule?.debugLog
  });
}

function buildEvidence(source, bodyText, lookupValue, pairs) {
  const snippets = [];
  const row = extractRowContaining(bodyText, lookupValue);
  if (row) snippets.push({ source, type: "matched-row", text: row.slice(0, 500) });
  for (const pair of pairs.slice(0, 30)) {
    if (interestingLabel(pair.label)) {
      snippets.push({
        source,
        type: "field",
        label: pair.label,
        value: pair.value
      });
    }
  }
  return snippets;
}

function interestingLabel(label) {
  return /用户|手机|姓名|昵称|机会|状态|品类|训练营|商品|课程|订单|付费|购买|销售|归属|跟进/i.test(label);
}

function extractLatestFollowUp(text) {
  const lines = String(text || "").split(/[。；\n]/).map(cleanText).filter(Boolean);
  return lines.find((line) => /跟进|回访|联系|沟通|备注/.test(line))?.slice(0, 120) || "";
}

function defaultFieldLabels() {
  return {
    userIdLabels: ["用户ID", "用户id", "UID", "uid"],
    phoneLabels: ["手机号", "手机号码", "联系电话", "电话"],
    nameLabels: ["姓名", "用户姓名", "昵称", "微信昵称", "学员名称"],
    chanceLabels: ["机会状态", "跟进状态", "销售阶段", "意向状态"],
    categoryLabels: ["所属品类", "课程品类", "品类"],
    startTimeLabels: ["支付时间", "订单支付时间", "下单时间", "开营时间", "开课时间", "开始时间"],
    campLabels: ["训练营名称", "营名称", "商品名称", "课程名称"],
    orderLabels: ["订单状态", "付费类型", "购买类型", "支付状态"],
    ownerLabels: ["销售归属人", "销售", "跟进人", "班主任", "归属人"]
  };
}

function extractOrderDetailRedBox(text, pairs) {
  const source = cleanText(text);
  const commonStops = ["商品ID", "商品名称", "所在期数", "开营时间", "训练营名称", "用户信息", "订单ID", "主订单ID", "正式营ID", "下单时间", "支付金额", "订单金额", "支付方式", "订单状态", "销售归属人", "分销人ID", "分销人名称", "下单链接"];
  return {
    category: firstNonEmpty(
      pickValue(pairs, ["所属品类"]),
      extractValueAfterLabel(source, "所属品类", commonStops.filter((item) => item !== "所属品类"))
    ),
    startTime: firstNonEmpty(
      pickValue(pairs, ["订单支付时间", "支付时间", "下单时间"]),
      extractValueAfterLabel(source, "支付时间", commonStops.filter((item) => item !== "支付时间").concat(["用户ID", "用户昵称", "手机号"])),
      extractValueAfterLabel(source, "下单时间", commonStops.filter((item) => item !== "下单时间").concat(["用户ID", "用户昵称", "手机号"]))
    ),
    trainingCampName: firstNonEmpty(
      pickValue(pairs, ["训练营名称"]),
      extractValueAfterLabel(source, "训练营名称", commonStops.filter((item) => item !== "训练营名称").concat(["用户ID", "用户昵称", "手机号"]))
    )
  };
}

function normalizeRedBox(redBox, pairs, text, fields) {
  const value = {
    category: normalizeOrderCategory(firstNonEmpty(
      redBox.category,
      pickValue(pairs, fields.categoryLabels || ["所属品类"]),
      extractValueAfterLabel(text, "所属品类", ["商品ID", "商品名称", "所在期数", "开营时间", "训练营名称", "用户信息"])
    )),
    startTime: firstNonEmpty(
      redBox.startTime,
      pickValue(pairs, fields.startTimeLabels || ["订单支付时间", "支付时间", "下单时间", "开营时间"]),
      extractValueAfterLabel(text, "支付时间", ["训练营名称", "用户信息", "用户ID", "下单链接"]),
      extractValueAfterLabel(text, "下单时间", ["训练营名称", "用户信息", "用户ID", "下单链接"])
    ),
    trainingCampName: firstNonEmpty(
      redBox.trainingCampName,
      pickValue(pairs, ["训练营名称"]),
      extractValueAfterLabel(text, "训练营名称", ["用户信息", "用户ID", "手机号", "下单链接"])
    )
  };
  value.text = [
    `所属品类：${value.category || ""}`,
    `支付时间：${value.startTime || ""}`,
    `训练营名称：${value.trainingCampName || ""}`
  ].join("\n");
  return value;
}

function extractValueAfterLabel(text, label, nextLabels) {
  const source = cleanText(text);
  const labelPattern = new RegExp(`${escapeRegExp(label)}\\s*[:：]\\s*`, "i");
  const match = labelPattern.exec(source);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = source.slice(start);
  const stops = nextLabels.map((item) => {
    const index = rest.search(new RegExp(`${escapeRegExp(item)}\\s*[:：]`, "i"));
    return index >= 0 ? index : Number.POSITIVE_INFINITY;
  });
  const end = Math.min(...stops, rest.length);
  return cleanText(rest.slice(0, end)).replace(/^[-—\s]+/, "").slice(0, 120);
}

function firstNonEmpty(...values) {
  return values.map((value) => cleanText(value)).find(Boolean) || "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeServiceUserId(value) {
  const normalized = String(value || "").trim();
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(normalized)) throw new Error("无效的网站用户标识");
  return normalized;
}

function overviewError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeSessionId(value) {
  const normalized = String(value || "").trim();
  if (!/^[a-zA-Z0-9._-]{8,256}$/.test(normalized)) throw new Error("无效的网站会话标识");
  return normalized;
}

function createLoginRequiredResult(query, expiresAt) {
  const lookup = query.userId
    ? { type: "userId", label: "用户ID", value: query.userId }
    : { type: "phone", label: "手机号", value: query.phone };
  return {
    ...createEmptyOverview(query, lookup),
    loginRequired: true,
    error: "兴趣岛登录态尚未就绪，请先完成站内扫码。",
    backendLoginExpiresAt: new Date(expiresAt).toISOString(),
    trace: ["等待扫码登录"]
  };
}
