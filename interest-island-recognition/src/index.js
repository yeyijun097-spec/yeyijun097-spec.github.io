import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./envLoader.js";
import { readWorkbook, writeWorkbook } from "./excelBridge.js";
import { attachHistoricalExamples, classify, isNonPlatformComplaint } from "./ruleMatcher.js";
import { assertLlmConfigured, classifyWithLlm, resolveLlmSettings } from "./llmClassifier.js";
import { summarizeDialogWithLlm } from "./llmDialogSummarizer.js";
import { createQichatClient } from "./qlchatClient.js";
import { createQichatApiClient } from "./qlchatApiClient.js";
import { createQichatDomClient } from "./qlchatDomClient.js";
import { discoverApiMap, apiMapExists, apiMapPath } from "./apiDiscovery.js";
import { createChanceAssApiClient, discoverChanceApiMap, chanceApiMapExists, chanceApiMapPath, chanceConfig } from "./chanceAssApiClient.js";
import { createChanceAssDomClient } from "./chanceAssDomClient.js";
import { shouldRetryDomRecognition } from "./domRecognitionGuards.js";
import { createCompletedResultsCheckpoint, createGracefulStopController } from "./gracefulStop.js";
import { createDualLaneCoordinator } from "./dualLaneCoordinator.js";
import { mergeDualLaneRow } from "./dualLaneMerge.js";
import { createLogger } from "./logger.js";
import { resolveWorkbookPath } from "./workbookResolver.js";

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  validateArgs(args);
  const configPath = args.config || "config/default.json";
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const workbookResolution = resolveWorkbookPath(config, args);
  const limit = args.limit ? Number(args.limit) : null;
  const fromRow = args["from-row"] ? Number(args["from-row"]) : config.startRow;
  const toRow = args["to-row"] ? Number(args["to-row"]) : null;
  const debugRow = args["debug-row"] ? Number(args["debug-row"]) : null;
  const write = Boolean(args.write);
  const { offline, disableLlm } = resolveRuntimeMode(args);
  const keepOpen = Boolean(args["keep-open"]);
  const chatOnly = Boolean(args["chat-only"]);
  const autoWriteEvery = Number(args["auto-write-every"] || config.batch?.autoWriteEvery || 0);
  // 默认保留配置中的在线 DOM 与模型能力；只有显式离线或仅关闭模型时才收窄能力。
  if (disableLlm) {
    config.llm = { ...(config.llm || {}), enabled: false };
    config.contextExtractor = { ...(config.contextExtractor || {}), enabled: false };
  }
  if (offline) {
    config.chance = { ...(config.chance || {}), enabled: false, url: "about:blank" };
    config.browser = { ...(config.browser || {}), url: "about:blank", headless: true };
  }
  const llmSettings = resolveLlmSettings(config, args);
  const contextMode = resolveContextMode(config, args, offline);
  const logger = createLogger();
  const stopController = createGracefulStopController();
  stopController.install();

  if (debugRow) {
    config.debug = { enabled: true, dir: "debug" };
  }
  if (args["capture-api"]) {
    config.api = { ...(config.api || {}), capture: true };
  }

  const { rows, rules } = readWorkbook(config);
  const enrichedRules = attachHistoricalExamples(rules, rows);
  const retryRows = args["retry-failed"] ? failedRowsFromLog(args["retry-failed"]) : null;
  // 历史结果中的待复核、低置信度和旧写回文案行可以被定向重识别，
  // 但绝不在筛选阶段直接改写工作簿。
  const reviewRows = args["retry-review"] ? reviewRowsFromLog(args["retry-review"]) : null;
  const explicitRows = args["row-list"] ? parseRowList(args["row-list"]) : null;
  const resumeRows = args.resume ? completedRowsFromLog(args.resume) : new Set();
  const selectedRows = rows
    .filter((row) => row.rowNumber >= fromRow)
    .filter((row) => (toRow ? row.rowNumber <= toRow : true))
    .filter((row) => (debugRow ? row.rowNumber === debugRow : true))
    .filter((row) => (retryRows ? retryRows.has(row.rowNumber) : true))
    .filter((row) => (reviewRows ? reviewRows.has(row.rowNumber) : true))
    .filter((row) => (explicitRows ? explicitRows.has(row.rowNumber) : true))
    .filter((row) => (!resumeRows.has(row.rowNumber)))
    .slice(0, limit || undefined);

  console.log(`读取 ${config.targetSheet}：${rows.length} 行；本次处理 ${selectedRows.length} 行；规则 ${enrichedRules.length} 条。`);
  if (workbookResolution.changed) {
    console.log(`原 Excel 路径不存在：${workbookResolution.missingPath}`);
    console.log(`已自动改用最新匹配文件：${workbookResolution.path}`);
  }
  console.log(`日志：${logger.file}`);
  console.log(`上下文模式：${formatContextMode(contextMode)}。`);
  if (args["chance-discover"]) {
    const discovery = await discoverChanceApiMap({ config, row: selectedRows[0], keepOpen });
    console.log(`chanceAss接口发现完成：${discovery.file}`);
    console.log(`捕获接口事件：${discovery.eventCount} 条；保存请求模板 ${discovery.map.requests.length} 条。`);
    const labels = discovery.map.profile?.validation?.matchedLabels || [];
    const validation = discovery.map.profile?.validation || {};
    const campSource = validation.hasTrainingName ? "详情训练营名称" : "订单商品名称兜底";
    const typeSource = validation.hasCampTypeId ? "详情营ID" : "订单购买类型";
    console.log(`已验证字段：${typeSource} / ${campSource} / 详情所属品类${labels.length ? `（${labels.join("，")}）` : ""}。`);
    if (keepOpen) console.log("已启用 --keep-open，浏览器将保持打开。");
    return;
  }
  if (args["api-discover"]) {
    const discovery = await discoverApiMap({ config, row: selectedRows[0], keepOpen });
    console.log(`接口发现完成：${discovery.file}`);
    console.log(`捕获接口事件：${discovery.eventCount} 条；搜索映射分数 ${discovery.map.search.score}，详情映射分数 ${discovery.map.detail.score}。`);
    if (keepOpen) console.log("已启用 --keep-open，浏览器将保持打开。");
    return;
  }
  if (contextMode === "api" && selectedRows.length && !apiMapExists(config)) {
    if (config.api?.discoverOnMissingMap === false) {
      throw new Error(`未找到企聊宝接口映射：${apiMapPath(config)}。请先运行 npm run api:discover -- --debug-row 3`);
    }
    console.log("未找到接口映射，先用首行样本自动发现企聊宝接口...");
    const discovery = await discoverApiMap({ config, row: selectedRows[0], keepOpen: false });
    console.log(`接口发现完成：${discovery.file}`);
  }
  const chanceEnabled = chanceConfig(config).enabled !== false && !offline;
  if (contextMode !== "dom" && chanceEnabled && selectedRows.length && !chanceApiMapExists(config)) {
    if (chanceConfig(config).discoverOnMissingMap === false) {
      throw new Error(`未找到 chanceAss 接口映射：${chanceApiMapPath(config)}。请先运行 npm run chance:discover -- --debug-row 3`);
    } else {
      console.log("未找到 chanceAss 接口映射，先进入发现模式。");
      const discovery = await discoverChanceApiMap({ config, row: selectedRows[0], keepOpen: false });
      console.log(`chanceAss接口发现完成：${discovery.file}`);
    }
  }
  if (llmSettings.enabled && selectedRows.length) {
    assertLlmConfigured(llmSettings);
    console.log(`大模型分类：已启用 ${llmSettings.provider || "deepseek"} / ${llmSettings.model}，并发 ${llmSettings.concurrency || 3}；外部模型数据处理已授权，载荷已脱敏并最小化。`);
  } else if (llmSettings.llmDisabledReason) {
    console.log(`大模型分类：${llmSettings.llmDisabledReason}`);
  } else {
    console.log("大模型分类：已关闭，使用本地规则。");
  }
  if (retryRows) {
    console.log(`失败重跑：已从日志筛选 ${retryRows.size} 行，本次命中 ${selectedRows.length} 行。`);
  }
  if (reviewRows) {
    console.log(`建议复核重跑：已从日志筛选 ${reviewRows.size} 行，本次命中 ${selectedRows.length} 行。`);
  }
  if (explicitRows) {
    console.log(`指定行重跑：请求 ${explicitRows.size} 行，本次命中 ${selectedRows.length} 行。`);
  }
  if (chatOnly) {
    console.log("稳定兜底：本轮只重跑聊天上下文和分类，保留首轮已成功的 Q/R/S。");
  }
  if (resumeRows.size) {
    console.log(`断点续跑：已跳过日志中存在结果的 ${resumeRows.size} 行，本次剩余 ${selectedRows.length} 行。`);
  }

  // 登录检查发生在批处理 try/finally 之外。全流程模式会先用无头进程
  // 检查登录，失败后再切换有头进程；如果这里抛错而不主动关闭上下文，
  // 无头 Chromium 会继续占用同一个 userDataDir，后续有头进程虽然能打开
  // 页面，却可能读到未同步的登录态，表现为 chanceAss 反复要求扫码。
  // 因此把启动和两套登录检查放进可回收的保护块，任何失败都先关闭浏览器。
  const client = await createContextClient({ config, offline, contextMode });
  let profileClient = null;
  stopController.setOnStopRequested(async () => {
    await profileClient?.close?.().catch(() => {});
    await client.close().catch(() => {});
  });
  let readiness;
  let profileReadiness;
  try {
    readiness = await client.ensureReady(!offline);
    if (!readiness.ready && !offline) {
      throw new Error("未检测到企聊宝查询页，请确认已扫码登录并进入聊天记录页面后重试。");
    }
    if (readiness.waitedForLogin) {
      console.log("已继续执行：扫码登录等待结束。");
    }
    profileClient = chatOnly
      ? createSkippedProfileClient()
      : (contextMode === "dom"
        ? await createChanceAssDomClient(config, client, offline || chanceConfig(config).enabled === false)
        : await createChanceAssApiClient(config, client, offline || chanceConfig(config).enabled === false));
    profileReadiness = await profileClient.ensureReady(
      !chatOnly && !offline && chanceConfig(config).enabled !== false
    );
    if (!profileReadiness.ready && !chatOnly && !offline && chanceConfig(config).enabled !== false) {
      throw new Error("未检测到 chanceAss 机会管理页，登录验证尚未真正完成，已停止识别写回。请完成二维码验证后重试。");
    }
    if (profileReadiness.waitedForLogin) {
      console.log("已继续执行：chanceAss 登录/验证等待结束。");
    }
  } catch (error) {
    await profileClient?.close?.().catch(() => {});
    await client.close().catch(() => {});
    throw error;
  }
  if (args["login-only"]) {
    await client.close().catch(() => {});
    await profileClient.close().catch(() => {});
    console.log("登录态检查完成，login-only 阶段结束，未执行识别写回。");
    if (stopController.requested) process.exitCode = 130;
    stopController.dispose();
    return;
  }
  const results = [];
  const entries = [];
  const contextCache = new Map();
  const profileCache = new Map();
  const llmConcurrency = llmSettings.enabled ? Math.max(1, Number(llmSettings.concurrency || 3)) : 1;
  const llmLimit = createLimiter(llmConcurrency);
  const outputPath = write ? (args.output ? path.resolve(args.output) : config.workbookPath) : "";
  if (write) fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  let lastAutoWriteCount = 0;
  let dualLaneCoordinator = null;
  const cancellationCheckpoint = createCompletedResultsCheckpoint({
    enabled: write,
    outputPath,
    getUpdates: () => buildWritableUpdates(results),
    write: (updates) => writeWorkbook(config, outputPath, updates)
  });

  // 登录阶段安装的回调只负责关闭浏览器。进入行处理后，
  // 改为先同步写回 results 快照，再中止当前页面操作。这样不会
  // 因浏览器 close 超时而丢失上一个已完整行。
  stopController.setOnStopRequested(async () => {
    try {
      dualLaneCoordinator?.seal();
      const checkpoint = cancellationCheckpoint.save();
      if (checkpoint.saved) {
        console.log(`WEB_RECOGNITION_PARTIAL_RESULT=${outputPath}`);
      }
    } finally {
      await profileClient?.close?.().catch(() => {});
      await client.close().catch(() => {});
    }
  });

  const processClassificationRow = async (row) => {
    const startedAt = Date.now();
    const contextKey = contextCacheKey(row);
    let contextCacheHit = false;
    const contextStart = Date.now();
    let cachedContext = contextCache.get(contextKey);
    if (cachedContext) {
      contextCacheHit = true;
    } else {
      cachedContext = client.fetchContext(row);
      contextCache.set(contextKey, cachedContext);
    }
    const contextValue = await cachedContext;
    let context = enforceDomContextIdentityGate(contextMode, cloneContext(contextValue));
    const kEvidence = classifyKMessageEvidence(row.message || row.existing?.K || "");
    context = { ...context, ...kEvidence };
    if (!contextCacheHit) contextCache.set(contextKey, cloneContext(context));
    const measuredContextMs = contextCacheHit ? 0 : Date.now() - contextStart;
    const contextMs = context.contextMs || measuredContextMs;
    const runClassification = async (currentContext) => {
      if (contextMode === "dom" && currentContext.invalidContext) {
        const blocked = blockedClassificationResult(currentContext);
        return { ruleResult: blocked, result: blocked };
      }
      const currentRuleResult = classify({
        row,
        contextText: currentContext.contextText,
        rules: enrichedRules,
        contextOpened: currentContext.contextOpened,
        includeOriginalMessageEvidence: currentContext.kEvidenceStrong === true
      });
      const llmStart = Date.now();
      const currentResult = await withProgressHeartbeat(`行${row.rowNumber}正在等待豆包分类`, llmLimit(async () => {
        const value = llmSettings.enabled
          ? await classifyWithLlm({ row, context: currentContext, rules: enrichedRules, ruleResult: currentRuleResult, settings: llmSettings })
          : { ...currentRuleResult, classifier: "rule" };
        return { ...value, llmMs: Date.now() - llmStart };
      }));
      return {
        ruleResult: currentRuleResult,
        result: applyClassificationEvidenceGuards(currentResult, row, currentContext, enrichedRules)
      };
    };

    let { ruleResult, result } = await runClassification(context);
    const expandDecision = shouldExpandDomContext({
      contextMode,
      client,
      context,
      result,
      llmSettings,
      args
    });
    if (expandDecision.expand) {
      const expandedContext = await client.expandContext(row, context, {
        beforeScreens: expandDecision.beforeScreens,
        afterScreens: expandDecision.afterScreens,
        reason: expandDecision.reason
      });
      if (expandedContext?.contextExpanded) {
        context = {
          ...expandedContext,
          ...kEvidence,
          contextExpandReason: expandDecision.reason
        };
        contextCache.set(contextKey, cloneContext(context));
        const firstLlmMs = result.llmMs || 0;
        const second = await runClassification(context);
        ruleResult = second.ruleResult;
        result = {
          ...second.result,
          llmMs: firstLlmMs + (second.result.llmMs || 0),
          contextExpandedClassification: true
        };
        result.reason = `${result.reason || ""}；${result.needsReview ? "扩展后仍待复核" : "已扩展上下文后重新分类"}`;
      } else {
        context = {
          ...context,
          contextExpanded: false,
          contextExpandReason: expandDecision.reason,
          contextExpandError: expandedContext?.contextExpandError || "扩展上下文失败"
        };
      }
    }

    result.contextOpened = Boolean(context.contextOpened);
    result.domModeContext = contextMode === "dom";
    result.invalidContext = Boolean(context.invalidContext);
    result.invalidContextReason = context.invalidContextReason || result.invalidContextReason || "";
    result.contextSource = context.contextSource || "";
    result.relatedRecords = context.relatedRecords || 0;
    result.docProductType = row.docProductType || row.existing?.L || "";
    result.docCampName = row.docCampName || row.existing?.M || "";
    if (context.relatedRecords > 0 && (!context.conversationClicked || !context.recordClicked || !context.contextOpened)) {
      result.needsReview = true;
      result.reason = `${result.reason}；${context.contextSource === "api" ? "接口已查到相关记录，但未可靠提取上下文" : "网页已查到相关记录，但未完整打开右侧上下文"}`;
    } else if (!context.matchedMessage && context.error !== "offline mode") {
      result.needsReview = true;
      result.reason = `${result.reason}；${context.contextSource === "api" ? "接口未成功提取可用于判断的上下文" : "网页未成功打开可用于判断的右侧上下文"}`;
    }
    const categoryPatch = applyExperienceComplaintCategoryPatch(result, row, context);
    if (categoryPatch.applied) {
      result = categoryPatch.result;
    }
    result = applyClassificationEvidenceGuards(result, row, context, enrichedRules);
    enforceRiskConsistency(result, context);
    const riskLevel = classifyRiskLevel(result, row, context);
    result.riskLevel = riskLevel.level;
    result.riskAssessedLevel = riskLevel.assessedLevel || riskLevel.level;
    result.riskReason = riskLevel.reason;
    result.riskMatchedKeywords = riskLevel.matchedKeywords;
    const dialogContext = context.invalidContext
      ? blockedDialogContext(row, context)
      : await buildDialogContextForRow({ row, context, client, contextMode, args });
    const dialogSummaryStart = Date.now();
    const dialogSummary = context.invalidContext
      ? blockedDialogSummary(context)
      : await withProgressHeartbeat(`行${row.rowNumber}正在等待豆包生成三天总结`, llmLimit(() => summarizeDialogWithLlm({
        row,
        context: {
          ...dialogContext,
          userSummary: result.userSummary || ""
        },
        settings: llmSettings
      })));
    Object.assign(result, dialogContext, dialogSummary, {
      dialogSummaryMs: Date.now() - dialogSummaryStart
    });
    const summaryAwareContext = {
      ...context,
      ...dialogContext,
      contextText: dialogContext.dialogContextText || context.contextText || "",
      userBubbleText: dialogContext.dialogStudentText || context.userBubbleText || ""
    };
    const summaryAwareCategoryPatch = applyExperienceComplaintCategoryPatch(
      result,
      row,
      summaryAwareContext
    );
    if (summaryAwareCategoryPatch.applied) {
      result = summaryAwareCategoryPatch.result;
    }
    result = applyClassificationEvidenceGuards(result, row, summaryAwareContext, enrichedRules);
    enforceRiskConsistency(result, summaryAwareContext);
    const summaryFallbackResult = await trySummaryBasedCategoryFallback({
      row,
      context,
      result,
      rules: enrichedRules,
      llmSettings,
      llmLimit
    });
    if (summaryFallbackResult) {
      result = summaryFallbackResult;
      const summaryCategoryPatch = applyExperienceComplaintCategoryPatch(
        result,
        row,
        summaryAwareContext
      );
      if (summaryCategoryPatch.applied) {
        result = summaryCategoryPatch.result;
      }
      result = applyClassificationEvidenceGuards(result, row, summaryAwareContext, enrichedRules);
      enforceRiskConsistency(result, summaryAwareContext);
      const recalculatedRiskLevel = classifyRiskLevel(result, row, summaryAwareContext);
      result.riskLevel = recalculatedRiskLevel.level;
      result.riskAssessedLevel = recalculatedRiskLevel.assessedLevel || recalculatedRiskLevel.level;
      result.riskReason = recalculatedRiskLevel.reason;
      result.riskMatchedKeywords = recalculatedRiskLevel.matchedKeywords;
    }
    // 三天总结可能补充出 K 列和首屏没有的风险证据，最终写回前必须再做一次一致性校验。
    result = applyClassificationEvidenceGuards(result, row, summaryAwareContext, enrichedRules);
    enforceRiskConsistency(result, summaryAwareContext);
    const finalRiskLevel = classifyRiskLevel(result, row, summaryAwareContext);
    result.riskLevel = finalRiskLevel.level;
    result.riskAssessedLevel = finalRiskLevel.assessedLevel || finalRiskLevel.level;
    result.riskReason = finalRiskLevel.reason;
    result.riskMatchedKeywords = finalRiskLevel.matchedKeywords;
    // 写回桥接以 rowNumber 定位 Excel 行。分类结果此前没有携带该字段，
    // 阶段性写回会生成缺少 rowNumber 的更新对象并让 Python bridge 失败。
    result.rowNumber = row.rowNumber;

    return {
      rowNumber: row.rowNumber,
      row,
      context: summaryAwareContext,
      result,
      ruleResult,
      timing: {
        startedAt,
        contextMs,
        contextCacheHit,
        totalMs: Date.now() - startedAt,
        llmMs: result.llmMs || 0
      }
    };
  };

  const processProfileRow = async (row) => {
    const startedAt = Date.now();
    const profileKey = profileCacheKey(row);
    let profileCacheHit = true;
    let cachedProfile = profileCache.get(profileKey);
    if (!cachedProfile) {
      profileCacheHit = false;
      cachedProfile = profileClient.fetchProfile(row);
      profileCache.set(profileKey, cachedProfile);
    }
    try {
      const profile = cloneContext(await cachedProfile);
      return {
        rowNumber: row.rowNumber,
        row,
        profile,
        timing: { profileMs: Date.now() - startedAt, profileCacheHit }
      };
    } catch (error) {
      profileCache.delete(profileKey);
      throw error;
    }
  };

  const finalizeMergedRow = (merged) => {
    let { result } = merged;
    if (result.error && !result.firstCategory) {
      merged.result = result;
      return merged;
    }
    const categoryPatch = applyExperienceComplaintCategoryPatch(result, merged.row, merged.context);
    if (categoryPatch.applied) result = categoryPatch.result;
    result = applyClassificationEvidenceGuards(result, merged.row, merged.context, enrichedRules);
    enforceRiskConsistency(result, merged.context);
    const riskLevel = classifyRiskLevel(result, merged.row, merged.context);
    Object.assign(result, {
      rowNumber: merged.row.rowNumber,
      riskLevel: riskLevel.level,
      riskAssessedLevel: riskLevel.assessedLevel || riskLevel.level,
      riskReason: riskLevel.reason,
      riskMatchedKeywords: riskLevel.matchedKeywords
    });
    merged.result = result;
    return merged;
  };

  const commitMergedRow = (merged) => {
    const entry = buildLogEntry({
      row: merged.row,
      context: merged.context,
      profile: merged.profile,
      result: merged.result,
      ruleResult: merged.ruleResult,
      readiness,
      timing: {
        ...merged.timing,
        totalMs: Date.now() - (merged.timing.startedAt || Date.now())
      }
    });
    logger.write(entry);
    entries.push(entry);
    results.push(merged.result);
    console.log(formatResult(entry));
    if (write && autoWriteEvery > 0 && entries.length - lastAutoWriteCount >= autoWriteEvery) {
      writeWorkbook(config, outputPath, buildWritableUpdates(results));
      lastAutoWriteCount = entries.length;
      console.log(`自动写回：已阶段性写回 ${entries.length} 行完整双通道结果到 ${outputPath}`);
    }
  };

  dualLaneCoordinator = createDualLaneCoordinator({
    rows: selectedRows,
    // 7 月稳定路径是 DOM 按行串行：先完整读聊天上下文，再查档案。
    // 两个 FineBI 页面在同一持久浏览器上下文中并发会放大重绘和登录态波动。
    parallelLanes: contextMode !== "dom",
    skipProfileLane: chatOnly,
    processClassification: processClassificationRow,
    processProfile: processProfileRow,
    mergeRow: ({ row, classification, profile }) => mergeDualLaneRow({
      row,
      classification,
      profile,
      finalize: finalizeMergedRow
    }),
    onMerged: commitMergedRow,
    onProgress: (progress) => console.log(`WEB_LANE_PROGRESS=${JSON.stringify(progress)}`),
    shouldStop: () => stopController.requested
  });

  try {
    await dualLaneCoordinator.run();
  } finally {
    if (keepOpen && !stopController.requested) {
      console.log("已启用 --keep-open，浏览器将保持打开，便于继续观察页面。");
    } else {
      await client.close().catch(() => {});
    }
    await profileClient.close().catch(() => {});
  }

  if (write) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const writableUpdates = buildWritableUpdates(results);
    const writeResult = stopController.requested && cancellationCheckpoint.saved
      ? { updatedRows: cancellationCheckpoint.savedRows }
      : writeWorkbook(config, outputPath, writableUpdates);
    console.log(`已写回 ${writeResult.updatedRows} 行到：${outputPath}`);
    console.log("待复核或低置信度行不会被覆盖，请查看日志。默认直接更新读取的原 Excel。");
    if (stopController.requested) {
      console.log(`终止保存完成：已将 ${results.length} 行完整识别结果写入当前工作簿。`);
      console.log(`WEB_RECOGNITION_PARTIAL_RESULT=${outputPath}`);
      process.exitCode = 130;
    }
  } else {
    console.log("预览完成，未写回 Excel。需要写回时加 --write。");
  }

  printSummary(entries);
  stopController.dispose();
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function validateArgs(args) {
  const numericKeys = ["limit", "from-row", "to-row", "debug-row", "auto-write-every", "expand-screens", "image-expand-screens", "dialog-screens"];
  for (const key of numericKeys) {
    const value = args[key];
    if (value === undefined || value === true) continue;
    const text = String(value);
    if (text.includes("--")) {
      throw new Error(`参数 --${key} 的值 "${text}" 看起来粘上了另一个参数。请确认参数之间有空格，例如：--${key} ${text.split("--")[0]} --write`);
    }
    if (!Number.isFinite(Number(text))) {
      throw new Error(`参数 --${key} 的值必须是数字，当前是 "${text}"。`);
    }
  }
  if (args["row-list"] !== undefined && args["row-list"] !== true) {
    parseRowList(args["row-list"]);
  }
}

