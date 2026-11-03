const DOM_FIELD_SOURCES = {
  actualProductType: new Set([
    "chanceAssDom订单信息页订单购买类型"
  ]),
  actualCampName: new Set([
    "chanceAssDom详情页训练营名称",
    "chanceAssDom订单信息页订单商品名称兜底"
  ]),
  actualCourseCategory: new Set([
    "chanceAssDom详情页所属品类"
  ])
};

const FIELD_COLUMN = {
  actualProductType: "Q",
  actualCampName: "R",
  actualCourseCategory: "S"
};

function isTrustedField(profile, field) {
  const value = String(profile?.[field] || "").trim();
  if (!value) return false;
  const source = String(profile?.[`${field}Source`] || "").trim();
  return DOM_FIELD_SOURCES[field]?.has(source) || false;
}

export function filterTrustedProfileFields(profile = {}) {
  return Object.fromEntries(Object.keys(FIELD_COLUMN).map((field) => [
    field,
    isTrustedField(profile, field) ? String(profile[field]).trim() : ""
  ]));
}

export function getWritableQrsUpdates(profile = {}) {
  return Object.fromEntries(Object.entries(FIELD_COLUMN).flatMap(([field, column]) => {
    const value = isTrustedField(profile, field) ? String(profile[field]).trim() : "";
    return value ? [[column, value]] : [];
  }));
}
