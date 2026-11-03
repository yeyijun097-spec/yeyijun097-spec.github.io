import {
  applyExternalLlmAuthorization,
  collectExternalLlmRedactions,
  isExternalLlmAllowed,
  sanitizeProfileCandidatesForExternalLlm,
  sanitizeRowForExternalLlm,
  sanitizeTextForExternalLlm
} from "./llmDataBoundary.js";

const DEFAULT_PROFILE_EXTRACTOR = {
  enabled: true,
  provider: "deepseek",
  baseUrl: "",
  model: "deepseek-v4-flash",
  timeoutMs: 45000,
  minConfidence: 0.9,
  maxResponseChars: 22000
};

export function resolveProfileExtractorSettings(config = {}) {
  const llm = config.llm || {};
  const profile = config.chance?.profileExtractor || {};
  const settings = {
    ...DEFAULT_PROFILE_EXTRACTOR,
    ...profile,
    provider: llm.provider || profile.provider || DEFAULT_PROFILE_EXTRACTOR.provider,
    baseUrl: process.env.DEEPSEEK_BASE_URL || llm.baseUrl || profile.baseUrl || DEFAULT_PROFILE_EXTRACTOR.baseUrl,
    model: process.env.DEEPSEEK_MODEL || llm.model || profile.model || DEFAULT_PROFILE_EXTRACTOR.model,
    timeoutMs: Number(profile.timeoutMs || llm.timeoutMs || DEFAULT_PROFILE_EXTRACTOR.timeoutMs),
    minConfidence: Number(profile.minConfidence || DEFAULT_PROFILE_EXTRACTOR.minConfidence),
    maxResponseChars: Number(profile.maxResponseChars || DEFAULT_PROFILE_EXTRACTOR.maxResponseChars),
    apiKey: process.env.ARK_API_KEY || process.env.DEEPSEEK_API_KEY || ""
  };
  settings.enabled = profile.enabled !== false && llm.enabled !== false;
  return applyExternalLlmAuthorization(settings);
}

export async function extractProfileWithLlm({ row, responses, localCandidates, partial, settings }) {
  const resolved = { ...DEFAULT_PROFILE_EXTRACTOR, ...(settings || {}) };
  const base = {
    profileExtractor: "deepseek",
    profileSanitized: true,
    profileExtractConfidence: 0,
    profileExtractReason: "",
    profileEvidenceFields: {},
    profileLlmError: ""
  };

  if (!isExternalLlmAllowed(resolved)) {
    return { ...base, profileLlmError: resolved.llmDisabledReason || "档案字段解析模型未启用" };
  }
  if (!resolved.apiKey) {
    return { ...base, profileLlmError: "未配置 ARK_API_KEY 或 DEEPSEEK_API_KEY，无法调用档案字段解析模型" };
  }

  try {
    const raw = await requestDeepSeek(buildPayload({ row, localCandidates, partial, settings: resolved }), resolved);
    const parsed = parseJsonContent(raw);
    const normalized = normalizeProfileResult(parsed);
    const validation = validateProfileEvidence(normalized, resolved.minConfidence);

    return {
      ...base,
      ...normalized,
      profileLlmError: validation.valid ? "" : validation.error,
      profileRawSnippet: sanitizeTextForExternalLlm(raw, 1000, {
        redactions: collectExternalLlmRedactions(row)
      })
    };
  } catch (error) {
    return {
      ...base,
      profileLlmError: safeErrorMessage(error, row)
    };
  }
}

