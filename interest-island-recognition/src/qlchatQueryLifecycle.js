export function classifyQueryLifecycle(value = {}) {
  const requestObserved = value.requestObserved === true;
  const responseObserved = value.responseObserved === true;
  const responseStatus = Number(value.responseStatus || 0);
  const responseCount = Math.max(0, Number(value.responseCount || 0));
  const responseCountKnown = value.responseCountKnown === true || responseCount > 0;
  const renderObserved = value.renderObserved === true;

  let responseKind = "unknown";
  if (responseObserved && (responseStatus < 200 || responseStatus >= 400)) responseKind = "error";
  else if (responseObserved && responseCount > 0) responseKind = "records";
  else if (responseObserved && responseCountKnown) responseKind = "empty";

  let failureStage = "";
  if (!requestObserved) failureStage = "request-not-observed";
  else if (!responseObserved) failureStage = "response-not-observed";
  else if (responseKind === "error") failureStage = "response-error";
  else if (responseKind === "records" && !renderObserved) failureStage = "response-render-timeout";

  return {
    requestObserved,
    responseObserved,
    responseStatus,
    responseKind,
    responseCount,
    renderObserved,
    failureStage
  };
}

export function createQueryLifecycleObserver(page, {
  expectedUserId = "",
  keyword = "",
  responseReadTimeoutMs = 500
} = {}) {
  const matching = new Set();
  const pending = new Set();
  const state = {};
  const onRequest = (request) => {
    if (!["xhr", "fetch"].includes(request.resourceType?.())) return;
    const rawHaystack = `${request.url?.() || ""}\n${request.postData?.() || ""}`;
    const haystack = decodeURIComponentSafely(rawHaystack);
    if (!expectedUserId || !haystack.includes(String(expectedUserId))) return;
    if (keyword && !haystack.includes(String(keyword))) return;
    matching.add(request);
    state.requestObserved = true;
  };
  const onResponse = (response) => {
    const request = response.request?.();
    if (!matching.has(request)) return;
    const work = Promise.resolve().then(async () => {
      state.responseObserved = true;
      state.responseStatus = Number(response.status?.() || 0);
      const body = await withTimeout(
        Promise.resolve().then(() => response.json?.()).catch(() => null),
        responseReadTimeoutMs,
        null
      );
      const count = findResponseCount(body);
      if (count !== null) {
        state.responseCountKnown = true;
        state.responseCount = count;
      }
    }).finally(() => pending.delete(work));
    pending.add(work);
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  return {
    async finish({ renderObserved = false } = {}) {
      page.off("request", onRequest);
      page.off("response", onResponse);
      await Promise.allSettled([...pending]);
      return classifyQueryLifecycle({ ...state, renderObserved });
    }
  };
}

function withTimeout(work, timeoutMs, fallback) {
  let timer;
  return Promise.race([
    work,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), Math.max(1, Number(timeoutMs || 0)));
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

function decodeURIComponentSafely(value) {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, " "));
  } catch {
    return String(value || "");
  }
}

function findResponseCount(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "object") return null;
  for (const key of ["total", "count", "totalCount", "recordCount"]) {
    const count = Number(value[key]);
    if (Number.isFinite(count) && count >= 0) return count;
  }
  for (const key of ["list", "records", "rows", "items", "data", "result"]) {
    if (!(key in value)) continue;
    const count = findResponseCount(value[key], depth + 1);
    if (count !== null) return count;
  }
  return null;
}