function parseRowList(value) {
  const rows = new Set();
  const text = String(value || "").trim();
  if (!text) throw new Error("参数 --row-list 不能为空。");
  for (const token of text.split(",").map((item) => item.trim()).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start) {
        throw new Error(`参数 --row-list 的范围无效：${token}`);
      }
      for (let row = start; row <= end; row += 1) rows.add(row);
      continue;
    }
    if (!/^\d+$/.test(token) || Number(token) < 1) {
      throw new Error(`参数 --row-list 只能包含行号或范围，当前无效项：${token}`);
    }
    rows.add(Number(token));
  }
  if (!rows.size) throw new Error("参数 --row-list 没有有效行号。");
  return rows;
}

function buildLogEntry({ row, context, profile = {}, result, ruleResult, readiness, timing }) {
  const categoryWritable = shouldWriteCategoryColumns(result);
  const riskWritable = shouldWriteRiskLevel(result);
  const riskEvidence = getClassificationRiskEvidence(result, row, context);
  return {
    rowNumber: row.rowNumber,
    userId: row.userId,
    receiverName: row.receiverName,
    message: row.message,
    docProductType: row.docProductType || row.existing?.L || "",
    docCampName: row.docCampName || row.existing?.M || "",
    foundConversation: context.foundConversation,
    matchedMessage: context.matchedMessage,
    originalMessageMatched: Boolean(context.originalMessageMatched),
    matchedByRelatedRecords: Boolean(context.matchedByRelatedRecords),
    relatedRecords: context.relatedRecords || 0,
    candidateTried: context.candidateTried || 0,
    queryClicked: Boolean(context.queryClicked),
    conversationClicked: Boolean(context.conversationClicked),
    recordClicked: Boolean(context.recordClicked),
    contextOpened: Boolean(context.contextOpened),
    personSearchName: context.personSearchName || "",
    searchKeyword: context.searchKeyword || "",
    loginReady: readiness.ready,
    waitedForLogin: Boolean(readiness.waitedForLogin),
    firstCategory: result.firstCategory,
    secondCategory: result.secondCategory,
    thirdCategory: result.thirdCategory,
    confidence: result.confidence,
    needsReview: result.needsReview,
    classifier: result.classifier || "rule",
    llmProvider: result.llmProvider || "",
    llmModel: result.llmModel || "",
    llmValidCategory: Boolean(result.llmValidCategory),
    llmReason: result.llmReason || "",
    llmEvidence: result.llmEvidence || "",
    llmError: result.llmError || "",
    llmRawSnippet: result.llmRawSnippet || "",
    llmCategoryCorrected: Boolean(result.llmCategoryCorrected),
    llmCategoryCorrectionReason: result.llmCategoryCorrectionReason || "",
    ruleFirstCategory: result.ruleFirstCategory || ruleResult.firstCategory || "",
    ruleSecondCategory: result.ruleSecondCategory || ruleResult.secondCategory || "",
    ruleThirdCategory: result.ruleThirdCategory || ruleResult.thirdCategory || "",
    ruleConfidence: result.ruleConfidence || ruleResult.confidence || 0,
    ruleReason: result.ruleReason || ruleResult.reason || "",
    diagnosis: diagnoseEntry(context, result),
    reason: result.reason,
    error: context.error,
    contextTextLength: context.contextText ? context.contextText.length : 0,
    contextLineCount: countTextLines(context.contextText),
    contextSnippet: context.contextText ? context.contextText.slice(0, 500) : "",
    contextSource: context.contextSource || "ui",
    chatPageReset: context.chatPageReset || {},
    contextExpanded: Boolean(context.contextExpanded),
    contextExpandReason: context.contextExpandReason || "",
    contextExpandError: context.contextExpandError || "",
    contextExpandBeforeScreens: context.contextExpandBeforeScreens || 0,
    contextExpandAfterScreens: context.contextExpandAfterScreens || 0,
    contextExpandedLineCount: context.contextExpandedLineCount || 0,
    contextExpandedUserBubbleCount: context.contextExpandedUserBubbleCount || 0,
    contextExpandedTextLength: context.contextExpandedTextLength || 0,
    contextExpandedClassification: Boolean(result.contextExpandedClassification),
    kEvidenceMode: context.kEvidenceMode || "",
    kEvidenceWeak: Boolean(context.kEvidenceWeak),
    kEvidenceReason: context.kEvidenceReason || "",
    kEvidenceContextSufficient: Boolean(result.kEvidenceContextSufficient),
    kEvidenceReviewRequired: Boolean(result.kEvidenceReviewRequired),
    kEvidenceGuardReason: result.kEvidenceGuardReason || "",
    kComplaintPatchApplied: Boolean(result.kComplaintPatchApplied),
    kComplaintPatchReason: result.kComplaintPatchReason || "",
    evidenceGuardApplied: Boolean(result.evidenceGuardApplied),
    evidenceGuardReason: result.evidenceGuardReason || "",
    domQueryClicked: Boolean(context.domQueryClicked),
    domRelatedRecords: context.domRelatedRecords || 0,
    domMiddleOpened: Boolean(context.domMiddleOpened),
    domRightContextOpened: Boolean(context.domRightContextOpened),
    domUserBubbleCount: context.domUserBubbleCount || 0,
    domSearchKeywordTried: context.domSearchKeywordTried || [],
    domQueryResultChanged: Boolean(context.domQueryResultChanged),
    domRightBubbleVerified: Boolean(context.domRightBubbleVerified),
    domPersonCandidates: context.domPersonCandidates || 0,
    domPersonCandidateTried: context.domPersonCandidateTried || 0,
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
    domReplayAttempted: Boolean(context.domReplayAttempted),
    domReplaySucceeded: Boolean(context.domReplaySucceeded),
    domInitialFailureStage: context.domInitialFailureStage || "",
    domFinalFailureStage: context.domFinalFailureStage || "",
    domPageReloaded: Boolean(context.domPageReloaded),
    domQueryRequestObserved: Boolean(context.domQueryRequestObserved),
    domQueryResponseObserved: Boolean(context.domQueryResponseObserved),
    domQueryResponseStatus: Number(context.domQueryResponseStatus || 0),
    domQueryResponseKind: context.domQueryResponseKind || "unknown",
    domQueryResponseCount: Number(context.domQueryResponseCount || 0),
    domQueryRenderObserved: Boolean(context.domQueryRenderObserved),
    domQueryLifecycleFailureStage: context.domQueryLifecycleFailureStage || "",
    invalidContext: Boolean(context.invalidContext || result.invalidContext),
    invalidContextReason: context.invalidContextReason || "",
    domCandidateSnapshotCount: context.domCandidateSnapshotCount || 0,
    domCandidateAttemptDetails: context.domCandidateAttemptDetails || [],
    domCandidateFailureReason: context.domCandidateFailureReason || "",
    userBubbleText: context.userBubbleText || "",
    userBubbleMessages: context.userBubbleMessages || [],
    userBubbleCount: context.userBubbleCount || 0,
    userDirectionReliable: context.userDirectionReliable !== false,
    userSummary: result.userSummary || "",
    summarySource: result.summarySource || "",
    summaryTruncated: Boolean(result.summaryTruncated),
    summaryError: result.summaryError || "",
    summaryCategoryUsed: Boolean(result.summaryCategoryUsed),
    summaryCategoryConfidence: result.summaryCategoryConfidence || 0,
    summaryDialogCategoryUsed: Boolean(result.summaryDialogCategoryUsed),
    summaryDialogCategorySource: result.summaryDialogCategorySource || "",
    summaryDialogCategoryReason: result.summaryDialogCategoryReason || "",
    riskConsistencyBlocked: Boolean(result.riskConsistencyBlocked),
    riskEvidenceQualified: Boolean(riskEvidence.qualified),
    riskEvidenceHasDissatisfaction: Boolean(riskEvidence.hasDissatisfaction),
    riskEvidenceHasUserDissatisfaction: Boolean(riskEvidence.hasUserDissatisfaction),
    riskEvidenceContextUserDissatisfaction: Boolean(riskEvidence.contextUserDissatisfaction),
    riskEvidenceCategoryMention: Boolean(riskEvidence.categoryRiskMention),
    riskEvidenceSummaryMention: Boolean(riskEvidence.summaryRiskMention),
    riskEvidenceTechnicalAlarm: Boolean(riskEvidence.technicalAlarm),
    riskEvidenceDomesticOnly: Boolean(riskEvidence.domesticOnly),
    riskEvidenceKTechnicalAlarm: Boolean(riskEvidence.kTechnicalAlarm),
    riskEvidenceKDomesticOnly: Boolean(riskEvidence.kDomesticOnly),
    riskEvidenceKBusinessConcern: Boolean(riskEvidence.kBusinessConcern),
    riskEvidenceNonBusinessKOnly: Boolean(riskEvidence.nonBusinessKOnly),
    riskEvidenceSummaryUserDissatisfaction: Boolean(riskEvidence.summaryUserDissatisfaction),
    riskEvidenceHasDetailedUserDissatisfaction: Boolean(riskEvidence.hasDetailedUserDissatisfaction),
    riskEvidenceKeywords: [...new Set([
      ...riskEvidence.externalComplaintMatches,
      ...riskEvidence.actionableRiskMatches,
      ...riskEvidence.highRiskMatches
    ])],
    categoryColumnsWritable: categoryWritable,
    categoryWriteBlockedReason: categoryWritable ? "" : categoryWriteBlockedReason(result),
    lowRiskRelaxedWritable: isAutoWritableLowRisk(result),
    riskLevel: result.riskLevel || "",
    riskAssessedLevel: result.riskAssessedLevel || result.riskLevel || "",
    riskReason: result.riskReason || "",
    riskMatchedKeywords: result.riskMatchedKeywords || [],
    categoryPatchApplied: Boolean(result.categoryPatchApplied),
    categoryPatchReason: result.categoryPatchReason || "",
    riskLevelWritable: riskWritable,
    riskWriteBlockedReason: riskWritable ? "" : riskWriteBlockedReason(result),
    dialogSummarySource: result.dialogSummarySource || "",
    dialogWindowStart: result.dialogWindowStart || "",
    dialogWindowEnd: result.dialogWindowEnd || "",
    dialogMessageCount: result.dialogMessageCount || 0,
    studentDialogMessageCount: result.studentDialogMessageCount || 0,
    teacherDialogMessageCount: result.teacherDialogMessageCount || 0,
    teacherHandlingMessageCount: result.teacherHandlingMessageCount || 0,
    overallDialogSummary: result.overallDialogSummary || "",
    studentDialogSummary: result.studentDialogSummary || "",
    teacherDialogSummary: result.teacherDialogSummary || "",
    teacherHandlingSummary: result.teacherHandlingSummary || "",
    teacherResponseStatus: result.teacherResponseStatus || "",
    teacherFollowupStatus: result.teacherFollowupStatus || "",
    teacherHandlingEvidence: result.teacherHandlingEvidence || "",
    dialogSummaryError: result.dialogSummaryError || "",
    dialogSummaryWarning: result.dialogSummaryWarning || "",
    dialogNeedsReview: Boolean(result.dialogNeedsReview),
    dialogSummaryConfidence: result.dialogSummaryConfidence || 0,
    overallDialogConfidence: result.overallDialogConfidence || 0,
    studentDialogConfidence: result.studentDialogConfidence || 0,
    teacherDialogConfidence: result.teacherDialogConfidence || 0,
    dialogSummaryMs: result.dialogSummaryMs || 0,
    dialogDomScrolledBefore: result.dialogDomScrolledBefore || 0,
    dialogDomScrolledAfter: result.dialogDomScrolledAfter || 0,
    dialogDomReachedWindowBoundary: Boolean(result.dialogDomReachedWindowBoundary),
    contextMs: timing.contextMs || 0,
    llmMs: timing.llmMs || 0,
    totalMs: timing.totalMs || 0,
    contextCacheHit: Boolean(timing.contextCacheHit),
    webTimings: context.webTimings || {},
    apiSearchMs: context.apiSearchMs || 0,
    apiDetailMs: context.apiDetailMs || 0,
    apiDiscoveryUsed: Boolean(context.apiDiscoveryUsed),
    apiEndpointMatched: Boolean(context.apiEndpointMatched),
    apiError: context.apiError || "",
    apiCandidateCount: context.apiCandidateCount || 0,
    apiMessageCount: context.apiMessageCount || 0,
    apiUserMessageCount: context.apiUserMessageCount || 0,
    contextExtractor: context.contextExtractor || "",
    contextExtractConfidence: context.contextExtractConfidence || 0,
    contextExtractReason: context.contextExtractReason || "",
    rawStatusTextFiltered: context.rawStatusTextFiltered || 0,
    llmContextUsed: Boolean(context.llmContextUsed),
    apiMessageExtractPath: context.apiMessageExtractPath || "",
    apiRawMessageArrayCount: context.apiRawMessageArrayCount || 0,
    apiFilteredStatusTextCount: context.apiFilteredStatusTextCount || 0,
    apiStaffUserId: context.apiStaffUserId || "",
    apiStaffUserIdMissing: Boolean(context.apiStaffUserIdMissing),
    apiCrossStaffSearch: Boolean(context.apiCrossStaffSearch),
    apiRequestAdjustments: context.apiRequestAdjustments || [],
    apiDetailTried: context.apiDetailTried || 0,
    apiCandidateIds: context.apiCandidateIds || [],
    apiBindingApplied: context.apiBindingApplied || [],
    apiDetailStatuses: context.apiDetailStatuses || [],
    contextExtractorAttempted: Boolean(context.contextExtractorAttempted),
    contextExtractorError: context.contextExtractorError || "",
    apiStaffCandidates: context.apiStaffCandidates || [],
    apiStaffResolveError: context.apiStaffResolveError || "",
    profileSource: profile.profileSource || "",
    profileSkipped: Boolean(profile.profileSkipped),
    profileQuerySucceeded: Boolean(profile.profileQuerySucceeded ?? profile.profileDomQueryResultFound ?? profile.profileFound),
    profileFailureStage: profile.profileFailureStage || "",
    profilePageReset: profile.profilePageReset || {},
    profileFound: Boolean(profile.profileFound),
    profileCandidateCount: profile.profileCandidateCount || 0,
    profileSelectedReason: profile.profileSelectedReason || "",
    profilePartialFields: profile.profilePartialFields || {},
    profileExtractor: profile.profileExtractor || "",
    profileExtractConfidence: profile.profileExtractConfidence || 0,
    profileExtractReason: profile.profileExtractReason || "",
    profileEvidenceFields: profile.profileEvidenceFields || {},
    profileLlmError: profile.profileLlmError || "",
    profileSanitized: Boolean(profile.profileSanitized),
    profileDetailEndpointMatched: Boolean(profile.profileDetailEndpointMatched),
    profileDetailHasTrainingName: Boolean(profile.profileDetailHasTrainingName),
    profileDetailHasCategory: Boolean(profile.profileDetailHasCategory),
    profileDetailHasCampTypeId: Boolean(profile.profileDetailHasCampTypeId),
    profileDetailLabels: profile.profileDetailLabels || [],
    profileOrderListHasProductType: Boolean(profile.profileOrderListHasProductType),
    profileOrderListProductType: profile.profileOrderListProductType || "",
    profileOrderListLabels: profile.profileOrderListLabels || [],
    profileOrderCardProductName: profile.profileOrderCardProductName || "",
    profileFormalOrderFound: Boolean(profile.profileFormalOrderFound),
    profileMatchedOrderType: profile.profileMatchedOrderType || "",
    profileMatchedOrderName: profile.profileMatchedOrderName || "",
    profileMatchedOrderId: profile.profileMatchedOrderId || "",
    profileOrderSelectionReason: profile.profileOrderSelectionReason || "",
    profileDomOrderTextSnippet: profile.profileDomOrderTextSnippet || "",
    profileDomQueryResultFound: Boolean(profile.profileDomQueryResultFound),
    profileDomQueryTextSnippet: profile.profileDomQueryTextSnippet || "",
    profileDomUserIdFilled: Boolean(profile.profileDomUserIdFilled),
    profileDomUserIdVerified: Boolean(profile.profileDomUserIdVerified),
    profileDomSearchDateRange: profile.profileDomSearchDateRange || {},
    profileDateCleared: Boolean(profile.profileDateCleared),
    profileDomStudentArchiveButtonFound: Boolean(profile.profileDomStudentArchiveButtonFound),
    profileDomStudentArchiveClickStrategy: profile.profileDomStudentArchiveClickStrategy || "",
    profileDomArchiveOpened: Boolean(profile.profileDomArchiveOpened),
    profileDomArchiveVerifyText: profile.profileDomArchiveVerifyText || "",
    profileDomStillOnChanceList: Boolean(profile.profileDomStillOnChanceList),
    profileDomArchiveVerifyFailedReason: profile.profileDomArchiveVerifyFailedReason || "",
    profileDomOrderTabOpened: Boolean(profile.profileDomOrderTabOpened),
    profileDomWrongPageForOrderParse: profile.profileDomWrongPageForOrderParse || "",
    profileDomOrderCount: profile.profileDomOrderCount || 0,
    profileOrderScrollCompleted: profile.profileOrderScrollCompleted || {},
    profileOrderMatchScore: profile.profileOrderMatchScore || 0,
    profileDomMatchedOrderText: profile.profileDomMatchedOrderText || "",
    profileDomDetailOpened: Boolean(profile.profileDomDetailOpened),
    profileDomDetailTextSnippet: profile.profileDomDetailTextSnippet || "",
    profileCampNameFallbackUsed: Boolean(profile.profileCampNameFallbackUsed),
    profileCampNameFallbackSource: profile.profileCampNameFallbackSource || "",
    profileCampNameRejectedReason: profile.profileCampNameRejectedReason || "",
    profileApiTried: profile.profileApiTried || 0,
    profileBindingApplied: profile.profileBindingApplied || [],
    profileMs: profile.profileMs || 0,
    profileError: profile.profileError || "",
    profileDocumentFallbackUsed: Boolean(result.profileDocumentFallbackUsed),
    profileDocumentFallbackFields: result.profileDocumentFallbackFields || [],
    profileColumnStatus: result.profileColumnStatus || {},
    profileColumnMissingReason: result.profileColumnMissingReason || {},
    actualProductType: profile.actualProductType || result.actualProductType || "",
    actualCampName: profile.actualCampName || result.actualCampName || "",
    actualCourseCategory: profile.actualCourseCategory || result.actualCourseCategory || "",
    actualProductTypeSource: profile.actualProductTypeSource || result.actualProductTypeSource || "",
    actualCampNameSource: profile.actualCampNameSource || result.actualCampNameSource || "",
    actualCourseCategorySource: profile.actualCourseCategorySource || result.actualCourseCategorySource || "",
    actualCourseCategoryRaw: profile.actualCourseCategoryRaw || result.actualCourseCategoryRaw || "",
    actualCourseCategoryNormalized: profile.actualCourseCategoryNormalized || result.actualCourseCategoryNormalized || "",
    actualCourseCategorySourceTrust: profile.actualCourseCategorySourceTrust || result.actualCourseCategorySourceTrust || "",
    profileCourseCategoryRejectedSource: profile.profileCourseCategoryRejectedSource || result.profileCourseCategoryRejectedSource || "",
    profileCourseCategoryConflictReason: profile.profileCourseCategoryConflictReason || result.profileCourseCategoryConflictReason || ""
  };
}

