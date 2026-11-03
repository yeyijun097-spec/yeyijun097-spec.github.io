import { suggestProblemLabels } from "./complaintTaxonomy.js";

const PHONE_RE = /(?<!\d)(1\d{10})(?!\d)/;
const DATE_RE = /(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})(?:日|\b)/;

export function parseComplaintText(rawText) {
  const text = normalizeText(rawText);
  const template = detectTemplate(text);
  const fields = template === "12315" ? parse12315(text) : template === "12345" ? parse12345(text) : template === "petition" ? parsePetition(text) : {};
  const details = formatComplaintDetails(String(fields.details || extractGenericComplaintDetails(text)).replace(/\n容\s*$/, ""));
  const source = inferSource(template, text);
  const relationship = suggestRelationship(details);
  const result = {
    template,
    externalNumber: fields.externalNumber || "",
    registeredAt: normalizeDateTime(fields.registeredAt || ""),
    name: fields.name || "",
    phone: fields.phone || text.match(PHONE_RE)?.[1] || "",
    alternatePhone: fields.alternatePhone || "",
    amount: normalizeAmount(fields.amount || ""),
    productName: fields.productName || "",
    disputeAt: normalizeDateTime(fields.disputeAt || ""),
    complaintType: fields.complaintType || "",
    source,
    relationship,
    problemLabels: suggestProblemLabels(details, relationship),
    detailsOriginalLength: [...details].length,
    details: [...details].slice(0, 500).join(""),
    detailsTruncated: [...details].length > 500,
    notes: "",
    confidences: {}
  };
  result.confidences = validateComplaintFields(result);
  return result;
}

export function detectTemplate(text) {
  if (/人民群众信访登记表|信访件编号/.test(text) && /内容摘要|主要事实/.test(text)) return "petition";
  if (/市场监管投诉举报平台/.test(text) || (/(?:投诉单|举报单)/.test(text) && /登记单位|统一社会信用代码/.test(text))) return "12315";
  if (/12345.{0,20}(工单登记表|转字第)/s.test(text) || /商家实际履行情况|具体情况描述/.test(text)) return "12345";
  return "unknown";
}

export function suggestRelationship(text) {
  if (/(儿子|女儿|孩子|小孩|子女)/.test(text)) return "子女";
  if (/(父亲|母亲|父母|爸爸|妈妈|配偶|丈夫|妻子|爱人|家人|家属)/.test(text)) return "家属";
  return "本人";
}

export function inferSource(template, text) {
  if (template === "12315") return /举报单|举报内容/.test(text) ? "12315举报单" : "12315投诉单";
  if (template === "12345") {
    if (/举报\s*[√✓✔☑]/.test(text) || /工单类型[^\n]*(?:举报单|举报件)/.test(text)) return "12345举报单";
    return "12345投诉单";
  }
  if (template === "petition") return "国满件（信访）";
  return "";
}

export function scoreOrders(complaint, orders) {
  return (orders || []).map((order) => {
    let score = 0;
    const reasons = [];
    const amountA = Number(complaint.amount);
    const amountB = Number(order.amount);
    if (amountA > 0 && amountB > 0) {
      const delta = Math.abs(amountA - amountB);
      if (delta < 0.01) { score += 45; reasons.push("金额一致"); }
      else if (delta / amountA <= 0.05) { score += 25; reasons.push("金额接近"); }
    }
    if (complaint.productName && order.name && fuzzyIncludes(complaint.productName, order.name)) {
      score += 25; reasons.push("课程名称相近");
    }
    const complaintDate = dateValue(complaint.disputeAt || complaint.registeredAt);
    const orderDate = dateValue(order.paidAt || order.createdAt);
    if (complaintDate && orderDate) {
      const days = Math.abs(complaintDate - orderDate) / 86400000;
      if (days <= 7) { score += 20; reasons.push("时间相近"); }
      else if (days <= 30) { score += 10; reasons.push("时间在30天内"); }
    }
    if (order.type) { score += 5; reasons.push(`订单类型${order.type}`); }
    return { ...order, score, reasons };
  }).sort((a, b) => b.score - a.score);
}

export function uniqueUserIds(rows) {
  return [...new Set((rows || []).map((row) => String(row.userId || "").trim()).filter(Boolean))];
}

