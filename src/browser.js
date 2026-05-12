// browser.js —— 双模式封装：
//   1. 持久化身份（推荐主线）：launchPersistentContext + channel:'chrome' + ./user-data/
//      抓 Walmart 主要走这条；首次启动会"养号"，cookie 落盘后多次重启都复用。
//   2. 临时浏览器（兼容旧 API）：getBrowser() —— 留给 playwright_goto 等通用抓取。

import path from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { chromium as pwChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { humanize } from './humanize.js';

// 把所有 stealth evasions 装到 playwright-extra 上
pwChromium.use(StealthPlugin());

// ============ 1) 持久化 Context（主线） ============
let _persistent = null;             // { context, headless, userDataDir }
let _maintenanceTimer = null;

function commonLaunchArgs() {
  return [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-default-browser-check',
    '--no-first-run',
    '--password-store=basic',
    '--lang=en-US,en',
    '--start-maximized',
  ];
}

/** 是否已经"养过号"——判断条件：user-data 目录下有 Cookies 文件且最近被写过 */
export function isWarmedUp(userDataDir) {
  try {
    const cookiesPath = path.join(userDataDir, 'Default', 'Cookies');
    if (!existsSync(cookiesPath)) return false;
    const sz = statSync(cookiesPath).size;
    return sz > 1024;   // > 1KB 才认为是养过号
  } catch {
    return false;
  }
}

/**
 * 打开（或复用）持久化 BrowserContext。
 *   - userDataDir 不存在则会被自动创建
 *   - channel:'chrome' → 用本机 Chrome 二进制（C:\Program Files\Google\Chrome\Application\chrome.exe）
 *   - 失败回退到 playwright 自带 chromium
 */
export async function getPersistentContext({
  userDataDir,
  headless = false,
  proxy = null,
  useLocalChrome = true,
  logger = console,
} = {}) {
  if (!userDataDir) throw new Error('userDataDir is required');
  if (_persistent && _persistent.context && !_persistent.context.pages?.()?.[0]?.isClosed?.()) {
    if (_persistent.headless === headless && _persistent.userDataDir === userDataDir) {
      return _persistent.context;
    }
    logger.log?.('[browser] persistent mode changed, closing old context...');
    try { await _persistent.context.close(); } catch {}
    _persistent = null;
  }

  if (!existsSync(userDataDir)) {
    mkdirSync(userDataDir, { recursive: true });
    logger.log?.(`[browser] created user-data-dir: ${userDataDir}`);
  }

  const baseOpts = {
    headless,
    args: commonLaunchArgs(),
    proxy: proxy ? { server: proxy } : undefined,
    viewport: null,        // 跟随窗口，避免固定 1366x768 这种"教科书"分辨率
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ignoreDefaultArgs: ['--enable-automation'],
  };

  let context;
  try {
    if (useLocalChrome) {
      logger.log?.(`[browser] launching persistent context with channel='chrome'  headless=${headless}`);
      context = await pwChromium.launchPersistentContext(userDataDir, {
        ...baseOpts,
        channel: 'chrome',
      });
    } else {
      throw new Error('USE_LOCAL_CHROME=false');
    }
  } catch (e) {
    logger.warn?.(`[browser] chrome channel failed (${e.message}), fallback to bundled chromium...`);
    context = await pwChromium.launchPersistentContext(userDataDir, baseOpts);
  }

  // 反检测注入（每个新 page 都会执行）
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });

  _persistent = { context, headless, userDataDir };
  logger.log?.(`[browser] persistent context ready. pages=${context.pages().length}`);
  return context;
}

export function getCurrentPersistentInfo() {
  return _persistent
    ? { running: true, headless: _persistent.headless, userDataDir: _persistent.userDataDir }
    : { running: false };
}

