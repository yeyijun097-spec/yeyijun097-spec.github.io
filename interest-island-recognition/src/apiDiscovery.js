import fs from "node:fs";
import path from "node:path";
import { createQichatClient, buildSearchKeyword } from "./qlchatClient.js";

const RELEVANT_URL = /chat|record|workWechat|session|message|conversation|wechat|work/i;
const SECRET_HEADER = /cookie|authorization|token|csrf|xsrf|secret|session|sign/i;
const SECRET_QUERY = /token|ticket|sign|signature|secret|session|csrf|xsrf/i;

export function apiMapPath(config) {
  return path.resolve(config.api?.mapPath || "config/qlchat-api-map.local.json");
}

export function apiMapExists(config) {
  return fs.existsSync(apiMapPath(config));
}

export function loadApiMap(config) {
  const file = apiMapPath(config);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export async function discoverApiMap({ config, row, keepOpen = false }) {
  if (!row) throw new Error("接口发现需要至少一行样本数据，请使用 --debug-row 或确保范围内有数据。");

  const discoveryConfig = {
    ...config,
    context: { ...(config.context || {}), mode: "ui" },
    api: { ...(config.api || {}), capture: false }
  };

  const client = await createQichatClient(discoveryConfig, false);
  const recorder = createRecorder(client.page);
  let readiness = { ready: false, waitedForLogin: false };
  let uiContext = null;

  try {
    readiness = await client.ensureReady(true);
    if (!readiness.ready) throw new Error("接口发现前未检测到企聊宝查询页。");
    uiContext = await client.fetchContext(row);
    await client.page.waitForTimeout(800).catch(() => {});
    const map = buildApiMap({
      config,
      row,
      uiContext,
      events: recorder.events
    });
    const file = apiMapPath(config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2), "utf8");
    return { file, map, readiness, uiContext, eventCount: recorder.events.length };
  } finally {
    recorder.detach();
    if (!keepOpen) await client.close();
  }
}

function createRecorder(page) {
  const requests = new Map();
  const events = [];

  const onRequest = (request) => {
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    const url = request.url();
    if (!RELEVANT_URL.test(url)) return;
    requests.set(request, {
      at: Date.now(),
      method: request.method(),
      url,
      headers: safeHeaders(request.headers()),
      postData: request.postData() || "",
      resourceType: request.resourceType()
    });
  };

  const onResponse = async (response) => {
    const request = response.request();
    const req = requests.get(request);
    if (!req) return;
    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    let body = "";
    if (/json|text|javascript/.test(contentType)) {
      body = await response.text().catch(() => "");
    }
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

function buildApiMap({ config, row, uiContext, events }) {
  const keyword = buildSearchKeyword(row.message, config.keywordMaxLength || 10);
  const scored = events
    .map((event, index) => ({
      event,
      index,
      searchScore: scoreSearchEvent(event, row, keyword),
      detailScore: scoreDetailEvent(event, row, keyword, uiContext)
    }))
    .filter((item) => item.event.response.status >= 200 && item.event.response.status < 400);

  const search = [...scored].sort((a, b) => b.searchScore - a.searchScore)[0];
  const detail = [...scored]
    .filter((item) => item.index >= (search?.index || 0))
    .sort((a, b) => b.detailScore - a.detailScore)[0];

  if (!search || search.searchScore < 25) {
    throw new Error("接口发现失败：没有识别到搜索接口。请使用 npm run capture:api 录制后再重试。");
  }

  const searchCandidates = extractCandidateObjects(search.event.response.data, row, keyword);
  const sourceCandidate = chooseSourceCandidate(searchCandidates, row, keyword);
  const detailEvent = detail && detail.detailScore >= 20 ? detail.event : search.event;

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    source: {
      rowNumber: row.rowNumber,
      userId: String(row.userId || ""),
      receiverName: String(row.receiverName || ""),
      userWechatName: String(row.userWechatName || ""),
      teacherName: String(row.teacherName || ""),
      weworkUserId: requestValueByKey(search.event.request, (key) => /weworkuserid|wework_user_id|workuserid|work_user_id|staffid|staff_id|teacherid|teacher_id|employeeid|employee_id/.test(key)),
      message: String(row.message || ""),
      keyword,
      dataDate: String(row.dataDate || ""),
      sentAt: String(row.sentAt || "")
    },
    search: {
      score: search.searchScore,
      request: requestTemplate(search.event.request)
    },
    detail: {
      score: detail?.detailScore || 0,
      request: requestTemplate(detailEvent.request),
      bindings: sourceCandidate ? detailBindings(detailEvent.request, sourceCandidate) : []
    },
    responseHints: {
      searchCandidateCount: searchCandidates.length,
      detailLooksSameAsSearch: detailEvent === search.event
    }
  };
}

function scoreSearchEvent(event, row, keyword) {
  const requestText = requestTextOf(event.request);
  const responseText = responseTextOf(event.response);
  let score = 0;
  if (includesLoose(requestText, row.userId)) score += 25;
  if (includesLoose(requestText, keyword)) score += 25;
  if (includesLoose(requestText, row.receiverName)) score += 8;
  if (includesLoose(responseText, row.userId)) score += 15;
  if (includesLoose(responseText, keyword)) score += 15;
  if (/相关记录|record|conversation|session|chat/i.test(responseText)) score += 8;
  if (arrayLikeCount(event.response.data) >= 1) score += 8;
  return score;
}

function scoreDetailEvent(event, row, keyword, uiContext) {
  const requestText = requestTextOf(event.request);
  const responseText = responseTextOf(event.response);
  let score = 0;
  if (includesLoose(responseText, keyword)) score += 20;
  if (includesLoose(responseText, row.message)) score += 25;
  if (uiContext?.contextText && sharedSnippetScore(responseText, uiContext.contextText) >= 2) score += 25;
  const messageCount = extractMessageObjects(event.response.data).length;
  if (messageCount >= 2) score += 20;
  if (/message|msg|chat|record|conversation|session/i.test(requestText)) score += 8;
  return score;
}

function requestTemplate(request) {
  return {
    method: request.method || "GET",
    url: sanitizeUrl(request.url || ""),
    headers: safeHeaders(request.headers || {}),
    postData: request.postData || ""
  };
}

function detailBindings(request, sourceCandidate) {
  const text = requestTextOf(request);
  return primitivePaths(sourceCandidate)
    .filter((item) => item.value.length >= 3 && text.includes(item.value))
    .slice(0, 20)
    .map((item) => ({
      sourceValue: item.value,
      candidatePath: item.path
    }));
}

function extractCandidateObjects(data, row, keyword) {
  const objects = [];
  walk(data, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const text = JSON.stringify(value);
    let score = 0;
    if (includesLoose(text, row.userId)) score += 5;
    if (includesLoose(text, keyword)) score += 5;
    if (/相关记录|record|conversation|session|chat|id/i.test(text)) score += 2;
    if (score > 0) objects.push({ object: value, score });
  });
  return objects.sort((a, b) => b.score - a.score).map((item) => item.object);
}

