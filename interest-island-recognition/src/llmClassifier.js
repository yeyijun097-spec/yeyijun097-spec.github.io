import {
  applyExternalLlmAuthorization,
  collectExternalLlmRedactions,
  isExternalLlmAllowed,
  sanitizeChatMessagesForExternalLlm,
  sanitizeRowForExternalLlm,
  sanitizeTextForExternalLlm
} from "./llmDataBoundary.js";

const DEFAULT_LLM = {
  enabled: true,
  provider: "deepseek",
  baseUrl: "",
  model: "deepseek-v4-flash",
  timeoutMs: 45000,
  maxContextChars: 12000,
  minConfidenceToWrite: 0.6,
  maxSummaryLength: 15,
  summaryMinConfidenceToClassify: 0.95
};

export function resolveLlmSettings(config, args = {}) {
  const configured = { ...DEFAULT_LLM, ...(config.llm || {}) };
  const enabled = args["no-llm"] ? false : configured.enabled !== false;
  return applyExternalLlmAuthorization({
    ...configured,
    enabled,
    apiKey: process.env.ARK_API_KEY || process.env.DEEPSEEK_API_KEY || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || configured.baseUrl || DEFAULT_LLM.baseUrl,
    model: args["llm-model"] || process.env.DEEPSEEK_MODEL || configured.model || DEFAULT_LLM.model,
    minConfidenceToWrite: Number(configured.minConfidenceToWrite || DEFAULT_LLM.minConfidenceToWrite),
    maxSummaryLength: Number(configured.maxSummaryLength || DEFAULT_LLM.maxSummaryLength),
    summaryMinConfidenceToClassify: Number(configured.summaryMinConfidenceToClassify || DEFAULT_LLM.summaryMinConfidenceToClassify)
  });
}

export function assertLlmConfigured(settings) {
  if (!settings.enabled) return;
  if (!settings.apiKey) {
    throw new Error(
      "已启用分类大模型，但未检测到 ARK_API_KEY 或 DEEPSEEK_API_KEY；如需临时使用纯规则模式，请加 --no-llm。"
    );
  }
}