function contextCacheKey(row) {
  return JSON.stringify([
    String(row.userId || ""),
    String(row.receiverName || ""),
    String(row.message || "")
  ]);
}

function profileCacheKey(row) {
  return JSON.stringify([
    String(row.userId || ""),
    String(row.docProductType || ""),
    String(row.docCampName || ""),
    String(row.sentAt || "")
  ]);
}

function cloneContext(context) {
  return JSON.parse(JSON.stringify(context || {}));
}

function enforceDomContextIdentityGate(contextMode, value = {}) {
  if (contextMode !== "dom") return value;

  const expectedPersonName = String(value.domPersonExpectedName || "").trim();
  const actualPersonInput = String(value.domPersonInputValue || "").trim();
  const expectedUserId = String(value.domQueryExpectedUserId || "").trim();
  const actualUserId = String(value.domQueryActualUserId || "").trim();
  const baseChecks = [
    [Boolean(expectedPersonName) && actualPersonInput === expectedPersonName, "人员名称输入值未确认等于当前行"],
    [value.domPersonListRefreshed === true, "人员列表未确认刷新到当前行"],
    [value.domPersonIdentityVerified === true || Number(value.domPersonMatchLevel || 0) > 0, "人员姓名身份未验证"],
    [value.domSelectedPersonVerified === true, "当前人员卡片未确认选中"],
    [Boolean(expectedUserId) && actualUserId === expectedUserId, "查询用户ID输入值未确认等于当前D列"],
    [value.domQueryFormVerified === true, "查询表单未确认属于当前行"],
    [value.domQueryResultTerminal === true, "查询结果未刷新到明确终态"]
  ];
  const contextChecks = [];
  if (Number(value.relatedRecords || 0) > 0 || value.contextOpened) {
    contextChecks.push([
      value.domConversationUserIdVerified === true,
      "会话卡片用户ID未确认等于当前D列"
    ]);
  }
  if (value.contextOpened) {
    contextChecks.push([
      value.domRightBubbleVerified === true,
      "最右侧真实气泡或时间戳未验证"
    ]);
  }
  const failed = [...baseChecks, ...contextChecks]
    .filter(([passed]) => !passed)
    .map(([, reason]) => reason);
  if (!value.invalidContext && !failed.length) return value;

  const reason = [...new Set([
    ...(value.invalidContext ? [value.domCandidateFailureReason || value.error || "DOM上下文已标记无效"] : []),
    ...failed
  ].filter(Boolean))].join("；");
  return {
    ...value,
    invalidContext: true,
    invalidContextReason: reason,
    foundConversation: false,
    matchedMessage: false,
    originalMessageMatched: false,
    matchedByRelatedRecords: false,
    conversationClicked: false,
    recordClicked: false,
    contextOpened: false,
    domRightContextOpened: false,
    domRightBubbleVerified: false,
    contextText: "",
    userBubbleText: "",
    userBubbleMessages: [],
    userBubbleCount: 0,
    error: reason || "DOM身份与查询归属闸门未通过"
  };
}

function blockedClassificationResult(context = {}) {
  const reason = context.invalidContextReason || context.error || "DOM身份与查询归属闸门未通过";
  return {
    firstCategory: "",
    secondCategory: "",
    thirdCategory: "",
    confidence: 0,
    needsReview: true,
    classifier: "blocked-invalid-context",
    reason: `上下文身份验证失败，分类模型未调用：${reason}`,
    llmMs: 0,
    invalidContext: true
  };
}

function blockedDialogContext(row, context = {}) {
  const window = buildDialogWindow(row);
  const reason = context.invalidContextReason || context.error || "DOM身份与查询归属闸门未通过";
  return {
    dialogWindowStart: window.start,
    dialogWindowEnd: window.end,
    dialogContextText: "",
    dialogStudentText: "",
    dialogTeacherText: "",
    dialogTeacherTextFiltered: "",
    dialogMessageCount: 0,
    studentDialogMessageCount: 0,
    teacherDialogMessageCount: 0,
    teacherHandlingMessageCount: 0,
    dialogDomScrolledBefore: 0,
    dialogDomScrolledAfter: 0,
    dialogDomReachedWindowBoundary: false,
    contextOpened: false,
    dialogSummaryError: `DOM身份验证失败，未生成三天总结：${reason}`
  };
}

function blockedDialogSummary(context = {}) {
  const reason = context.invalidContextReason || context.error || "DOM身份与查询归属闸门未通过";
  return {
    dialogSummarySource: "",
    overallDialogSummary: "",
    studentDialogSummary: "",
    teacherDialogSummary: "",
    teacherHandlingSummary: "",
    teacherResponseStatus: "",
    teacherFollowupStatus: "",
    teacherHandlingEvidence: "",
    dialogNeedsReview: true,
    dialogSummaryConfidence: 0,
    dialogSummaryError: `DOM身份验证失败，未生成三天总结：${reason}`
  };
}

const RELAXED_LOW_RISK_MIN_CONFIDENCE = 0.6;

function buildWritableUpdates(results) {
  return results
    .map((item) => {
      const rowNumber = Number(item.rowNumber);
      if (!Number.isInteger(rowNumber) || rowNumber < 1) {
        throw new Error(`识别结果缺少有效 rowNumber，已阻止无定位写回：${JSON.stringify({
          userId: item.userId || "",
          firstCategory: item.firstCategory || "",
          actualCampName: item.actualCampName || ""
        })}`);
      }
      const update = { rowNumber };
      const summaryFallback = resolveSummaryFallbacks(item);
      if (shouldWriteCategoryColumns(item)) {
        update.U = item.firstCategory;
        update.V = item.secondCategory;
        update.W = item.thirdCategory;
      }
      if (!item.invalidContext && summaryFallback.userSummary) {
        update.Y = summaryFallback.userSummary;
      }
      const hasDialogOutput = item.dialogSummarySource
        || item.overallDialogSummary
        || item.studentDialogSummary
        || item.teacherDialogSummary
        || item.teacherHandlingSummary;
      if (!item.invalidContext && summaryFallback.overallDialogSummary) {
        update.AH = summaryFallback.overallDialogSummary;
      }
      if (!item.invalidContext && hasDialogOutput) {
        update.AI = item.teacherHandlingSummary
          || (item.teacherResponseStatus === "未回应" ? "未回复学员问题" : "");
      }
      if (item.actualProductType) {
        update.Q = item.actualProductType;
      }
      if (item.actualCampName) {
        update.R = item.actualCampName;
      }
      if (item.actualCourseCategory) {
        update.S = item.actualCourseCategory;
      }
      if (shouldWriteRiskLevel(item)) {
        update.T = item.riskLevel;
      }
      return Object.keys(update).length > 1 ? update : null;
    })
    .filter(Boolean);
}

function resolveSummaryFallbacks(item = {}) {
  const userSummary = limitText(cleanText(item.userSummary || ""), 15);
  const overallDialogSummary = limitText(cleanText(item.overallDialogSummary || ""), 50);
  if (userSummary && overallDialogSummary) {
    return { userSummary, overallDialogSummary };
  }
  if (!userSummary && overallDialogSummary) {
    return {
      userSummary: limitText(overallDialogSummary, 15),
      overallDialogSummary
    };
  }
  if (userSummary && !overallDialogSummary) {
    return {
      userSummary,
      overallDialogSummary: limitText(userSummary, 50)
    };
  }
  return { userSummary: "", overallDialogSummary: "" };
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/[，,。；;]+$/, "").trim();
}

function limitText(value, maxLength) {
  const chars = [...cleanText(value)];
  if (chars.length <= maxLength) return chars.join("");
  return chars.slice(0, maxLength).join("");
}

