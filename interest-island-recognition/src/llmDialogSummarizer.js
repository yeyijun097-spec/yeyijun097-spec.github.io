import {
  collectExternalLlmRedactions,
  isExternalLlmAllowed,
  sanitizeRowForExternalLlm,
  sanitizeTextForExternalLlm
} from "./llmDataBoundary.js";

const DEFAULT_DIALOG_SUMMARY = {
  timeoutMs: 45000,
  maxContextChars: 16000,
  minConfidence: 0.6,
  overallMaxLength: 50,
  sideMaxLength: 30
};

export async function summarizeDialogWithLlm({ row, context, settings }) {
  const base = {
    dialogSummarySource: "",
    overallDialogSummary: "",
    studentDialogSummary: "",
    teacherDialogSummary: "",
    teacherHandlingSummary: "",
    teacherResponseStatus: "",
    teacherFollowupStatus: "",
    teacherHandlingEvidence: "",
    dialogSummaryError: "",
    dialogSummaryWarning: "",
    dialogNeedsReview: false,
    dialogSummaryConfidence: 0,
    overallDialogConfidence: 0,
    studentDialogConfidence: 0,
    teacherDialogConfidence: 0
  };

  if (!isExternalLlmAllowed(settings)) {
    return { ...base, dialogSummaryError: settings?.llmDisabledReason || "大模型未启用，未生成三天对话总结" };
  }
  if (!settings.apiKey) {
    return { ...base, dialogSummaryError: "未配置 ARK_API_KEY 或 DEEPSEEK_API_KEY，未生成三天对话总结" };
  }
  if (!context?.contextOpened) {
    return { ...base, dialogSummaryError: "右侧上下文未可靠打开，未生成三天对话总结" };
  }

  const overallText = normalizeText(context.dialogContextText || context.contextText || "");
  const studentText = normalizeText(context.dialogStudentText || context.userBubbleText || "");
  const teacherRawText = normalizeText(context.dialogTeacherText || "");
  const teacherText = normalizeText(context.dialogTeacherTextFiltered || teacherRawText);
  if (!overallText && !studentText && !teacherText && !teacherRawText) {
    return { ...base, dialogSummaryError: "三天对话上下文为空" };
  }

  try {
    const raw = await requestDeepSeek({ row, context, settings, overallText, studentText, teacherText, teacherRawText });
    const parsed = parseJsonContent(raw);
    const confidence = normalizeConfidence(parsed.confidence);
    const overallConfidence = normalizeFieldConfidenceWithEvidence(
      parsed.overallConfidence,
      confidence,
      parsed.overallDialogSummary,
      overallText
    );
    const studentConfidence = normalizeFieldConfidenceWithEvidence(
      parsed.studentConfidence,
      confidence,
      parsed.studentDialogSummary,
      studentText || row.message
    );
    const teacherConfidence = normalizeFieldConfidenceWithEvidence(
      parsed.teacherConfidence,
      confidence,
      parsed.teacherDialogSummary || parsed.teacherHandlingSummary,
      teacherText || teacherRawText || row.message
    );
    const overall = overallConfidence >= DEFAULT_DIALOG_SUMMARY.minConfidence
      ? limitText(parsed.overallDialogSummary, DEFAULT_DIALOG_SUMMARY.overallMaxLength)
      : "";
    const student = (studentText || parsed.studentDialogSummary) && studentConfidence >= DEFAULT_DIALOG_SUMMARY.minConfidence
      ? limitText(parsed.studentDialogSummary, DEFAULT_DIALOG_SUMMARY.sideMaxLength)
      : "";
    const teacher = (teacherText || teacherRawText || parsed.teacherDialogSummary) && teacherConfidence >= DEFAULT_DIALOG_SUMMARY.minConfidence
      ? limitText(parsed.teacherDialogSummary, DEFAULT_DIALOG_SUMMARY.sideMaxLength)
      : "";
    const teacherResponseStatus = normalizeStatus(parsed.teacherResponseStatus, ["已处理", "已回应未处理", "未回应", "无法判断"]);
    const teacherFollowupStatus = normalizeStatus(parsed.teacherFollowupStatus, ["已跟进解决", "已跟进未解决", "未见跟进", "无法判断"]);
    const teacherHandlingEvidence = limitText(parsed.teacherHandlingEvidence, 40);
    const teacherHandlingSummary = normalizeTeacherHandlingSummary({
      value: parsed.teacherHandlingSummary,
      teacherResponseStatus,
      teacherFollowupStatus,
      teacherHandlingEvidence,
      teacherText,
      teacherRawText,
      studentText: studentText || row.message,
      confidence: teacherConfidence
    });

    const fallbackOverall = !overall && (student || teacherHandlingSummary)
      ? buildOverallFromFields({ student, teacherHandlingSummary, row })
      : "";

    if (!overall && !fallbackOverall && !student && !teacher && !teacherHandlingSummary) {
      return {
        ...base,
        dialogSummaryError: "DeepSeek未生成可写入的三天总结",
        dialogSummaryConfidence: confidence,
        overallDialogConfidence: overallConfidence,
        studentDialogConfidence: studentConfidence,
        teacherDialogConfidence: teacherConfidence
      };
    }

    return {
      ...base,
      dialogSummarySource: "deepseek_3day_dialog",
      overallDialogSummary: overall || fallbackOverall,
      studentDialogSummary: student,
      teacherDialogSummary: teacher,
      teacherHandlingSummary,
      teacherResponseStatus,
      teacherFollowupStatus,
      teacherHandlingEvidence,
      dialogSummaryWarning: [
        confidence < DEFAULT_DIALOG_SUMMARY.minConfidence
          ? `整体置信度${confidence}，已按字段证据保留可用总结`
          : "",
        Boolean(parsed.needsReview) ? normalizeText(parsed.reason) || "DeepSeek标记需复核，已按字段保留可用总结" : ""
      ].filter(Boolean).join("；"),
      dialogNeedsReview: Boolean(parsed.needsReview),
      dialogSummaryConfidence: confidence,
      overallDialogConfidence: overallConfidence,
      studentDialogConfidence: studentConfidence,
      teacherDialogConfidence: teacherConfidence
    };
  } catch (error) {
    return {
      ...base,
      dialogSummaryError: safeErrorMessage(error, row)
    };
  }
}

