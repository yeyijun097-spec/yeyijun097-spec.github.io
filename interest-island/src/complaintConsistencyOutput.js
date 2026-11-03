const SUMMARY_FIELDS = Object.freeze([
  "count",
  "isolatedPage",
  "filterPairFound",
  "userIdStable",
  "queryClicked",
  "resultChanged",
  "userIdMatched",
  "technicalFailure"
]);

export function publicConsistencyResult(index, consistent, complaintOnly, all) {
  return {
    index: normalizeIndex(index),
    consistent: Boolean(consistent),
    complaintOnly: publicSummary(complaintOnly),
    all: publicSummary(all)
  };
}

export function publicConsistencySummary(results) {
  const values = Array.isArray(results) ? results : [];
  const failedIndexes = values.flatMap((item, index) => item?.consistent ? [] : [index + 1]);
  return {
    total: values.length,
    passed: values.length - failedIndexes.length,
    failed: failedIndexes.length,
    failedIndexes
  };
}

function publicSummary(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(SUMMARY_FIELDS.map((field) => [
    field,
    field === "count" ? normalizeCount(source[field]) : Boolean(source[field])
  ]));
}

function normalizeIndex(value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 1) throw new TypeError("诊断结果序号必须为正整数");
  return index;
}

function normalizeCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}