export async function classifyWithLlm({ row, context, rules, ruleResult, settings }) {
  const baseMeta = {
    classifier: "deepseek",
    llmProvider: settings.provider || "deepseek",
    llmModel: settings.model,
    llmValidCategory: false,
    llmReason: "",
    llmEvidence: "",
    llmError: "",
    llmRawSnippet: "",
    userSummary: "",
    summarySource: "",
    summaryTruncated: false,
    summaryError: "",
    summaryCategoryUsed: false,
    summaryCategoryConfidence: 0
  };

  if (!isExternalLlmAllowed(settings)) {
    return llmBlockedResult(ruleResult, {
      ...baseMeta,
      classifier: "deepseek_skipped",
      llmError: settings?.llmDisabledReason || "分类大模型未启用"
    });
  }

  if (!context.contextOpened) {
    return llmBlockedResult(ruleResult, {
      ...baseMeta,
      classifier: "deepseek_skipped",
      llmError: "上下文未可靠提取，分类大模型未调用"
    });
  }

  if (
    ruleResult?.firstCategory === "无风险" &&
    ruleResult?.secondCategory === "无风险" &&
    ruleResult?.thirdCategory === "话题分享" &&
    Number(ruleResult?.confidence || 0) >= 0.95 &&
    ruleResult?.needsReview !== true
  ) {
    return {
      ...baseMeta,
      ...ruleResult,
      classifier: "rule_high_confidence_no_risk",
      llmValidCategory: true,
      ruleFirstCategory: ruleResult.firstCategory,
      ruleSecondCategory: ruleResult.secondCategory,
      ruleThirdCategory: ruleResult.thirdCategory,
      ruleConfidence: ruleResult.confidence,
      ruleReason: ruleResult.reason || ""
    };
  }

  try {
    const raw = await requestDeepSeek({ row, context, rules, settings });
    const parsed = parseJsonContent(raw);
    const summary = normalizeSummary(parsed.userSummary, settings.maxSummaryLength);
    const validation = validateCategory(parsed, rules);
    const confidence = normalizeConfidence(parsed.confidence);
    const reason = normalizeText(parsed.reason);
    const evidence = normalizeEvidence(parsed.evidence);
    const rawSnippet = sanitizeTextForExternalLlm(raw, 1000, {
      redactions: collectExternalLlmRedactions(row)
    });
    const summaryMeta = {
      userSummary: summary.text,
      summarySource: summary.text ? "deepseek_white_bubbles" : "",
      summaryTruncated: summary.truncated,
      summaryError: summary.text ? "" : (context.userBubbleText ? "DeepSeek未生成Y摘要" : "未提取到白色气泡")
    };
    const summaryCandidate = {
      firstCategory: parsed.summaryFirstCategory,
      secondCategory: parsed.summarySecondCategory,
      thirdCategory: parsed.summaryThirdCategory
    };
    const summaryValidation = validateCategory(summaryCandidate, rules);
    const summaryConfidence = normalizeConfidence(parsed.summaryConfidence);
    const canUseSummaryCategory =
      summaryValidation.valid &&
      summaryConfidence >= settings.summaryMinConfidenceToClassify &&
      !Boolean(parsed.summaryNeedsReview);

    if (!validation.valid) {
      const correction = correctInvalidCategory(parsed, rules);
      if (correction.valid) {
        const lowConfidence = confidence <= settings.minConfidenceToWrite;
        return {
          rowNumber: row.rowNumber,
          firstCategory: correction.category.firstCategory,
          secondCategory: correction.category.secondCategory,
          thirdCategory: correction.category.thirdCategory,
          confidence,
          reason: `${reason || "DeepSeek 根据右侧上下文完成分类"}；${correction.reason}`,
          needsReview: lowConfidence,
          ...baseMeta,
          ...summaryMeta,
          llmValidCategory: true,
          llmReason: reason,
          llmEvidence: evidence,
          llmError: lowConfidence ? `大模型置信度低于写回阈值 ${settings.minConfidenceToWrite}` : "",
          llmRawSnippet: rawSnippet,
          summaryCategoryConfidence: summaryConfidence,
          llmCategoryCorrected: true,
          llmCategoryCorrectionReason: correction.reason,
          ruleFirstCategory: ruleResult.firstCategory || "",
          ruleSecondCategory: ruleResult.secondCategory || "",
          ruleThirdCategory: ruleResult.thirdCategory || "",
          ruleConfidence: ruleResult.confidence || 0,
          ruleReason: ruleResult.reason || ""
        };
      }
      if (canUseSummaryCategory) {
        return summaryCategoryResult({
          row,
          category: summaryCandidate,
          summaryConfidence,
          reason,
          evidence,
          rawSnippet,
          ruleResult,
          baseMeta,
          summaryMeta,
          settings
        });
      }
      if (ruleResult?.confidence >= 0.95 && ruleResult.firstCategory && ruleResult.secondCategory && ruleResult.thirdCategory) {
        return {
          ...baseMeta,
          ...summaryMeta,
          ...ruleResult,
          classifier: "rule_fallback_after_invalid_llm",
          llmReason: reason,
          llmEvidence: evidence,
          llmError: validation.error,
          llmRawSnippet: rawSnippet,
          llmCategoryCorrected: false,
          llmCategoryCorrectionReason: "大模型分类非法，规则结果高置信回退"
        };
      }
      return llmBlockedResult(ruleResult, {
        ...baseMeta,
        ...summaryMeta,
        summaryCategoryConfidence: summaryConfidence,
        llmReason: reason,
        llmEvidence: evidence,
        llmError: validation.error,
        llmRawSnippet: rawSnippet
      });
    }

    const lowConfidence = confidence <= settings.minConfidenceToWrite;
    const needsReview = lowConfidence;
    if (needsReview && canUseSummaryCategory) {
      return summaryCategoryResult({
        row,
        category: summaryCandidate,
        summaryConfidence,
        reason,
        evidence,
        rawSnippet,
        ruleResult,
        baseMeta,
        summaryMeta,
        settings
      });
    }

    return {
      rowNumber: row.rowNumber,
      firstCategory: parsed.firstCategory,
      secondCategory: parsed.secondCategory,
      thirdCategory: parsed.thirdCategory,
      confidence,
      reason: reason || "DeepSeek 根据右侧上下文完成分类",
      needsReview,
      ...baseMeta,
      ...summaryMeta,
      llmValidCategory: true,
      llmReason: reason,
      llmEvidence: evidence,
      llmError: lowConfidence ? `大模型置信度低于写回阈值 ${settings.minConfidenceToWrite}` : "",
      llmRawSnippet: rawSnippet,
      summaryCategoryConfidence: summaryConfidence,
      ruleFirstCategory: ruleResult.firstCategory || "",
      ruleSecondCategory: ruleResult.secondCategory || "",
      ruleThirdCategory: ruleResult.thirdCategory || "",
      ruleConfidence: ruleResult.confidence || 0,
      ruleReason: ruleResult.reason || ""
    };
  } catch (error) {
    const requestError = safeErrorMessage(error, row);
    const ruleIsWritable =
      validateCategory(ruleResult, rules).valid &&
      Number(ruleResult?.confidence || 0) > settings.minConfidenceToWrite &&
      ruleResult?.needsReview !== true;
    if (ruleIsWritable) {
      return {
        ...baseMeta,
        ...ruleResult,
        classifier: "rule_fallback_after_llm_error",
        needsReview: false,
        llmValidCategory: true,
        llmError: requestError,
        reason: `${ruleResult.reason || "本地规则高置信命中"}；豆包暂不可用，采用0.95以上合法规则结果`,
        ruleFirstCategory: ruleResult.firstCategory || "",
        ruleSecondCategory: ruleResult.secondCategory || "",
        ruleThirdCategory: ruleResult.thirdCategory || "",
        ruleConfidence: ruleResult.confidence || 0,
        ruleReason: ruleResult.reason || ""
      };
    }
    return llmBlockedResult(ruleResult, {
      ...baseMeta,
      llmError: requestError
    });
  }
}

