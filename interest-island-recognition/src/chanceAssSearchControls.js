/**
 * 从已经按 DOM 祖先归属的候选控件中选择机会管理的身份查询控件。
 *
 * 这里故意不使用页面顺序、水平坐标或 `.first()`：FineBI 同屏会渲染大量
 * 无关输入框，只有“稳定占位符 + 同一查询容器”的组合才可以写入用户 ID。
 */
export function resolveChanceSearchControls(candidates = []) {
  const visibleCandidates = candidates.filter((candidate) => candidate && candidate.visible !== false);
  // 线上历史可用结构为 Element UI 的“前置下拉 + 多选输入”输入组。
  // 当它与 FineBI 其它泛化筛选控件同时出现时，不能因候选不止一个而把
  // 已验证的稳定路径一起拒绝；稳定路径只在自身唯一时被采用。
  const stableCandidates = visibleCandidates.filter((candidate) => candidate.stable === true);
  const usable = stableCandidates.length ? stableCandidates : visibleCandidates;
  const byContainer = new Map();
  for (const candidate of usable) {
    if (!candidate.containerId) continue;
    const bucket = byContainer.get(candidate.containerId) || [];
    bucket.push(candidate);
    byContainer.set(candidate.containerId, bucket);
  }

  const matches = [];
  for (const [containerId, items] of byContainer.entries()) {
    // FineBI 重绘时，历史身份输入框偶发丢失 placeholder；此时只能接受
    // DOM 读取器已经在同一 Element UI 身份输入组上标记过的输入框。
    // 不能把任意空 placeholder 输入框当成用户 ID，以免在 49 个可见输入框中误填。
    const inputs = items.filter((item) => item.kind === "input"
      && !item.disabled && !item.readOnly
      && (/可用逗号分隔多选/.test(String(item.placeholder || "")) || item.identityInput === true));
    const queries = items.filter((item) => item.kind === "button" && String(item.text || "").trim() === "查询");
    if (inputs.length !== 1 || queries.length !== 1) continue;
    const modes = items.filter((item) => ["combobox", "select"].includes(item.kind));
    const selected = modes.find((item) => String(item.selectedText || item.text || "").trim());
    // 输入组包装层或页面上的静态“用户ID”文字不能代替真实下拉控件。
    // 没有可操作的模式控件时，后续无法可靠验证用户ID模式，宁可局部失败。
    if (!selected?.id) continue;
    matches.push({
      containerId,
      inputId: inputs[0].id,
      modeId: selected?.id || null,
      queryId: queries[0].id,
      modeText: String(selected?.selectedText || selected?.text || "").trim(),
    });
  }

  return matches.length === 1 ? matches[0] : null;
}
