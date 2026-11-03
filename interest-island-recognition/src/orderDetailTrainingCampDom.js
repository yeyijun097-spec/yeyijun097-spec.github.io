import { createHash } from "node:crypto";

const CAMP_LABELS = new Set(["训练营名称", "营名称", "对应训练营", "训练营"]);

export function resolveDetailTrainingCampName({ expectedOrderId, panelOrderId, fields = [] }) {
  const expected = digits(expectedOrderId);
  const actual = digits(panelOrderId);
  if (!expected || !actual || expected !== actual) {
    return emptyResult("详情订单ID校验失败", expectedOrderId, panelOrderId, []);
  }

  const candidates = (Array.isArray(fields) ? fields : [])
    .filter((field) => normalize(field.section) === "商品信息")
    .filter((field) => CAMP_LABELS.has(normalize(field.label)))
    .map((field) => ({ ...field, value: normalize(field.value) }))
    .filter((field) => field.value);

  if (candidates.length === 0) {
    return emptyResult("详情页未展示已确认的训练营名称字段", expectedOrderId, panelOrderId, candidates);
  }
  if (candidates.length !== 1) {
    return emptyResult("详情训练营名称值不唯一", expectedOrderId, panelOrderId, candidates);
  }

  return {
    value: candidates[0].value,
    source: "chanceAssDom详情页训练营名称",
    failureReason: "",
    matchedLabel: candidates[0].label,
    diagnostic: summarizeDetailTrainingCampProbe({ expectedOrderId, panelOrderId, fields: candidates })
  };
}

export function summarizeDetailTrainingCampProbe({ expectedOrderId, panelOrderId, fields = [] }) {
  const candidates = Array.isArray(fields) ? fields : [];
  return {
    expectedOrderIdHash: hashOrderId(expectedOrderId),
    panelOrderIdHash: hashOrderId(panelOrderId),
    candidateCount: candidates.length,
    candidates: candidates.map((field) => ({
      label: normalize(field.label),
      labelPath: structuralPath(field.labelPath),
      valuePath: structuralPath(field.valuePath),
      rect: projectRect(field.rect),
      valueLength: normalize(field.value).length
    }))
  };
}

function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalize(value) {
  return String(value ?? "").trim();
}

function structuralPath(value) {
  return normalize(value)
    .split(">")
    .map((segment) => {
      if (segment.includes("://")) return "";
      const match = segment.match(/^([a-zA-Z][a-zA-Z0-9-]*)(?::nth\((\d+)\))?/);
      return match ? `${match[1]}${match[2] ? `:nth(${match[2]})` : ""}` : "";
    })
    .filter(Boolean)
    .join(">");
}

function projectRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  const projected = {};
  for (const key of ["top", "left", "width", "height"]) {
    if (Number.isFinite(rect[key])) projected[key] = rect[key];
  }
  return Object.keys(projected).length ? projected : null;
}

function emptyResult(failureReason, expectedOrderId, panelOrderId, fields) {
  return {
    value: "",
    source: "",
    failureReason,
    matchedLabel: "",
    diagnostic: summarizeDetailTrainingCampProbe({ expectedOrderId, panelOrderId, fields })
  };
}

function hashOrderId(orderId) {
  const value = digits(orderId);
  return value ? createHash("sha256").update(value).digest("hex") : "";
}
