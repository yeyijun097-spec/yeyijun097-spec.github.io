import {
  applyExternalLlmAuthorization,
  collectExternalLlmRedactions,
  isExternalLlmAllowed,
  sanitizeChatMessagesForExternalLlm,
  sanitizeRowForExternalLlm,
  sanitizeTextForExternalLlm
} from "./llmDataBoundary.js";

const DEFAULT_EXTRACTOR = {
  enabled: true,
  provider: "deepseek",
  baseUrl: "",
  model: "deepseek-v4-flash",
  timeoutMs: 45000,
  maxResponseChars: 22000,
  minConfidence: 0.85
};

const STATUS_TEXT_PATTERN = /^(操作成功|成功|success|ok|true|暂无消息|没有更多了|查看最新消息|搜索聊天内容|TEXT)$/i;

export function resolveContextExtractorSettings(config = {}) {
  const llm = config.llm || {};
  const configured = {
    ...DEFAULT_EXTRACTOR,
    ...(config.contextExtractor || {}),
    provider: llm.provider || DEFAULT_EXTRACTOR.provider,
    baseUrl: process.env.DEEPSEEK_BASE_URL || llm.baseUrl || DEFAULT_EXTRACTOR.baseUrl,
    model: process.env.DEEPSEEK_MODEL || llm.model || DEFAULT_EXTRACTOR.model,
    timeoutMs: Number(llm.timeoutMs || DEFAULT_EXTRACTOR.timeoutMs),
    apiKey: process.env.ARK_API_KEY || process.env.DEEPSEEK_API_KEY || "",
    minConfidence: Number(config.contextExtractor?.minConfidence || DEFAULT_EXTRACTOR.minConfidence),
    maxResponseChars: Number(config.contextExtractor?.maxResponseChars || DEFAULT_EXTRACTOR.maxResponseChars)
  };
  configured.enabled = config.contextExtractor?.enabled !== false && llm.enabled !== false;
  return applyExternalLlmAuthorization(configured);
}

export async function extractContextWithLlm({
  row,
  keyword,
  searchData,
  detailData,
  searchText,
  detailText,
  localMessages = [],
  timeWindow,
  settings
}) {
  const resolved = { ...DEFAULT_EXTRACTOR, ...(settings || {}) };
  const base = {
    contextExtractor: "deepseek",
    llmContextUsed: false,
    contextExtractConfidence: 0,
    contextExtractReason: "",
    rawStatusTextFiltered: countStatusText(searchData) + countStatusText(detailData),
    contextExtractError: ""
  };

  if (!isExternalLlmAllowed(resolved)) {
    return { ...base, contextExtractError: resolved.llmDisabledReason || "上下文解析模型未启用" };
  }
  if (!resolved.apiKey) {
    return { ...base, contextExtractError: "未配置 ARK_API_KEY 或 DEEPSEEK_API_KEY，无法调用上下文解析模型" };
  }

  try {
    const raw = await requestDeepSeek(buildPayload({
      row,
      keyword,
      searchData,
      detailData,
      searchText,
      detailText,
      localMessages,
      timeWindow,
      settings: resolved
    }), resolved);
    const parsed = parseJsonContent(raw);
    const messages = normalizeMessages(parsed.messages);
    const userMessages = normalizeTextArray(parsed.userMessages);
    const confidence = normalizeConfidence(parsed.extractConfidence);
    const contextText = normalizeText(parsed.contextText) || formatMessages(messages);
    const userBubbleText = normalizeText(parsed.userBubbleText) || userMessages.join("\n");
    const hitMessageIndex = normalizeIndex(parsed.hitMessageIndex, messages.length);
    const needsReview = Boolean(parsed.needsReview) || confidence < resolved.minConfidence || !contextText;

    return {
      ...base,
      llmContextUsed: true,
      messages,
      hitMessageIndex,
      userMessages,
      contextText,
      userBubbleText,
      extractConfidence: confidence,
      contextExtractConfidence: confidence,
      needsReview,
      contextExtractReason: normalizeText(parsed.reason),
      rawStatusTextFiltered: base.rawStatusTextFiltered + countStatusText(parsed),
      contextExtractError: needsReview ? `上下文解析置信度低于阈值 ${resolved.minConfidence}` : "",
      rawSnippet: sanitizeTextForExternalLlm(raw, 1000, {
        redactions: collectExternalLlmRedactions(row)
      })
    };
  } catch (error) {
    return {
      ...base,
      contextExtractError: safeErrorMessage(error, row)
    };
  }
}

