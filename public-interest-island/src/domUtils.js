export function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function compactText(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

export function includesLoose(text, keyword) {
  const target = compactText(keyword);
  if (!target) return false;
  return compactText(text).includes(target);
}

export async function clickButtonByText(page, text) {
  const candidates = [
    page.getByRole("button", { name: text }).first(),
    page.locator(`button:has-text("${text}")`).first(),
    page.locator(`text=${text}`).first()
  ];

  for (const locator of candidates) {
    if (await locator.isVisible({ timeout: 800 }).catch(() => false)) {
      await locator.click().catch(async () => locator.click({ force: true }));
      return true;
    }
  }
  return false;
}

export async function fillInputNearLabel(page, labels, value) {
  if (!value) return false;
  const point = await page.evaluate((labelTexts) => {
    const normalize = (item) => String(item || "").replace(/\s+/g, "").trim().toLowerCase();
    const wanted = labelTexts.map(normalize).filter(Boolean);
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 6 && rect.height > 6 && rect.bottom > 0 && rect.top < window.innerHeight
        && style.display !== "none" && style.visibility !== "hidden";
    };

    const labels = [...document.body.querySelectorAll("label, span, div, th")]
      .filter(visible)
      .map((el) => ({
        el,
        rect: el.getBoundingClientRect(),
        text: normalize(el.innerText || el.textContent || "")
      }))
      .filter((item) => wanted.some((label) => item.text === label || item.text.includes(label)));

    const inputs = [...document.body.querySelectorAll("input, textarea")]
      .filter(visible)
      .filter((el) => !el.disabled && !el.readOnly)
      .map((el) => ({
        el,
        rect: el.getBoundingClientRect(),
        placeholder: normalize(el.getAttribute("placeholder") || ""),
        value: normalize(el.value || "")
      }));

    const ranked = [];
    for (const label of labels) {
      const labelY = label.rect.top + label.rect.height / 2;
      for (const input of inputs) {
        const inputY = input.rect.top + input.rect.height / 2;
        const sameRow = Math.abs(inputY - labelY);
        const below = input.rect.top >= label.rect.top && input.rect.top - label.rect.bottom < 90;
        const toRight = input.rect.left >= label.rect.left - 10;
        if (sameRow > 46 && !below) continue;
        ranked.push({
          x: input.rect.left + input.rect.width / 2,
          y: input.rect.top + input.rect.height / 2,
          score: Math.abs(input.rect.left - label.rect.right) + sameRow * 3 + (toRight ? 0 : 300)
        });
      }
    }

    const placeholderMatched = inputs
      .filter((input) => wanted.some((label) => input.placeholder.includes(label)))
      .map((input) => ({
        x: input.rect.left + input.rect.width / 2,
        y: input.rect.top + input.rect.height / 2,
        score: 50
      }));

    return [...ranked, ...placeholderMatched].sort((a, b) => a.score - b.score)[0] || null;
  }, labels).catch(() => null);

  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(String(value), { delay: 8 }).catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});
  return true;
}

export async function readLabelValuePairs(page) {
  return await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const pairs = [];

    for (const row of [...document.querySelectorAll("tr")]) {
      const cells = [...row.querySelectorAll("th,td")].map((cell) => normalize(cell.innerText || cell.textContent)).filter(Boolean);
      if (cells.length >= 2) {
        for (let i = 0; i < cells.length - 1; i += 2) {
          pairs.push({ label: cells[i], value: cells[i + 1], source: "table" });
        }
      }
    }

    for (const item of [...document.querySelectorAll(".ant-descriptions-item, .el-descriptions__cell, .el-form-item, .form-item")]) {
      const text = normalize(item.innerText || item.textContent);
      if (!text) continue;
      const label = normalize(item.querySelector("label, .ant-descriptions-item-label, .el-descriptions__label")?.innerText || "");
      const content = normalize(item.querySelector(".ant-descriptions-item-content, .el-descriptions__content, input, textarea")?.value || item.querySelector(".ant-descriptions-item-content, .el-descriptions__content")?.innerText || "");
      if (label && content) pairs.push({ label, value: content, source: "description" });
      else if (/[:：]/.test(text)) {
        const [left, ...rest] = text.split(/[:：]/);
        if (left && rest.length) pairs.push({ label: normalize(left), value: normalize(rest.join("：")), source: "text" });
      }
    }

    return pairs.filter((pair) => pair.label && pair.value).slice(0, 300);
  }).catch(() => []);
}

export async function findVisibleText(page, maxChars = 4000) {
  const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  return cleanText(text).slice(0, maxChars);
}

export function pickValue(pairs, labels) {
  const wanted = labels.map(compactText).filter(Boolean);
  const scored = [];
  for (const pair of pairs) {
    const label = compactText(pair.label);
    for (const wantedLabel of wanted) {
      if (label === wantedLabel || label.includes(wantedLabel) || wantedLabel.includes(label)) {
        scored.push({ ...pair, score: label === wantedLabel ? 0 : Math.abs(label.length - wantedLabel.length) + 1 });
      }
    }
  }
  return scored.sort((a, b) => a.score - b.score)[0]?.value || "";
}

export function extractRowContaining(text, keyword) {
  const target = compactText(keyword);
  if (!target) return "";
  const lines = String(text || "").split(/\r?\n/).map(cleanText).filter(Boolean);
  return lines.find((line) => compactText(line).includes(target)) || "";
}