function chooseSourceCandidate(candidates, row, keyword) {
  return candidates
    .map((candidate) => {
      const text = JSON.stringify(candidate);
      let score = 0;
      if (includesLoose(text, row.userId)) score += 10;
      if (includesLoose(text, keyword)) score += 8;
      if (includesLoose(text, row.receiverName)) score += 4;
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.candidate || candidates[0] || null;
}

function extractMessageObjects(data) {
  const messages = [];
  walk(data, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const text = messageText(value);
    if (!text || text.length < 2) return;
    messages.push(value);
  });
  return messages;
}

function messageText(object) {
  const keys = ["content", "msg", "message", "text", "body", "chatContent", "messageContent", "contentText"];
  for (const key of keys) {
    if (typeof object[key] === "string" && object[key].trim()) return object[key].trim();
  }
  for (const [key, value] of Object.entries(object)) {
    if (/content|message|msg|text/i.test(key) && typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function primitivePaths(value, prefix = []) {
  const result = [];
  if (value === null || value === undefined) return result;
  if (typeof value !== "object") {
    result.push({ path: prefix, value: String(value) });
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => result.push(...primitivePaths(item, [...prefix, index])));
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    result.push(...primitivePaths(item, [...prefix, key]));
  }
  return result;
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

function arrayLikeCount(value) {
  let count = 0;
  walk(value, (item) => {
    if (Array.isArray(item)) count = Math.max(count, item.length);
  });
  return count;
}

function sharedSnippetScore(responseText, contextText) {
  const snippets = String(contextText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4)
    .slice(0, 20);
  return snippets.filter((snippet) => responseText.includes(snippet.slice(0, Math.min(12, snippet.length)))).length;
}

function requestTextOf(request) {
  return `${request.url || ""}\n${request.postData || ""}`;
}

function requestValueByKey(request, predicate) {
  const body = request?.postData || "";
  if (body) {
    try {
      const data = JSON.parse(body);
      const found = primitiveValueByKey(data, predicate);
      if (found) return found;
    } catch {}
    const params = new URLSearchParams(body);
    for (const key of params.keys()) {
      if (predicate(key.toLowerCase())) return String(params.get(key) || "");
    }
  }
  try {
    const url = new URL(request?.url || "");
    for (const key of url.searchParams.keys()) {
      if (predicate(key.toLowerCase())) return String(url.searchParams.get(key) || "");
    }
  } catch {}
  return "";
}

function primitiveValueByKey(value, predicate) {
  let found = "";
  const visit = (item) => {
    if (found || !item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (found) return;
      if (predicate(key.toLowerCase()) && child !== null && child !== undefined && typeof child !== "object") {
        found = String(child);
        return;
      }
      visit(child);
    }
  };
  visit(value);
  return found;
}

function responseTextOf(response) {
  if (response.body) return response.body;
  if (response.data !== undefined) return JSON.stringify(response.data);
  return "";
}

function safeHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (SECRET_HEADER.test(key)) continue;
    const lower = key.toLowerCase();
    const keep =
      ["accept", "content-type", "x-requested-with"].includes(lower) ||
      lower.startsWith("x-") ||
      lower.startsWith("ql-") ||
      lower.startsWith("app-") ||
      lower.startsWith("platform-");
    if (!keep) {
      continue;
    }
    if (SECRET_HEADER.test(String(value))) continue;
    result[key] = value;
  }
  return result;
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

function parseJsonMaybe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function includesLoose(text, value) {
  const needle = String(value || "").replace(/\s+/g, "");
  if (!needle) return false;
  const haystack = String(text || "").replace(/\s+/g, "");
  if (haystack.includes(needle)) return true;
  const prefix = needle.slice(0, Math.min(10, needle.length));
  return prefix.length >= 4 && haystack.includes(prefix);
}
