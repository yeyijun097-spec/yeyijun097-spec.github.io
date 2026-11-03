const CATEGORY_HINTS = [
  { third: "体验营退费申请", words: ["退费", "退款", "退钱", "返钱", "不退", "到账", "申请后台介入"] },
  { third: "正式营退费申请", words: ["正式营", "退费", "退款", "退钱", "返钱", "不退", "申请后台介入"] },
  { third: "退费进度", words: ["退费进度", "退款进度", "多久到账", "还没到账", "什么时候退", "加急处理", "没退给我", "退给我", "不给退款", "不给退", "催催", "推诿", "退款已"] },
  { third: "退费时效", words: ["超过", "超时", "七个工作日", "7个工作日", "一直不退", "迟迟不退", "几天了", "好几天"] },
  { third: "身体原因/其他", words: ["没时间", "没有时间", "没时间听课", "没时间学习", "身体", "不适合", "家里有事", "上班", "不想学", "学不成", "放弃学习", "后悔"] },
  { third: "过度骚扰", words: ["骚扰", "别再", "不要再", "再发", "一直发", "天天", "啰嗦", "烦我", "信息太多", "轰炸", "推送", "不要再劝", "别劝"] },
  { third: "回复时效", words: ["不回复", "不回复信息", "不回信息", "没人回", "没人联系", "联系不上", "不理", "回复我的", "没回", "未回复", "没及时回"] },
  { third: "课程咨询", words: ["怎么报名", "课表", "课程时间", "课程介绍", "有效期", "课程资料"] },
  { third: "内容安排", words: ["背景", "白板", "内容安排", "图片", "课件", "不舒服"] },
  { third: "课程节数/内容/老师不符", words: ["内容重复", "广告多", "掺水", "内容错误", "没有用", "学不到", "实际不符"] },
  { third: "课程难度", words: ["太难", "太简单", "学不会", "跟不上", "难度"] },
  { third: "开课时间", words: ["时间太长", "时间太短", "开课时间", "安排不合理", "没有及时开课", "提前拉群", "不安排课", "安排课", "排课", "调班", "改班"] },
  { third: "投诉对象非兴趣岛", words: ["业主投诉", "客户会投诉", "邻居投诉", "家人投诉", "投诉我"] },
  { third: "话题分享", words: ["谢谢", "辛苦", "分享", "很满意", "很好", "玫瑰"] },
  { third: "信任问题", words: ["诈骗", "欺骗", "套路", "虚假宣传", "新闻", "报道", "黑猫", "消协", "12315", "报警", "平台投诉", "投诉电话"] },
  { third: "态度问题", words: ["有病", "态度", "阴阳怪气", "不耐烦", "质问", "敷衍", "冷漠"] },
  { third: "学员称被诱导消费", words: ["诱导", "忽悠", "欺骗消费", "刷单", "托儿", "套路"] },

  // 新版场景分类文档中的明确场景。这里仅放“能区分三级分类”的短语，
  // 避免把通用的“问题/课程/老师”等词当成分类依据。
  { third: "无效会话", words: ["进线不说话", "没说任何问题就离线", "耳机无声", "在线后离线"] },
  { third: "编辑错误", words: ["系统翻译错误", "打错字", "错别字"] },
  { third: "活动信息/问题", words: ["节假日", "特惠活动", "优惠活动", "活动规则", "活动时间"] },
  { third: "群服务咨询", words: ["添加老师", "如何进群", "怎么进群", "进群", "推送没有影响", "信息推送"] },
  { third: "发票咨询", words: ["发票类目", "下载发票", "查看发票", "发票开不了", "发票给不了"] },
  { third: "商城下单咨询", words: ["商城下单", "发货时间", "礼品破损", "物流问题"] },
  { third: "用户反馈", words: ["表扬", "认可平台", "认可兴趣岛", "满意平台"] },
  { third: "改进建议", words: ["课程优化", "流程优化", "功能优化", "服务优化", "建议改进"] },
  { third: "商务合作", words: ["商务合作", "合作咨询", "合作项目"] },
  { third: "APP操作路径繁琐", words: ["操作路径繁琐", "指示不明", "找不到课程", "不会使用互动功能", "注册困难", "登录困难"] },
  { third: "广告过多", words: ["广告过多", "广告太多", "弹窗广告"] },
  { third: "APP 运行问题", words: ["APP闪退", "APP频繁闪退", "APP卡顿", "打开速度慢", "APP无法登录"] },
  { third: "商城运行问题", words: ["商城打不开", "商城卡顿", "商城运行", "商城技术"] },
  { third: "版本问题", words: ["版本未更新", "版本更新", "旧版本"] },
  { third: "曝光券问题", words: ["曝光券", "曝光券未收到", "没有发放曝光券"] },
  { third: "账号绑定", words: ["账号绑定失败", "绑定账号", "个人信息难修改"] },
  { third: "无法打卡/签到", words: ["无法打卡", "不能打卡", "无法签到", "修改作业", "上传图片音频", "下载作业"] },
  { third: "找回课程", words: ["课程丢失", "课程找不到", "账号迁移", "换设备课程丢失"] },
  { third: "视频回放", words: ["视频播放", "视频回放", "播放卡顿", "播放黑屏", "评论异常"] },
  { third: "直播问题", words: ["直播卡顿", "弹幕异常", "直播不同步", "伪直播"] },
  { third: "画面显示", words: ["字体尺寸", "画面尺寸", "清晰度", "没有字幕", "课程标题显示"] },
  { third: "投屏异常", words: ["无法投屏", "投屏异常", "投屏比例", "投屏分辨率"] },
  { third: "第三方链接转载", words: ["危险网站", "风险提示", "不信任链接", "二维码跳转错误", "链接安全隐患"] },
  { third: "购课协议问题", words: ["购课协议", "隐私协议", "未签订协议", "信息用于营销"] },
  { third: "误操作支付", words: ["误触支付", "无故扣费", "扫电宝支付", "扫单车支付", "误充值"] },
  { third: "重复扣费", words: ["重复扣费", "支付多次", "重复购买", "已经购买过"] },
  { third: "优惠券问题", words: ["优惠券", "优惠入口", "显示原价", "优惠券过期"] },
  { third: "引导分期支付", words: ["花呗", "信用卡分期", "借钱", "借贷", "分期付款", "超前消费"] },
  { third: "先垫付后索取", words: ["垫付学费", "垫付后索取", "先帮我付"] },
  { third: "先定金后尾款", words: ["定金", "尾款", "先付定金"] },
  { third: "开课前流程繁琐", words: ["下载多个APP", "加多个群", "加多个老师", "开课前操作复杂"] },
  { third: "课程时长", words: ["课程时长", "服务周期", "不满服务周期", "课程太长", "课程太短"] },
  { third: "排课冲突（真实存在）", words: ["排课冲突", "课程冲突", "时间冲突"] },
  { third: "服务周期", words: ["服务周期", "售后时间", "服务期限"] },
  { third: "未达宣传效果", words: ["没有效果", "未达效果", "包治百病", "保底收益", "包就业", "必成助教"] },
  { third: "智能直播", words: ["宣传是直播实际是录播", "伪直播", "录播冒充直播"] },
  { third: "虚构资质", words: ["虚构师资", "虚假背景", "教育部认证", "权威机构推荐", "冒用官方资质"] },
  { third: "虚假/隐瞒优惠政策", words: ["隐瞒优惠", "虚假优惠", "额外购买高阶课", "承诺礼品未给"] },
  { third: "物流问题", words: ["发货不及时", "物流不显示", "漏发", "到货破损", "海外件"] },
  { third: "质量问题", words: ["教具质量", "质量差", "物料不符", "礼品质量"] },
  { third: "滥用职权", words: ["取消有效期", "恶意取消", "听课权限"] },
  { third: "老师账号异常", words: ["老师离职", "二维码识别不了", "联系不上老师"] },
  { third: "学员添加率问题", words: ["不会添加老师", "老师不会主动添加", "添加老师失败"] },
  { third: "专业水平差", words: ["老师不专业", "专业能力差", "督学频次", "沟通能力不专业"] },
  { third: "被移除/解散社群", words: ["被移出群", "被移除", "解散社群", "再次进群"] },
  { third: "个性化服务", words: ["一对一服务", "保留班级群", "结营以后答疑", "安排二次学习", "社群人数过多"] },
  { third: "积分权益", words: ["积分权益", "学分兑换", "积分兑换", "礼品兑换"] },
  { third: "延期/换班/换课权益", words: ["延期", "换班", "换课", "只能延期一次"] },
  { third: "转介绍服务", words: ["转介绍", "佣金无法提现", "佣金错误"] },
  { third: "手续费", words: ["手续费", "扣手续费", "退款扣费"] },
  { third: "课时费", words: ["课时费", "扣费节数", "课程节数与扣费"] },
  { third: "礼品费", words: ["礼品费", "教具定价", "礼品费用"] },
  { third: "已结营已观看/已结营未观看", words: ["已结营", "已观看", "结营未观看", "超售后时间"] },
  { third: "无社群服务已超售后时间", words: ["无社群服务", "超售后时间"] },
  { third: "家人反对", words: ["家人反对", "家人不同意", "家里人不支持"] }
];

