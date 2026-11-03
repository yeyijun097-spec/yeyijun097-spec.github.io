const PHONE_PATTERN = /(?<!\d)(1[3-9]\d{9})(?!\d)/g;
const NATIONAL_ID_PATTERN = /(?<!\d)\d{17}[\dXx](?![\dXx])/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>，。；、！？（）【】]+/gi;
const LONG_ID_PATTERN = /(?<!\d)\d{8,}(?!\d)/g;
const HASH_PATTERN = /\b[a-f0-9]{24,}\b/gi;
const API_KEY_PATTERN = /\b(?:sk|ark|api)[-_][A-Za-z0-9_-]{12,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(?:cookie|token|authorization)\s*[:=]\s*[^,;\s]{4,}/gi;

/**
 * 外部模型调用必须由部署环境显式确认。仅配置 API Key 不代表获准外发业务数据。
 */
export function isExternalLlmDataTransferApproved(env = process.env) {
  return String(env?.EXTERNAL_LLM_DATA_TRANSFER_APPROVED || "").trim() === "1";
}

export function applyExternalLlmAuthorization(settings = {}, env = process.env) {
  const approved = isExternalLlmDataTransferApproved(env);
  const configuredEnabled = Boolean(settings.enabled);
  return {
    ...settings,
    configuredEnabled,
    externalDataTransferApproved: approved,
    enabled: configuredEnabled && approved,
    llmDisabledReason: configuredEnabled && !approved
      ? "未确认外部模型数据处理授权，已保留 DOM 与本地规则，未调用外部模型"
      : ""
  };
}

export function isExternalLlmAllowed(settings = {}) {
  return Boolean(settings.enabled) && Boolean(settings.externalDataTransferApproved);
}

export function externalLlmDisabledReason(settings = {}) {
  return settings.llmDisabledReason || "外部模型数据处理未获授权，未调用外部模型";
}

export function sanitizeTextForExternalLlm(value, maxChars = 1200, options = {}) {
  if (maxChars && typeof maxChars === "object") {
    options = maxChars;
    maxChars = 1200;
  }
  let text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const limit = Math.max(0, Number(maxChars) || 0);
  const sourceLength = text.length;
  text = redactKnownValues(text, options.redactions);
  text = text
    .replace(BEARER_PATTERN, "Bearer [SECRET]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "[SECRET]")
    .replace(API_KEY_PATTERN, "[API_KEY]")
    .replace(URL_PATTERN, "[URL]")
    .replace(EMAIL_PATTERN, "[EMAIL]")
    .replace(NATIONAL_ID_PATTERN, "[NATIONAL_ID]")
    .replace(PHONE_PATTERN, (_match, phone) => `[PHONE:${phone.slice(0, 3)}****${phone.slice(-4)}]`)
    .replace(HASH_PATTERN, (hash) => `[HASH:${hash.length}]`)
    .replace(LONG_ID_PATTERN, (id) => `[ID:${id.length}]`);
  return limit && sourceLength > limit ? `${text.slice(0, limit)}…` : text;
}

export function sanitizeChatMessagesForExternalLlm(messages = [], options = {}) {
  const maxMessages = Math.max(0, Number(options.maxMessages ?? 24));
  const maxTextChars = Math.max(1, Number(options.maxTextChars ?? 800));
  return (Array.isArray(messages) ? messages : [])
    .slice(0, maxMessages)
    .map((message) => ({
      time: normalizeTime(message?.at ?? message?.time),
      role: normalizeRole(message?.role),
      text: sanitizeTextForExternalLlm(message?.text, maxTextChars, {
        redactions: [...collectExternalLlmRedactions(options.row), message?.speaker]
      })
    }))
    .filter((message) => message.text);
}

export function sanitizeProfileCandidatesForExternalLlm(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .slice(0, 30)
    .map((candidate) => ({
      Q: sanitizeTextForExternalLlm(candidate?.actualProductType || candidate?.Q || "", 80),
      R: sanitizeTextForExternalLlm(candidate?.actualCampName || candidate?.R || "", 200),
      S: sanitizeTextForExternalLlm(candidate?.actualCourseCategory || candidate?.S || "", 100),
      goodsName: sanitizeTextForExternalLlm(candidate?.actualGoodsName || candidate?.goodsName || "", 240),
      rowRelated: Boolean(candidate?.rowRelated)
    }));
}

export function sanitizeRowForExternalLlm(row = {}, options = {}) {
  return {
    rowNumber: Number(row.rowNumber) || 0,
    keyword: sanitizeTextForExternalLlm(options.keyword || "", 120),
    originalMessage: sanitizeTextForExternalLlm(row.message || "", 1200, {
      redactions: collectExternalLlmRedactions(row)
    }),
    sentAt: normalizeTime(row.sentAt),
    dataDate: sanitizeTextForExternalLlm(row.dataDate || "", 40)
  };
}

/** 仅遮蔽业务行中已明确识别的身份字段，避免猜测式姓名识别篡改分类语义。 */
export function collectExternalLlmRedactions(row = {}, extraValues = []) {
  const known = [
    row.receiver,
    row.receiverName,
    row.sender,
    row.senderName,
    row.userName,
    row.userWechatName,
    row.nickName,
    ...(Array.isArray(extraValues) ? extraValues : [extraValues])
  ];
  return [...new Set(known
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length >= 2 && value.length <= 60))];
}

export function buildExternalLlmAudit(purpose, payload) {
  return {
    purpose: sanitizeTextForExternalLlm(purpose, 80),
    payloadChars: String(payload ?? "").length,
    redacted: true
  };
}

function normalizeTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const text = String(value || "").trim();
  return text.length <= 40 ? text : "";
}

function normalizeRole(value) {
  const role = String(value || "unknown").trim().toLowerCase();
  return ["user", "staff", "unknown"].includes(role) ? role : "unknown";
}

function redactKnownValues(text, values) {
  const candidates = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length >= 2 && value.length <= 60))]
    .sort((a, b) => b.length - a.length);
  return candidates.reduce(
    (result, value) => result.replace(new RegExp(escapeRegExp(value), "g"), "[NAME]"),
    text
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