/** 关闭持久化 context（也会停止维护轮询） */
export async function closePersistent() {
  if (_maintenanceTimer) { clearInterval(_maintenanceTimer); _maintenanceTimer = null; }
  if (_persistent?.context) {
    try { await _persistent.context.close(); } catch {}
    _persistent = null;
  }
}

/**
 * 启动时的"养号"流程：
 *   - 如果 user-data 已存在 → 仅做一次轻量验证（开页 → 检查 cookie）
 *   - 否则 → 跑完整 warmupBrowse(~40s)
 * 返回 { warmed: bool, cookies: { pxvid?, px3?, pxhd? } }
 */
export async function runWarmup({ userDataDir, headless = false, proxy = null, useLocalChrome = true, logger = console } = {}) {
  const context = await getPersistentContext({ userDataDir, headless, proxy, useLocalChrome, logger });
  const isFirstRun = !isWarmedUp(userDataDir);
  const page = context.pages()[0] || await context.newPage();

  try {
    if (isFirstRun) {
      logger.log?.('[warmup] first run -> doing full ~40s human browse...');
      await humanize.warmupBrowse(page, logger);
    } else {
      logger.log?.('[warmup] user-data exists -> light revalidation...');
      await page.goto('https://www.walmart.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await humanize.afterLand(page);
    }

    // 读取关键 cookies
    const cookies = await context.cookies('https://www.walmart.com');
    const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));
    const summary = {
      pxvid: !!cookieMap._pxvid,
      px3:   !!cookieMap._px3,
      pxhd:  !!cookieMap._pxhd || !!cookieMap.pxhd2,
    };
    logger.log?.(`[warmup] cookies acquired: _pxvid=${summary.pxvid} _px3=${summary.px3} _pxhd=${summary.pxhd}  total=${cookies.length}`);

    // 检测是否仍处于人机校验页
    const isChallenge = await page.evaluate(() => {
      const t = (document.title || '').toLowerCase();
      const b = (document.body?.innerText || '').slice(0, 600).toLowerCase();
      return /robot or human|verify you are|access denied|px-captcha|are you a human/.test(t + ' ' + b);
    }).catch(() => false);

    if (isChallenge) {
      logger.warn?.('[warmup] STILL on PX challenge page. 请在这个 Chrome 窗口里手动点击 "Press & Hold" 或勾选 "I\'m not a robot"，完成后窗口会自动检测。');
      // 轮询等待用户手动过关（最多 5 分钟）
      const start = Date.now();
      while (Date.now() - start < 5 * 60_000) {
        await page.waitForTimeout(2500);
        const stillBlocked = await page.evaluate(() => {
          const t = (document.title || '').toLowerCase();
          const b = (document.body?.innerText || '').slice(0, 600).toLowerCase();
          return /robot or human|verify you are|access denied|px-captcha|are you a human/.test(t + ' ' + b);
        }).catch(() => true);
        if (!stillBlocked) {
          logger.log?.('[warmup] challenge cleared by human ✅');
          await humanize.afterLand(page);
          break;
        }
      }
    }

    return { warmed: true, firstRun: isFirstRun, cookies: summary };
  } catch (e) {
    logger.error?.('[warmup] failed:', e.message);
    return { warmed: false, error: e.message };
  }
}