async function requestDeepSeek(payload, settings) {
  const endpoint = `${String(settings.baseUrl || DEFAULT_PROFILE_EXTRACTOR.baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs || DEFAULT_PROFILE_EXTRACTOR.timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`DeepSeek档案字段解析请求失败 ${response.status}: ${body.slice(0, 500)}`);
    }
    const data = JSON.parse(body);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek档案字段解析响应中没有 choices[0].message.content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function buildPayload({ row, localCandidates, partial, settings }) {
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
          "你是 chanceAss 学员档案字段解析助手，只负责从脱敏后的本地候选中提取 Q/R/S。",
          "输入只包含本地已解析候选；不能将列表campName、categoryName、goodsName、productName 作为 Q/R/S 证据。",
          "Q=商品类型（实际），只能输出“体验营”或“正式营”。优先依据正式营ID或体验营ID判断；如果详情缺少营ID，允许使用订单信息页第一条订单的“购买体验营/购买正式营”判断。",
          "R=训练营名称（实际），只能来自字段语义明确为“训练营名称”或“营名称”的值。不能使用商品名称、投放名称、推广名称、活动名称、列表campName、goodsName、productName代替。",
          "S=课程品类（实际），只能来自字段语义明确为“所属品类/课程品类/品类名称/categoryName”的值。",
          "必须返回 evidenceFields，说明每个值来自哪个字段标签或字段路径。",
          "如果找不到可靠的训练营名称字段，actualCampName 必须为空，needsReview 必须为 true。",
          "不要编造字段，不要根据用户聊天内容推测 Q/R/S。",
          "只输出 JSON，不要输出解释性文本。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          输出JSON格式: {
            actualProductType: "体验营/正式营，无法判断为空",
            actualCampName: "训练营名称，必须来自训练营名称/营名称字段，无法判断为空",
            actualCourseCategory: "所属品类，无法判断为空",
            confidence: "0到1之间的小数",
            needsReview: "布尔值",
            reason: "一句话说明依据或缺失原因",
            evidenceFields: {
              productTypeField: "Q来源字段标签或路径",
              campNameField: "R来源字段标签或路径，必须是训练营名称语义",
              courseCategoryField: "S来源字段标签或路径"
            }
          },
          行信息: sanitizeRowForExternalLlm(row),
          本地候选摘要: {
            partial: Boolean(partial),
            localCandidates: sanitizeProfileCandidatesForExternalLlm(localCandidates)
          },
          数据范围说明: "仅提供本地已解析候选；不提供原始接口响应、用户ID、姓名、手机号、路径或链接。"
        }, null, 2)
      }
    ]
  };
}

function normalizeProfileResult(parsed) {
  const confidence = normalizeConfidence(parsed?.confidence);
  return {
    actualProductType: normalizeProductType(parsed?.actualProductType),
    actualCampName: normalizeText(parsed?.actualCampName),
    actualCourseCategory: normalizeText(parsed?.actualCourseCategory),
    profileExtractConfidence: confidence,
    profileExtractReason: normalizeText(parsed?.reason),
    profileEvidenceFields: normalizeEvidenceFields(parsed?.evidenceFields),
    needsReview: Boolean(parsed?.needsReview)
  };
}

function validateProfileEvidence(result, minConfidence) {
  if (!result.actualProductType || !result.actualCampName || !result.actualCourseCategory) {
    return { valid: false, error: "DeepSeek档案字段解析字段不完整" };
  }
  if (result.profileExtractConfidence < minConfidence || result.needsReview) {
    return { valid: false, error: `DeepSeek档案字段解析置信度低于阈值 ${minConfidence}` };
  }
  const evidence = result.profileEvidenceFields || {};
  if (!/(正式\s*营\s*ID|体验\s*营\s*ID|购买\s*正式营|购买\s*体验营|订单信息.*第一条|formal.*id|official.*camp.*id|experience.*id|trial.*id)/i.test(evidence.productTypeField || "")) {
    return { valid: false, error: "DeepSeek档案字段解析Q证据不足" };
  }
  if (!/(训练\s*营\s*名称|营\s*名称|training\s*camp\s*name|trainingCampName|training_camp_name)/i.test(evidence.campNameField || "")) {
    return { valid: false, error: "DeepSeek档案字段解析R证据不是训练营名称字段" };
  }
  if (/(商品名称|投放|推广|activity|goods|product|sku|列表campName|list.*camp)/i.test(evidence.campNameField || "")) {
    return { valid: false, error: "DeepSeek档案字段解析R证据疑似商品/投放字段" };
  }
  if (!/(所属\s*品\s*类|课程\s*品\s*类|品\s*类\s*名称|categoryName|category_name|course.*category|subject)/i.test(evidence.courseCategoryField || "")) {
    return { valid: false, error: "DeepSeek档案字段解析S证据不足" };
  }
  return { valid: true, error: "" };
}

function normalizeEvidenceFields(value) {
  if (!value || typeof value !== "object") {
    return { productTypeField: "", campNameField: "", courseCategoryField: "" };
  }
  return {
    productTypeField: normalizeText(value.productTypeField || value.Q || value.productType || ""),
    campNameField: normalizeText(value.campNameField || value.R || value.campName || ""),
    courseCategoryField: normalizeText(value.courseCategoryField || value.S || value.courseCategory || "")
  };
}

function parseJsonContent(content) {
  const text = String(content || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("DeepSeek档案字段解析未返回合法JSON");
    return JSON.parse(match[0]);
  }
}

function normalizeProductType(value) {
  const text = normalizeText(value);
  if (/正式营/.test(text)) return "正式营";
  if (/体验营/.test(text)) return "体验营";
  return "";
}

function normalizeConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric > 1) return Math.max(0, Math.min(1, numeric / 100));
  return Math.max(0, Math.min(1, numeric));
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function safeErrorMessage(error, row) {
  return sanitizeTextForExternalLlm(error?.message || error || "档案字段解析失败", 500, {
    redactions: collectExternalLlmRedactions(row)
  });
}
