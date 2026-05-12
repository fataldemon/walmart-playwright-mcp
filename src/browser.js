// browser.js —— Playwright + stealth 封装
// 一个常驻 browser 实例，按需开 context；每次抓取注入 _pxvid 与一致指纹。

import { chromium as pwChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// 把所有 stealth evasions 装到 playwright-extra 上
pwChromium.use(StealthPlugin());

let _browser = null;
let _browserHeadless = null;       // 记录当前已开启 browser 的模式
let _browserProxy = null;

export function getCurrentBrowserMode() {
  return {
    running: !!(_browser && _browser.isConnected()),
    headless: _browserHeadless,
    proxy: _browserProxy,
  };
}

export async function getBrowser({ headless = true, proxy = null } = {}) {
  // 若 mode 变化（比如运行时 set_headless），关旧的换新的
  if (_browser && _browser.isConnected()) {
    if (_browserHeadless === headless && _browserProxy === proxy) return _browser;
    console.log(`[browser] mode changed (headless ${_browserHeadless}->${headless}), restarting...`);
    try { await _browser.close(); } catch {}
    _browser = null;
  }
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--lang=en-US,en',
  ];
  if (!headless) {
    args.push('--start-maximized');
  } else {
    args.push('--disable-gpu');
  }
  console.log(`[browser] launching chromium  headless=${headless}  proxy=${proxy || '<none>'}`);
  _browser = await pwChromium.launch({
    headless,
    args,
    proxy: proxy ? { server: proxy } : undefined,
  });
  _browserHeadless = headless;
  _browserProxy = proxy;
  console.log(`[browser] launched. version=${_browser.version()}  isConnected=${_browser.isConnected()}`);
  return _browser;
}

export async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }
}

/**
 * 用一个 _pxvid 令牌打开 Walmart 页面，返回 HTML / JSON
 * @param {object} opts
 * @param {string} opts.url           要抓取的页面 url
 * @param {object} opts.token         pxvid token 对象 { pxvid, headers }
 * @param {boolean} [opts.headless]
 * @param {string|null} [opts.proxy]
 * @param {'html'|'json'|'text'} [opts.responseType]
 * @param {string} [opts.waitForSelector]  抓取前等待的选择器
 * @param {number} [opts.timeoutMs]
 */
export async function fetchWalmartPage({
  url,
  token,
  headless = true,
  proxy = null,
  responseType = 'html',
  waitForSelector = null,
  timeoutMs = 45_000,
}) {
  const browser = await getBrowser({ headless, proxy });
  const ua = token.headers['User-Agent'];

  const context = await browser.newContext({
    userAgent: ua,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1366 + Math.floor(Math.random() * 200), height: 768 + Math.floor(Math.random() * 200) },
    extraHTTPHeaders: {
      'Accept-Language': token.headers['Accept-Language'],
      'Sec-Ch-Ua': token.headers['Sec-Ch-Ua'],
      'Sec-Ch-Ua-Mobile': token.headers['Sec-Ch-Ua-Mobile'],
      'Sec-Ch-Ua-Platform': token.headers['Sec-Ch-Ua-Platform'],
    },
  });

  // 关键：把 _pxvid 注入到 walmart.com cookie 中
  await context.addCookies([
    {
      name: '_pxvid',
      value: token.pxvid,
      domain: '.walmart.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    },
    ...(token.pxhd ? [{
      name: '_pxhd',
      value: token.pxhd,
      domain: '.walmart.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    }] : []),
  ]);

  // 再注入一段反检测脚本（webdriver / chrome.runtime / plugins）
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    // plugins
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    // chrome obj
    window.chrome = window.chrome || { runtime: {} };
  });

  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = resp ? resp.status() : 0;

    // 触发了 PerimeterX 校验时通常是 403 + "Robot or human?" / "px-captcha"
    const isBlocked = await page.evaluate(() => {
      const t = document.title || '';
      const body = document.body ? document.body.innerText.slice(0, 500) : '';
      return /robot or human|access denied|px-captcha|verify you are/i.test(t + ' ' + body);
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
    await context.close().catch(() => {});
  }
}
