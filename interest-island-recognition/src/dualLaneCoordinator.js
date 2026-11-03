const TERMINAL_STATES = new Set(["done", "failed"]);
const CHAT_CONTEXT_VERIFICATIONS = [
  "contextOpened",
  "domPersonListRefreshed",
  "domPersonIdentityVerified",
  "domSelectedPersonVerified",
  "domConversationUserIdVerified",
  "domQueryFormVerified",
  "domQueryResultTerminal",
  "domRightBubbleVerified"
];

function profileOutcome(state) {
  if (!TERMINAL_STATES.has(state.profileState)) return "pending";
  if (state.profileState === "failed") return "failed";
  const result = state.profileResult?.profile || state.profileResult || {};
  if (result.profileSkipped === true) return "skipped";
  // 只有 DOM 明确打开档案并返回 profileFound=true，才允许统计为档案成功。
  // 旧的异常包装对象常缺少该标记；若默认当成功，会造成页面显示“80/80”
  // 而 Q/R/S 实际尚未读取的假进度。
  if (result.profileFound !== true) return "failed";
  const hasCompleteArchive = [
    result.actualProductType,
    result.actualCampName,
    result.actualCourseCategory
  ].every((value) => String(value || "").trim());
  if (result.profileError || !hasCompleteArchive) return "partial";
  return "complete";
}

function classificationContext(value) {
  if (!value || typeof value !== "object") return null;
  if (value.context && typeof value.context === "object") return value.context;
  if (value.result?.context && typeof value.result.context === "object") return value.result.context;
  return null;
}

function hasChatTechnicalSuccess(state) {
  const context = classificationContext(state.classificationResult);
  return Boolean(
    state.classificationState === "done"
    && context
    && context.invalidContext !== true
    && CHAT_CONTEXT_VERIFICATIONS.every((key) => context[key] === true)
  );
}

export function createDualLaneCoordinator({
  rows,
  processClassification,
  processProfile,
  mergeRow,
  onMerged = () => {},
  onProgress = () => {},
  shouldStop = () => false,
  skipProfileLane = false,
  parallelLanes = true
}) {
  const orderedRows = [...(rows || [])];
  const states = new Map(orderedRows.map((row) => [row.rowNumber, {
    row,
    classificationState: "pending",
    profileState: skipProfileLane ? "done" : "pending",
    classificationResult: null,
    profileResult: skipProfileLane ? {
      rowNumber: row.rowNumber,
      row,
      profile: {
        profileSource: "chat-only-retry",
        profileSkipped: true,
        profileFound: false,
        profileError: ""
      }
    } : null,
    mergedResult: null
  }]));
  let sealed = false;

  const snapshot = () => ({
    merged: orderedRows.flatMap((row) => {
      const merged = states.get(row.rowNumber)?.mergedResult;
      return merged ? [merged] : [];
    }),
    states: orderedRows.map((row) => ({ ...states.get(row.rowNumber) }))
  });

  const emitProgress = (lane, rowNumber) => {
    const values = [...states.values()];
    const profileOutcomes = values.map(profileOutcome);
    const classificationTerminal = values.filter((state) => TERMINAL_STATES.has(state.classificationState));
    onProgress({
      lane,
      rowNumber,
      classification: classificationTerminal.length,
      chatSucceeded: classificationTerminal.filter(hasChatTechnicalSuccess).length,
      chatFailed: classificationTerminal.filter((state) => !hasChatTechnicalSuccess(state)).length,
      // 只计入已完整读回的 Q/R/S，不能将普通失败对象显示为成功。
      profile: profileOutcomes.filter((outcome) => outcome === "complete").length,
      profileAttempted: profileOutcomes.filter((outcome) => !["pending", "skipped"].includes(outcome)).length,
      profileSkipped: profileOutcomes.filter((outcome) => outcome === "skipped").length,
      profilePartial: profileOutcomes.filter((outcome) => outcome === "partial").length,
      profileFailed: profileOutcomes.filter((outcome) => outcome === "failed").length,
      merged: values.filter((state) => state.mergedResult).length,
      failed: values.filter((state, index) => state.classificationState === "failed" || profileOutcomes[index] === "failed").length,
      total: orderedRows.length
    });
  };

  const commitIfReady = (state) => {
    if (sealed || state.mergedResult) return;
    if (!TERMINAL_STATES.has(state.classificationState) || !TERMINAL_STATES.has(state.profileState)) return;
    state.mergedResult = mergeRow({
      row: state.row,
      classification: state.classificationResult,
      profile: state.profileResult
    });
    onMerged(state.mergedResult);
  };

  const processLaneRow = async (lane, processor, row) => {
    const state = states.get(row.rowNumber);
    state[`${lane}State`] = "running";
    try {
      state[`${lane}Result`] = await processor(row);
      state[`${lane}State`] = "done";
    } catch (error) {
      state[`${lane}Result`] = {
        rowNumber: row.rowNumber,
        lane,
        error: error?.stack || error?.message || String(error)
      };
      state[`${lane}State`] = "failed";
    }
    commitIfReady(state);
    emitProgress(lane, row.rowNumber);
  };

  const runLane = async (lane, processor) => {
    for (const row of orderedRows) {
      if (sealed || shouldStop()) break;
      await processLaneRow(lane, processor, row);
    }
  };

  const runRowsSequentially = async () => {
    for (const row of orderedRows) {
      if (sealed || shouldStop()) break;
      await processLaneRow("classification", processClassification, row);
      if (sealed || shouldStop()) break;
      if (!skipProfileLane) await processLaneRow("profile", processProfile, row);
    }
  };

  return {
    async run() {
      if (!parallelLanes) {
        await runRowsSequentially();
        return snapshot();
      }
      if (skipProfileLane) {
        await runLane("classification", processClassification);
        return snapshot();
      }
      await Promise.all([
        runLane("classification", processClassification),
        runLane("profile", processProfile)
      ]);
      return snapshot();
    },
    seal() {
      sealed = true;
    },
    snapshot
  };
}