export function validateComplaintFields(value) {
  const validPhone = /^1\d{10}$/.test(value.phone || "");
  const validDate = /^20\d{2}-\d{2}-\d{2}/.test(value.registeredAt || "");
  const known = value.template !== "unknown";
  return {
    template: known ? 0.98 : 0,
    phone: validPhone ? 0.98 : 0,
    externalNumber: value.externalNumber ? 0.9 : 0,
    registeredAt: validDate ? 0.9 : 0,
    details: value.details ? 0.9 : 0,
    source: value.source ? 0.98 : 0
  };
}

function parse12315(text) {
  return {
    externalNumber: capture(text, /编号[：:]?\s*([0-9]{12,})/),
    registeredAt: capture(text, /登记时间[：:]?\s*([^\n]+)/),
    name: capture(text, /姓名[：:]?\s*([^\n\s]{2,20})/),
    phone: capture(text, /(?:联系电话|来电号码)[：:]?\s*(1\d{10})/),
    amount: capture(text, /(?:消费金额(?:（元）|\(元\))?|涉及金额(?:（元）|\(元\))?)[：:]?\s*([\d,.]+)/),
    productName: capture(text, /商品\/服务名称[：:]?\s*([^\n]+)/),
    disputeAt: capture(text, /争议发生时间[：:]?\s*([^\n]+)/),
    complaintType: capture(text, /投诉问题类型[：:]?\s*([^\n]+)/),
    details: section(text, /(?:投诉内容|举报内容|投诉内(?=\s)|举报内(?=\s))[：:]?/, /(?:经办人|处理结果|办理情况)[：:]?/)
  };
}

function parse12345(text) {
  const stop = /(?:是\s*否\s*预\s*付\s*费|监\s*管\s*部\s*门|市\s*民\s*诉\s*求|补\s*充\s*信\s*息|回\s*复\s*方\s*式)[：:]?/;
  const fulfilled = section(text, /商家实际履行情况[：:]?/, stop);
  const contactPhone = capture(text, /(?:联系电话|市民电话)[：:]?\s*(1\d{10})/);
  const incomingPhone = capture(text, /来电号码[：:]?\s*(1\d{10})/);
  const externalNumber = capture(text, /(穗\s*12345\s*转字第?\s*[\d\s]+号)/)?.replace(/\s+/g, "");
  const reportedProblem = section(text, /存\s*在\s*问\s*题[：:]?/, /(?:紧\s*急\s*程\s*度|热\s*线\s*审\s*核\s*意\s*见|回\s*复\s*方\s*式)[：:]?/);
  return {
    externalNumber,
    // 事发时间是争议发生时间，不能在缺少登记/转办/来电时间时冒充投诉时间。
    registeredAt: capture(text, /(?:登记时间|转办时间|来电时间)[：:]?\s*([^\n]+)/) || dateFrom12345Number(externalNumber),
    name: capture(text, /市民称呼[：:]?\s*([^\n]+)/),
    // 12345 工单可能同时包含平台来电号码和市民联系电话；录单查询
    // 使用明确的联系电话，只有该字段缺失时才回退来电号码。
    phone: contactPhone || incomingPhone,
    alternatePhone: contactPhone && incomingPhone && contactPhone !== incomingPhone ? incomingPhone : "",
    amount: capture(text, /(?:消费金额|涉及金额)(?:（元）|\(元\))?[：:]?\s*([\d,.]+)/),
    productName: capture(text, /商品\s*\/\s*服务名称[：:]?\s*([^\n]+)/),
    disputeAt: capture(text, /(?:事发时间|消费时间)[：:]?\s*([^\n]+)/),
    details: meaningfulDetails(fulfilled) || section(text, /具\s*体\s*情\s*况\s*描\s*述[：:]?/, stop) ||
      meaningfulDetails(reportedProblem) || section(text, /约定内容[：:]?/, /(?:商家实际履行情况|是否预付费|监管部门|市民诉求|补充信息|回复方式)[：:]?/) ||
      detailsFrom12345TagGroup(text)
  };
}