async function trySummaryBasedCategoryFallback({ row, context, result, rules, llmSettings, llmLimit }) {
  if (context.invalidContext || result.invalidContext) return null;
  if (shouldWriteCategoryColumns(result)) return null;
  const summaryFallback = resolveSummaryFallbacks(result);
  const summaryParts = [
    summaryFallback.userSummary ? `Y列摘要：${summaryFallback.userSummary}` : "",
    summaryFallback.overallDialogSummary ? `AH问题总结：${summaryFallback.overallDialogSummary}` : ""
  ].filter(Boolean);
  if (!summaryParts.length) return null;

  const summaryText = summaryParts.join("\n");
  const summaryContext = {
    ...context,
    contextOpened: true,
    contextSource: `${context.contextSource || "unknown"}_summary_fallback`,
    contextText: [
      row.message ? `K列原始消息：${row.message}` : "",
      summaryText
    ].filter(Boolean).join("\n"),
    userBubbleText: summaryFallback.userSummary || summaryFallback.overallDialogSummary,
    userBubbleMessages: [summaryFallback.userSummary || summaryFallback.overallDialogSummary].filter(Boolean),
    userBubbleCount: summaryFallback.userSummary || summaryFallback.overallDialogSummary ? 1 : 0,
    matchedMessage: true,
    foundConversation: Boolean(context.foundConversation || context.contextOpened),
    summaryFallbackInput: summaryText
  };
  const summaryRuleResult = classify({
    row,
    contextText: summaryContext.contextText,
    rules,
    contextOpened: true
  });
  const llmStart = Date.now();
  const summaryResult = await llmLimit(async () => {
    const value = llmSettings.enabled
      ? await classifyWithLlm({
        row,
        context: summaryContext,
        rules,
        ruleResult: summaryRuleResult,
        settings: llmSettings
      })
      : { ...summaryRuleResult, classifier: "rule" };
    return { ...value, llmMs: Date.now() - llmStart };
  });
  const minConfidence = Number(llmSettings?.minConfidenceToWrite || RELAXED_LOW_RISK_MIN_CONFIDENCE);
  if (!hasCompleteCategory(summaryResult)) return null;
  if (summaryResult.needsReview) return null;
  if (Number(summaryResult.confidence || 0) <= minConfidence) return null;

  const originalReason = cleanText(result.reason || "");
  const fallbackReason = cleanText(summaryResult.reason || "Y/AH摘要可高置信判断三级分类");
  return {
    ...result,
    firstCategory: summaryResult.firstCategory,
    secondCategory: summaryResult.secondCategory,
    thirdCategory: summaryResult.thirdCategory,
    confidence: summaryResult.confidence,
    needsReview: false,
    reason: [originalReason, `基于Y/AH摘要补判分类：${fallbackReason}`].filter(Boolean).join("；"),
    classifier: summaryResult.classifier || result.classifier,
    llmProvider: summaryResult.llmProvider || result.llmProvider,
    llmModel: summaryResult.llmModel || result.llmModel,
    llmValidCategory: summaryResult.llmValidCategory ?? result.llmValidCategory,
    llmReason: summaryResult.llmReason || result.llmReason,
    llmEvidence: summaryResult.llmEvidence || result.llmEvidence,
    llmError: summaryResult.llmError || "",
    llmRawSnippet: summaryResult.llmRawSnippet || result.llmRawSnippet,
    llmMs: (result.llmMs || 0) + (summaryResult.llmMs || 0),
    ruleFirstCategory: summaryResult.ruleFirstCategory || summaryRuleResult.firstCategory || result.ruleFirstCategory,
    ruleSecondCategory: summaryResult.ruleSecondCategory || summaryRuleResult.secondCategory || result.ruleSecondCategory,
    ruleThirdCategory: summaryResult.ruleThirdCategory || summaryRuleResult.thirdCategory || result.ruleThirdCategory,
    ruleConfidence: summaryResult.ruleConfidence || summaryRuleResult.confidence || result.ruleConfidence,
    ruleReason: summaryResult.ruleReason || summaryRuleResult.reason || result.ruleReason,
    summaryCategoryUsed: true,
    summaryCategoryConfidence: summaryResult.summaryCategoryConfidence || summaryResult.confidence,
    summaryDialogCategoryUsed: true,
    summaryDialogCategorySource: summaryFallback.overallDialogSummary ? "AH/Y" : "Y",
    summaryDialogCategoryReason: fallbackReason,
    userSummary: result.userSummary || summaryResult.userSummary || summaryFallback.userSummary,
    summarySource: result.summarySource || summaryResult.summarySource,
    summaryTruncated: Boolean(result.summaryTruncated || summaryResult.summaryTruncated),
    summaryError: result.summaryError || summaryResult.summaryError,
    overallDialogSummary: result.overallDialogSummary || summaryFallback.overallDialogSummary,
    dialogSummarySource: result.dialogSummarySource,
    dialogSummaryError: result.dialogSummaryError,
    dialogSummaryWarning: result.dialogSummaryWarning
  };
}

function shouldWriteCategoryColumns(item) {
  if (lacksReliableDomContext(item)) return false;
  if (item.invalidContext) return false;
  if (!hasCompleteCategory(item)) return false;
  if (item.kEvidenceReviewRequired) return false;
  // 待复核或低置信度的模型结论不能因为风险等级而绕过写回门槛。
  // 确定性业务补丁会主动把 needsReview 置为 false，因此不受此限制。
  if (item.needsReview) return false;
  if (item.riskConsistencyBlocked && !isExplicitNoRiskCategory(item)) return false;
  return true;
}

function shouldWriteRiskLevel(item) {
  if (lacksReliableDomContext(item)) return false;
  if (item.invalidContext) return false;
  if (!item.riskLevel) return false;
  if (!hasCompleteCategory(item)) return false;
  if (item.kEvidenceReviewRequired) return false;
  if (item.needsReview) return false;
  // 风险证据与分类冲突时，先停止自动写回，避免把不完整或矛盾的结论写入 T。
  if (item.riskConsistencyBlocked && isLowOrNoRiskLevel(item.riskLevel) && !isExplicitNoRiskCategory(item)) return false;
  return true;
}

function categoryWriteBlockedReason(item = {}) {
  if (lacksReliableDomContext(item)) {
    return "DOM右侧上下文未真实打开，禁止写回三级分类";
  }
  if (item.invalidContext) {
    return `DOM身份或查询归属验证失败：${item.invalidContextReason || item.reason || "上下文无效"}`;
  }
  if (item.kEvidenceReviewRequired) {
    return "K列为图片/附件占位且扩展上下文证据不足，未写回三级分类";
  }
  if (!hasCompleteCategory(item)) {
    return item.contextOpened === false
      ? "未打开可靠右侧上下文，未写回三级分类"
      : "三级分类不完整"
  }
  if (item.needsReview) return "模型标记待复核，未自动写回三级分类";
  if (item.riskConsistencyBlocked && !isExplicitNoRiskCategory(item)) {
    return "一致性校验拦截：摘要或用户气泡存在风险词"
  }
  return "三级分类写回条件未满足";
}

function riskWriteBlockedReason(item = {}) {
  if (lacksReliableDomContext(item)) {
    return "DOM右侧上下文未真实打开，禁止写回风险等级";
  }
  if (item.invalidContext) {
    return `DOM身份或查询归属验证失败：${item.invalidContextReason || item.reason || "上下文无效"}`;
  }
  if (item.kEvidenceReviewRequired) {
    return "K列为图片/附件占位且扩展上下文证据不足，未写回风险等级";
  }
  if (!item.riskLevel) return "未形成可靠风险等级";
  if (!hasCompleteCategory(item)) return "三级分类不完整，无法确认风险等级";
  if (item.riskConsistencyBlocked && !isExplicitNoRiskCategory(item)) {
    return "一致性校验拦截：摘要或用户气泡存在风险词";
  }
  if (item.needsReview) return "模型标记待复核，未自动写回T风险";
  return "风险等级写回条件未满足";
}

function isAutoWritableLowRisk(item) {
  if (lacksReliableDomContext(item)) return false;
  if (!isLowOrNoRiskLevel(item.riskLevel)) return false;
  if (!hasCompleteCategory(item)) return false;
  if (item.needsReview) return false;
  if (item.kEvidenceReviewRequired) return false;
  if (item.riskConsistencyBlocked && !isExplicitNoRiskCategory(item)) return false;
  return Number(item.confidence || 0) > RELAXED_LOW_RISK_MIN_CONFIDENCE;
}

function lacksReliableDomContext(item = {}) {
  return item.domModeContext === true && item.contextOpened !== true;
}

function isLowOrNoRiskLevel(value) {
  return value === "无风险" || value === "低风险";
}

function hasCompleteCategory(item) {
  return [item.firstCategory, item.secondCategory, item.thirdCategory].every(isFilledCategoryValue);
}

