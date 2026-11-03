import { createQichatClient } from "./qlchatClient.js";

export function resolveContextHeartbeatStage(client) {
  const stage = client?.getProgressStage?.();
  return String(stage || "正在读取聊天上下文");
}

export function resolveRowHardTimeoutMs(config = {}) {
  const configured = Number(config?.ui?.rowHardTimeoutMs || 0);
  return Number.isFinite(configured) && configured > 0 ? Math.max(100, configured) : 180000;
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
    const timed = timeoutMs > 0
      ? new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(`DOM_ROW_TIMEOUT: 行${row.rowNumber}右侧上下文超过${timeoutSeconds}秒`);
          error.code = "DOM_ROW_TIMEOUT";
          reject(error);
        }, timeoutMs);
      })
      : null;
    const heartbeatIntervalMs = Math.max(10, Number(this.client?.config?.ui?.rowHeartbeatIntervalMs || 10000));
    heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`WEB_ROW_HEARTBEAT=${JSON.stringify({
        lane: "classification",
        rowNumber: row.rowNumber,
        stage: resolveContextHeartbeatStage(this.client),
        elapsedSeconds: elapsed,
        ...(timeoutSeconds ? { timeoutSeconds } : {})
      })}`);
    }, heartbeatIntervalMs);
    heartbeat.unref?.();

    try {
      const awaitWithinRow = (work) => timed ? Promise.race([work, timed]) : work;
      const work = this.client.fetchContext(row);
      let context;
      try {
        context = await awaitWithinRow(work);
      } catch (error) {
        if (error?.code !== "DOM_ROW_TIMEOUT") throw error;
        await this.client.abortCurrentPage?.().catch(() => {});
        work.catch(() => null);
        const recovery = await recoverClientPageAfterTimeout(this.client);
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
      }

      if (/Target page, context or browser has been closed/i.test(String(context?.chatPageReset?.error || context?.error || ""))) {
        let recovery;
        try {
          recovery = await recoverClientPageWithinRow(this.client, awaitWithinRow);
        } catch (error) {
          if (error?.code !== "DOM_ROW_TIMEOUT") throw error;
          const cleanupRecovery = await recoverClientPageAfterTimeout(this.client);
          recovery = {
            ok: false,
            stage: "row-timeout",
            error: cleanupRecovery.ok
              ? error.message
              : `${error.message}；超时清理恢复失败：${cleanupRecovery.error || cleanupRecovery.stage}`
          };
        }
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

      const initialFailureStage = resolveReplayTriggerStage(context, row);
      let replayAttempted = false;
      let replaySucceeded = false;
      let pageReloaded = false;
      let finalFailureStage = "";
      if (initialFailureStage) {
        replayAttempted = true;
        this.client.setProgressStage?.("正在刷新企聊宝页面并重放当前行");
        let recovery;
        try {
          recovery = await recoverClientPageWithinRow(this.client, awaitWithinRow);
        } catch (error) {
          if (error?.code !== "DOM_ROW_TIMEOUT") throw error;
          const cleanupRecovery = await recoverClientPageAfterTimeout(this.client);
          finalFailureStage = "row-timeout-recovery";
          const cleanupDetail = cleanupRecovery.ok
            ? error.message
            : `${error.message}；超时清理恢复失败：${cleanupRecovery.error || cleanupRecovery.stage}`;
          context = markReplayTechnicalFailure(context, finalFailureStage, cleanupDetail);
        }
        if (!finalFailureStage) {
          pageReloaded = recovery.ok;
          if (!recovery.ok) {
            finalFailureStage = `page-reload-${recovery.stage || "unknown"}`;
            context = markReplayTechnicalFailure(context, finalFailureStage, recovery.error);
          } else {
            try {
              const replayContext = await awaitWithinRow(this.client.fetchContext(row));
              const replayTriggerStage = resolveReplayTriggerStage(replayContext, row);
              const replayValidationStage = replayTriggerStage || resolveReplayValidationStage(replayContext, row);
              if (replayValidationStage) {
                finalFailureStage = replayValidationStage;
                context = markReplayTechnicalFailure(replayContext, finalFailureStage);
              } else {
                replaySucceeded = true;
                context = replayContext;
              }
            } catch (error) {
              if (error?.code === "DOM_ROW_TIMEOUT") {
                await this.client.abortCurrentPage?.().catch(() => {});
                const cleanupRecovery = await recoverClientPageAfterTimeout(this.client);
                finalFailureStage = "row-timeout-replay";
                if (!cleanupRecovery.ok) {
                  error.message = `${error.message}；超时清理恢复失败：${cleanupRecovery.error || cleanupRecovery.stage}`;
                }
              } else {
                finalFailureStage = "replay-exception";
              }
              context = markReplayTechnicalFailure({}, finalFailureStage, error?.message || String(error));
            }
          }
        }
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
        domCandidateFailureReason: context.domCandidateFailureReason || "",
        domReplayAttempted: replayAttempted,
        domReplaySucceeded: replaySucceeded,
        domInitialFailureStage: initialFailureStage,
        domFinalFailureStage: finalFailureStage,
        domPageReloaded: pageReloaded
      };
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
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

function resolveReplayTriggerStage(context = {}, row = {}) {
  if (context.contextSource === "offline" || context.chatPageReset?.timedOut) return "";
  if (context.invalidContext !== true && resolveReplayValidationStage(context, row) === "") return "";
  if (Object.hasOwn(context, "domPersonListRefreshed") && context.domPersonListRefreshed !== true) {
    return "person-list-not-refreshed";
  }
  if (hasSubmittedUnchangedQuery(context)) {
    return "query-result-unchanged";
  }
  if (isExplicitZeroRecordResult(context)) return "explicit-zero-records";
  return "";
}

function hasSubmittedUnchangedQuery(context = {}) {
  const attempts = Array.isArray(context.domCandidateAttemptDetails)
    ? context.domCandidateAttemptDetails
    : [];
  return attempts.some((attempt) => {
    const keywords = Array.isArray(attempt.keywords) ? attempt.keywords : [];
    return keywords.some((keyword) =>
      keyword.formVerified === true
      && keyword.queryClicked === true
      && keyword.resultChanged === false
    );
  });
}

function isExplicitZeroRecordResult(context = {}) {
  if (Number(context.relatedRecords || 0) !== 0 || context.domQueryResultChanged !== true) return false;
  const attempts = Array.isArray(context.domCandidateAttemptDetails)
    ? context.domCandidateAttemptDetails
    : [];
  if (!attempts.length) return false;
  return attempts.every((attempt) => {
    const keywords = Array.isArray(attempt.keywords) ? attempt.keywords : [];
    return Number(attempt.personMatchLevel || 0) > 0
      && attempt.selectedPersonVerified === true
      && keywords.length > 0
      && keywords.every((keyword) =>
        keyword.formVerified === true
        && keyword.queryClicked === true
        && keyword.resultChanged === true
        && keyword.resultTerminal === true
        && keyword.resultTerminalKind === "candidate-empty"
        && keyword.currentUserMatched !== true
        && Number(keyword.relatedRecords || 0) === 0
      );
  });
}

function resolveReplayValidationStage(context = {}, row = {}) {
  const expectedPersonName = String(row.receiverName || row.teacherName || row.senderName || "").trim();
  const expectedUserId = String(row.userId || "").trim();
  if (!expectedPersonName
    || String(context.domPersonExpectedName || "").trim() !== expectedPersonName
    || String(context.domPersonInputValue || "").trim() !== expectedPersonName
    || context.domPersonListRefreshed !== true
    || context.domPersonIdentityVerified !== true
    || context.domSelectedPersonVerified !== true) {
    return "teacher-not-verified";
  }
  if (!expectedUserId
    || String(context.domQueryExpectedUserId || "").trim() !== expectedUserId
    || String(context.domQueryActualUserId || "").trim() !== expectedUserId
    || context.domQueryFormVerified !== true) {
    return "excel-user-id-not-verified";
  }
  if (!hasVerifiedCurrentResultCard(context)
    || Number(context.relatedRecords || 0) <= 0
    || context.domQueryResultChanged !== true
    || context.domQueryResultTerminal !== true) {
    return "result-card-user-id-not-verified";
  }
  if (context.domConversationUserIdVerified !== true) {
    return "conversation-user-id-not-verified";
  }
  const userBubbleMessages = Array.isArray(context.userBubbleMessages) ? context.userBubbleMessages : [];
  if (context.contextOpened !== true
    || context.domRightBubbleVerified !== true
    || Number(context.userBubbleCount || 0) <= 0
    || userBubbleMessages.length <= 0) {
    return "right-user-bubble-not-verified";
  }
  return "";
}

function hasVerifiedCurrentResultCard(context = {}) {
  const attempts = Array.isArray(context.domCandidateAttemptDetails)
    ? context.domCandidateAttemptDetails
    : [];
  return attempts.some((attempt) => {
    const keywords = Array.isArray(attempt.keywords) ? attempt.keywords : [];
    return keywords.some((keyword) =>
      keyword.currentUserMatched === true
      && keyword.resultTerminal === true
      && keyword.resultTerminalKind === "current-user-records"
      && Number(keyword.relatedRecords || 0) > 0
    );
  });
}

function markReplayTechnicalFailure(context = {}, stage, detail = "") {
  const reason = [
    `企聊宝当前行刷新重放失败（${stage || "unknown"}）`,
    String(detail || context.error || context.domCandidateFailureReason || "").trim()
  ].filter(Boolean).join("：");
  return {
    ...context,
    foundConversation: false,
    matchedMessage: false,
    originalMessageMatched: false,
    matchedByRelatedRecords: false,
    conversationClicked: false,
    recordClicked: false,
    contextOpened: false,
    domRightContextOpened: false,
    contextText: "",
    userBubbleText: "",
    userBubbleMessages: [],
    userBubbleCount: 0,
    invalidContext: true,
    invalidContextReason: reason,
    error: reason
  };
}

async function recoverClientPage(client, signal) {
  try {
    const result = await client?.recoverPage?.(signal);
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

async function recoverClientPageAfterTimeout(client) {
  // 此时整行查询预算已经耗尽且当前页已被关闭。恢复属于交还共享页面
  // 所有权前的同步清理：必须等新查询页真正就绪，不能预先取消，也不能
  // 把恢复任务留在后台与下一行竞争 this.page。
  return await recoverClientPage(client);
}

async function recoverClientPageWithinRow(client, awaitWithinRow) {
  const controller = new AbortController();
  const recoveryWork = recoverClientPage(client, controller.signal);
  try {
    return await awaitWithinRow(recoveryWork);
  } catch (error) {
    if (error?.code !== "DOM_ROW_TIMEOUT") throw error;
    controller.abort();
    if (typeof client?.abortCurrentPage === "function") {
      await client.abortCurrentPage().catch(() => {});
    }
    await recoveryWork;
    throw error;
  }
}
