const CLASSIFICATION_OWNED_FIELDS = new Set([
  "firstCategory",
  "secondCategory",
  "thirdCategory",
  "confidence",
  "needsReview",
  "riskLevel",
  "riskAssessedLevel",
  "riskReason",
  "riskMatchedKeywords",
  "categoryColumnsWritable",
  "riskLevelWritable"
]);

export function mergeDualLaneRow({ row, classification, profile, finalize }) {
  const classificationFailed = Boolean(classification?.error && !classification?.result);
  const rawProfileValue = profile?.profile || {};
  const profileFailed = Boolean(profile?.error && !profile?.profile)
    || rawProfileValue.profileFound === false;
  const result = classificationFailed
    ? createClassificationFailure(row, classification.error)
    : { ...(classification?.result || {}), rowNumber: row.rowNumber };
  // 失败时不把空档案的 Q/R/S 合入结果，但保留原 profile 供日志与审计定位。
  const profileValue = profileFailed ? {} : rawProfileValue;

  for (const [key, value] of Object.entries(profileValue)) {
    if (!CLASSIFICATION_OWNED_FIELDS.has(key)) result[key] = value;
  }

  result.actualProductType ||= "";
  result.actualCampName ||= "";
  result.actualCourseCategory ||= "";
  result.profileColumnStatus ||= {};
  if (profileFailed) {
    // 档案通道没有产出时，不能保留分类通道可能携带的旧 Q/R/S。
    // 先清除分类通道的临时值，再按列恢复已有工作簿值和 L/M 兜底。
    result.actualProductType = "";
    result.actualCampName = "";
    result.actualCourseCategory = "";
    result.profileError = profile?.error || rawProfileValue.profileError || "档案查询失败";
  }

  // 详情页的真实值优先；任一列没有本轮可信值时，保留原工作簿值。
  // 这样部分成功（例如只获取 S）不会回退已经确认的 Q/R。
  applyExistingProfilePreservation(result, row);

  // 仅在档案查询实际失败且 Q/R 仍为空时，才用 L/M 填充 Q/R；S 永不推断。
  if (profileFailed && canApplyDocumentProfileFallback(rawProfileValue)) {
    applyDocumentProfileFallback(result, row);
  }
  finalizeProfileColumnStatus(result, rawProfileValue);

  const merged = {
    row,
    rowNumber: row.rowNumber,
    context: classification?.context || {},
    ruleResult: classification?.ruleResult || result,
    profile: rawProfileValue,
    result,
    timing: {
      ...(classification?.timing || {}),
      profileMs: profile?.timing?.profileMs || 0,
      profileCacheHit: Boolean(profile?.timing?.profileCacheHit)
    }
  };

  return typeof finalize === "function" ? (finalize(merged) || merged) : merged;
}

function canApplyDocumentProfileFallback(profile = {}) {
  return !profile.profileSkipped;
}

function applyDocumentProfileFallback(result, row) {
  const productType = normalizeDocumentProductType(row?.docProductType || row?.existing?.L);
  const campName = normalizeDocumentCampName(row?.docCampName || row?.existing?.M);
  const fields = [];

  if (!result.actualProductType && productType) {
    result.actualProductType = productType;
    result.actualProductTypeSource = "文档L列兜底（档案查询失败）";
    result.profileColumnStatus.Q = "fallback";
    fields.push("Q");
  }
  if (!result.actualCampName && campName) {
    result.actualCampName = campName;
    result.actualCampNameSource = "文档M列兜底（档案查询失败）";
    result.profileColumnStatus.R = "fallback";
    fields.push("R");
  }

  if (fields.length) {
    result.profileDocumentFallbackUsed = true;
    result.profileDocumentFallbackFields = fields;
  }
}

function applyExistingProfilePreservation(result, row) {
  const fields = [
    ["Q", "actualProductType", "actualProductTypeSource"],
    ["R", "actualCampName", "actualCampNameSource"],
    ["S", "actualCourseCategory", "actualCourseCategorySource"]
  ];
  for (const [column, valueKey, sourceKey] of fields) {
    if (String(result[valueKey] || "").trim()) {
      result.profileColumnStatus[column] ||= "written";
      continue;
    }
    const existingValue = String(row?.existing?.[column] || "").trim();
    if (!existingValue) continue;
    result[valueKey] = existingValue;
    result[sourceKey] = `原工作簿${column}列保留`;
    result.profileColumnStatus[column] = "preserved";
  }
}

function finalizeProfileColumnStatus(result, profile) {
  const failureStage = String(profile?.profileFailureStage || "").trim();
  for (const [column, valueKey] of [["Q", "actualProductType"], ["R", "actualCampName"], ["S", "actualCourseCategory"]]) {
    if (result.profileColumnStatus[column]) continue;
    result.profileColumnStatus[column] = String(result[valueKey] || "").trim() ? "written" : "missing";
    if (result.profileColumnStatus[column] === "missing" && failureStage) {
      result.profileColumnMissingReason ||= {};
      result.profileColumnMissingReason[column] = failureStage;
    }
  }
}

function normalizeDocumentProductType(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.includes("正式营")) return "正式营";
  if (text.includes("体验营")) return "体验营";
  return "";
}

function normalizeDocumentCampName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function createClassificationFailure(row, error) {
  return {
    rowNumber: row.rowNumber,
    firstCategory: "",
    secondCategory: "",
    thirdCategory: "",
    confidence: 0,
    needsReview: true,
    error,
    reason: "分类通道处理异常，未写回三级分类和风险等级",
    diagnosis: ["分类通道处理异常", error],
    categoryColumnsWritable: false,
    riskLevelWritable: false,
    riskLevel: "",
    riskAssessedLevel: ""
  };
}
