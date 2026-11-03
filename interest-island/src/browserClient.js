import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

export class BrowserClient {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.page = null;
    this.launching = null;
    this.activeUserId = null;
    this.profileRoot = path.resolve(config.browser.profileRoot || ".browser-profiles");
    fs.mkdirSync(this.profileRoot, { recursive: true, mode: 0o700 });
  }

  async activateUser(userId) {
    const normalized = normalizeUserId(userId);
    if (this.activeUserId === normalized && this.context && await this.isContextUsable()) {
      return;
    }
    await this.closeContext();
    this.activeUserId = normalized;
  }

  async ensurePage(url = this.config.browser.dashboardUrl, options = {}) {
    if (!this.activeUserId) throw new Error("尚未选择网站用户的浏览器登录态");
    const { navigateExisting = true } = options;
    if (this.context && !await this.isContextUsable()) {
      this.context = null;
      this.page = null;
    }
    if (this.page && !this.page.isClosed()) {
      if (navigateExisting) {
        await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch((error) => {
          if (!isTargetClosedError(error)) return;
          this.context = null;
          this.page = null;
        });
        await this.closeForeignPages(url);
      }
      if (this.page && !this.page.isClosed()) return this.page;
    }
    if (this.context && await this.isContextUsable()) {
      try {
        await this.installNavigationGuards();
        await this.closeForeignPages(url);
        this.page = pickBestPage(this.context.pages(), url) || await this.context.newPage();
        this.page.setDefaultTimeout(this.config.browser.timeoutMs || 30000);
        if (navigateExisting || this.page.url() === "about:blank") {
          await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch((error) => {
            if (isTargetClosedError(error)) throw error;
          });
          await this.closeForeignPages(url);
        }
        return this.page;
      } catch (error) {
        if (!isTargetClosedError(error)) throw error;
        this.context = null;
        this.page = null;
      }
    }
    if (this.launching) return this.launching;

    this.launching = this.launch(url).finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  getExistingPage() {
    if (this.page && !this.page.isClosed() && isAllowedAutomationUrl(this.page.url(), this.config.browser.dashboardUrl)) return this.page;
    if (this.page && !this.page.isClosed() && isBlockedUrl(this.page.url())) {
      this.page.close().catch(() => {});
      this.page = null;
    }
    const page = pickBestPage(this.context?.pages?.() || [], this.config.browser.dashboardUrl);
    if (page) {
      this.page = page;
      this.page.setDefaultTimeout(this.config.browser.timeoutMs || 30000);
    }
    return page;
  }

  async reset(url = this.config.browser.dashboardUrl) {
    if (!this.activeUserId) throw new Error("尚未选择网站用户的浏览器登录态");
    await this.closeContext({ preserveUser: true });
    this.launching = null;
    return this.ensurePage(url);
  }

  async isContextUsable() {
    if (!this.context) return false;
    try {
      const pages = this.context.pages();
      const page = pages.find((item) => !item.isClosed());
      if (page) await page.evaluate(() => true);
      return true;
    } catch (error) {
      if (isTargetClosedError(error)) return false;
      return false;
    }
  }

  async launch(url) {
    const browser = this.config.browser;
    const profilePath = this.getProfilePath(this.activeUserId);
    fs.mkdirSync(profilePath, { recursive: true, mode: 0o700 });
    this.context = await chromium.launchPersistentContext(profilePath, {
      headless: Boolean(browser.headless),
      viewport: browser.viewport || { width: 1440, height: 960 }
    });
    await this.installNavigationGuards();
    await this.closeForeignPages(url);
    this.page = pickBestPage(this.context.pages(), url) || await this.context.newPage();
    this.page.setDefaultTimeout(browser.timeoutMs || 30000);
    await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.closeForeignPages(url);
    return this.page;
  }

  async newPage(url) {
    await this.ensurePage();
    let page;
    try {
      page = await this.context.newPage();
    } catch (error) {
      if (!isTargetClosedError(error)) throw error;
      await this.reset(url);
      page = await this.context.newPage();
    }
    page.setDefaultTimeout(this.config.browser.timeoutMs || 30000);
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.closeForeignPages(url);
    return page;
  }

  async withIsolatedPage(url, task) {
    if (!this.activeUserId) throw new Error("尚未选择网站用户的浏览器登录态");
    await this.ensurePage(this.config.browser.dashboardUrl, { navigateExisting: false });

    let taskPage;
    try {
      taskPage = await this.context.newPage();
    } catch (error) {
      if (!isTargetClosedError(error)) throw error;
      await this.reset(this.config.browser.dashboardUrl);
      taskPage = await this.context.newPage();
    }

    taskPage.setDefaultTimeout(this.config.browser.timeoutMs || 30000);
    await taskPage.goto(url, { waitUntil: "domcontentloaded" });
    // 全部查询会先长时间停留在机会/学员档案页，再创建独立投诉页。
    // 如果不把新页切到前台，headful Chromium 可能把键盘事件留给旧页，
    // 表面上能找到投诉输入框，但 fill/press 后值仍为空。
    await taskPage.bringToFront().catch(() => {});
    try {
      return await task(taskPage);
    } finally {
      await taskPage.close().catch(() => {});
    }
  }

  async ensureReady(page, options = {}) {
    await page.bringToFront().catch(() => {});
    const ready = await this.isLoggedIn(page, options);
    if (ready) return { ready: true, loginRequired: false };
    return {
      ready: false,
      loginRequired: true,
      message: "未检测到后台登录态，请在站内扫码面板完成登录。"
    };
  }

  async isLoggedIn(page, options = {}) {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    const text = await waitForUsefulBodyText(page, page.url(), options.waitMs).catch(() => "");
    const domSignals = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const elements = [...document.querySelectorAll("input, iframe, img, button, [class*='login'], [class*='Login']")]
        .filter(visible).slice(0, 200);
      const loginControl = elements.some((element) => {
        const source = `${element.tagName} ${element.getAttribute("type") || ""} ${element.getAttribute("src") || ""} ${element.className || ""} ${element.textContent || ""}`;
        return /password|qrcode|qr-code|scanlogin|扫码登录|微信登录|验证码/i.test(source);
      });
      const queryButton = [...document.querySelectorAll("button")].some((element) => visible(element) && element.textContent?.trim() === "查询");
      return { loginControl, queryButton };
    }).catch(() => ({ loginControl: false, queryButton: false }));
    const hasLoginWords = /扫码登录|请.{0,12}扫码|登录二维码|验证码|账号密码|安全验证|立即登录/.test(text);
    const hasAppWords = /工作台|dashboard|机会管理|查询|用户ID|手机号|销售归属人|所属品类|付费类型|推广类型|\d{4}-\d{2}-\d{2}/.test(text);
    if (domSignals.loginControl || hasLoginWords) return false;

    const apiProbe = await page.evaluate(async (timeoutMs) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch("/admin/weworkUser/simpleSelectList", {
          method: "POST",
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json"
          },
          body: JSON.stringify({ size: 1, page: 1, weworkName: "", userId: "", isLeave: "N" }),
          credentials: "include",
          signal: controller.signal
        });
        const text = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get("content-type") || "",
          redirected: response.redirected,
          url: response.url,
          text: text.slice(0, 500)
        };
      } catch {
        return { ok: false, status: 0, text: "" };
      } finally {
        clearTimeout(timer);
      }
    }, Math.min(10000, Math.max(3000, Number(this.config.browser.timeoutMs || 30000))))
      .catch(() => ({ ok: false, status: 0, text: "" }));

    const apiAuthenticated = apiProbe.ok
      && /application\/json/i.test(apiProbe.contentType || "")
      && !apiProbe.redirected
      && !/login|登录|unauthor|未登录|无权限/i.test(apiProbe.text);
    return Boolean(apiAuthenticated || (hasAppWords && domSignals.queryButton
      && safeHost(page.url()) === safeHost(this.config.browser.dashboardUrl)));
  }

  async detectUnsupportedLoginInteraction(page = this.getExistingPage()) {
    if (!page) return false;
    const text = await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
    return /滑块|拖动.{0,8}验证|点击.{0,8}验证|输入验证码|短信验证码|图形验证码/.test(text);
  }

  async prepareQrLogin(page = this.getExistingPage()) {
    if (!page) return false;
    const existingQrPage = findOfficialWeComPage(this.context?.pages?.() || []);
    if (existingQrPage) {
      this.page = existingQrPage;
      await waitForOfficialWeComQr(existingQrPage, this.config.browser.dashboardUrl);
      return true;
    }

    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200).catch(() => {});

    let checkbox = page.locator("input.el-checkbox__original[type='checkbox'], input[type='checkbox']").first();
    await checkbox.waitFor({ state: "attached", timeout: 6000 }).catch(() => {});
    const checkboxFound = await checkbox.count().catch(() => 0);
    if (!checkboxFound) {
      // 新版登录页可能不再常驻渲染原生 checkbox，而是在点击企业微信 Logo
      // 后才弹出协议确认；也可能协议已在该 Profile 中确认，直接跳转二维码。
      await clickWeComLoginLogo(page);
      const redirected = await waitForOfficialWeComPage(this.context, page, 3500);
      if (redirected) {
        this.page = redirected;
        await waitForOfficialWeComQr(redirected, this.config.browser.dashboardUrl);
        return true;
      }
      const agreement = page.locator("button.agree-button").filter({ hasText: "同意协议" }).first();
      await agreement.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
      if (!await agreement.isVisible().catch(() => false)) {
        throw new Error("点击企业微信登录后未进入二维码页，也未出现协议确认弹窗");
      }
      await waitForEnabledAgreement(agreement, 12000);
      await agreement.click({ timeout: 3000 });
      await page.waitForTimeout(500).catch(() => {});
      await clickWeComLoginLogo(page);
      const qrPage = await waitForOfficialWeComPage(this.context, page, 12000);
      if (!qrPage) throw new Error("协议已确认，但未进入企业微信官方二维码页面");
      this.page = qrPage;
      await waitForOfficialWeComQr(qrPage, this.config.browser.dashboardUrl);
      return true;
    }

    if (!await checkbox.isChecked().catch(() => false)) {
      await clickWeComLoginLogo(page);

      const redirected = await waitForOfficialWeComPage(this.context, page, 2500);
      if (redirected) {
        this.page = redirected;
        await waitForOfficialWeComQr(redirected, this.config.browser.dashboardUrl);
        return true;
      }

      const agreement = page.locator("button.agree-button").filter({ hasText: "同意协议" }).first();
      await agreement.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      if (!await agreement.isVisible().catch(() => false)) {
        // 登录组件偶发吞掉第一次原生点击；只有协议和跳转都未出现时才补一次 DOM 点击。
        await dispatchWeComLoginLogoClick(page);
        await agreement.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      }
      if (!await agreement.isVisible().catch(() => false)) {
        throw new Error("点击企业微信 Logo 后未出现《重要提示》协议弹窗");
      }

      await waitForEnabledAgreement(agreement, 12000);
      await agreement.click({ timeout: 3000 });
      await page.waitForFunction(() => {
        const input = document.querySelector("input.el-checkbox__original[type='checkbox']");
        return Boolean(input?.checked);
      }, { timeout: 5000 }).catch(() => {});

      if (!await checkbox.isChecked().catch(() => false)) {
        throw new Error("协议已点击同意，但登录页协议勾选状态未生效");
      }
      await page.waitForTimeout(500).catch(() => {});
    }

    // 协议确认会重绘登录组件，必须重新定位 Logo，不能复用旧节点。
    await clickWeComLoginLogo(page);
    let qrPage = await waitForOfficialWeComPage(this.context, page, 8000);
    if (!qrPage) {
      // 页面偶发吞掉第一次导航事件，仅在 URL 完全未变化时补一次 DOM 点击。
      await clickWeComLoginLogo(page);
      qrPage = await waitForOfficialWeComPage(this.context, page, 12000);
    }
    if (!qrPage) {
      throw new Error("协议已确认并点击企业微信 Logo，但未进入企业微信官方二维码页面");
    }

    this.page = qrPage;
    await waitForOfficialWeComQr(qrPage, this.config.browser.dashboardUrl);
    return true;
  }

  async close() {
    await this.closeContext();
  }

  async closeUser(userId) {
    if (this.activeUserId !== normalizeUserId(userId)) return;
    await this.closeContext();
  }

  async deleteUserProfile(userId) {
    const normalized = normalizeUserId(userId);
    if (this.activeUserId === normalized) await this.closeContext();
    await fs.promises.rm(this.getProfilePath(normalized), { recursive: true, force: true });
  }

  async closeContext(options = {}) {
    await this.context?.close?.().catch(() => {});
    this.context = null;
    this.page = null;
    this.launching = null;
    if (!options.preserveUser) this.activeUserId = null;
  }

  getProfilePath(userId) {
    return path.join(this.profileRoot, normalizeUserId(userId));
  }

  async captureScreenshot(page = this.getExistingPage()) {
    if (!page) throw new Error("后台登录页面尚未打开");
    return page.screenshot({ type: "png", fullPage: false });
  }

  getStatus() {
    return {
      contextOpen: Boolean(this.context),
      pageOpen: Boolean(this.page && !this.page.isClosed()),
      launching: Boolean(this.launching),
      active: Boolean(this.activeUserId)
    };
  }

  async closeForeignPages(targetUrl = "") {
    if (!this.context) return;
    const targetHost = safeHost(targetUrl);
    if (!targetHost || !/edu-admin\.qlchat\.com$/.test(targetHost)) return;
    const hasTargetPage = this.context.pages().some((page) => !page.isClosed() && safeHost(page.url()) === targetHost);
    for (const page of this.context.pages()) {
      if (page.isClosed()) continue;
      const host = safeHost(page.url());
      if (!host || host === targetHost || page.url() === "about:blank") continue;
      if (isAuthenticationUrl(page.url())) continue;
      if (!isBlockedUrl(page.url()) && !hasTargetPage) continue;
      await page.close().catch(() => {});
      if (this.page === page) this.page = null;
    }
  }

  async installNavigationGuards() {
    if (!this.context || this.context.__codexBlockedTencentDocs) return;
    this.context.__codexBlockedTencentDocs = true;
    await this.context.addInitScript(() => {
      const blocked = /(^|\.)doc\.weixin\.qq\.com$|(^|\.)docs\.qq\.com$/i;
      const isBlocked = (value) => {
        try {
          return blocked.test(new URL(String(value || ""), location.href).host);
        } catch {
          return false;
        }
      };
      const originalOpen = window.open;
      window.open = function patchedOpen(url, target, features) {
        if (isBlocked(url)) return null;
        return originalOpen.call(window, url, target, features);
      };
      document.addEventListener("click", (event) => {
        const anchor = event.target?.closest?.("a[href]");
        if (anchor && isBlocked(anchor.href)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    }).catch(() => {});
    this.context.on("page", async (page) => {
      for (let index = 0; index < 20; index += 1) {
        if (page.isClosed()) return;
        if (isBlockedUrl(page.url())) {
          await page.close().catch(() => {});
          return;
        }
        await page.waitForTimeout(50).catch(() => {});
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => {});
      if (!page.isClosed() && isBlockedUrl(page.url())) await page.close().catch(() => {});
    });
    await this.context.route("**/*", async (route) => {
      const url = route.request().url();
      if (isBlockedUrl(url)) {
        await route.abort().catch(() => {});
        return;
      }
      await route.continue().catch(() => {});
    }).catch(() => {});
  }
}

function normalizeUserId(value) {
  const normalized = String(value || "").trim();
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(normalized)) {
    throw new Error("无效的网站用户标识");
  }
  return normalized;
}

export function isTargetClosedError(error) {
  return /Target page, context or browser has been closed|Browser has been closed|Context closed|Target closed/i.test(String(error?.message || error || ""));
}

function pickBestPage(pages, targetUrl = "") {
  const usable = pages.filter((item) => !item.isClosed());
  if (!usable.length) return null;
  const targetHost = safeHost(targetUrl);
  return usable.find((page) => safeHost(page.url()) === targetHost)
    || usable.find((page) => page.url() === "about:blank")
    || usable.find((page) => !isBlockedUrl(page.url()))
    || usable[0];
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function isAllowedAutomationUrl(value, dashboardUrl) {
  const host = safeHost(value);
  return host === safeHost(dashboardUrl) || isAuthenticationUrl(value) || value === "about:blank";
}

function isAuthenticationUrl(value) {
  const host = safeHost(value);
  return /(^|\.)qlchat\.com$/i.test(host)
    || /(^|\.)weixin\.qq\.com$/i.test(host)
    || /(^|\.)work\.weixin\.qq\.com$/i.test(host);
}

function isBlockedUrl(value) {
  const host = safeHost(value);
  return /(^|\.)doc\.weixin\.qq\.com$/i.test(host) || /(^|\.)docs\.qq\.com$/i.test(host);
}

async function waitForUsefulBodyText(page, url, waitMs) {
  const isChanceAss = /\/saleAssign\/chanceAss/.test(url || "");
  const deadline = Date.now() + (Number(waitMs) || (isChanceAss ? 15000 : 6000));
  const appReadyAfter = Date.now() + Math.min(1800, Math.max(800, Number(waitMs) || 1500));
  let latest = "";
  while (Date.now() < deadline) {
    latest = await page.locator("body").innerText({ timeout: 1500 }).catch(() => latest);
    if (/扫码登录|请.{0,12}扫码|登录二维码|验证码|账号密码|安全验证|立即登录/.test(latest)) return latest;
    if (Date.now() >= appReadyAfter && /工作台|dashboard|机会管理|查询|用户ID|手机号|销售归属人|所属品类|付费类型|推广类型|\d{4}-\d{2}-\d{2}/.test(latest)) {
      return latest;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return latest;
}

const WECOM_LOGIN_HOST = "login.work.weixin.qq.com";
const WECOM_LOGO_SELECTOR = ".el-image:has(img.el-image__inner)";

function findOfficialWeComPage(pages) {
  return [...pages].reverse().find((page) => {
    return !page.isClosed() && safeHost(page.url()) === WECOM_LOGIN_HOST;
  }) || null;
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
  throw new Error("兴趣岛登录页未找到可见的企业微信登录 Logo");
}

async function dispatchWeComLoginLogoClick(page) {
  const clicked = await page.locator(WECOM_LOGO_SELECTOR).evaluateAll((elements) => {
    const visible = elements.find((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    if (!visible) return false;
    visible.click();
    return true;
  }).catch(() => false);
  if (!clicked) throw new Error("企业微信登录 Logo 的 DOM 补点失败");
  return true;
}

async function waitForEnabledAgreement(button, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await button.evaluate((element) => {
      const text = String(element.textContent || "").replace(/\s+/g, "").trim();
      return {
        text,
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        disabledClass: element.classList.contains("is-disabled")
      };
    }).catch(() => null);
    if (state && state.text === "同意协议" && !state.disabled && !state.disabledClass) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("《重要提示》协议倒计时结束后，同意按钮仍不可点击");
}

async function waitForOfficialWeComPage(context, currentPage, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!currentPage.isClosed() && safeHost(currentPage.url()) === WECOM_LOGIN_HOST) return currentPage;
    const popup = findOfficialWeComPage(context?.pages?.() || []);
    if (popup) return popup;
    await currentPage.waitForTimeout(150).catch(() => {});
  }
  return null;
}

export async function waitForOfficialWeComQr(page, dashboardUrl = "") {
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(5000).catch(() => {});
  const currentUrl = page.url();
  const currentHost = safeHost(currentUrl);
  // 二维码展示后用户可能在固定等待窗口内完成扫码，企业微信会把同一页
  // 直接回跳到兴趣岛后台。此时不再要求页面仍停留在二维码域名。
  if (currentHost === safeHost(dashboardUrl) && !/\/login(?:[/?#]|$)/i.test(currentUrl)) {
    return true;
  }
  if (currentHost !== WECOM_LOGIN_HOST) {
    throw new Error(`企业微信扫码页面地址校验失败：${page.url()}`);
  }

  const qrVisible = await page.evaluate(() => {
    const text = String(document.body?.innerText || "");
    if (/企业微信|扫码|二维码|使用企业微信/.test(text)) return true;
    return [...document.querySelectorAll("canvas, img, iframe")].some((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 120 && rect.height >= 120;
    });
  }).catch(() => false);
  if (!qrVisible) throw new Error("已进入企业微信登录域名，但未检测到可见二维码内容");
  return true;
}