function classifyKMessageEvidence(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const compact = text.replace(/[\s\[\]【】()（）:：,，。.!！？?、]/g, "");
  const weakPlaceholder = Boolean(compact && /^(?:图片|图像|图片消息|图片附件|附件|附件消息|文件|文件消息|语音|语音消息|视频|视频消息|表情|表情包)$/.test(compact));
  // 导出的 K 列有时不是“图片”占位，而是图片/视频消息的 JSON 或 URL。
  // 这些内容不是学员原话，不能拿其中的字段名、URL 或元数据参与风险判定。
  const weakAttachment = Boolean(text && (
    /^(?:https?:\/\/|data:image\/)/i.test(text)
    || (/^[{[]/.test(text) && /(?:avatar|cover|imageUrl|thumbnailUrl|videoUrl|artwork|md5|width|height|items|msgType|mediaId)/i.test(text))
    || /(?:头像|图片消息|图像消息|附件消息|视频消息|语音消息)/.test(text)
  ));
  const weak = weakPlaceholder || weakAttachment;
  return {
    kOriginalMessage: text,
    kEvidenceMode: weak ? "image_or_attachment" : text ? "text" : "empty",
    kEvidenceWeak: weak,
    kEvidenceStrong: Boolean(text && !weak),
    kEvidenceReason: weak
      ? "K列仅为图片/附件/语音/视频占位，不能直接据此分类"
      : text
        ? "K列包含可直接分析的文字"
        : "K列为空"
  };
}

function buildUserEvidenceText(result = {}, row = {}, context = {}) {
  return normalizeRiskText([
    row.message || row.existing?.K || "",
    context.userBubbleText,
    context.dialogStudentText,
    result.userSummary,
    result.studentDialogSummary
  ].filter(Boolean).join("\n"));
}

function hasExplicitComplaintOrReportIntent(value) {
  const text = normalizeRiskText(value);
  if (!text) return false;
  return /(?:我|本人|学员|用户|客户)?(?:要|想|会|准备|打算|必须|坚决|马上|立刻|已经|已|继续).{0,8}(?:投诉|举报)|(?:再发|再推送|再联系|再打电话|否则|不然).{0,12}(?:投诉|举报)|(?:投诉|举报).{0,10}(?:你们|你|公司|平台|老师|客服|课程|兴趣岛|商家)|(?:投诉|举报)(?:了|过|到底)/.test(text);
}

function getUserRiskEvidence(result = {}, row = {}, context = {}) {
  const text = buildUserEvidenceText(result, row, context);
  const kText = normalizeRiskText([
    row.message || row.existing?.K || "",
    context.kOriginalMessage || ""
  ].filter(Boolean).join("\n"));
  const kEvidence = classifyKMessageEvidence(kText);
  const kSignalText = kEvidence.kEvidenceWeak ? "" : kText;
  // 只把明确指向学员/用户/客户的对话摘要作为补充证据。
  // AH 可能同时包含老师内容，因此只有同时出现用户主体和风险诉求时才纳入。
  const summaryRiskPattern = /(?:投诉|举报|维权|黑猫|消协|12315|12345|报警|退费|退款|退钱|扣款|续费|诈骗|被骗|欺骗|套路|忽悠|诱导|骚扰|不满|失望|拒绝|不想|不回复|不回|联系不上|没人回)/;
  const existingYSummaryCandidate = normalizeRiskText(row.existing?.Y || "");
  // Y 是总体短摘要，可能同时包含老师内容。只有出现用户主体或明确的
  // 用户诉求动作时，才允许把它作为学员侧辅助证据；例如“老师未回应投诉”
  // 不能单独证明学员正在提出风险诉求。
  const existingYSummary = /(?:学员|用户|客户|要求|反映|质疑|坚持|希望|担心|拒绝|不满|称|投诉对象)/.test(
    existingYSummaryCandidate
  ) && summaryRiskPattern.test(existingYSummaryCandidate)
    ? existingYSummaryCandidate
    : "";
  const summaryUserText = normalizeRiskText([
    result.userSummary || "",
    result.studentDialogSummary || "",
    existingYSummary
  ].filter(Boolean).join("\n"));
  const nonBusinessRiskSharing = /(?:分享|讲述|回忆|转发|看到|讨论).{0,16}(?:投诉|举报|报警|虚假宣传|诈骗|被骗|欺骗|套路|维权|黑猫|消协|12315|12345)/.test(summaryUserText);
  const userContextText = normalizeRiskText([
    context.userBubbleText || "",
    context.dialogStudentText || "",
    summaryUserText
  ].filter(Boolean).join("\n"));
  // 分类/风险证据只相信原始K列、白色学员气泡和三天学员侧文本。
  // 不把模型生成的总结作为“事实来源”，避免老师广告或模型误摘要把风险词带进来。
  const sourceText = normalizeRiskText([
    kSignalText,
    context.userBubbleText || "",
    context.dialogStudentText || "",
    summaryUserText
  ].filter(Boolean).join("\n"));
  const evidenceText = sourceText || text;
  // 完整对话只用于确认投诉对象是否属于第三方，不允许老师侧文本制造或抬高风险。
  // 例如老师提到“家里安装的 WiFi”，学员随后说“又投诉了”，应整体视为
  // 对宽带/WiFi 服务方的投诉，而不是兴趣岛平台风险。
  const fullComplaintContext = normalizeRiskText(
    context.dialogContextText ||
    context.contextText ||
    context.dialogStudentText ||
    context.userBubbleText ||
    kSignalText ||
    evidenceText
  );
  const nonPlatformComplaint = isNonPlatformComplaint(fullComplaintContext);
  const businessPattern = /(?:课程|老师|客服|兴趣岛|体验营|正式营|订单|扣款|退款|退费|退钱|学费|报名|服务|群|消息|推送|广告|营销|产品|商品|续费)/;
  const technicalAlarmPattern = /(?:手机|内存|电池|系统|软件|设备|电脑|相机|存储).{0,10}(?:报警|告警)/;
  const domesticPattern = /(?:外甥女|侄女|孙子|孙女|小孩|孩子|家人|亲戚|带娃|带小孩)/;
  const kTechnicalAlarm = technicalAlarmPattern.test(kSignalText);
  const kDomesticOnly = domesticPattern.test(kSignalText) && !businessPattern.test(kSignalText);
  const kBusinessConcern = businessPattern.test(kSignalText);
  const userContextBusinessConcern = businessPattern.test(userContextText);
  // K列是主证据。只有当K列本身是设备/家庭语境，且学员真实上下文也没有课程/服务诉求时，
  // 才按非业务语境过滤，避免老师广告或模型摘要把“报警”重新解释成风险。
  const nonBusinessKOnly = (kTechnicalAlarm || kDomesticOnly)
    && !kBusinessConcern
    && !userContextBusinessConcern;
  const technicalAlarm = nonBusinessKOnly && kTechnicalAlarm;
  const domesticOnly = nonBusinessKOnly && kDomesticOnly;
  const businessConcern = businessPattern.test(evidenceText);
  // “报警”必须是面向平台/老师的处理诉求才算风险；“报警后离开”“报警一下”
  // 或手机/家庭报警属于生活语境，不能因为本批次是报警敏感词表就自动升风险。
  const alarmIntent = /(?:我要|我会|我准备|我打算|我马上|我就|我只能|我只有|我将|必须).{0,8}报警|(?:要|就|只能|只有|否则|不然|已经|已).{0,8}报警|报警.{0,8}(?:投诉|举报|退费|退款|处理你们|处理老师|找你们|找老师|平台|兴趣岛)/.test(evidenceText);
  const riskEvidenceText = stripNegatedRiskText(
    alarmIntent ? evidenceText : evidenceText.replace(/报警/g, "")
  );
  const userContextRiskText = stripNegatedRiskText(
    alarmIntent ? userContextText : userContextText.replace(/报警/g, "")
  );
  const highRiskMatches = matchedRiskKeywords(riskEvidenceText.replace(/(?:手机|内存|电池|系统|软件|设备|电脑|相机|存储).{0,10}(?:报警|告警)/g, ""), HIGH_RISK_KEYWORDS);
  const externalComplaintMatches = matchedRiskKeywords(riskEvidenceText, EXTERNAL_COMPLAINT_KEYWORDS);
  const actionableRiskMatches = matchedRiskKeywords(riskEvidenceText, ACTIONABLE_RISK_KEYWORDS);
  const riskKeywordMatches = matchedRiskKeywords(riskEvidenceText, RISK_TRIGGER_KEYWORDS);
  const explicitComplaintIntent = hasExplicitComplaintOrReportIntent(riskEvidenceText);
  const hasDissatisfaction = explicitComplaintIntent || /(?:维权|黑猫|消协|12315|12345|退费|退款|退钱|不退|扣款|续费|诈骗|被骗|欺骗|套路|忽悠|诱导|骚扰|再发|别再|不要再|不满|失望|不想|拒绝|要求)/.test(riskEvidenceText);
  // “报警”本身可能只是家庭、设备或生活描述，不能单独当作“用户表达不满”。
  // “投诉/举报”也可能只是讨论他人或泛指投诉者，只有出现“我要投诉、已举报、
  // 再发就投诉、投诉你们”等明确意图或对象时，才作为学员不满证据。
  // 不能把“要求资料/要求回放”这类普通动作当成中风险不满。
  // 必须出现投诉、退费、拒绝骚扰、被骗/虚假等明确用户诉求或负面事实。
  const dissatisfactionPattern = /(?:维权|黑猫|消协|12315|12345|报警|诈骗|被骗|欺骗|套路|忽悠|诱导|骚扰|再发|别再|不要再|不满|失望|拒绝|不回复|不回|联系不上|没人回|没及时回|不退|不给退|退不了|退费|退款|退钱|扣款|续费|虚假宣传|夸大其词|宣传不符|课程打不开|无法播放|没有收到)/;
  const kExplicitComplaintIntent = hasExplicitComplaintOrReportIntent(stripNegatedRiskText(kSignalText));
  const contextExplicitComplaintIntent = hasExplicitComplaintOrReportIntent(userContextRiskText);
  const hasUserDissatisfaction = dissatisfactionPattern.test(riskEvidenceText)
    || dissatisfactionPattern.test(userContextRiskText)
    || kExplicitComplaintIntent
    || alarmIntent
    || contextExplicitComplaintIntent;
  const contextUserDissatisfaction = dissatisfactionPattern.test(userContextRiskText)
    || contextExplicitComplaintIntent;
  const isolatedRiskKeyword = /^(?:投诉|举报|伪直播|报警|虚假宣传|诱导|12315|黑猫|维权|市长热线|曝光你|消协|退费|退款|退钱|扣款|续费|骚扰)$/;
  const hasDetailedUserDissatisfaction = Boolean(
    contextUserDissatisfaction ||
    (dissatisfactionPattern.test(riskEvidenceText) && !isolatedRiskKeyword.test(riskEvidenceText))
  );
  const qualified = Boolean(
    hasUserDissatisfaction &&
    hasDetailedUserDissatisfaction &&
    !nonBusinessRiskSharing &&
    !technicalAlarm &&
    !domesticOnly &&
    !nonPlatformComplaint &&
    (businessConcern || externalComplaintMatches.length > 0 || actionableRiskMatches.length > 0)
  );
  return {
    text,
    sourceText: evidenceText,
    // 风险等级只读取原始K列、学员气泡和学员侧三天文本，不让模型生成的总结单独制造风险。
    cleanedText: evidenceText.replace(/(?:手机|内存|电池|系统|软件|设备|电脑|相机|存储).{0,10}(?:报警|告警)/g, ""),
    kTechnicalAlarm,
    kDomesticOnly,
    kBusinessConcern,
    kEvidenceMode: kEvidence.kEvidenceMode,
    kEvidenceWeak: kEvidence.kEvidenceWeak,
    kEvidenceReason: kEvidence.kEvidenceReason,
    kSignalText,
    riskEvidenceText,
    userContextRiskText,
    alarmIntent,
    nonBusinessKOnly,
    technicalAlarm,
    domesticOnly,
    businessConcern,
    hasDissatisfaction,
    hasUserDissatisfaction,
    contextUserDissatisfaction,
    summaryUserText,
    nonBusinessRiskSharing,
    nonPlatformComplaint,
    summaryUserDissatisfaction: dissatisfactionPattern.test(stripNegatedRiskText(summaryUserText))
      || hasExplicitComplaintOrReportIntent(stripNegatedRiskText(summaryUserText)),
    hasDetailedUserDissatisfaction,
    qualified,
    highRiskMatches,
    externalComplaintMatches,
    actionableRiskMatches,
    riskKeywordMatches
  };
}

function getClassificationRiskEvidence(result = {}, row = {}, context = {}) {
  const userEvidence = getUserRiskEvidence(result, row, context);
  const categoryText = normalizeRiskText([
    result.firstCategory,
    result.secondCategory,
    result.thirdCategory
  ].filter(Boolean).join("/"));
  const studentSummaryText = normalizeRiskText([
    result.userSummary,
    result.studentDialogSummary,
    userEvidence.summaryUserText,
    context.userBubbleText,
    context.dialogStudentText
  ].filter(Boolean).join("\n"));
  // “体验营退费申请/课程咨询”本身是业务咨询分类，不等于已经发生风险。
  // 只有风险性质的分类（退费争议、虚假宣传、服务争议等）才作为辅助信号，
  // 最终仍必须结合学员侧真实文本判断 T。
  const categoryRiskMention = /退费争议|虚假宣传|服务争议|购课问题|诱导分期|过度骚扰|信任问题|态度问题|回复时效|被移除|课程宣传和实际不符/.test(categoryText);
  const studentSummaryRiskText = stripNegatedRiskText(studentSummaryText);
  const summaryRiskMention = /投诉|举报|骚扰|虚假|诱导|诈骗|被骗|欺骗|套路|忽悠|维权|黑猫|消协|12315|12345|报警|起诉|工商|市场监管|律师函|上门|退费|退款|退钱|扣款|续费|不满|失望|拒绝|不想/.test(studentSummaryRiskText);
  return {
    ...userEvidence,
    categoryRiskMention,
    summaryRiskMention,
    studentSummaryText,
    studentSummaryRiskText,
    // 中风险不能仅由 K 列固定关键词制造。三级分类或学员侧摘要至少一处
    // 必须明确提及风险，然后再由真实用户证据决定风险等级。
    hasAnyRiskMention: Boolean(categoryRiskMention || summaryRiskMention)
  };
}

function applyExplicitKHarassmentPatch(result, row, context = {}, rules = []) {
  if (!result || context.contextOpened !== true) return result;
  const userText = normalizeRiskText([
    row.message || row.existing?.K || "",
    context.userBubbleText || "",
    context.dialogStudentText || ""
  ].filter(Boolean).join("\n"));
  const explicitHarassment = /(?:你敢|敢)再发.{0,12}(?:就|否则|不然)?(?:投诉|举报)|(?:不要|别|停止|拒绝).{0,8}(?:发消息|发信息|联系|打电话|推送).{0,12}(?:否则|不然|再.{0,4}就)?(?:投诉|举报)|再发.{0,12}(?:就|否则|不然)?(?:投诉|举报)/.test(userText);
  if (!explicitHarassment) {
    return result;
  }
  const rule = rules.find((item) => item.thirdCategory === "过度骚扰");
  if (!rule) return result;
  const reason = "K列明确表达“再发就投诉”，按过度骚扰纠偏";
  return {
    ...result,
    firstCategory: rule.firstCategory,
    secondCategory: rule.secondCategory,
    thirdCategory: rule.thirdCategory,
    confidence: Math.max(Number(result.confidence || 0), 0.95),
    needsReview: false,
    riskConsistencyBlocked: false,
    kComplaintPatchApplied: true,
    kComplaintPatchReason: reason,
    classifier: "k_message_patch",
    reason: [result.reason, reason].filter(Boolean).join("；")
  };
}

function applyWeakKEvidenceGuard(result, row, context = {}) {
  if (!result || context.kEvidenceWeak !== true) return result;
  const expandedLineCount = countTextLines(context.contextText || context.dialogContextText || "");
  const expandedUserText = normalizeRiskText([
    context.userBubbleText,
    context.dialogStudentText,
    context.studentDialogSummary
  ].filter(Boolean).join("\n"));
  const sufficient = context.contextExpanded === true && expandedLineCount >= 4 && expandedUserText.length >= 4;
  if (sufficient) {
    return { ...result, kEvidenceContextSufficient: true, kEvidenceReviewRequired: false };
  }
  const reason = "K列为图片/附件占位且扩展上下文不足，暂不自动写回";
  return {
    ...result,
    needsReview: true,
    kEvidenceContextSufficient: false,
    kEvidenceReviewRequired: true,
    kEvidenceGuardReason: reason,
    reason: [result.reason, reason].filter(Boolean).join("；")
  };
}

function applyClassificationEvidenceGuards(result, row, context = {}, rules = []) {
  let guarded = applyExplicitKHarassmentPatch(result, row, context, rules);
  const userEvidence = getUserRiskEvidence(guarded, row, context);
  const nonBusinessContext = userEvidence.nonBusinessKOnly;
  if (
    nonBusinessContext &&
    !userEvidence.businessConcern &&
    guarded.firstCategory !== "无风险"
  ) {
    const noRiskRule = rules.find((rule) =>
      rule.firstCategory === "无风险" &&
      rule.secondCategory === "无风险" &&
      rule.thirdCategory === "话题分享"
    );
    if (noRiskRule) {
      guarded = {
        ...guarded,
        firstCategory: noRiskRule.firstCategory,
        secondCategory: noRiskRule.secondCategory,
        thirdCategory: noRiskRule.thirdCategory,
        confidence: Math.max(Number(guarded.confidence || 0), 0.9),
        needsReview: false,
        riskConsistencyBlocked: false,
        classifier: "non_business_context_guard",
        evidenceGuardApplied: true,
        evidenceGuardReason: userEvidence.technicalAlarm
          ? "仅出现设备/系统报警，未见课程或服务风险诉求"
          : "仅出现家庭生活分享，未见课程或服务风险诉求",
        reason: [guarded.reason, userEvidence.technicalAlarm
          ? "设备/系统报警不作为课程风险证据"
          : "家庭生活分享不作为课程风险证据"].filter(Boolean).join("；")
      };
    }
  }

  if (
    guarded.firstCategory === "无风险" &&
    guarded.thirdCategory !== "投诉对象非兴趣岛" &&
    userEvidence.qualified &&
    /(?:投诉|举报|维权|黑猫|消协|12315|12345)/.test(userEvidence.riskEvidenceText || "") &&
    /(?:重新|另行|改期|延期|调整|安排).{0,12}(?:时间|时间段|学习|课程|跟学)/.test(userEvidence.riskEvidenceText || "")
  ) {
    const serviceRule = rules.find((rule) => rule.thirdCategory === "个性化服务" && rule.firstCategory !== "无风险");
    if (serviceRule) {
      const reason = "学员明确投诉并要求调整课程安排，纠正无风险话题分享";
      guarded = {
        ...guarded,
        firstCategory: serviceRule.firstCategory,
        secondCategory: serviceRule.secondCategory,
        thirdCategory: serviceRule.thirdCategory,
        confidence: Math.max(Number(guarded.confidence || 0), 0.9),
        needsReview: false,
        riskConsistencyBlocked: false,
        evidenceGuardApplied: true,
        evidenceGuardReason: reason,
        classifier: "platform_complaint_category_guard",
        reason: [guarded.reason, reason].filter(Boolean).join("；")
      };
    }
  }

  // 模型把明确的“套路/被骗/虚假宣传”归到话题分享或无风险时，使用用户侧
  // 原文做一次确定性纠偏。普通单独出现“投诉”不在这里强行分类，避免把
  // “投诉对象非兴趣岛”或缺少具体问题的短句误判为业务风险。
  if (
    guarded.firstCategory === "无风险" &&
    guarded.thirdCategory !== "投诉对象非兴趣岛" &&
    userEvidence.qualified
  ) {
    const sourceText = userEvidence.sourceText || userEvidence.text;
    const correctionThird = /套路|忽悠|欺骗|诈骗|被骗|虚假宣传|夸大宣传|黑猫|消协|12315|维权/.test(sourceText)
      ? "信任问题"
      : /不回复|不回信息|没人回|联系不上|不理|没及时回/.test(sourceText)
        ? "回复时效"
        : "";
    const correctionRule = correctionThird
      ? rules.find((rule) => rule.thirdCategory === correctionThird && rule.firstCategory !== "无风险")
      : null;
    if (correctionRule) {
      const reason = `用户侧明确出现${correctionThird}证据，纠正无风险分类`;
      guarded = {
        ...guarded,
        firstCategory: correctionRule.firstCategory,
        secondCategory: correctionRule.secondCategory,
        thirdCategory: correctionRule.thirdCategory,
        confidence: Math.max(Number(guarded.confidence || 0), 0.9),
        needsReview: false,
        riskConsistencyBlocked: false,
        evidenceGuardApplied: true,
        evidenceGuardReason: reason,
        classifier: "user_evidence_category_guard",
        reason: [guarded.reason, reason].filter(Boolean).join("；")
      };
    }
  }
  return applyWeakKEvidenceGuard(guarded, row, context);
}

function applyExperienceComplaintCategoryPatch(result, row, context = {}) {
  if (!result || context.contextOpened !== true) {
    return { applied: false, result };
  }

  // 体验营补丁只能读取 K 列和学员侧真实文本，不能读取老师广告或模型生成的
  // 总结，避免“家庭分享/设备报警”被误套成退费申请。
  const userEvidence = getUserRiskEvidence(result, row, context);
  const evidenceText = userEvidence.sourceText;
  const kText = normalizeRiskText(row.message || row.existing?.K || "");
  const explicitHarassment = /(?:你敢|敢)再发.{0,8}(?:就|否则|不然)?(?:投诉|举报)|再发.{0,8}(?:就|否则|不然)?(?:投诉|举报)/.test(kText);
  if (explicitHarassment || userEvidence.nonBusinessKOnly || userEvidence.nonBusinessRiskSharing) {
    return { applied: false, result };
  }
  const riskEvidenceText = userEvidence.riskEvidenceText || evidenceText;
  const complaintSignal = /投诉|举报|黑猫|维权|消协|12315|12345|报警|市场监管|工商|起诉|律师函|上门/.test(riskEvidenceText);
  const refundOrCourseConcernSignal = /退费|退款|退钱|扣款|续费|套路|忽悠|欺骗|诈骗|被骗|虚假宣传/.test(riskEvidenceText);
  // 学员只说“要投诉”时，不能仅凭该词猜测退款；但若紧邻对话中老师已明确
  // 要求支付凭证并代为申请退款，这属于可验证的业务处理上下文，应作为
  // “投诉对应退费诉求”的佐证。该佐证只用于三级分类，绝不作为 T 风险证据。
  const teacherHandlingText = normalizeRiskText([
    result.teacherHandlingEvidence,
    result.teacherHandlingSummary,
    result.teacherDialogSummary
  ].filter(Boolean).join("\n"));
  const verifiedTeacherRefundHandling = /(?:支付截图|付款截图|订单截图|支付凭证|付款凭证).{0,32}(?:申请|提交|发给|转给).{0,16}(?:退款|退费)|(?:申请|提交|发给|转给).{0,16}(?:退款|退费)/.test(teacherHandlingText);
  const complaintWithRefundHandling = complaintSignal && verifiedTeacherRefundHandling;
  // 只有明确涉及课程、订单、扣款、老师回复或服务本身时，投诉词才可进入
  // 体验营退费补丁。家庭报警、设备报警、旅行/生活分享不能触发退费分类。
  const serviceConcernSignal = /(?:课程|老师|客服|兴趣岛|体验营|正式营|订单|扣款|退款|退费|退钱|学费|报名|服务|群|消息|推送|广告|营销|产品|商品|续费|不回复|不回信息|联系不上)/.test(riskEvidenceText);
  if ((!complaintSignal && !refundOrCourseConcernSignal) || (!serviceConcernSignal && !refundOrCourseConcernSignal && !complaintWithRefundHandling)) {
    return { applied: false, result };
  }

  const actualProductType = normalizeRiskText(
    result.actualProductType || result.profileOrderListProductType || ""
  );
  const documentProductType = normalizeRiskText(
    result.docProductType || row.docProductType || row.existing?.L || ""
  );
  const productTypeText = actualProductType || documentProductType;
  if (!/体验营/.test(productTypeText)) {
    return { applied: false, result };
  }

  const strongRiskText = riskEvidenceText;
  const strongHighRisk = matchedRiskKeywords(strongRiskText, HIGH_RISK_KEYWORDS).length > 0
    || String(result.secondCategory || "").includes("诱导分期/隐形消费");
  if (strongHighRisk) {
    return { applied: false, result };
  }

  const currentCategoryIsFallbackLike =
    !hasCompleteCategory(result)
    || result.firstCategory === "无风险"
    || result.firstCategory === "其他"
    || result.thirdCategory === "无效会话";
  if (!currentCategoryIsFallbackLike) {
    return { applied: false, result };
  }

  const reason = complaintWithRefundHandling
    ? "体验营订单中学员表达投诉，且同一会话老师明确处理退款申请，按体验营退费申请归类"
    : complaintSignal
    ? "体验营订单且K列/上下文命中投诉类关键词，按体验营投诉咨询补丁归类"
    : "体验营订单且K列/上下文命中退费或课程争议关键词，按体验营咨询补丁归类";
  return {
    applied: true,
    result: {
      ...result,
      firstCategory: "咨询问题",
      secondCategory: "信息咨询",
      thirdCategory: "体验营退费申请",
      confidence: Math.max(Number(result.confidence || 0), 0.9),
      needsReview: false,
      riskConsistencyBlocked: false,
      categoryPatchApplied: true,
      categoryPatchReason: reason,
      classifier: "experience_complaint_patch",
      reason: [result.reason, reason].filter(Boolean).join("；")
    }
  };
}

function isFilledCategoryValue(value) {
  const text = String(value || "").trim();
  return Boolean(text && text !== "-");
}

function classifyRawRiskLevel(result, row, context) {
  // T 风险只使用 K 列、学员白色气泡、学员侧三天总结和分类结果作为证据。
  // 不能把右侧老师的推广广告、课程介绍或设备/家庭分享里的“报警”当成用户风险。
  const userEvidence = getUserRiskEvidence(result, row, context);
  // 使用已经过滤设备/家庭报警、附件 JSON 和否定表达的风险文本，避免
  // “不存在虚假宣传”“报警后离开”被再次命中风险关键词。
  const text = userEvidence.riskEvidenceText || userEvidence.cleanedText;
  const highRiskMatches = matchedRiskKeywords(text, HIGH_RISK_KEYWORDS);
  const externalComplaintMatches = matchedRiskKeywords(text, EXTERNAL_COMPLAINT_KEYWORDS);
  const actionableRiskMatches = matchedRiskKeywords(text, ACTIONABLE_RISK_KEYWORDS);
  // 过度骚扰只能由 K 列或真实学员侧上下文触发。不要从总体摘要、老师
  // 处理摘要或分类名称里读取“推送/骚扰”，否则老师广告会被误判成骚扰。
  const harassmentEvidenceText = normalizeRiskText([
    userEvidence.kSignalText || "",
    context.userBubbleText || "",
    context.dialogStudentText || ""
  ].filter(Boolean).join("\n"));
  const harassmentMatch = /骚扰|别再|不要再|再发|一直发|信息太多|轰炸|不要再劝|别劝|(?:天天|频繁|反复).{0,8}(?:发|推送|推荐|广告|营销|打电话|联系)|(?:推送|广告|营销|信息|电话).{0,6}(?:太多|打扰|烦|拒绝|不要|别再|不想)/.test(
    harassmentEvidenceText
  );
  const productTypeText = normalizeRiskText(
    result.actualProductType ||
    row.existing?.Q ||
    row.docProductType ||
    ""
  );
  const isExperienceCamp = /体验营/.test(productTypeText);
  const qualifiedRiskEvidence = userEvidence.qualified;
  const classificationEvidence = getClassificationRiskEvidence(result, row, context);

  if (userEvidence.nonPlatformComplaint) {
    return {
      level: "无风险",
      reason: "完整上下文表明投诉对象为 WiFi、宽带或其他非兴趣岛主体",
      matchedKeywords: []
    };
  }

  const hasMediumRiskEvidence = Boolean(
    context.contextOpened === true &&
    qualifiedRiskEvidence &&
    userEvidence.riskKeywordMatches.length > 0 &&
    userEvidence.hasDetailedUserDissatisfaction &&
    (actionableRiskMatches.length > 0 || externalComplaintMatches.length > 0 || harassmentMatch)
  );

  // “投诉对象非兴趣岛”是明确的无风险业务归类，即使原文出现投诉，也不抬高 T。
  if (result.thirdCategory === "投诉对象非兴趣岛") {
    return {
      level: "无风险",
      reason: "三级分类为投诉对象非兴趣岛，且不属于本平台实际风险",
      matchedKeywords: []
    };
  }

  // “再发就投诉/举报”归入过度骚扰，但过度骚扰按业务口径始终为低风险。
  // 该分支必须早于普通投诉和体验营中风险判断，避免被后续条件抬高。
  const explicitHarassmentMessage = /(?:你敢|敢)再发.{0,8}(?:就|否则|不然)?(?:投诉|举报)|再发.{0,8}(?:就|否则|不然)?(?:投诉|举报)/.test(
    userEvidence.kSignalText || ""
  );
  if (result.thirdCategory === "过度骚扰" || explicitHarassmentMessage || harassmentMatch) {
    return {
      level: "低风险",
      reason: "过度骚扰按统一规则判定低风险",
      matchedKeywords: ["过度骚扰"]
    };
  }

  // 三级分类已经明确为无风险时，T 不得再被 K 列固定关键词或老师侧摘要抬高。
  // 若学员侧确有风险，前面的证据分类纠偏会先把 U/V/W 改成对应风险分类；
  // 未完成可靠上下文时宁可保留无风险，也不能制造“无风险分类+中风险T”的矛盾。
  if (result.firstCategory === "无风险") {
    return {
      level: "无风险",
      reason: "一级分类为无风险，T按三级分类一致性写入无风险",
      matchedKeywords: []
    };
  }

  // 三级分类和学员侧简要描述都没有风险含义时，不能因为“正式营”或
  // 某个泛化的分类名称自动抬高 T。风险等级必须有用户侧可解释证据。
  if (!classificationEvidence.hasAnyRiskMention) {
    return {
      level: "无风险",
      reason: "三级分类与学员侧简要描述均未提及风险，按无风险处理",
      matchedKeywords: []
    };
  }

  // 没有用户侧风险证据时，日常分享、家庭问题和设备提示都只能是无风险。
  if (!qualifiedRiskEvidence) {
    if (userEvidence.technicalAlarm || userEvidence.domesticOnly) {
      return {
        level: "无风险",
        reason: userEvidence.technicalAlarm
          ? "仅出现设备/系统报警，未见用户对课程或服务表达风险诉求"
          : userEvidence.domesticOnly
            ? "仅为家庭生活分享，未见用户对课程或服务表达风险诉求"
            : "三级分类与用户侧总结均未出现可靠风险证据",
        matchedKeywords: []
      };
    }
    // 固定关键词命中但没有形成“用户明确不满/处理诉求”时，只能给低风险，
    // 不能直接给中风险；没有任何风险信号则按无风险处理，避免旧 T 残留。
    if (userEvidence.riskKeywordMatches.length > 0 || classificationEvidence.categoryRiskMention || classificationEvidence.summaryRiskMention) {
      return {
        level: "低风险",
        reason: "命中风险关键词但未形成用户明确不满或处理诉求，按低风险处理",
        matchedKeywords: userEvidence.riskKeywordMatches
      };
    }
    return {
      level: "无风险",
      reason: "未形成可靠的用户侧风险证据，按无风险处理",
      matchedKeywords: []
    };
  }

  // 体验营与正式营使用相同的原始风险语义；产品类型只影响分类补丁，
  // 不得预先降低高风险，否则会在最终写回映射时发生双重降级。
  if (isExperienceCamp && actionableRiskMatches.length) {
    const experienceHighRiskMatches = [
      ...(String(result.secondCategory || "").includes("诱导分期/隐形消费") ? ["诱导分期/隐形消费"] : []),
      ...highRiskMatches
    ];
    if (experienceHighRiskMatches.length) {
      return {
        level: "高风险",
        reason: "Q列为体验营，命中诱导分期或医疗、收益、就业绝对承诺高风险证据",
        matchedKeywords: experienceHighRiskMatches
      };
    }
    if (hasMediumRiskEvidence) {
      return {
        level: "中风险",
        reason: "Q列为体验营，用户命中风险关键词且明确表达不满或处理诉求，判定中风险",
        matchedKeywords: [...new Set([...actionableRiskMatches, ...externalComplaintMatches])]
      };
    }
    return {
      level: "低风险",
      reason: "Q列为体验营，K列/摘要/上下文命中投诉或课程争议证据，按体验营规则判定低风险",
      matchedKeywords: actionableRiskMatches
    };
  }

  if (result.firstCategory === "无风险" && actionableRiskMatches.length) {
    if (highRiskMatches.length) {
      return {
        level: "高风险",
        reason: "一级分类为无风险，但K列/摘要/上下文命中医疗、收益、就业绝对承诺",
        matchedKeywords: highRiskMatches
      };
    }
    if (hasMediumRiskEvidence) {
      return {
        level: "中风险",
        reason: "用户侧明确表达投诉/不满或骚扰拒绝，且命中风险关键词",
        matchedKeywords: [...new Set([...externalComplaintMatches, ...(harassmentMatch ? ["过度骚扰"] : [])])]
      };
    }
    return {
      level: "低风险",
      reason: "一级分类为无风险，但K列/摘要/上下文存在明确课程争议或投诉证据",
      matchedKeywords: actionableRiskMatches
    };
  }

  if (result.firstCategory === "无风险") {
    return {
      level: "无风险",
      reason: "一级分类为无风险",
      matchedKeywords: []
    };
  }

  if (isExperienceCamp) {
    const experienceHighRiskMatches = [
      ...(String(result.secondCategory || "").includes("诱导分期/隐形消费") ? ["诱导分期/隐形消费"] : []),
      ...highRiskMatches
    ];
    if (experienceHighRiskMatches.length) {
      return {
        level: "高风险",
        reason: "Q列为体验营，命中诱导分期或医疗、收益、就业绝对承诺高风险证据",
        matchedKeywords: experienceHighRiskMatches
      };
    }
    if (hasReliableLowRiskClassification(result, context)) {
      return {
        level: "低风险",
        reason: "Q列为体验营，未命中中高风险条件，原始判定为低风险",
        matchedKeywords: []
      };
    }
    return {
      level: "",
      reason: "Q列为体验营但分类待复核，风险等级不写入",
      matchedKeywords: []
    };
  }

  if (String(result.secondCategory || "").includes("诱导分期/隐形消费")) {
    return {
      level: "高风险",
      reason: "二级分类为诱导分期/隐形消费",
      matchedKeywords: ["诱导分期/隐形消费"]
    };
  }

  if (highRiskMatches.length) {
    return {
      level: "高风险",
      reason: "命中医疗/收益/就业绝对承诺高风险词",
      matchedKeywords: highRiskMatches
    };
  }

  if (hasMediumRiskEvidence) {
    return {
      level: "中风险",
      reason: result.firstCategory === "退费争议"
        ? "退费争议且用户明确表达外部投诉或不满"
        : "用户侧命中风险关键词且明确表达不满或处理诉求",
      matchedKeywords: [...new Set([...actionableRiskMatches, ...externalComplaintMatches])]
    };
  }

  if (hasReliableLowRiskClassification(result, context)) {
    return {
      level: "低风险",
      reason: "其他可靠分类默认低风险",
      matchedKeywords: []
    };
  }

  return {
    level: "",
    reason: "分类待复核，风险等级不写入",
    matchedKeywords: []
  };
}

// 与业务写回口径保持一致：模型判为中风险时写低风险；模型判为高风险时
// 写中风险，由人工决定是否进一步升级。保留 assessedLevel 供审计日志使用。
function classifyRiskLevel(result, row, context) {
  const assessment = classifyRawRiskLevel(result, row, context);
  if (assessment.level === "高风险") {
    return {
      ...assessment,
      assessedLevel: "高风险",
      level: "中风险",
      reason: `${assessment.reason}；原始高风险按人工复核策略写为中风险`
    };
  }
  if (assessment.level === "中风险") {
    return {
      ...assessment,
      assessedLevel: "中风险",
      level: "低风险",
      reason: `${assessment.reason}；原始中风险按写回策略降为低风险`
    };
  }
  return { ...assessment, assessedLevel: assessment.level };
}

function hasReliableLowRiskClassification(result, context = {}) {
  if (!hasCompleteCategory(result)) return false;
  if (result.riskConsistencyBlocked) return false;
  return Number(result.confidence || 0) >= RELAXED_LOW_RISK_MIN_CONFIDENCE;
}

function normalizeRiskText(value) {
  return String(value || "").replace(/\s+/g, "");
}

function stripNegatedRiskText(value) {
  const text = normalizeRiskText(value);
  if (!text) return "";
  const terms = "投诉|举报|报警|退费|退款|退钱|扣款|续费|虚假宣传|诈骗|被骗|欺骗|套路|忽悠|诱导|骚扰|维权|黑猫|消协|12315|12345";
  return text
    .replace(new RegExp(`(?:不存在|没有|并非|不是|未见|未有|无|不会|不可能|不至于|没必要|怎么可能).{0,3}(?:${terms})`, "g"), "")
    .replace(new RegExp(`(?:${terms}).{0,4}(?:不至于|不会|不可能|没必要)`, "g"), "")
    .replace(new RegExp(`(?:分享|讲述|回忆|转发|看到|讨论).{0,12}(?:${terms}).{0,8}(?:经历|往事|视频|新闻|故事|内容)?`, "g"), "")
    .replace(/(?:被谁|谁|别人|他人|有人|客户|邻居|孩子|大宝).{0,6}(?:投诉|举报|报警)/g, "")
    .replace(/(?:被|遭到|收到).{0,3}(?:投诉|举报)/g, "");
}

function matchedRiskKeywords(text, rules) {
  return [...new Set(rules
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.label))];
}

const EXTERNAL_COMPLAINT_KEYWORDS = [
  { label: "工商", pattern: /工商|工商局|工商投诉/ },
  { label: "消协", pattern: /消协|消费者协会/ },
  { label: "12345", pattern: /12345/ },
  { label: "12315", pattern: /12315/ },
  { label: "报警", pattern: /报警|警察|派出所/ },
  { label: "市场监管", pattern: /市场监管|监管局|市监局/ },
  { label: "黑猫投诉", pattern: /黑猫投诉|黑猫/ },
  { label: "法院/起诉", pattern: /法院|起诉|打官司|诉讼/ },
  { label: "律师函", pattern: /律师函|律师/ },
  { label: "投诉公司", pattern: /投诉.{0,8}公司|公司.{0,8}投诉|投诉.{0,8}你们|投诉.{0,8}贵司/ },
  { label: "上门", pattern: /上门|到.{0,6}公司|去.{0,6}公司|找.{0,6}公司|到.{0,6}总部|去.{0,6}总部|找.{0,6}总部/ }
];

// T=中风险前必须在 K 列或学员侧真实上下文中命中用户约定的风险关键词，
// 不能只因为分类名、老师广告或模型总结里出现风险词而抬高风险等级。
const RISK_TRIGGER_KEYWORDS = [
  { label: "投诉", pattern: /投诉/ },
  { label: "举报", pattern: /举报/ },
  { label: "伪直播", pattern: /伪直播/ },
  { label: "报警", pattern: /报警/ },
  { label: "虚假宣传", pattern: /虚假宣传/ },
  { label: "诱导", pattern: /诱导/ },
  { label: "12315", pattern: /12315/ },
  { label: "黑猫", pattern: /黑猫/ },
  { label: "维权", pattern: /维权/ },
  { label: "市长热线", pattern: /市长热线/ },
  { label: "曝光你", pattern: /曝光你/ },
  { label: "消协", pattern: /消协/ },
  { label: "退费", pattern: /退费|退款|退钱/ },
  { label: "扣款", pattern: /扣款|续费/ },
  { label: "骚扰", pattern: /骚扰|再发|别再|不要再/ },
  { label: "诈骗/套路", pattern: /诈骗|被骗|欺骗|套路|忽悠/ }
];

const HIGH_RISK_KEYWORDS = [
  { label: "包治百病", pattern: /包治百病|包治|百病/ },
  { label: "治愈/根治", pattern: /治愈|根治|彻底治好|完全治好/ },
  { label: "替代医疗", pattern: /替代医疗|代替医疗|替代医院|不用看医生|不用吃药|停药/ },
  { label: "保证康复", pattern: /保证康复|保证恢复|保证痊愈/ },
  { label: "保底收益", pattern: /保底收益|保证收益|承诺收益/ },
  { label: "保证赚钱", pattern: /保证赚钱|稳赚|稳赚不赔|一定赚钱/ },
  { label: "就业承诺", pattern: /承诺就业|保证就业|包就业|保就业/ }
];

const ACTIONABLE_RISK_KEYWORDS = [
  { label: "投诉/举报", pattern: /投诉|举报|黑猫|维权|消协|12315|12345|报警|市场监管|工商|起诉|律师函|上门/ },
  { label: "退费/扣款争议", pattern: /退费|退款|退钱|扣款|续费|不退/ },
  { label: "课程套路/忽悠", pattern: /套路|忽悠|欺骗|诈骗|被骗|虚假宣传|夸大宣传/ }
];

function enforceRiskConsistency(result, context) {
  const userEvidence = getUserRiskEvidence(
    result,
    { message: context?.kOriginalMessage || "" },
    context || {}
  );
  if (result.thirdCategory === "投诉对象非兴趣岛" || result.firstCategory !== "无风险") return;
  // 一致性校验只针对“用户侧真实证据”。老师广告、右侧蓝色气泡和设备/家庭
  // 语境不能把一个无风险分类强行拦截成待复核。
  if (!userEvidence.qualified) return;

  const reason = String(result.reason || result.llmReason || "");
  const hasExplicitNoRiskReason = /(非实际投诉|没有实际投诉|未实际投诉|仅表达|误触|误会|日常|无实际争议|无具体诉求|非平台问题)/.test(reason);
  if (Number(result.confidence || 0) >= 0.95 && hasExplicitNoRiskReason) return;

  result.needsReview = true;
  result.riskConsistencyBlocked = true;
  result.reason = `${result.reason || "模型分类为无风险"}；用户侧K列/白色气泡存在明确风险证据，分类与证据不一致，转待复核`;
}

function isExplicitNoRiskCategory(result) {
  const third = String(result.thirdCategory || "");
  // 该分类本身已经表达“投诉对象不是本平台”，不能因为出现“投诉”二字
  // 被 T 风险二次抬高。
  if (third === "投诉对象非兴趣岛") return true;
  if (Number(result.confidence || 0) < 0.95) return false;
  if (!/(话题分享|无效会话)/.test(third)) return false;

  // “话题分享”只适用于真正的日常交流。若三天总结、Y/AH或老师处理
  // 文本已经出现投诉、黑猫、套路、忽悠等行动性风险证据，不能继续享受
  // 无风险豁免，否则写回层会把风险一致性校验再次短路。
  const categoryEvidence = normalizeRiskText([
    result.userSummary,
    result.overallDialogSummary,
    result.teacherHandlingSummary,
    result.riskReason,
    ...(Array.isArray(result.riskMatchedKeywords) ? result.riskMatchedKeywords : [])
  ].filter(Boolean).join("\n"));
  return !ACTIONABLE_RISK_KEYWORDS.some(({ pattern }) => pattern.test(categoryEvidence));
}

function failedRowsFromLog(value) {
  const logFile = resolveLogArg(value);
  const entries = readLogEntries(logFile);
  return new Set(entries
    .filter(shouldRetryLogEntry)
    .map((entry) => Number(entry.rowNumber))
    .filter(Boolean));
}

function reviewRowsFromLog(value) {
  const logFile = resolveLogArg(value);
  const legacyWriteMarkers = [
    "中/高风险已允许写回T列",
    "完整三级类按当前策略写回",
    "低风险放宽写回"
  ];
  return new Set(readLogEntries(logFile)
    .filter((entry) => {
      const diagnosis = Array.isArray(entry.diagnosis) ? entry.diagnosis.join("；") : "";
      return Boolean(entry.needsReview)
        || (Number(entry.confidence || 0) > 0 && Number(entry.confidence || 0) <= 0.6)
        || legacyWriteMarkers.some((marker) => diagnosis.includes(marker));
    })
    .map((entry) => Number(entry.rowNumber))
    .filter(Boolean));
}

function shouldRetryLogEntry(entry = {}) {
  const transientErrors = [entry.error, entry.llmError, entry.classificationError]
    .filter(Boolean)
    .map(String);
  if (transientErrors.some(isTransientRecognitionError)) return true;

  const isDomEntry = entry.contextSource === "dom"
    || Object.prototype.hasOwnProperty.call(entry, "domPersonListRefreshed")
    || Array.isArray(entry.domCandidateAttemptDetails);
  if (isDomEntry && shouldRetryDomRecognition(entry)) return true;

  const relatedRecords = Number(entry.relatedRecords || 0);
  if (!isDomEntry && entry.contextOpened === false) {
    // 已查到相关记录却没打开右侧，通常是点击或页面渲染的瞬时失败，值得重试。
    if (relatedRecords > 0) return true;

    const attempts = Array.isArray(entry.domCandidateAttemptDetails)
      ? entry.domCandidateAttemptDetails
      : [];
    const clickedCandidates = attempts.filter((item) => item?.personClickSucceeded === true);
    const queryFailed = attempts.some((item) =>
      (Array.isArray(item?.keywords) ? item.keywords : []).some((keyword) => keyword?.queryClicked === false)
    );

    // 没采集到人员卡片或查询按钮未执行，批量状态可能污染，重试一次有价值。
    if (!attempts.length || !clickedCandidates.length || queryFailed) return true;

    // 已逐个点击真实人员并确认均无记录，是确定性空结果；再次完整重跑只会耗时。
    return false;
  }

  if (!entry.profileSkipped) {
    const hasMissingProfileColumn = ["Q", "R", "S"].some((column) =>
      entry.profileColumnStatus?.[column] === "missing"
    );
    const profileError = String(entry.profileError || "");
    if (hasMissingProfileColumn && /(超时|错误|未查询|未进入|未打开|点击|页面|登录)/.test(profileError)) return true;
  }

  const dialogError = String(entry.dialogSummaryError || "");
  if (/(超时|timeout|网络|连接|请求失败|限流|429|5\d\d)/i.test(dialogError)) return true;
  return false;
}

function isTransientRecognitionError(value) {
  return /(超时|timeout|网络|连接|请求失败|限流|429|5\d\d|ECONN|ETIMEDOUT|socket|Target closed|Execution context|页面崩溃|导航失败|登录失效)/i
    .test(String(value || ""));
}

function completedRowsFromLog(value) {
  const logFile = resolveLogArg(value);
  const entries = readLogEntries(logFile);
  return new Set(entries
    .map((entry) => Number(entry.rowNumber))
    .filter(Boolean));
}

function resolveLogArg(value) {
  if (value && value !== true) return path.resolve(String(value));
  const latest = latestLogFile();
  if (!latest) throw new Error("未找到 logs/*.jsonl，无法断点续跑或失败重跑。");
  return latest;
}

function latestLogFile() {
  if (!fs.existsSync("logs")) return "";
  const files = fs.readdirSync("logs")
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => {
      const fullPath = path.resolve("logs", file);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.fullPath || "";
}

function readLogEntries(logFile) {
  return fs.readFileSync(logFile, "utf8")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function formatResult(entry) {
  const categoryWritable = entry.categoryColumnsWritable ?? shouldWriteCategoryColumns(entry);
  const riskWritable = entry.riskLevelWritable ?? shouldWriteRiskLevel(entry);
  const status = categoryWritable ? "可写回" : "待复核";
  const diagnosis = entry.diagnosis?.length ? `；原因：${entry.diagnosis.join("、")}` : "";
  const web = formatWebStatus(entry);
  const summary = entry.userSummary ? `，Y摘要：${entry.userSummary}` : "";
  const dialogSummary = entry.overallDialogSummary || entry.studentDialogSummary || entry.teacherDialogSummary
    ? `，三天总结：${entry.overallDialogSummary || "-"} / 学员：${entry.studentDialogSummary || "-"} / 老师：${entry.teacherDialogSummary || "-"}${entry.teacherResponseStatus ? ` / 老师状态：${entry.teacherResponseStatus}` : ""}${entry.teacherFollowupStatus ? `/${entry.teacherFollowupStatus}` : ""}`
    : "";
  const teacherHandling = entry.teacherHandlingSummary ? `，AI处理：${entry.teacherHandlingSummary}` : "";
  const categoryPatch = entry.categoryPatchApplied ? `，分类补丁：${entry.categoryPatchReason}` : "";
  const risk = entry.riskLevel ? `，T风险：${entry.riskLevel}` : "";
  const writeBlocks = [];
  if (!categoryWritable && entry.categoryWriteBlockedReason) {
    writeBlocks.push(`三级类未写回：${entry.categoryWriteBlockedReason}`);
  }
  if (!riskWritable && entry.riskWriteBlockedReason) {
    writeBlocks.push(`T未写回：${entry.riskWriteBlockedReason}`);
  }
  const writeBlockText = writeBlocks.length ? `，写回拦截：${writeBlocks.join("；")}` : "";
  const expanded = entry.contextExpanded ? "，已扩展上下文" : "";
  const profile = entry.actualProductType || entry.actualCampName || entry.actualCourseCategory
    ? `，Q/R/S：${formatProfileValue(entry.actualProductType, entry.actualProductTypeSource)} / ${formatProfileValue(entry.actualCampName, entry.actualCampNameSource)} / ${formatProfileValue(entry.actualCourseCategory, entry.actualCourseCategorySource)}`
    : "";
  return `行 ${entry.rowNumber} ${status}：${entry.firstCategory || "-"} / ${entry.secondCategory || "-"} / ${entry.thirdCategory || "-"}，置信度 ${entry.confidence}（${web}）${summary}${dialogSummary}${teacherHandling}${categoryPatch}${risk}${expanded}${profile}${writeBlockText}${diagnosis}`;
}

function formatProfileValue(value, source) {
  if (!value) return "-";
  if (!source) return value;
  if (/订单信息页.*订单购买类型/.test(source)) return `${value}(订单列表)`;
  if (/订单信息页.*订单商品名称兜底/.test(source)) return `${value}(订单商品名兜底)`;
  if (/训练营名称关键词高置信兜底/.test(source)) return `${value}(训练营名兜底)`;
  if (/所属品类|课程品类|品类名称|category/i.test(source)) return `${value}(详情页)`;
  if (/训练营名称|营名称|training/i.test(source)) return `${value}(详情页)`;
  return `${value}(${source})`;
}

function formatWebStatus(entry) {
  if (entry.contextSource === "api") {
    if (entry.contextOpened) {
      return `接口已获取上下文${entry.relatedRecords ? `(${entry.relatedRecords}条相关记录)` : ""}`;
    }
    if (entry.relatedRecords > 0) {
      return `接口已查询到相关记录(${entry.relatedRecords}条)，但未可靠提取上下文`;
    }
    return "接口未查询到相关记录";
  }
  if (entry.contextSource === "dom") {
    if (entry.contextOpened) {
      return `DOM已读取右侧上下文${entry.relatedRecords ? `(${entry.relatedRecords}条相关记录)` : ""}`;
    }
    if (entry.relatedRecords > 0) {
      return `DOM已查询到相关记录(${entry.relatedRecords}条)，但右侧上下文未打开`;
    }
    if (entry.invalidContext) {
      return "DOM当前未加载出记录（技术失败，已加入失败集合重跑）";
    }
    return "DOM未查询到相关记录";
  }
  if (entry.contextOpened) {
    return `网页已打开右侧上下文${entry.relatedRecords ? `(${entry.relatedRecords}条相关记录)` : ""}`;
  }
  if (entry.relatedRecords > 0) {
    return `网页已查询到相关记录(${entry.relatedRecords}条)，但右侧上下文未打开`;
  }
  return "网页未查询到相关记录";
}

function appendRiskEvidenceDiagnosis(reasons, context = {}, result = {}) {
  const evidence = getClassificationRiskEvidence(
    result,
    { message: context.kOriginalMessage || "" },
    context
  );
  if (evidence.nonBusinessKOnly) {
    reasons.push(evidence.kTechnicalAlarm
      ? "K列报警属于设备/系统语境，按无风险过滤"
      : "K列报警属于家庭生活语境，按无风险过滤");
  } else if (evidence.qualified && evidence.hasDetailedUserDissatisfaction) {
    reasons.push("用户侧命中风险关键词并明确表达不满或处理诉求");
  } else if (evidence.categoryRiskMention || evidence.summaryRiskMention) {
    reasons.push(result.riskLevel === "无风险"
      ? "虽出现风险词，但未形成可靠用户侧风险证据，T按无风险"
      : "出现风险分类或风险词，但用户侧证据不足");
  }
  if (result.thirdCategory === "过度骚扰") {
    reasons.push("过度骚扰统一按低风险处理");
  }
}

function diagnoseEntry(context, result) {
  const reasons = [];
  appendRiskEvidenceDiagnosis(reasons, context, result);
  if (context.contextSource === "api") {
    if (!context.foundConversation) reasons.push("未确认会话");
    if (!context.matchedMessage && !context.relatedRecords) reasons.push("未查询到相关记录");
    if (context.relatedRecords > 0 && !context.contextOpened) reasons.push("详情接口未提取上下文");
    if (context.apiStaffResolveError) reasons.push(`员工ID解析失败：${context.apiStaffResolveError}`);
    if (context.apiStaffCandidates?.length === 1) reasons.push(`已解析员工ID：${context.apiStaffCandidates[0].weworkUserId}`);
    if (context.apiStaffCandidates?.length > 1) reasons.push(`已尝试${context.apiStaffCandidates.length}个员工候选`);
    if (context.apiDetailTried > 0) reasons.push(`已尝试${context.apiDetailTried}个详情候选`);
    if (context.contextExtractorAttempted) reasons.push("已尝试DeepSeek上下文解析");
    if (context.contextExtractorError) reasons.push(`上下文解析失败：${context.contextExtractorError}`);
    if (context.relatedRecords > 0 && !context.contextOpened && !context.contextExtractorAttempted) reasons.push("详情接口无有效响应，未触发上下文解析");
    if (!result.firstCategory || result.confidence === 0) reasons.push("规则未命中");
    if (result.needsReview && result.confidence > 0 && result.confidence <= 0.6) reasons.push("置信度偏低");
    if (result.llmError && !context.contextExtractorAttempted) reasons.push(result.llmError);
    if (context.contextOpened && !context.userBubbleText) reasons.push("未提取到白色气泡");
    if (context.userDirectionReliable === false) reasons.push("接口无法可靠区分学员侧消息");
    if (context.userBubbleText && !result.userSummary) reasons.push("Y摘要未生成");
    if (result.summaryDialogCategoryUsed) reasons.push("基于Y/AH摘要高置信补判分类");
    else if (result.summaryCategoryUsed) reasons.push("基于Y摘要高置信反推分类");
    if (result.categoryPatchApplied) reasons.push(`体验营投诉补丁：${result.categoryPatchReason}`);
    if (result.kComplaintPatchApplied) reasons.push(`K列明确诉求纠偏：${result.kComplaintPatchReason}`);
    if (result.evidenceGuardApplied) reasons.push(`证据语境校正：${result.evidenceGuardReason}`);
    if (result.kEvidenceReviewRequired) reasons.push(`K列证据不足：${result.kEvidenceGuardReason}`);
    if (result.riskConsistencyBlocked) reasons.push("Y摘要存在风险词但分类为无风险");
    if (result.needsReview) reasons.push("模型标记待复核，未自动写回三级分类和T风险");
    if (result.riskAssessedLevel && result.riskAssessedLevel !== result.riskLevel) {
      reasons.push(`T原始判定=${result.riskAssessedLevel}，已按写回策略映射为${result.riskLevel}`);
    }
    if (result.riskLevel) reasons.push(`T风险=${result.riskLevel}`);
    if (result.riskReason) reasons.push(`T原因=${result.riskReason}`);
    if (result.riskMatchedKeywords?.length) reasons.push(`T命中=${result.riskMatchedKeywords.join("/")}`);
    if (context.contextExpanded) reasons.push(`已扩展上下文：${context.contextExpandReason || "疑难行补充前后文"}`);
    if (context.contextExpandError) reasons.push(`上下文扩展失败：${context.contextExpandError}`);
    if (result.contextExpandedClassification) reasons.push(result.needsReview ? "扩展后仍待复核" : "扩展后重新分类");
    if (result.dialogSummarySource) reasons.push("已生成三天对话总结");
    if (result.dialogSummaryError) reasons.push(`三天总结失败：${result.dialogSummaryError}`);
    if (result.dialogSummaryWarning) reasons.push(`三天总结提示：${result.dialogSummaryWarning}`);
    if (context.llmContextUsed) reasons.push("大模型已参与接口上下文提取");
    if (context.apiCrossStaffSearch) reasons.push("未确认员工ID，已启用跨员工接口搜索");
    if (result.docProductType) reasons.push(`文档L=${result.docProductType}`);
    if (result.docCampName) reasons.push(`文档M=${result.docCampName}`);
    if (result.profileFormalOrderFound) reasons.push("已发现正式营订单");
    if (result.profileMatchedOrderName || result.profileMatchedOrderType) {
      reasons.push(`选中订单=${[result.profileMatchedOrderType, result.profileMatchedOrderName, result.profileMatchedOrderId].filter(Boolean).join("/")}`);
    }
    if (result.profileOrderSelectionReason) reasons.push(`选单原因：${result.profileOrderSelectionReason}`);
    if (result.profileExtractor === "deepseek") reasons.push(`DeepSeek档案解析置信度${result.profileExtractConfidence || 0}`);
    if (result.profileLlmError) reasons.push(`档案模型失败：${result.profileLlmError}`);
    if (result.profileDetailEndpointMatched) reasons.push(context.contextSource === "dom" ? "已打开档案详情页" : "已命中档案详情接口");
    if (result.profileOrderListHasProductType) reasons.push(`订单列表Q=${result.profileOrderListProductType}`);
    if (result.profileOrderCardProductName) reasons.push(`订单商品名称=${result.profileOrderCardProductName}`);
    if (result.profileCampNameFallbackUsed) reasons.push("R来源=订单信息页商品名称兜底");
    if (result.profileCampNameRejectedReason) reasons.push(`R兜底拒绝：${result.profileCampNameRejectedReason}`);
    if (result.actualCourseCategorySourceTrust) reasons.push(`S来源=${result.actualCourseCategorySourceTrust}`);
    if (
      result.actualCourseCategoryRaw &&
      result.actualCourseCategoryNormalized &&
      result.actualCourseCategoryRaw !== result.actualCourseCategoryNormalized
    ) {
      reasons.push(`S标准化：${result.actualCourseCategoryRaw}->${result.actualCourseCategoryNormalized}`);
    }
    if (result.profileCourseCategoryRejectedSource) reasons.push(`拒绝S来源=${result.profileCourseCategoryRejectedSource}`);
    if (result.profileCourseCategoryConflictReason) reasons.push(`S冲突：${result.profileCourseCategoryConflictReason}`);
    if (result.profileDetailEndpointMatched && !result.profileDetailHasTrainingName) reasons.push(context.contextSource === "dom" ? "详情页缺训练营名称字段" : "详情接口缺训练营名称字段");
    if (result.profileDetailEndpointMatched && !result.profileDetailHasCategory) reasons.push(context.contextSource === "dom" ? "详情页缺所属品类字段" : "详情接口缺所属品类字段");
    if (result.profileDetailEndpointMatched && !result.profileDetailHasCampTypeId && !result.profileOrderListHasProductType) {
      reasons.push("订单列表/详情缺体验营或正式营判断字段");
    }
    if (result.profileError && hasAnyProfileField(result)) reasons.push(`档案字段部分缺失：${result.profileError}`);
    else if (result.profileError) reasons.push(`档案未写Q/R/S：${result.profileError}`);
    else if (result.profileFound) reasons.push("已获取学员档案Q/R/S");
    return reasons;
  }
  if (!context.foundConversation) reasons.push("未确认会话");
  if (context.relatedRecords > 0 && !context.contextOpened) reasons.push("已查询到相关记录但未打开右侧上下文");
  if (!context.matchedMessage && !context.relatedRecords) {
    reasons.push(context.invalidContext
      ? (context.domCandidateFailureReason || context.error || "当前候选暂未加载出记录，已加入失败集合重跑")
      : "未查询到相关记录");
  }
  if (!context.queryClicked) reasons.push("查询按钮未确认点击");
  if (context.relatedRecords > 0 && !context.conversationClicked) reasons.push("相关会话未点击");
  if (context.relatedRecords > 0 && !context.recordClicked) reasons.push("相关记录未点击");
  if (context.relatedRecords > 0 && !context.contextOpened) reasons.push("右侧上下文未打开");
  if (context.candidateTried === 1) reasons.push("仅尝试到1个人员候选");
  if (!result.firstCategory || result.confidence === 0) reasons.push("规则未命中");
  if (result.needsReview && result.confidence > 0 && result.confidence <= 0.6) reasons.push("置信度偏低");
  if (result.llmError) reasons.push(result.llmError);
  if (result.classifier === "deepseek" && result.needsReview && result.confidence > 0) {
    reasons.push("大模型标记待复核，未自动写回三级分类和T风险");
  }
  if (context.contextOpened && !context.userBubbleText) reasons.push("未提取到白色气泡");
  if (context.contextSource === "api" && context.userDirectionReliable === false) reasons.push("接口无法可靠区分学员侧消息");
  if (context.userBubbleText && !result.userSummary) reasons.push("Y摘要未生成");
  if (result.summaryDialogCategoryUsed) reasons.push("基于Y/AH摘要高置信补判分类");
  else if (result.summaryCategoryUsed) reasons.push("基于Y摘要高置信反推分类");
  if (result.categoryPatchApplied) reasons.push(`体验营投诉补丁：${result.categoryPatchReason}`);
  if (result.kComplaintPatchApplied) reasons.push(`K列明确诉求纠偏：${result.kComplaintPatchReason}`);
  if (result.evidenceGuardApplied) reasons.push(`证据语境校正：${result.evidenceGuardReason}`);
  if (result.kEvidenceReviewRequired) reasons.push(`K列证据不足：${result.kEvidenceGuardReason}`);
  if (result.riskConsistencyBlocked) reasons.push("Y摘要存在风险词但分类为无风险");
  if (result.riskAssessedLevel && result.riskAssessedLevel !== result.riskLevel) {
    reasons.push(`T原始判定=${result.riskAssessedLevel}，已按写回策略映射为${result.riskLevel}`);
  }
  if (result.riskLevel) reasons.push(`T风险=${result.riskLevel}`);
  if (result.riskReason) reasons.push(`T原因=${result.riskReason}`);
  if (result.riskMatchedKeywords?.length) reasons.push(`T命中=${result.riskMatchedKeywords.join("/")}`);
  if (context.contextExpanded) reasons.push(`已扩展上下文：${context.contextExpandReason || "疑难行补充前后文"}`);
  if (context.contextExpandError) reasons.push(`上下文扩展失败：${context.contextExpandError}`);
  if (result.contextExpandedClassification) reasons.push(result.needsReview ? "扩展后仍待复核" : "扩展后重新分类");
  if (result.dialogSummarySource) reasons.push("已生成三天对话总结");
  if (result.dialogSummaryError) reasons.push(`三天总结失败：${result.dialogSummaryError}`);
  if (result.dialogSummaryWarning) reasons.push(`三天总结提示：${result.dialogSummaryWarning}`);
  if (context.llmContextUsed) reasons.push("大模型已参与接口上下文提取");
  if (context.contextSource === "api" && context.apiCrossStaffSearch) reasons.push("未确认员工ID，已启用跨员工接口搜索");
  if (result.docProductType) reasons.push(`文档L=${result.docProductType}`);
  if (result.docCampName) reasons.push(`文档M=${result.docCampName}`);
  if (result.profileFormalOrderFound) reasons.push("已发现正式营订单");
  if (result.profileMatchedOrderName || result.profileMatchedOrderType) {
    reasons.push(`选中订单=${[result.profileMatchedOrderType, result.profileMatchedOrderName, result.profileMatchedOrderId].filter(Boolean).join("/")}`);
  }
  if (result.profileOrderSelectionReason) reasons.push(`选单原因：${result.profileOrderSelectionReason}`);
  if (result.profileExtractor === "deepseek") reasons.push(`DeepSeek档案解析置信度${result.profileExtractConfidence || 0}`);
  if (result.profileLlmError) reasons.push(`档案模型失败：${result.profileLlmError}`);
  if (result.profileDetailEndpointMatched) reasons.push(context.contextSource === "dom" ? "已打开档案详情页" : "已命中档案详情接口");
  if (result.profileOrderListHasProductType) reasons.push(`订单列表Q=${result.profileOrderListProductType}`);
  if (result.profileOrderCardProductName) reasons.push(`订单商品名称=${result.profileOrderCardProductName}`);
  if (result.profileCampNameFallbackUsed) reasons.push("R来源=订单信息页商品名称兜底");
  if (result.profileCampNameRejectedReason) reasons.push(`R兜底拒绝：${result.profileCampNameRejectedReason}`);
  if (result.actualCourseCategorySourceTrust) reasons.push(`S来源=${result.actualCourseCategorySourceTrust}`);
  if (
    result.actualCourseCategoryRaw &&
    result.actualCourseCategoryNormalized &&
    result.actualCourseCategoryRaw !== result.actualCourseCategoryNormalized
  ) {
    reasons.push(`S标准化：${result.actualCourseCategoryRaw}->${result.actualCourseCategoryNormalized}`);
  }
  if (result.profileCourseCategoryRejectedSource) reasons.push(`拒绝S来源=${result.profileCourseCategoryRejectedSource}`);
  if (result.profileCourseCategoryConflictReason) reasons.push(`S冲突：${result.profileCourseCategoryConflictReason}`);
  if (result.profileDetailEndpointMatched && !result.profileDetailHasTrainingName) reasons.push(context.contextSource === "dom" ? "详情页缺训练营名称字段" : "详情接口缺训练营名称字段");
  if (result.profileDetailEndpointMatched && !result.profileDetailHasCategory) reasons.push(context.contextSource === "dom" ? "详情页缺所属品类字段" : "详情接口缺所属品类字段");
  if (result.profileDetailEndpointMatched && !result.profileDetailHasCampTypeId && !result.profileOrderListHasProductType) {
    reasons.push("订单列表/详情缺体验营或正式营判断字段");
  }
  if (result.profileError && hasAnyProfileField(result)) reasons.push(`档案字段部分缺失：${result.profileError}`);
  else if (result.profileError) reasons.push(`档案未写Q/R/S：${result.profileError}`);
  else if (result.profileFound) reasons.push("已获取学员档案Q/R/S");
  return reasons;
}

function hasAnyProfileField(result) {
  return Boolean(result.actualProductType || result.actualCampName || result.actualCourseCategory);
}

function countTextLines(text) {
  return String(text || "").split(/\n+/).filter((line) => line.trim().length >= 2).length;
}

async function buildDialogContextForRow({ row, context, client, contextMode, args }) {
  const window = buildDialogWindow(row);
  const base = {
    dialogWindowStart: window.start,
    dialogWindowEnd: window.end,
    dialogSummaryError: "",
    dialogMessageCount: 0,
    studentDialogMessageCount: 0,
    teacherDialogMessageCount: 0,
    dialogDomScrolledBefore: 0,
    dialogDomScrolledAfter: 0,
    dialogDomReachedWindowBoundary: false,
    contextOpened: Boolean(context.contextOpened)
  };

  if (!context.contextOpened) {
    return {
      ...base,
      dialogContextText: "",
      dialogStudentText: "",
      dialogTeacherText: "",
      dialogSummaryError: "右侧上下文未打开，无法采集三天对话"
    };
  }

  let dialogContext = context;
  if (
    contextMode === "dom" &&
    typeof client.expandContext === "function" &&
    !context.contextExpanded
  ) {
    const screens = Math.max(1, Number(args["dialog-screens"] || 4));
    const expanded = await client.expandContext(row, context, {
      beforeScreens: screens,
      afterScreens: screens,
      reason: "三天对话总结补充上下文"
    });
    if (expanded?.contextOpened) {
      dialogContext = expanded;
      base.dialogDomScrolledBefore = screens;
      base.dialogDomScrolledAfter = screens;
      base.dialogDomReachedWindowBoundary = Boolean(expanded.contextExpanded);
    } else {
      base.dialogSummaryError = expanded?.contextExpandError || "三天对话扩展失败，使用当前可见上下文";
    }
  }

  const structuredMessages = normalizeStructuredMessages(dialogContext.dialogMessages || []);
  const structuredStudentMessages = normalizeStructuredMessages(dialogContext.dialogStudentMessages || []);
  const structuredTeacherMessages = normalizeStructuredMessages(dialogContext.dialogTeacherMessages || []);
  const overallText = structuredMessages.length
    ? structuredMessages.map(formatDialogMessage).join("\n")
    : normalizeDialogLines(dialogContext.contextText || "").join("\n");
  const studentMessages = structuredStudentMessages.length
    ? structuredStudentMessages.map((message) => message.text)
    : normalizeMessageList(dialogContext.userBubbleMessages || []);
  const studentText = studentMessages.join("\n") || normalizeDialogLines(dialogContext.userBubbleText || "").join("\n");
  const teacherMessages = structuredTeacherMessages.length
    ? structuredTeacherMessages.map((message) => message.text)
    : deriveTeacherMessages(overallText, studentMessages);
  const teacherText = normalizeMessageList(teacherMessages).join("\n");
  const teacherHandlingMessages = filterTeacherHandlingMessages(teacherMessages);
  const teacherTextFiltered = teacherHandlingMessages.length
    ? teacherHandlingMessages.join("\n")
    : teacherText;

  return {
    ...base,
    contextOpened: Boolean(dialogContext.contextOpened),
    dialogContextText: overallText,
    dialogStudentText: studentText,
    dialogTeacherText: teacherText,
    dialogTeacherTextFiltered: teacherTextFiltered,
    dialogMessageCount: countTextLines(overallText),
    studentDialogMessageCount: countTextLines(studentText),
    teacherDialogMessageCount: teacherMessages.length,
    teacherHandlingMessageCount: teacherHandlingMessages.length,
    dialogDomScrolledBefore: base.dialogDomScrolledBefore,
    dialogDomScrolledAfter: base.dialogDomScrolledAfter,
    dialogDomReachedWindowBoundary: base.dialogDomReachedWindowBoundary
  };
}

function normalizeStructuredMessages(messages) {
  const seen = new Set();
  const result = [];
  for (const item of messages || []) {
    const text = normalizeDialogLine(typeof item === "string" ? item : item.text);
    if (!text) continue;
    const key = compactDialogText(`${item.time || ""}${item.speaker || ""}${item.role || ""}${text}`);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      text,
      time: typeof item === "string" ? "" : String(item.time || ""),
      speaker: typeof item === "string" ? "" : String(item.speaker || ""),
      role: typeof item === "string" ? "" : String(item.role || "")
    });
  }
  return result;
}

function formatDialogMessage(message) {
  return [message.time, message.speaker || message.role, message.text].filter(Boolean).join(" ");
}

function buildDialogWindow(row) {
  const sentAt = parseLooseDate(row.sentAt || row.dataDate);
  if (!sentAt) return { start: "", end: "" };
  const start = new Date(sentAt.getTime() - 3 * 24 * 60 * 60 * 1000);
  const end = new Date(sentAt.getTime() + 3 * 24 * 60 * 60 * 1000);
  return {
    start: formatDateTime(start),
    end: formatDateTime(end)
  };
}

function parseLooseDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = text.replace(/[./]/g, "-");
  const match = normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0)
    );
  }
  const number = Number(text);
  if (Number.isFinite(number) && number > 20000) {
    return new Date(Math.round((number - 25569) * 86400 * 1000));
  }
  return null;
}

function formatDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function normalizeMessageList(messages) {
  const seen = new Set();
  const result = [];
  for (const message of messages || []) {
    const text = normalizeDialogLine(message);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeDialogLines(text) {
  return normalizeMessageList(String(text || "").split(/\n+/));
}

function normalizeDialogLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[：:，,。.\s]+|[：:，,。.\s]+$/g, "")
    .trim();
}

function deriveTeacherMessages(overallText, studentMessages) {
  const studentSet = new Set(studentMessages.map(compactDialogText));
  return normalizeDialogLines(overallText)
    .filter((line) => isDialogMessageLine(line))
    .filter((line) => !studentSet.has(compactDialogText(line)));
}

function filterTeacherHandlingMessages(messages) {
  const normalized = normalizeMessageList(messages);
  const handling = normalized.filter((line) => TEACHER_HANDLING_PATTERN.test(line));
  if (handling.length) return handling;
  return normalized.filter((line) => !TEACHER_PROMOTION_PATTERN.test(line));
}

const TEACHER_HANDLING_PATTERN = /(登记|记录|提交|申请|发起|反馈|处理|跟进|退款|退费|退回|退到|到账|审核|流程|工单|安排|补发|补寄|重发|已发|发您|给您发|发课程|课程已发|发资料|补资料|发回放|补回放|发链接|补链接|发货|补发货|已发货|已到货|物流|快递|赠品|礼品|小音箱|教材|资料|课程|帮您|为您|稍等|等一下|耐心等待|核实|确认|转交|联系|回复|解决|售后|客服|班主任|道歉|抱歉|不好意思|未及时|没及时|漏回|晚回|回复慢)/;

