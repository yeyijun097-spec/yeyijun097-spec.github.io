export function isDeterministicDomEmpty(entry = {}) {
  // 当前业务输入均应存在聊天记录。页面显示 0 条只能说明加载、人员名片
  // 或查询归属存在瞬时问题，不能被当成无需重跑的确定性业务结果。
  return false;
}

export function shouldRetryDomRecognition(entry = {}) {
  const hasDomEvidence = entry.contextSource === "dom"
    || Object.prototype.hasOwnProperty.call(entry, "domPersonListRefreshed")
    || Array.isArray(entry.domCandidateAttemptDetails);

  if (!hasDomEvidence) return false;
  if (entry.invalidContext === true) return true;

  if (entry.contextOpened === true) {
    return !(
      entry.domPersonListRefreshed === true
      && entry.domPersonIdentityVerified === true
      && entry.domSelectedPersonVerified === true
      && entry.domConversationUserIdVerified === true
      && entry.domQueryFormVerified === true
      && entry.domQueryResultTerminal === true
      && entry.domRightBubbleVerified === true
    );
  }

  // 未打开右侧上下文的 DOM 行一律进入失败集合。尤其是 0 条结果，必须
  // 在全量结束后重新进入页面再跑，避免把页面短暂空态误判为真实无记录。
  return true;
}