async function requestDeepSeek({ row, context, settings, overallText, studentText, teacherText, teacherRawText }) {
  const endpoint = `${String(settings.baseUrl || "").replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs || DEFAULT_DIALOG_SUMMARY.timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(buildPayload({ row, context, settings, overallText, studentText, teacherText, teacherRawText })),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`DeepSeek 三天总结请求失败 ${response.status}: ${body.slice(0, 500)}`);
    }
    const data = JSON.parse(body);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek 三天总结响应中没有 choices[0].message.content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function buildPayload({ row, context, settings, overallText, studentText, teacherText }) {
  const maxChars = Number(settings.dialogMaxContextChars || DEFAULT_DIALOG_SUMMARY.maxContextChars);
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
          "你是对话质检总结助手，只能根据给定的三天内真实聊天内容做摘要。",
          "不得补写没有出现的处理动作、退款承诺、老师承诺或结果。",
          "总体总结要同时覆盖学员诉求和老师回应；学员总结只概括学员侧；老师总结只概括老师侧。",
          "老师侧文本可能含课程推广、活动介绍、报名引导、海报广告；这些内容不是处理动作，应忽略或降权。",
          "老师总结必须重点回答：老师是否回应了学员问题，以及是否有跟进解决动作。",
          "teacherHandlingSummary 是写入 AI 列的处理进展判断，必须围绕 K列原始消息判断老师是否回应了该问题。",
          "如果老师明确回应、安抚、对接或处理学员问题，teacherHandlingSummary 提炼老师给学员的处理方案或处理进展。",
          "如果老师处理的是同一轮诉求中的赠品、课程、资料、回放、物流、社群、退款流程等实际事项，也算有回应或处理，不要因为没有复述K列原词就判定未回复。",
          "如果老师没有针对 K列问题回复，或只有推广广告、课程介绍、报名引导、海报链接，teacherHandlingSummary 必须输出“未回复学员问题”。",
          "老师总结应优先概括明确处理动作，例如已登记、已提交、已发起申请、退款处理中、已反馈、让等待、补发资料、发课程、发回放、解释流程、已到货、已回复、已道歉。",
          "如果学员提出退费、退款、投诉、物流、回放、课程安排、骚扰等诉求，必须检查老师是否对该诉求有针对性回复。",
          "推广广告、课程介绍、欢迎语、催报名、海报链接，不算回应诉求，也不算跟进处理。",
          "如果老师有回应但没有解决动作，写“已回应，未见明确处理”或概括实际回应。",
          "如果老师只有推广广告或没有针对学员诉求回应，老师总结写“未见明确处理”。",
          "teacherResponseStatus 只能为：已处理、已回应未处理、未回应、无法判断。",
          "teacherFollowupStatus 只能为：已跟进解决、已跟进未解决、未见跟进、无法判断。",
          "teacherHandlingEvidence 只摘录老师侧可证明回应/处理的短句；没有则空。",
          "如果某一侧文本为空，对应总结必须为空。",
          "整体总结写入 AH 列，应较为详细地概括学员问题和老师是否回应，不超过50个汉字。",
          "学员总结和老师总结各不超过30个汉字；它们仅用于日志辅助，不写入 Excel。",
          "即使整体需要复核，也要尽量输出证据充足的单项总结，并分别给出 overallConfidence、studentConfidence、teacherConfidence。",
          "单项置信度不足时，该项总结留空；不要因为老师侧不足而清空学员总结。",
          "只输出 JSON，不要输出解释文本。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            输出JSON格式: {
              overallDialogSummary: "AH列问题总结，较详细，不超过50字",
              studentDialogSummary: "学员总结，不超过30字，学员侧为空则空",
              teacherDialogSummary: "老师总结，不超过30字，老师侧为空则空",
              teacherHandlingSummary: "AI列老师是否答复/处理，不超过30字；无针对性回复时固定为未回复学员问题",
              teacherResponseStatus: "已处理/已回应未处理/未回应/无法判断",
              teacherFollowupStatus: "已跟进解决/已跟进未解决/未见跟进/无法判断",
              teacherHandlingEvidence: "老师回应或处理证据短句，没有则空",
              confidence: "0到1之间的小数",
              overallConfidence: "总体总结置信度，0到1",
              studentConfidence: "学员总结置信度，0到1",
              teacherConfidence: "老师总结置信度，0到1",
              needsReview: "无法可靠总结时为true",
              reason: "一句话说明依据"
            },
            行信息: {
              ...sanitizeRowForExternalLlm(row),
              existingYSummary: sanitizeTextForExternalLlm(context.userSummary || "", 300, {
                redactions: collectExternalLlmRedactions(row)
              })
            },
            时间窗口: {
              start: context.dialogWindowStart || "",
              end: context.dialogWindowEnd || ""
            },
            老师处理动作条数: context.teacherHandlingMessageCount || 0,
            三天总体上下文: sanitizeTextForExternalLlm(overallText, maxChars, { redactions: collectExternalLlmRedactions(row) }),
            学员侧文本: sanitizeTextForExternalLlm(studentText, Math.min(6000, maxChars), { redactions: collectExternalLlmRedactions(row) }),
            老师处理相关文本: sanitizeTextForExternalLlm(teacherText, Math.min(6000, maxChars), { redactions: collectExternalLlmRedactions(row) })
          },
          null,
          2
        )
      }
    ]
  };
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
  throw new Error("DeepSeek 三天总结返回内容不是可解析 JSON");
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(Math.max(0, Math.min(1, number)).toFixed(2));
}

function normalizeFieldConfidence(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return normalizeConfidence(fallback);
  return normalizeConfidence(number);
}

function normalizeFieldConfidenceWithEvidence(value, fallback, fieldValue, sourceText) {
  const explicit = normalizeFieldConfidence(value, NaN);
  if (explicit > 0) return explicit;
  const base = normalizeConfidence(fallback);
  if (base >= DEFAULT_DIALOG_SUMMARY.minConfidence) return base;
  if (normalizeText(fieldValue) && normalizeText(sourceText)) {
    return DEFAULT_DIALOG_SUMMARY.minConfidence;
  }
  return base;
}

function normalizeStatus(value, allowed) {
  const text = normalizeText(value);
  return allowed.includes(text) ? text : "";
}

function normalizeTeacherHandlingSummary({
  value,
  teacherResponseStatus,
  teacherFollowupStatus,
  teacherHandlingEvidence,
  teacherText,
  teacherRawText,
  studentText,
  confidence
}) {
  const hasStudentProblem = Boolean(normalizeText(studentText));
  const hasRelevantTeacherText = Boolean(normalizeText(teacherText));
  const hasHandlingEvidence = hasTeacherHandlingEvidence(teacherText || teacherRawText);
  const hasEvidenceText = Boolean(normalizeText(teacherHandlingEvidence));
  const raw = normalizeText(value);
  const genericHandled = /^(已回应并处理相关事项|已回应并处理|老师已回应并处理|已处理相关事项|老师回应并处理)$/.test(raw);
  const teacherSaysNotHandled = /(未处理|未解决|未见明确|未给出|没有处理|没有解决|仅|只是|未直接回应|未回复|无回复)/.test(
    normalizeText([teacherText, teacherRawText, teacherHandlingEvidence].join(" "))
  );

  if ((teacherResponseStatus === "未回应" && !hasHandlingEvidence) || (!hasRelevantTeacherText && !hasHandlingEvidence && hasStudentProblem)) {
    return "未回复学员问题";
  }

  if (teacherResponseStatus === "未回应" && (genericHandled || !hasEvidenceText)) {
    return "未回复学员问题";
  }

  if (genericHandled && teacherSaysNotHandled && !hasHandlingEvidence) {
    return "未回复学员问题";
  }

  if (genericHandled && teacherSaysNotHandled) {
    return "已回应但未见明确处理";
  }

  if (/^(未回复学员问题|未回复|未回应|无回复|没有回复|未见回复)$/.test(raw)) {
    if (hasHandlingEvidence) return limitText(teacherHandlingEvidence, DEFAULT_DIALOG_SUMMARY.sideMaxLength) || "已回应并处理相关事项";
    return "未回复学员问题";
  }

  if (/^(未见明确处理|未明确处理|无明确处理|没有明确处理)$/.test(raw)) {
    if (hasHandlingEvidence) return limitText(teacherHandlingEvidence, DEFAULT_DIALOG_SUMMARY.sideMaxLength) || "已回应并处理相关事项";
    return teacherResponseStatus === "已回应未处理" ? "已回应但未见处理" : "未回复学员问题";
  }

  if (!raw) {
    if (teacherResponseStatus === "已回应未处理") return "已回应但未见处理";
    if (hasHandlingEvidence) return limitText(teacherHandlingEvidence, DEFAULT_DIALOG_SUMMARY.sideMaxLength) || "已回应并处理相关事项";
    if (teacherFollowupStatus === "未见跟进" && hasRelevantTeacherText) return "已回应但未见处理";
    return "";
  }

  if (/已回应/.test(raw) && teacherFollowupStatus === "未见跟进" && teacherSaysNotHandled && !hasHandlingEvidence) {
    return "已回应但未见明确处理";
  }

  if (Number(confidence || 0) < DEFAULT_DIALOG_SUMMARY.minConfidence && !/未回复学员问题/.test(raw)) {
    return "";
  }

  return limitText(raw, DEFAULT_DIALOG_SUMMARY.sideMaxLength);
}

function hasTeacherHandlingEvidence(value) {
  return /(登记|记录|提交|申请|发起|反馈|处理|跟进|退款|退费|流程|安排|补发|补寄|重发|已发|发课程|发资料|发回放|发链接|已到货|物流|快递|赠品|礼品|小音箱|教材|资料|核实|确认|转交|联系|解决|售后|客服|道歉|抱歉|不好意思|未及时|没及时)/.test(normalizeText(value));
}

function limitText(value, maxLength) {
  const normalized = normalizeText(value)
    .replace(/[。；;,.，、\s]+$/g, "")
    .replace(/^(总结|学员总结|老师总结)[：:]/, "");
  if (!normalized) return "";
  const chars = [...normalized];
  const limit = Math.max(1, Number(maxLength) || 30);
  return chars.length <= limit ? normalized : chars.slice(0, limit).join("");
}

function buildOverallFromFields({ student, teacherHandlingSummary, row }) {
  const studentPart = normalizeText(student) || limitText(row.message, 24);
  const teacherPart = normalizeText(teacherHandlingSummary);
  if (!studentPart && !teacherPart) return "";
  if (!teacherPart) return limitText(`学员${studentPart}`, DEFAULT_DIALOG_SUMMARY.overallMaxLength);
  if (!studentPart) return limitText(`老师${teacherPart}`, DEFAULT_DIALOG_SUMMARY.overallMaxLength);
  return limitText(`学员${studentPart}，老师${teacherPart}`, DEFAULT_DIALOG_SUMMARY.overallMaxLength);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value, maxChars) {
  const text = String(value || "").trim();
  const max = Number(maxChars) || DEFAULT_DIALOG_SUMMARY.maxContextChars;
  if (text.length <= max) return text;
  const half = Math.floor((max - 80) / 2);
  return `${text.slice(0, half)}\n...【中间内容已因长度截断】...\n${text.slice(-half)}`;
}

function safeErrorMessage(error, row) {
  if (error?.name === "AbortError") return "豆包三天总结请求超时";
  return sanitizeTextForExternalLlm(error?.message || error || "豆包三天总结调用失败", 500, {
    redactions: collectExternalLlmRedactions(row)
  });
}