const TEACHER_PROMOTION_PATTERN = /(报名|优惠|福利|活动|名额|课程介绍|直播间|开营|训练营|正式营|体验营|购买|下单|优惠券|限时|扫码|二维码|海报|链接|领取|赠送|礼包|学习资料|群内通知|今晚|明天.*直播|老师.*分享|欢迎|邀请|转发|推广|续报)/;

function isDialogMessageLine(line) {
  const text = normalizeDialogLine(line);
  if (!text) return false;
  if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}(\s+\d{1,2}:\d{1,2}(:\d{1,2})?)?$/.test(text)) return false;
  if (/^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(text)) return false;
  if (/^(私聊记录|群聊记录|学员相关记录|老师相关记录|查看最早消息|查看最新消息|暂无消息|暂无会话)$/.test(text)) return false;
  if (/^ID[:：]\s*\d+/.test(text)) return false;
  return [...text].length >= 2;
}

function compactDialogText(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function printSummary(entries) {
  const total = entries.length;
  const review = entries.filter((item) => item.needsReview).length;
  const opened = entries.filter((item) => item.contextOpened).length;
  const related = entries.filter((item) => item.relatedRecords > 0).length;
  const llm = entries.filter((item) => item.classifier === "deepseek").length;
  const summaries = entries.filter((item) => item.userSummary).length;
  const dialogSummaries = entries.filter((item) =>
    item.overallDialogSummary || item.studentDialogSummary || item.teacherDialogSummary
  ).length;
  const teacherHandlingSummaries = entries.filter((item) => item.teacherHandlingSummary).length;
  const profiles = entries.filter((item) => item.profileFound).length;
  const profileColumns = summarizeProfileColumns(entries);
  const profileFailures = summarizeProfileFailures(entries);
  const categoryWritable = entries.filter((item) => item.categoryColumnsWritable).length;
  const riskWritable = entries.filter((item) => item.riskLevelWritable ?? shouldWriteRiskLevel(item)).length;
  const llmContext = entries.filter((item) => item.llmContextUsed).length;
  const expanded = entries.filter((item) => item.contextExpanded).length;
  const avgContextMs = average(entries.map((item) => item.contextMs).filter((value) => value > 0));
  const avgLlmMs = average(entries.map((item) => item.llmMs).filter((value) => value > 0));
  const avgApiSearchMs = average(entries.map((item) => item.apiSearchMs).filter((value) => value > 0));
  const avgApiDetailMs = average(entries.map((item) => item.apiDetailMs).filter((value) => value > 0));
  const avgProfileMs = average(entries.map((item) => item.profileMs).filter((value) => value > 0));
  const cacheHits = entries.filter((item) => item.contextCacheHit).length;
  const timingSummary = summarizeWebTimings(entries);
  console.log(`诊断汇总：共 ${total} 行，待复核 ${review} 行，查到相关记录 ${related} 行，右侧上下文打开 ${opened} 行，扩展上下文 ${expanded} 行，DeepSeek 上下文解析 ${llmContext} 行，DeepSeek 分类 ${llm} 行，Y摘要 ${summaries} 行，三天总结 ${dialogSummaries} 行，AI处理进展 ${teacherHandlingSummaries} 行，Q/R/S档案 ${profiles} 行。`);
  console.log(`档案列诊断：Q 写入${profileColumns.Q.written}/保留${profileColumns.Q.preserved}/L兜底${profileColumns.Q.fallback}/缺失${profileColumns.Q.missing}；R 写入${profileColumns.R.written}/保留${profileColumns.R.preserved}/M兜底${profileColumns.R.fallback}/缺失${profileColumns.R.missing}；S 写入${profileColumns.S.written}/保留${profileColumns.S.preserved}/缺失${profileColumns.S.missing}。`);
  if (profileFailures.length) console.log(`档案失败阶段：${profileFailures.join("；")}。`);
  console.log(`写回诊断：三级分类已写回 ${categoryWritable}/${total} 行，T风险已写回 ${riskWritable}/${total} 行。待复核或低置信度结论不自动写回；原始中风险写低风险，原始高风险写中风险。`);
  console.log(`耗时诊断：上下文平均 ${avgContextMs}ms，模型平均 ${avgLlmMs}ms，档案平均 ${avgProfileMs}ms，上下文缓存命中 ${cacheHits} 行。`);
  if (avgApiSearchMs || avgApiDetailMs) {
    console.log(`接口阶段：搜索 ${avgApiSearchMs}ms，详情 ${avgApiDetailMs}ms。`);
  }
  if (timingSummary) {
    console.log(`网页阶段：人员 ${timingSummary.personSearchMs}ms，查询 ${timingSummary.queryMs}ms，检测记录 ${timingSummary.detectRelatedMs}ms，打开上下文 ${timingSummary.openContextMs}ms。`);
  }
}

function summarizeProfileColumns(entries) {
  const fields = { Q: "actualProductType", R: "actualCampName", S: "actualCourseCategory" };
  const summary = Object.fromEntries(Object.keys(fields).map((column) => [column, {
    written: 0,
    preserved: 0,
    fallback: 0,
    missing: 0
  }]));
  for (const entry of entries) {
    for (const [column, field] of Object.entries(fields)) {
      const status = entry.profileColumnStatus?.[column]
        || (String(entry[field] || "").trim() ? "written" : "missing");
      if (Object.prototype.hasOwnProperty.call(summary[column], status)) summary[column][status] += 1;
      else summary[column].missing += 1;
    }
  }
  return summary;
}

function summarizeProfileFailures(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const stage = String(entry.profileFailureStage || "").trim();
    if (stage) counts.set(stage, (counts.get(stage) || 0) + 1);
  }
  return [...counts.entries()].map(([stage, count]) => `${stage} ${count}行`);
}