export function classify({
  row,
  contextText,
  rules,
  contextOpened = false,
  includeOriginalMessageEvidence = false
}) {
  const rawMessageText = normalize(row.message || "");
  const context = normalize(contextText || "");
  const metadata = normalize(`${row.docProductType || ""} ${row.docCampName || ""}`);
  // 右侧上下文优先，但明确写在 K 列里的用户诉求不能在打开上下文后丢失。
  // 这对“你敢再发，我就投诉”这类短句尤其重要。
  const messageText = contextOpened && !includeOriginalMessageEvidence ? "" : rawMessageText;
  const text = normalize(contextOpened && context ? context : `${rawMessageText}\n${context}`);
  const scored = [];

  // “准备联系消协，具体情况以后再说”只表达了将来可能投诉，尚未给出任何
  // 可归类的争议事实。若其余上下文只是日常安排，不应被“消协”单词推成其他类。
  if (contextOpened && isDeferredComplaintMentionWithoutIssue(text)) {
    const noRiskRule = findRule(rules, "无风险", "无风险", "话题分享");
    if (noRiskRule) {
      return {
        rowNumber: row.rowNumber,
        firstCategory: noRiskRule.firstCategory,
        secondCategory: noRiskRule.secondCategory,
        thirdCategory: noRiskRule.thirdCategory,
        confidence: 0.95,
        reason: "仅提及后续可能投诉，未说明具体争议事项；当前上下文属于日常沟通",
        needsReview: false
      };
    }
  }

  // 投诉词必须先确认对象。完整上下文明确指向家用 WiFi、宽带安装、运营商
  // 等第三方服务时，不能再由“投诉”二字进入平台服务争议分类。
  if (contextOpened && isNonPlatformComplaint(text)) {
    const noRiskRule = findRule(rules, "无风险", "无风险", "投诉对象非兴趣岛");
    if (noRiskRule) {
      return {
        rowNumber: row.rowNumber,
        firstCategory: noRiskRule.firstCategory,
        secondCategory: noRiskRule.secondCategory,
        thirdCategory: noRiskRule.thirdCategory,
        confidence: 0.95,
        reason: "完整上下文表明投诉对象为 WiFi、宽带或其他非兴趣岛主体",
        needsReview: false
      };
    }
  }

  // 打开右侧上下文后仍要保留 K 列中的明确用户诉求，避免“你敢再发，我就投诉”
  // 被较短的右侧日常文本覆盖成话题分享。只有没有原始诉求证据时，才走日常聊天捷径。
  if (contextOpened && !includeOriginalMessageEvidence && isNeutralDailyChat(text)) {
    const noRiskRule = findRule(rules, "无风险", "无风险", "话题分享");
    if (noRiskRule) {
      return {
        rowNumber: row.rowNumber,
        firstCategory: noRiskRule.firstCategory,
        secondCategory: noRiskRule.secondCategory,
        thirdCategory: noRiskRule.thirdCategory,
        confidence: 0.9,
        reason: "右侧上下文为日常聊天，未识别到具体投诉/退费/服务争议",
        needsReview: false
      };
    }
  }

  for (const rule of rules) {
    const score = scoreRule(rule, { messageText, contextText: context, text, metadata });
    if (score > 0) scored.push({ rule, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (!best || best.score < 4 || isVagueComplaintWithoutIssue(rawMessageText, text)) {
    return {
      rowNumber: row.rowNumber,
      firstCategory: "",
      secondCategory: "",
      thirdCategory: "",
      confidence: 0,
      reason: isVagueComplaintWithoutIssue(rawMessageText, text) ? "仅识别到投诉/报警意图，未识别到具体问题原因" : "未命中新版场景分类中的明确规则",
      needsReview: true
    };
  }

  const confidence = Math.min(0.95, 0.45 + best.score / 20);
  return {
    rowNumber: row.rowNumber,
    firstCategory: best.rule.firstCategory,
    secondCategory: best.rule.secondCategory,
    thirdCategory: best.rule.thirdCategory,
    confidence: Number(confidence.toFixed(2)),
    reason: best.rule.scene ? `命中场景：${best.rule.scene.slice(0, 80)}` : "命中分类关键词",
    needsReview: confidence <= 0.6
  };
}

function scoreRule(rule, parts) {
  let score = 0;
  const { messageText, contextText, text, metadata = "" } = parts;
  const ruleText = normalize(`${rule.dimension} ${rule.firstCategory} ${rule.secondCategory} ${rule.thirdCategory} ${rule.scene} ${rule.examples || ""}`);
  const tokens = keywords(ruleText);

  for (const token of tokens) {
    if (token.length < 2) continue;
    const base = token.length >= 4 ? 2 : 1;
    if (messageText.includes(token)) score += base * 2;
    if (contextText.includes(token)) score += base;
  }

  for (const hint of CATEGORY_HINTS) {
    if (rule.thirdCategory === hint.third || rule.secondCategory === hint.third) {
      for (const word of hint.words) {
        if (messageText.includes(word)) score += 8;
        else if (contextText.includes(word)) score += 4;
      }
    }
  }

  // 退费申请在文档中按“体验营/正式营”拆成两个三级分类。
  // 订单字段比聊天中的“营”字更可靠，优先用于消除二者的并列得分。
  if (rule.thirdCategory === "体验营退费申请" && /体验营/.test(metadata) && /退费|退款|退钱|返钱|不退/.test(text)) {
    score += 14;
  }
  if (rule.thirdCategory === "正式营退费申请" && /正式营/.test(metadata) && /退费|退款|退钱|返钱|不退/.test(text)) {
    score += 14;
  }
  if (rule.thirdCategory === "体验营退费申请" && /正式营/.test(metadata)) score -= 10;
  if (rule.thirdCategory === "正式营退费申请" && /体验营/.test(metadata)) score -= 10;

  score += scoreComplaintContext(rule, messageText, contextText, text);

  if (rule.firstCategory === "无风险" && hasComplaintIntent(text)) score -= 6;
  if (rule.firstCategory !== "无风险" && isNonPlatformComplaint(text)) score -= 4;
  if (rule.thirdCategory === "投诉对象非兴趣岛" && isNonPlatformComplaint(text)) score += 8;
  if (rule.thirdCategory === "话题分享" && !hasComplaintIntent(text)) score += 2;

  return score;
}

function scoreComplaintContext(rule, messageText, contextText, text) {
  if (!hasComplaintIntent(text)) return 0;

  let score = 0;
  const target = messageText || text;
  const combined = text;

  if (rule.thirdCategory === "回复时效" && /(不回复|不回|没人回|没回|不理|联系不上|没及时回)/.test(combined)) score += 10;
  if (rule.thirdCategory === "过度骚扰" && /(骚扰|别再|不要再|再发|一直发|天天|推送|不要再劝|别劝)/.test(combined)) score += 10;
  if (rule.thirdCategory === "过度骚扰" && /敢再发.{0,8}(?:就|否则|不然)?投诉|再发.{0,8}(?:就|否则|不然)?投诉/.test(messageText)) score += 12;
  if (rule.thirdCategory === "退费进度" && /(退费|退款|退钱|退给我|返钱|不退|没退|不给退|推诿|催催)/.test(combined)) score += 10;
  if (rule.thirdCategory === "退费时效" && /(超过|超时|七个工作日|7个工作日|几天|迟迟|一直不退)/.test(combined)) score += 8;
  if (rule.thirdCategory === "身体原因/其他" && /(没时间|没有时间|没时间听课|没时间学习|不想学|学不成|放弃学习|身体)/.test(target)) score += 10;
  if (rule.thirdCategory === "开课时间" && /(不安排课|没有及时开课|开课|排课|调班|改班|安排进)/.test(target)) score += 10;
  if (rule.thirdCategory === "态度问题" && /(有病|态度|质问|敷衍|冷漠|不耐烦|骂)/.test(combined)) score += 8;
  if (rule.thirdCategory === "信任问题" && /(报警|12315|消协|黑猫|平台投诉|投诉电话|诈骗|欺骗|套路|正规)/.test(combined)) score += 6;

  if (rule.thirdCategory === "身体原因/其他" && /(不回复|不回|没人回|联系不上)/.test(target)) score -= 8;
  if (rule.thirdCategory === "回复时效" && /(没时间听课|没时间学习|学不成|放弃学习)/.test(target)) score -= 5;

  return score;
}

export function attachHistoricalExamples(rules, rows) {
  const ruleByKey = new Map(rules.map((rule) => [ruleKey(rule), { ...rule, examples: "" }]));
  const examples = new Map();

  for (const row of rows) {
    const existing = row.existing || {};
    const key = [existing.U, existing.V, existing.W].join("\u0001");
    if (!ruleByKey.has(key) || !row.message) continue;
    const bucket = examples.get(key) || [];
    if (bucket.length < 80) bucket.push(row.message);
    examples.set(key, bucket);
  }

  return [...ruleByKey.values()].map((rule) => {
    const sampleText = (examples.get(ruleKey(rule)) || []).join(" ");
    return { ...rule, examples: pickUsefulTerms(sampleText).join(" ") };
  });
}

function ruleKey(rule) {
  return [rule.firstCategory, rule.secondCategory, rule.thirdCategory].join("\u0001");
}

function findRule(rules, firstCategory, secondCategory, thirdCategory) {
  return rules.find((rule) =>
    rule.firstCategory === firstCategory &&
    rule.secondCategory === secondCategory &&
    rule.thirdCategory === thirdCategory
  );
}

function pickUsefulTerms(text) {
  const stopWords = new Set(["老师", "学员", "你们", "我们", "这个", "那个", "就是", "没有", "已经", "可以", "不是", "什么", "一下"]);
  const counts = new Map();
  for (const token of keywords(text)) {
    if (token.length < 2 || stopWords.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([token]) => token);
}

function hasComplaintIntent(text) {
  return /(投诉|举报|报警|退费|退款|退钱|12315|黑猫|消协|维权|诈骗|骚扰)/.test(text);
}

function isNeutralDailyChat(text) {
  if (!/(报表|工作|上班|忙|比较忙|出差|加班|干活|弄报表|今天也可能|今天就是|家里人|看电视)/.test(text)) return false;
  if (hasConcreteDispute(text)) return false;
  return true;
}

function hasConcreteDispute(text) {
  return /(我投诉你|我要投诉|我就投诉|去投诉|平台投诉|投诉电话|报警|举报|退费|退款|退钱|返钱|不退|退不了|到账|没退|不给退|课程不安排|不安排课|不回复|不回信息|没人回|联系不上|骚扰|删不掉|诱导|分期|扣费|手续费|发票|物流|教具|破损|质量差|态度差|有病|虚假|欺骗|套路|黑猫|12315|消协)/.test(text);
}

function isDeferredComplaintMentionWithoutIssue(text) {
  const hasDeferredIntent =
    /(?:消协|12315|投诉|举报|维权)/.test(text) &&
    /(?:还没|尚未|准备|打算|以后|后面|之后|有空).{0,16}(?:打|联系|投诉|说|再说)|详情.{0,8}(?:以后|后面|之后|再说)/.test(text);
  if (!hasDeferredIntent) return false;
  const concreteIssue = /(?:退费|退款|退钱|返钱|不退|未退|扣费|收费|分期|诱导|虚假|欺骗|套路|骚扰|不回复|不回信息|没人回|联系不上|态度差|辱骂|课程.{0,8}(?:不安排|无法|打不开|问题|不符)|开课.{0,6}(?:延迟|不安排)|排课.{0,6}(?:冲突|不安排)|直播.{0,6}(?:卡顿|录播|问题)|物流|未发货|破损|质量差|教具|发票|账号异常|被移出群|解散社群)/.test(text);
  return !concreteIssue;
}

function isVagueComplaintWithoutIssue(messageText, text) {
  if (!/(投诉|举报|报警|12315|黑猫|消协|维权|投诉电话|平台投诉)/.test(messageText)) return false;
  if (isNonPlatformComplaint(text)) return false;
  return !hasSpecificIssue(text);
}

function hasSpecificIssue(text) {
  return /(退费|退款|退钱|返钱|不退|退不了|到账|没退|不给退|课程|开课|排课|调班|没时间|不想学|学不成|放弃学习|不回复|不回|没人回|联系不上|不理|骚扰|别再|不要再|再发|推送|删不掉|删除|物流|教具|发货|破损|质量|态度|有病|敷衍|冷漠|诱导|分期|付款|扣费|手续费|发票|加群|进群|老师|二维码|有效期|回放|直播|录播|投屏|图片|背景|电视|虚假|欺骗|套路|广告|积分|延期|换班|换课)/.test(text);
}

export function isNonPlatformComplaint(text) {
  const normalized = normalize(text);
  const existingThirdPartyTarget = /(业主|客户|邻居|家人|朋友|同事|物业).{0,12}投诉|投诉(我|客户|邻居|业主|物业)|投诉.{0,6}(我的|客户|邻居|业主|物业)/.test(normalized);
  if (existingThirdPartyTarget) return true;

  if (!/(投诉|举报|报修)/.test(normalized)) return false;
  const connectivityTarget = /(?:家里|家中|住处|小区|宿舍|这个地方|破地方|安装).{0,18}(?:wifi|wi-fi|无线网|宽带|网络|路由器)|(?:wifi|wi-fi|无线网|宽带|路由器).{0,18}(?:安装|维修|报修|没来|运营商|物业|师傅)/i.test(normalized);
  if (!connectivityTarget) return false;

  // 仅在没有明确兴趣岛业务对象时采用第三方降级。老师的日常回应不属于
  // 平台对象证据，因此不把单独的“老师”作为反向条件。
  const platformTarget = /(?:兴趣岛|体验营|正式营|课程|订单|学费|报名|退费|退款|客服|平台).{0,12}(?:投诉|举报)|(?:投诉|举报).{0,12}(?:兴趣岛|体验营|正式营|课程|订单|客服|平台)/.test(normalized);
  return !platformTarget;
}

function keywords(value) {
  return normalize(value)
    .split(/[\s,，、。；;：:（）()【】\[\]\/\\|"'“”‘’!?！？\d]+/)
    .filter(Boolean)
    .filter((word) => word.length >= 2 && !["以下分类未包含场景", "业务跟进"].includes(word));
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
