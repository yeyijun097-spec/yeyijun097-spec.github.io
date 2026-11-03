import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const WEB_CONFIRM_PREFIX = "WEB_LOGIN_CONFIRM=";
const WECOM_LOGIN_HOST = "login.work.weixin.qq.com";
const WECOM_LOGO_SELECTOR = ".el-image:has(img.el-image__inner)";

export async function waitForInteractiveLogin({
  kind,
  label,
  page,
  targetUrl,
  isReady,
  timeoutMs = 300000,
  pollMs = 1000,
  // 登录确认后给业务页足够时间重新加载。chanceAss 页面数据量较大，
  // 20 秒内可能仍在首屏渲染，过早重开二维码会让一次扫码变成循环扫码。
  verificationTimeoutMs = 60000
}) {
  const webMode = process.env.WEB_PIPELINE_MODE === "1";
  const overallDeadline = Date.now() + timeoutMs;

  while (Date.now() < overallDeadline) {
    const token = createToken();
    let loginPage = page;
    if (webMode && page) {
      loginPage = await prepareInteractiveLoginPage(page).catch((error) => {
        console.warn(`网页登录页自动准备未完成，将展示当前页面供人工处理：${error.message}`);
        return page;
      });
      await writeLoginScreenshot(loginPage);
    }

    console.log(`WEB_LOGIN_REQUIRED=${kind}:${token}`);
    console.log(webMode
      ? `${label} 登录态失效，请在网页扫码/验证完成后点击确认继续。`
      : `${label} 登录态失效，请在打开的浏览器完成扫码/验证，完成后回到终端按回车继续...`);

    await loginPage?.bringToFront?.().catch(() => {});
    const stopScreenshotRefresh = webMode
      ? startLoginScreenshotRefresh(() => resolveLoginDisplayPage(loginPage, page))
      : () => {};
    try {
      await waitForConfirmation({
        token,
        webMode,
        timeoutMs: Math.max(1000, overallDeadline - Date.now())
      });
    } finally {
      stopScreenshotRefresh();
    }

    const ready = await waitForLoginReadiness({
      page,
      targetUrl,
      isReady,
      timeoutMs: Math.min(verificationTimeoutMs, Math.max(1000, overallDeadline - Date.now())),
      pollMs
    });
    if (ready) {
      console.log(`WEB_LOGIN_READY=${kind}:${token}`);
      return { ready: true, waitedForLogin: true };
    }

    if (Date.now() < overallDeadline) {
      console.warn(`${label} 确认后 ${Math.round(verificationTimeoutMs / 1000)} 秒内仍未检测到登录完成，将重新显示二维码。`);
    }
  }
  return { ready: false, waitedForLogin: true };
}