async function requestDeepSeek({ row, context, rules, settings }) {
  const endpoint = `${String(settings.baseUrl || DEFAULT_LLM.baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs || DEFAULT_LLM.timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(buildPayload({ row, context, rules, settings })),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`DeepSeek 请求失败 ${response.status}: ${body.slice(0, 500)}`);
    }
    const data = JSON.parse(body);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek 响应中没有 choices[0].message.content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function buildPayload({ row, context, rules, settings }) {
  const categoryTree = buildCategoryTree(rules);

  return {
    model: settings.model,
    temperature: 0,
    max_tokens: 700,
    ...(settings.provider === "ark" ? { thinking: { type: "disabled" } } : {}),
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "你是对话风险分类质检助手，只能根据给定的右侧聊天上下文判断 U/V/W 三级分类。",
          "必须严格从给定的合法分类组合中选择，不能创造新分类。",
          "K列消息只用于定位原始命中内容，分类时以右侧聊天气泡上下文为主；但K列若包含明确文字诉求（例如“你敢再发，我就投诉”），必须保留为用户诉求证据，不能被右侧短文本覆盖。",
          "K列若只是图片、附件、语音、视频等占位文本，不能根据占位内容猜分类，必须依赖扩展后的完整上下文；上下文不足时必须needsReview=true。",
          "必须综合右侧完整上下文和白色气泡列表，不得只根据命中关键词单句判断。",
          "右侧老师气泡可能包含大量课程推广、活动介绍、报名引导、海报文案；这些推广广告信息不能作为判断用户诉求的主要依据。",
          "判断问题分类时重点看白色/灰白学员气泡提出的真实诉求，以及老师是否针对该诉求做出回应或处理动作。",
          "userSummary 只能概括白色/灰白气泡文本，不能使用蓝色回复气泡，必须不超过15个汉字。",
          "如果完整上下文无法可靠判断U/V/W，但userSummary可以高置信判断，请填写summaryFirstCategory/summarySecondCategory/summaryThirdCategory，并且summaryConfidence必须大于等于0.95；否则这些字段留空或summaryNeedsReview为true。",
          "如果白色气泡多次出现退款、退费、不退、催退款、返钱等诉求，应优先在退费争议相关合法组合中判断；不要仅因出现投诉/欺骗就归为其他。",
          "如果上下文只是日常聊天、工作安排、普通问候，且没有具体投诉/退费/课程/服务争议，请选择最合适的无风险组合。",
          "只有在所有合法分类都明显不适配时，才允许选择其他/其他/其他，并且通常需要 needsReview=true。",
          "如果无法明确判断，needsReview 必须为 true。",
          "只输出 JSON，不要输出解释性文本。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            输出JSON格式: {
              firstCategory: "一级分类",
              secondCategory: "二级分类",
              thirdCategory: "三级分类",
              confidence: "0到1之间的小数",
              needsReview: "布尔值",
              reason: "一句话说明分类依据",
              evidence: "引用右侧上下文中的关键短语，最多80字",
              userSummary: "只概括白色气泡，15字以内",
              summaryFirstCategory: "仅当Y摘要可95%以上可靠判断时填写一级分类，否则空",
              summarySecondCategory: "仅当Y摘要可95%以上可靠判断时填写二级分类，否则空",
              summaryThirdCategory: "仅当Y摘要可95%以上可靠判断时填写三级分类，否则空",
              summaryConfidence: "摘要反推分类置信度，0到1之间的小数",
              summaryNeedsReview: "摘要无法95%以上可靠判断分类时为true"
            },
            行信息: {
              ...sanitizeRowForExternalLlm(row),
              K列证据状态: {
                mode: context.kEvidenceMode || "",
                weak: Boolean(context.kEvidenceWeak),
                reason: context.kEvidenceReason || ""
              }
            },
            右侧完整上下文: sanitizeTextForExternalLlm(
              context.contextText || "",
              settings.maxContextChars || DEFAULT_LLM.maxContextChars,
              { redactions: collectExternalLlmRedactions(row) }
            ),
            白色气泡文本: sanitizeTextForExternalLlm(context.userBubbleText || "", 3000, {
              redactions: collectExternalLlmRedactions(row)
            }),
            白色气泡列表: sanitizeChatMessagesForExternalLlm(context.userBubbleMessages || [], {
              maxMessages: 24,
              maxTextChars: 800,
              row
            }),
            合法分类树: categoryTree
          },
          null,
          2
        )
      }
    ]
  };
}

function validateCategory(parsed, rules) {
  if (!parsed || typeof parsed !== "object") return { valid: false, error: "大模型未返回 JSON 对象" };
  const first = normalizeText(parsed.firstCategory);
  const second = normalizeText(parsed.secondCategory);
  const third = normalizeText(parsed.thirdCategory);
  if (!first || !second || !third) return { valid: false, error: "大模型返回分类字段不完整" };
  const matched = rules.some((rule) =>
    rule.firstCategory === first &&
    rule.secondCategory === second &&
    rule.thirdCategory === third
  );
  if (!matched) {
    return { valid: false, error: `大模型返回的分类不在新版场景分类中：${first} / ${second} / ${third}` };
  }
  parsed.firstCategory = first;
  parsed.secondCategory = second;
  parsed.thirdCategory = third;
  return { valid: true, error: "" };
}

function correctInvalidCategory(parsed, rules) {
  const first = normalizeText(parsed?.firstCategory);
  const second = normalizeText(parsed?.secondCategory);
  const third = normalizeText(parsed?.thirdCategory);
  if (!first || !second || !third) return { valid: false };
  const sameSecond = rules.filter((rule) => rule.firstCategory === first && rule.secondCategory === second);
  if (!sameSecond.length) return { valid: false };

  const normalizedThird = normalizeLooseCategoryText(third);
  const exactLoose = sameSecond.filter((rule) => normalizeLooseCategoryText(rule.thirdCategory) === normalizedThird);
  if (exactLoose.length === 1) {
    return {
      valid: true,
      category: categoryFromRule(exactLoose[0]),
      reason: `已按合法分类组合纠偏：${third}->${exactLoose[0].thirdCategory}`
    };
  }

  if (third === "其他") {
    const otherLike = sameSecond.filter((rule) => /其他/.test(rule.thirdCategory));
    if (otherLike.length === 1) {
      return {
        valid: true,
        category: categoryFromRule(otherLike[0]),
        reason: `已按同一二级分类唯一“其他”项纠偏：其他->${otherLike[0].thirdCategory}`
      };
    }
  }

  return { valid: false };
}

function normalizeLooseCategoryText(value) {
  return normalizeText(value).replace(/[\/／、，,\s_-]/g, "");
}

function categoryFromRule(rule) {
  return {
    firstCategory: rule.firstCategory,
    secondCategory: rule.secondCategory,
    thirdCategory: rule.thirdCategory
  };
}

function buildCategoryTree(rules) {
  const tree = {};
  for (const rule of rules) {
    if (!tree[rule.firstCategory]) tree[rule.firstCategory] = {};
    if (!tree[rule.firstCategory][rule.secondCategory]) tree[rule.firstCategory][rule.secondCategory] = [];
    if (!tree[rule.firstCategory][rule.secondCategory].includes(rule.thirdCategory)) {
      tree[rule.firstCategory][rule.secondCategory].push(rule.thirdCategory);
    }
  }
  return tree;
}

function summaryCategoryResult({ row, category, summaryConfidence, reason, evidence, rawSnippet, ruleResult, baseMeta, summaryMeta, settings }) {
  return {
    rowNumber: row.rowNumber,
    firstCategory: category.firstCategory,
    secondCategory: category.secondCategory,
    thirdCategory: category.thirdCategory,
    confidence: summaryConfidence,
    reason: `基于Y列摘要高置信反推分类：${reason || "摘要可明确判断三级分类"}`,
    needsReview: false,
    ...baseMeta,
    ...summaryMeta,
    llmValidCategory: true,
    llmReason: reason,
    llmEvidence: evidence,
    llmError: "",
    llmRawSnippet: rawSnippet,
    summaryCategoryUsed: true,
    summaryCategoryConfidence: summaryConfidence,
    ruleFirstCategory: ruleResult.firstCategory || "",
    ruleSecondCategory: ruleResult.secondCategory || "",
    ruleThirdCategory: ruleResult.thirdCategory || "",
    ruleConfidence: ruleResult.confidence || 0,
    ruleReason: ruleResult.reason || "",
    summaryThreshold: settings.summaryMinConfidenceToClassify
  };
}

function llmBlockedResult(ruleResult, meta) {
  return {
    ...ruleResult,
    needsReview: true,
    reason: `${ruleResult.reason || "规则结果仅作参考"}；${meta.llmError || "大模型未产出可写回结果"}`,
    ...meta,
    ruleFirstCategory: ruleResult.firstCategory || "",
    ruleSecondCategory: ruleResult.secondCategory || "",
    ruleThirdCategory: ruleResult.thirdCategory || "",
    ruleConfidence: ruleResult.confidence || 0,
    ruleReason: ruleResult.reason || ""
  };
}

function parseJsonContent(content) {
  const text = String(content || "").trim();
  try {
    return JSON.parse(text);
  } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return JSON.parse(fenced[1]);

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));

  throw new Error("DeepSeek 返回内容不是可解析 JSON");
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(Math.max(0, Math.min(1, number)).toFixed(2));
}

function normalizeEvidence(value) {
  return normalizeText(Array.isArray(value) ? value.join("；") : value).slice(0, 120);
}

function normalizeSummary(value, maxLength) {
  const normalized = normalizeText(value)
    .replace(/[。；;,.，、\s]+$/g, "")
    .replace(/^用户[：:]/, "")
    .trim();
  const limit = Math.max(1, Number(maxLength) || DEFAULT_LLM.maxSummaryLength);
  if (!normalized) return { text: "", truncated: false };
  if ([...normalized].length <= limit) return { text: normalized, truncated: false };
  return { text: [...normalized].slice(0, limit).join(""), truncated: true };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value, maxChars) {
  const text = String(value || "").trim();
  const max = Number(maxChars) || DEFAULT_LLM.maxContextChars;
  if (text.length <= max) return text;
  const half = Math.floor((max - 80) / 2);
  return `${text.slice(0, half)}\n...【中间内容已因长度截断】...\n${text.slice(-half)}`;
}

function safeErrorMessage(error, row) {
  if (error?.name === "AbortError") return "豆包请求超时";
  return sanitizeTextForExternalLlm(error?.message || error || "豆包调用失败", 500, {
    redactions: collectExternalLlmRedactions(row)
  });
}
