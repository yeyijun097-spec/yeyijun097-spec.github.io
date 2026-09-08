import { createQichatClient } from "./qlchatClient.js";

export function resolveContextHeartbeatStage(client) {
  const stage = client?.getProgressStage?.();
  return String(stage || "正在读取聊天上下文");
}

export function resolveRowHardTimeoutMs(config = {}) {
  const configured = Number(config?.ui?.rowHardTimeoutMs || 0);
  return Number.isFinite(configured) && configured > 0 ? Math.max(100, configured) : 0;
}

export async function createQichatDomClient(config, disabled = false) {
  const domConfig = {
    ...config,
    api: {
      ...(config.api || {}),
      capture: false
    }
  };
  const client = await createQichatClient(domConfig, disabled);
  return new QichatDomClient(client);
}

export class QichatDomClient {
  constructor(client) {
    this.client = client;
  }

  get context() {
    return this.client.context;
  }

  get page() {
    return this.client.page;
  }

  async ensureReady(waitForLogin = true) {
    return await this.client.ensureReady(waitForLogin);
  }

  async fetchContext(row) {
    const timeoutMs = resolveRowHardTimeoutMs(this.client?.config);
    const timeoutSeconds = timeoutMs > 0 ? Math.max(1, Math.ceil(timeoutMs / 1000)) : 0;
    const startedAt = Date.now();
    let heartbeat = null;
    let timeout = null;
    const work = this.client.fetchContext(row);
    const timed = timeoutMs > 0
      ? new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(`DOM_ROW_TIMEOUT: 行${row.rowNumber}右侧上下文超过${timeoutSeconds}秒`);
          error.code = "DOM_ROW_TIMEOUT";
          reject(error);
        }, timeoutMs);
      })
      : null;
    heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`WEB_ROW_HEARTBEAT=${JSON.stringify({
        lane: "classification",
        rowNumber: row.rowNumber,
        stage: resolveContextHeartbeatStage(this.client),
        elapsedSeconds: elapsed,
        ...(timeoutSeconds ? { timeoutSeconds } : {})
      })}`);
    }, 10000);
    heartbeat.unref?.();

    let context;
    try {
      context = timed ? await Promise.race([work, timed]) : await work;
    } catch (error) {
      if (error?.code !== "DOM_ROW_TIMEOUT") throw error;
      await this.client.abortCurrentPage?.().catch(() => {});
      let settleTimer = null;
      await Promise.race([
        work.catch(() => null),
        new Promise((resolve) => {
          settleTimer = setTimeout(resolve, 10000);
        })
      ]);
      clearTimeout(settleTimer);
      const recovery = await recoverClientPage(this.client);
      const recovered = recovery.ok;
      context = {
        contextSource: "ui",
        foundConversation: false,
        matchedMessage: false,
        contextText: "",
        userBubbleText: "",
        userBubbleMessages: [],
        userBubbleCount: 0,
        relatedRecords: 0,
        queryClicked: false,
        conversationClicked: false,
        recordClicked: false,
        contextOpened: false,
        invalidContext: true,
        invalidContextReason: recovered
          ? `右侧上下文超过${timeoutSeconds}秒，已重建查询页并跳过本行`
          : `右侧上下文超过${timeoutSeconds}秒，查询页恢复失败`,
        error: recovered
          ? `DOM右侧上下文超时，已恢复页面`
          : `DOM右侧上下文超时且页面恢复失败`,
        chatPageReset: {
          readyAfter: recovered,
          timedOut: true,
          elapsedMs: Date.now() - startedAt,
          recoveryStage: recovery.stage,
          recoveryError: recovery.error
        }
      };
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }

    if (/Target page, context or browser has been closed/i.test(String(context?.chatPageReset?.error || context?.error || ""))) {
      const recovery = await recoverClientPage(this.client);
      const recovered = recovery.ok;
      context = {
        ...context,
        invalidContext: true,
        invalidContextReason: recovered
          ? "企聊宝查询页意外关闭，已重建页面并跳过本行"
          : "企聊宝浏览器上下文已关闭，无法继续查询",
        error: recovered ? "企聊宝查询页已恢复" : "企聊宝浏览器上下文已关闭",
        chatPageReset: {
          ...(context.chatPageReset || {}),
          readyAfter: recovered,
          recoveredAfterClose: recovered,
          recoveryStage: recovery.stage,
          recoveryError: recovery.error
        }
      };
    }
    const isOffline = context.contextSource === "offline";
    return {
      ...context,
      contextSource: isOffline ? "offline" : "dom",
      domQueryClicked: Boolean(context.queryClicked),
      domRelatedRecords: Number(context.relatedRecords || 0),
      domMiddleOpened: Boolean(context.conversationClicked),
      domRightContextOpened: Boolean(context.contextOpened),
      domUserBubbleCount: Number(context.userBubbleCount || 0),
      domSearchKeywordTried: context.domSearchKeywordTried || [],
      domQueryResultChanged: Boolean(context.domQueryResultChanged),
      domRightBubbleVerified: Boolean(context.domRightBubbleVerified),
      domPersonCandidates: Number(context.domPersonCandidates || 0),
      domPersonCandidateTried: Number(context.domPersonCandidateTried || context.candidateTried || 0),
      domPersonCandidateTexts: context.domPersonCandidateTexts || [],
      domPersonExpectedName: context.domPersonExpectedName || "",
      domPersonInputValue: context.domPersonInputValue || "",
      domPersonListBeforeSignature: context.domPersonListBeforeSignature || "",
      domPersonListAfterSignature: context.domPersonListAfterSignature || "",
      domPersonListRefreshed: Boolean(context.domPersonListRefreshed),
      domPersonMatchLevel: Number(context.domPersonMatchLevel || 0),
      domPersonIdentityVerified: Boolean(context.domPersonIdentityVerified),
      domSelectedPersonText: context.domSelectedPersonText || "",
      domSelectedPersonVerified: Boolean(context.domSelectedPersonVerified),
      domConversationUserIdVerified: Boolean(context.domConversationUserIdVerified),
      domQueryExpectedUserId: context.domQueryExpectedUserId || "",
      domQueryActualUserId: context.domQueryActualUserId || "",
      domQueryFormVerified: Boolean(context.domQueryFormVerified),
      domQueryResultTerminal: Boolean(context.domQueryResultTerminal),
      invalidContext: Boolean(context.invalidContext),
      chatPageReset: context.chatPageReset || {},
      domCandidateSnapshotCount: Number(context.domCandidateSnapshotCount || 0),
      domCandidateAttemptDetails: context.domCandidateAttemptDetails || [],
      domCandidateFailureReason: context.domCandidateFailureReason || ""
    };
  }

  async expandContext(row, context, options = {}) {
    if (context?.contextSource === "offline") return context;
    const expanded = await this.client.expandRightContext(row, context, options);
    return {
      ...expanded,
      contextSource: expanded.contextSource === "offline" ? "offline" : "dom",
      domRightContextOpened: Boolean(expanded.contextOpened),
      domRightBubbleVerified: Boolean(expanded.domRightBubbleVerified)
    };
  }

  async close() {
    await this.client.close();
  }
}

async function recoverClientPage(client) {
  try {
    const result = await client?.recoverPage?.();
    if (result === true) return { ok: true, stage: "ready", error: "" };
    if (result?.ok === true) return { ok: true, stage: result.stage || "ready", error: "" };
    return {
      ok: false,
      stage: result?.stage || "unknown",
      error: String(result?.error || "页面恢复未完成").slice(0, 300)
    };
  } catch (error) {
    return { ok: false, stage: "exception", error: String(error?.message || error || "页面恢复异常").slice(0, 300) };
  }
}