function average(values) {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function summarizeWebTimings(entries) {
  const personTimes = entries
    .map((entry) => entry.webTimings?.personSearchMs)
    .filter((value) => Number(value) > 0);
  const candidateTimes = entries.flatMap((entry) => entry.webTimings?.candidates || []);
  if (!personTimes.length && !candidateTimes.length) return null;
  return {
    personSearchMs: average(personTimes),
    queryMs: average(candidateTimes.map((item) => item.queryMs).filter((value) => Number(value) > 0)),
    detectRelatedMs: average(candidateTimes.map((item) => item.detectRelatedMs).filter((value) => Number(value) > 0)),
    openContextMs: average(candidateTimes.map((item) => item.openContextMs).filter((value) => Number(value) > 0))
  };
}

function shouldExpandDomContext({ contextMode, client, context, result, llmSettings, args }) {
  if (contextMode !== "dom") return { expand: false };
  if (!context?.contextOpened) return { expand: false };
  if (context.contextExpanded) return { expand: false };
  if (typeof client.expandContext !== "function") return { expand: false };
  // 网络或模型超时后扩展 DOM 不会修复基础设施故障，避免同一行再次等待一次完整超时。
  if (isModelRequestFailure(result?.llmError)) return { expand: false };

  const minConfidence = Number(llmSettings?.minConfidenceToWrite || 0.6);
  const currentLineCount = countTextLines(context.contextText || "");
  let reason = "";
  if (context.kEvidenceWeak) reason = "K列为图片/附件占位，必须扩展前后文确认真实诉求";
  else if (currentLineCount > 0 && currentLineCount < 4) reason = `右侧当前屏上下文不足4行(${currentLineCount}行)`;
  else if (result.needsReview) reason = "首次分类待复核";
  else if (Number(result.confidence || 0) < minConfidence) reason = `首次置信度低于阈值 ${minConfidence}`;
  else if (result.llmError) reason = `大模型异常：${result.llmError}`;
  else if (llmSettings?.enabled && result.llmValidCategory === false) reason = "首次分类不在新版场景分类中";
  else if (context.userBubbleText && !result.userSummary) reason = "白色气泡已提取但Y摘要缺失";

  if (!reason) return { expand: false };
  const screens = Math.max(1, Number(
    args[context.kEvidenceWeak ? "image-expand-screens" : "expand-screens"]
      || (context.kEvidenceWeak ? 4 : 2)
  ));
  return {
    expand: true,
    reason,
    beforeScreens: screens,
    afterScreens: screens
  };
}

function isModelRequestFailure(value) {
  return /(请求超时|timeout|网络|连接|请求失败|限流|429|5\d\d|ECONN|ETIMEDOUT|socket)/i.test(String(value || ""));
}

async function withProgressHeartbeat(label, promise) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    console.log(`${label}，已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒...`);
  }, 10_000);
  timer.unref?.();
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

function resolveContextMode(config, args, offline) {
  if (offline) return "offline";
  if (args.dom) return "dom";
  if (args.ui) return "ui";
  if (args.api) return "api";
  const configured = String(config.context?.mode || "api").toLowerCase();
  if (configured === "ui") return "ui";
  if (configured === "dom") return "dom";
  return "api";
}

function resolveRuntimeMode(args) {
  const offline = Boolean(args.offline);
  if (offline && !args["offline-confirmed"]) {
    throw new Error("离线模式需要显式确认：请同时传入 --offline-confirmed");
  }
  return {
    offline,
    disableLlm: offline || Boolean(args["no-llm"])
  };
}

async function createContextClient({ config, offline, contextMode }) {
  if (contextMode === "api") return await createQichatApiClient(config, offline);
  if (contextMode === "dom") return await createQichatDomClient(config, offline);
  return await createQichatClient(config, offline);
}

function createSkippedProfileClient() {
  return {
    async ensureReady() {
      return { ready: true, waitedForLogin: false };
    },
    async fetchProfile() {
      return {
        profileSource: "chat-only-retry",
        profileSkipped: true,
        profileFound: false,
        profileError: ""
      };
    },
    async close() {}
  };
}

function formatContextMode(contextMode) {
  if (contextMode === "api") return "接口模式";
  if (contextMode === "dom") return "DOM读取模式";
  if (contextMode === "ui") return "旧UI模式";
  return "离线模式";
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

// 供风险规则回归测试和离线审计使用；命令行入口仍由上面的 main() 负责。
export {
  applyExperienceComplaintCategoryPatch,
  classifyRiskLevel,
  getUserRiskEvidence,
  getClassificationRiskEvidence,
  applyClassificationEvidenceGuards,
  shouldWriteCategoryColumns,
  shouldWriteRiskLevel,
  buildLogEntry,
  reviewRowsFromLog,
  resolveRuntimeMode
};