/** 启动维护轮询：每隔 intervalMs 在后台跑一次 afterLand，让 PX 一直觉得我们活着 */
export function startMaintenance({ intervalMs = 30 * 60_000, logger = console } = {}) {
  if (_maintenanceTimer) return;
  _maintenanceTimer = setInterval(async () => {
    if (!_persistent?.context) return;
    try {
      const page = await _persistent.context.newPage();
      logger.log?.('[maintenance] heartbeat visit to walmart.com');
      await page.goto('https://www.walmart.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await humanize.afterLand(page);
      await page.close().catch(() => {});
    } catch (e) {
      logger.warn?.('[maintenance] heartbeat failed:', e.message);
    }
  }, intervalMs);
  _maintenanceTimer.unref?.();
}

// ============ 2) 通用 Browser（兼容旧 playwright_goto / 旧 pool） ============
let _browser = null;
let _browserHeadless = null;
let _browserProxy = null;

export function getCurrentBrowserMode() {
  return {
    running: !!(_browser && _browser.isConnected()),
    headless: _browserHeadless,
    proxy: _browserProxy,
  };
}

export async function getBrowser({ headless = true, proxy = null } = {}) {
  if (_browser && _browser.isConnected()) {
    if (_browserHeadless === headless && _browserProxy === proxy) return _browser;
    try { await _browser.close(); } catch {}
    _browser = null;
  }
  _browser = await pwChromium.launch({
    headless,
    args: commonLaunchArgs(),
    proxy: proxy ? { server: proxy } : undefined,
  });
  _browserHeadless = headless;
  _browserProxy = proxy;
  return _browser;
}

export async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }
}

// ============ 3) 真正的抓取主链路：基于 persistent context ============

/**
 * 使用持久化身份抓 Walmart 页面，全程模拟人类
 *   - 不再依赖 _pxvid 池
 *   - 复用同一个 persistent context（所有 cookie 已落盘）
 *   - 抓取前后跑 humanize.afterLand
 */
export async function fetchWalmartPagePersistent({
  url,
  userDataDir,
  headless = false,
  proxy = null,
  useLocalChrome = true,
  responseType = 'html',
  waitForSelector = null,
  timeoutMs = 60_000,
  logger = console,
}) {
  const context = await getPersistentContext({ userDataDir, headless, proxy, useLocalChrome, logger });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = resp ? resp.status() : 0;

    // 着陆后跑一遍人类化（鼠标 + 滚动 + 停顿）
    await humanize.afterLand(page);

    // 检测是否被 PX 拦截
    const isBlocked = await page.evaluate(() => {
      const t = (document.title || '').toLowerCase();
      const b = (document.body?.innerText || '').slice(0, 600).toLowerCase();
      return /robot or human|verify you are|access denied|px-captcha|are you a human/.test(t + ' ' + b);
    }).catch(() => false);

    if (waitForSelector && !isBlocked) {
      await page.waitForSelector(waitForSelector, { timeout: timeoutMs }).catch(() => {});
    }

    let data;
    if (responseType === 'json') {
      const txt = await page.evaluate(() => document.body.innerText);
      try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    } else if (responseType === 'text') {
      data = await page.evaluate(() => document.body.innerText);
    } else {
      data = await page.content();
    }

    return {
      ok: !isBlocked && status >= 200 && status < 400,
      status,
      blocked: isBlocked,
      url: page.url(),
      data,
    };
  } finally {
    // 注意：关闭的是 page，不是 context；context 要常驻
    await page.close().catch(() => {});
  }
}

// ============ 4) 兼容旧 API（pxvid-pool 仍可调） ============
// 这个函数已不在主链路使用，仅保留兼容性
export async function fetchWalmartPage({
  url, token, headless = true, proxy = null,
  responseType = 'html', waitForSelector = null, timeoutMs = 45_000,
}) {
  const browser = await getBrowser({ headless, proxy });
  const ua = token?.headers?.['User-Agent'];
  const context = await browser.newContext({
    userAgent: ua,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1366, height: 768 },
  });
  if (token?.pxvid) {
    await context.addCookies([{
      name: '_pxvid', value: token.pxvid,
      domain: '.walmart.com', path: '/', secure: true, sameSite: 'Lax',
    }]);
  }
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = resp ? resp.status() : 0;
    if (waitForSelector) await page.waitForSelector(waitForSelector, { timeout: timeoutMs }).catch(() => {});
    const data = responseType === 'text'
      ? await page.evaluate(() => document.body.innerText)
      : await page.content();
    return { ok: status >= 200 && status < 400, status, blocked: false, url: page.url(), data };
  } finally {
    await context.close().catch(() => {});
  }
}
