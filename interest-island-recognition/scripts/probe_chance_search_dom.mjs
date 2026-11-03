import { chromium } from "playwright";

const profileDir = process.argv[2];
const targetUrl = process.argv[3] || "https://edu-admin.qlchat.com/saleAssign/chanceAss";
if (!profileDir) throw new Error("missing profile directory");

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  viewport: { width: 1440, height: 960 }
});
try {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  const result = await page.evaluate(() => {
    const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < innerHeight
        && rect.right > 0 && rect.left < innerWidth
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const path = (element) => {
      const parts = [];
      let current = element;
      while (current && current !== document.body && parts.length < 8) {
        const tag = current.tagName.toLowerCase();
        const siblings = current.parentElement ? [...current.parentElement.children].filter((node) => node.tagName === current.tagName) : [];
        const index = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
        const role = current.getAttribute("role");
        parts.unshift(`${tag}${role ? `[role=${role}]` : ""}${index}`);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const meta = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        placeholder: element.getAttribute("placeholder") || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        ariaHaspopup: element.getAttribute("aria-haspopup") || "",
        type: element.getAttribute("type") || "",
        classTokens: [...element.classList].slice(0, 6),
        text: element.tagName === "INPUT" ? "[INPUT_VALUE_REDACTED]" : compact(element.innerText || element.textContent).slice(0, 80),
        rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
        path: path(element)
      };
    };
    const inputs = [...document.querySelectorAll("input")].filter(visible).map(meta);
    const identityMarkers = [...document.querySelectorAll("input, button, [role=combobox], [aria-haspopup=listbox], div, span, label")]
      .filter(visible)
      .filter((element) => compact(element.innerText || element.textContent || element.getAttribute("placeholder") || element.getAttribute("aria-label")) === "用户ID")
      .filter((element, index, all) => !all.some((other, otherIndex) => otherIndex !== index && element.contains(other)))
      .map(meta);
    const queryButtons = [...document.querySelectorAll("button, [role=button]")]
      .filter(visible)
      .filter((element) => compact(element.innerText || element.textContent) === "查询")
      .map(meta);
    return {
      url: `${location.origin}${location.pathname}`,
      title: document.title,
      counts: { inputs: inputs.length, identityMarkers: identityMarkers.length, queryButtons: queryButtons.length },
      identityMarkers,
      queryButtons,
      inputs
    };
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await context.close();
}