function detailsFrom12345TagGroup(text) {
  const value = section(
    text,
    /(?:^|\n)\s*标\s*签\s*组\s*(?:\n|$)/,
    /(?:^|\n)\s*补\s*充\s*信\s*息\s*(?:\n|$)/
  );
  // 该版式把“市民诉求”作为正文内部的栏名，前后两段都属于投诉详情。
  return meaningfulDetails(value.replace(/(?:^|\n)\s*市\s*民\s*诉\s*求\s*(?=\n|$)/g, "\n"));
}

function extractGenericComplaintDetails(text) {
  const start = /(?:投诉事实及诉求|投诉事实|诉求描述|投诉描述|问题描述|情况说明|反映内容|正文内容)[：:]?/;
  const stop = /(?:^|\n)\s*(?:办理部门|处理部门|监管部门|回复方式|补充信息|经办人|办理意见|处理结果)[：:]?/m;
  return meaningfulDetails(section(text, start, stop));
}

function dateFrom12345Number(value) {
  const match = String(value || "").match(/转字第\d{2}(\d{2})(\d{2})(\d{2})/);
  if (!match) return "";
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `20${String(year).padStart(2, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parsePetition(text) {
  const summary = section(text, /主要事实[：:]?/, /(?:主要诉求|内容摘要)[：:]?/);
  return {
    externalNumber: capture(text, /信访件编号[：:]?\s*([A-Z]{1,5}\s*\d{10,})/i)?.replace(/\s+/g, ""),
    registeredAt: capture(text, /信访日期[：:]?[\s\S]{0,100}?(20\d{2}[年\/-]\d{1,2}[月\/-]\d{1,2}日?)/) || extractDate(text),
    name: capture(text, /邮箱\s*\n\s*([^\n\d]{2,12})/) || capture(text, /姓名[：:]?\s*([^\n\d]{2,12})/),
    phone: extractPetitionPhone(text),
    details: meaningfulDetails(summary)
  };
}

function extractPetitionPhone(text) {
  const direct = text.match(PHONE_RE)?.[1]; if (direct) return direct;
  const match = text.match(/(1\d{4,5})\s*\n(?:人数\s*\n)?手机\s*\n(\d{4,6})\s*\n\d{1,2}\s*\n[\s\S]{0,80}?\n(\d)\s*(?:\n|$)/);
  const joined = match ? `${match[1]}${match[2]}${match[3]}` : "";
  return /^1\d{10}$/.test(joined) ? joined : "";
}

function meaningfulDetails(value) { const text = String(value || "").trim(); return /^[-—–－无\s]*$/.test(text) ? "" : text; }

function normalizeText(text) {
  return String(text || "").replace(/\r/g, "")
    .replace(/(20\d{2})[—–－](\d{1,2})[—–－](\d{1,2})/g, "$1-$2-$3")
    .replace(/(20\d{2}-\d{1,2}-\d{1,2})(\d{2}:\d{2})/g, "$1 $2")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function capture(text, regex) { return String(text.match(regex)?.[1] || "").trim(); }
function section(text, start, end) {
  const match = start.exec(text); if (!match) return "";
  const remainder = text.slice(match.index + match[0].length);
  const stop = end.exec(remainder);
  return remainder.slice(0, stop ? stop.index : remainder.length).trim();
}
function normalizeAmount(value) { const n = Number(String(value).replace(/,/g, "")); return Number.isFinite(n) && n >= 0 ? String(n) : ""; }
function extractDate(text) { return text.match(DATE_RE)?.[0] || ""; }
export function normalizeDateTime(value) {
  const text = String(value || "").trim(); const match = text.match(DATE_RE); if (!match) return "";
  const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const time = text.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/)?.[1]; return `${date} ${time || "00:00:00"}`;
}
export function formatComplaintDetails(value) {
  return String(value || "").replace(/\r/g, "").replace(/(?:^|\n)\s*(?:标签组|补充信息)\s*(?=\n|$)/g, "\n").replace(/[ \t]*\n+[ \t]*/g, "").replace(/[ \t]{2,}/g, " ").trim();
}
function fuzzyIncludes(a, b) { const clean = (v) => String(v).replace(/[\s课程培训线上线下]/g, "").toLowerCase(); const x = clean(a), y = clean(b); return x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)); }
function dateValue(value) { const n = Date.parse(String(value || "").replace(" ", "T")); return Number.isFinite(n) ? n : 0; }