export async function waitForLoginReadiness({ page, targetUrl, isReady, timeoutMs = 20000, pollMs = 1000 }) {
  // 扫码确认后先检查当前页；部分登录流程会直接把原业务页恢复为已登录，
  // 此时不应再次导航导致页面状态被重置。
  if (await isReady().catch(() => false)) return true;
  if (targetUrl) {
    await page?.goto?.(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page?.waitForTimeout?.(1000).catch(() => {});
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page?.waitForTimeout?.(500).catch(() => {});
    if (await isReady()) return true;
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  return false;
}

async function prepareInteractiveLoginPage(page) {
  const context = page.context?.();
  const existingQrPage = findOfficialWeComPage(context?.pages?.() || []);
  if (existingQrPage) {
    await waitForOfficialWeComQr(existingQrPage);
    return existingQrPage;
  }

  await page.waitForLoadState?.("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout?.(1200).catch(() => {});
  if (safeHost(page.url?.()) === WECOM_LOGIN_HOST) {
    await waitForOfficialWeComQr(page);
    return page;
  }

  const checkbox = page.locator?.("input.el-checkbox__original[type='checkbox']")?.first?.();
  const checkboxFound = await checkbox?.count?.().catch(() => 0) || 0;
  const logoFound = await visibleWeComLogo(page);
  if (!checkboxFound || !logoFound) return page;

  if (!await checkbox.isChecked().catch(() => false)) {
    await clickWeComLoginLogo(page);

    const redirected = await waitForOfficialWeComPage(context, page, 2500);
    if (redirected) {
      await waitForOfficialWeComQr(redirected);
      return redirected;
    }

    const agreement = page.locator("button.agree-button").filter({ hasText: "同意协议" }).first();
    await agreement.waitFor({ state: "visible", timeout: 7000 }).catch(() => {});
    if (!await agreement.isVisible().catch(() => false)) return page;

    await waitForEnabledAgreement(agreement, 15000);
    await agreement.click({ timeout: 5000 });
    await page.waitForFunction(() => {
      const input = document.querySelector("input.el-checkbox__original[type='checkbox']");
      return Boolean(input?.checked);
    }, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500).catch(() => {});
  }

  await clickWeComLoginLogo(page);
  let qrPage = await waitForOfficialWeComPage(context, page, 10000);
  if (!qrPage) {
    await clickWeComLoginLogo(page).catch(() => {});
    qrPage = await waitForOfficialWeComPage(context, page, 12000);
  }
  if (!qrPage) return page;
  await waitForOfficialWeComQr(qrPage);
  return qrPage;
}

function startLoginScreenshotRefresh(resolvePage) {
  const seconds = Number(process.env.PIPELINE_LOGIN_SCREENSHOT_INTERVAL || 2);
  const intervalMs = Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 2000);
  let stopped = false;
  let writing = false;

  const refresh = async () => {
    if (stopped || writing) return;
    writing = true;
    try {
      await writeLoginScreenshot(resolvePage());
    } finally {
      writing = false;
    }
  };
  const timer = setInterval(refresh, intervalMs);
  timer.unref?.();
  refresh();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function writeLoginScreenshot(page) {
  const screenshotPath = String(process.env.PIPELINE_LOGIN_SCREENSHOT || "").trim();
  if (!screenshotPath || !page || page.isClosed?.()) return false;
  const absolutePath = path.resolve(screenshotPath);
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const image = await page.screenshot({ type: "png", fullPage: false });
    await fs.writeFile(temporaryPath, image);
    await fs.rename(temporaryPath, absolutePath);
    return true;
  } catch {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    return false;
  }
}

function resolveLoginDisplayPage(preferredPage, originalPage) {
  const pages = originalPage?.context?.()?.pages?.() || [];
  return findOfficialWeComPage(pages)
    || (preferredPage && !preferredPage.isClosed?.() ? preferredPage : null)
    || (originalPage && !originalPage.isClosed?.() ? originalPage : null);
}

function findOfficialWeComPage(pages) {
  return [...pages].reverse().find((candidate) => {
    return !candidate.isClosed?.() && safeHost(candidate.url?.()) === WECOM_LOGIN_HOST;
  }) || null;
}

async function visibleWeComLogo(page) {
  const logos = page.locator(WECOM_LOGO_SELECTOR);
  const count = await logos.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await logos.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function clickWeComLoginLogo(page) {
  const logos = page.locator(WECOM_LOGO_SELECTOR);
  const count = await logos.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const logo = logos.nth(index);
    if (!await logo.isVisible().catch(() => false)) continue;
    await logo.click({ timeout: 5000 });
    return true;
  }
  throw new Error("兴趣岛登录页未找到可见的企业微信登录入口");
}

async function waitForEnabledAgreement(button, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await button.evaluate((element) => ({
      text: String(element.textContent || "").replace(/\s+/g, "").trim(),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      disabledClass: element.classList.contains("is-disabled")
    })).catch(() => null);
    if (state?.text === "同意协议" && !state.disabled && !state.disabledClass) return;
    await sleep(200);
  }
  throw new Error("《重要提示》倒计时结束后，同意协议按钮仍不可点击");
}

async function waitForOfficialWeComPage(context, currentPage, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!currentPage.isClosed?.() && safeHost(currentPage.url?.()) === WECOM_LOGIN_HOST) return currentPage;
    const popup = findOfficialWeComPage(context?.pages?.() || []);
    if (popup) return popup;
    await sleep(150);
  }
  return null;
}

async function waitForOfficialWeComQr(page) {
  await page.waitForLoadState?.("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout?.(5000).catch(() => {});
  return safeHost(page.url?.()) === WECOM_LOGIN_HOST;
}

function safeHost(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function waitForConfirmation({ token, webMode, timeoutMs }) {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("LOGIN_CONFIRM_TIMEOUT")), timeoutMs);
        timeoutId.unref?.();
      });
      let line;
      try {
        line = await Promise.race([rl.question(""), timeout]);
      } finally {
        clearTimeout(timeoutId);
      }
      const text = String(line || "").trim();
      if (!webMode && !text) return;
      if (text === `${WEB_CONFIRM_PREFIX}${token}`) return;
      if (!webMode && text.startsWith(WEB_CONFIRM_PREFIX)) return;
    }
  } finally {
    rl.close();
  }
}

function createToken() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