function buildPayload({ row, keyword, localMessages, timeWindow, settings }) {
  return {
    model: settings.model,
    temperature: 0,
    max_tokens: 900,
    ...(settings.provider === "ark" ? { thinking: { type: "disabled" } } : {}),
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "你是聊天上下文解析助手，只负责从本地已提取的脱敏聊天气泡中整理真实上下文。",
          "必须过滤状态文案，例如：操作成功、success、ok、code、msg、status、TEXT、ID/hash、UI文案。",
          "只保留输入中已有的真实聊天气泡文本，不能编造聊天内容。",
          "优先按消息时间排序；如果能识别命中K列原文或关键词，取其前后上下文。",
          "userMessages 只能包含学员/用户/客户侧文本；如果无法可靠区分，可以为空。",
          "如果无法从候选聊天气泡中找到真实聊天消息，needsReview必须为true，extractConfidence必须低于0.85。",
          "只输出JSON，不要输出解释性文本。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          输出JSON格式: {
            messages: [
              {
                time: "消息时间，可空",
                speaker: "发送方，可空",
                role: "user/staff/unknown",
                text: "真实聊天文本"
              }
            ],
            hitMessageIndex: "命中K列消息在messages中的序号，无法判断填-1",
            userMessages: ["只包含学员侧文本，无法可靠区分则空数组"],
            contextText: "按时间排序后的完整上下文文本",
            userBubbleText: "学员侧文本拼接，无法可靠区分则空",
            extractConfidence: "0到1之间的小数",
            needsReview: "布尔值",
            reason: "一句话说明提取依据或失败原因"
          },
          行信息: sanitizeRowForExternalLlm(row, { keyword }),
          查询时间范围: timeWindow ? {
            start: timeWindow.start?.toISOString?.() || "",
            end: timeWindow.end?.toISOString?.() || ""
          } : {},
          本地已提取候选消息: sanitizeChatMessagesForExternalLlm(localMessages, {
            maxMessages: 24,
            maxTextChars: 800,
            row
          }),
          数据范围说明: "仅提供本地已提取并脱敏的聊天气泡；不提供原始接口响应、姓名、用户ID、手机号、路径或链接。"
        }, null, 2)
      }
    ]
  };
}

async function requestDeepSeek(payload, settings) {
  const endpoint = `${String(settings.baseUrl || DEFAULT_EXTRACTOR.baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs || DEFAULT_EXTRACTOR.timeoutMs);

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
      throw new Error(`DeepSeek上下文解析请求失败 ${response.status}: ${body.slice(0, 500)}`);
    }
    const data = JSON.parse(body);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek上下文解析响应中没有 choices[0].message.content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      time: normalizeText(item?.time),
      speaker: normalizeText(item?.speaker),
      role: normalizeText(item?.role || "unknown"),
      text: normalizeText(item?.text)
    }))
    .filter((item) => item.text && !isStatusText(item.text))
    .slice(0, 80);
}

function normalizeTextArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeText).filter((text) => text && !isStatusText(text)).slice(0, 80);
}

function formatMessages(messages) {
  return messages
    .map((message) => [message.time, message.speaker || message.role, message.text].filter(Boolean).join(" "))
    .join("\n");
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
  throw new Error("DeepSeek上下文解析返回内容不是可解析JSON");
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(Math.max(0, Math.min(1, number)).toFixed(2));
}

function normalizeIndex(value, length) {
  const index = Number(value);
  if (!Number.isInteger(index)) return -1;
  return index >= 0 && index < length ? index : -1;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isStatusText(value) {
  return STATUS_TEXT_PATTERN.test(normalizeText(value));
}

function countStatusText(value) {
  let count = 0;
  walk(value, (item) => {
    if (typeof item === "string" && isStatusText(item)) count += 1;
  });
  return count;
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

function safeErrorMessage(error, row) {
  return sanitizeTextForExternalLlm(error?.message || error || "上下文解析失败", 500, {
    redactions: collectExternalLlmRedactions(row)
  });
}
