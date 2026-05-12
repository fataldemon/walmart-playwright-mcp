// pxvid-pool.js
// 复刻 iotword.com/33395 中的核心方案：
//   1) 通过 HEAD 请求带随机指纹去获取 _pxhd -> 解析 _pxvid
//   2) 令牌生效需等待 ~10s
//   3) 维护 主/副 令牌池，老化即换
//
// 通过 undici 直接走 HTTP，比浏览器快很多，专门用作"令牌生产者"。
// 真正抓数据时，把 _pxvid 注入到 Playwright 的 cookie 中即可。

import { request } from 'undici';
import UserAgent from 'user-agents';
import { randomBytes, randomInt } from 'node:crypto';
// 浏览器 fallback：当 HTTP 拿不到 _pxvid 时，用真实浏览器渲染获取
let _browserGetterPromise = null;
async function _getBrowserLazy(proxy) {
  if (!_browserGetterPromise) {
    _browserGetterPromise = import('./browser.js').then(m => m.getBrowser({ headless: true, proxy }));
  }
  return _browserGetterPromise;
}

const PXVID_REGEX = /_pxvid=([^;]+)/i;
const PXHD_REGEX = /_pxhd=([^;]+)/i;

// 沃尔玛站点上几乎所有商品/搜索页都会触发 PerimeterX 校验，
// 任意一个稳定页面都可作为"令牌生成入口"。
const SEED_URLS = [
  'https://www.walmart.com/',
  'https://www.walmart.com/cp/electronics/3944',
  'https://www.walmart.com/cp/grocery/976759',
];

const SEC_CH_UA_POOL = [
  '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"',
  '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
  '"Chromium";v="127", "Google Chrome";v="127", "Not-A.Brand";v="99"',
];

const ACCEPT_LANG_POOL = [
  'en-US,en;q=0.9',
  'en-US,en;q=0.8',
  'en-GB,en-US;q=0.9,en;q=0.8',
  'en-US,en;q=0.9,zh-CN;q=0.6',
];

function randomChoice(arr) {
  return arr[randomInt(0, arr.length)];
}

function randomTraceId() {
  return randomBytes(16).toString('hex');
}

/** 构造一组高随机度 headers，复刻原文“随机化混淆字段”策略 */
export function buildRandomHeaders(extra = {}) {
  const ua = new UserAgent({ deviceCategory: 'desktop' }).toString();
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': randomChoice(ACCEPT_LANG_POOL),
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': randomChoice(SEC_CH_UA_POOL),
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    // 随机的“无意义”字段，文章里强调的混淆头
    'X-Trace-Id': randomTraceId(),
    'X-Request-Id': randomTraceId(),
    ...extra,
  };
}

/** 单次向沃尔玛发起 HEAD/GET 请求，从 set-cookie 中抽出 _pxvid
 *  返回 { token, status, reason? }
 */
export async function fetchOnePxvid({ proxy } = {}) {
  const url = randomChoice(SEED_URLS);
  const headers = buildRandomHeaders();

  const dispatcherOpts = {};
  if (proxy) {
    const { ProxyAgent } = await import('undici');
    dispatcherOpts.dispatcher = new ProxyAgent(proxy);
  }

  let res;
  try {
    res = await request(url, {
      method: 'GET',
      headers,
      maxRedirections: 0,
      ...dispatcherOpts,
    });
  } catch (e) {
    return { token: null, status: 0, reason: `network: ${e.code || e.message}` };
  }

  const status = res.statusCode;
  const setCookies = res.headers['set-cookie'];
  res.body.dump().catch(() => {});

  if (!setCookies) {
    return { token: null, status, reason: `no set-cookie (status ${status}) — likely blocked / geo-restricted` };
  }
  const raw = Array.isArray(setCookies) ? setCookies.join('; ') : String(setCookies);
  const pxvid = raw.match(PXVID_REGEX)?.[1];
  const pxhd = raw.match(PXHD_REGEX)?.[1];
  if (!pxvid) {
    return { token: null, status, reason: `no _pxvid in cookies (status ${status})` };
  }

  return {
    token: {
      pxvid,
      pxhd: pxhd || null,
      headers,
      bornAt: Date.now(),
      ready: false,
    },
    status,
  };
}

/** 浏览器 fallback：访问首页让 PerimeterX JS 自己种 _pxvid，再从 cookie 里读
 *  比 HTTP 慢，但能搞定 JS-set 的情况
 */
export async function fetchOnePxvidViaBrowser({ proxy } = {}) {
  const browser = await _getBrowserLazy(proxy);
  const headers = buildRandomHeaders();
  const ua = headers['User-Agent'];
  const ctx = await browser.newContext({
    userAgent: ua,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': headers['Accept-Language'],
      'Sec-Ch-Ua': headers['Sec-Ch-Ua'],
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
    },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(randomChoice(SEED_URLS), {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    }).catch(() => null);
    // 给 PX JS 一点种 cookie 的时间
    await page.waitForTimeout(2500).catch(() => {});
    const cookies = await ctx.cookies('https://www.walmart.com');
    const pxvid = cookies.find(c => c.name === '_pxvid')?.value;
    const pxhd = cookies.find(c => c.name === '_pxhd')?.value || null;
    const status = resp?.status() ?? 0;
    if (!pxvid) {
      return { token: null, status, reason: `browser: no _pxvid cookie (status ${status})` };
    }
    return {
      token: { pxvid, pxhd, headers, bornAt: Date.now(), ready: false },
      status,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * 令牌池：主令牌 + 副令牌
 *   - 启动时批量造一批主令牌
 *   - 10s 后转 ready
 *   - 异步源源不断造副令牌
 *   - 取出已 ready 的令牌使用，过期 / 使用次数超限就丢弃
 */
export class PxvidPool {
  constructor({
    primarySize = 5,
    secondarySize = 5,
    activationMs = 10_000,      // 文章里说的 ~10s 才能生效
    maxUsePerToken = 50,
    ttlMs = 30 * 60_000,        // 30min 强制淘汰，避免老化失效
    proxy = null,
    logger = console,
  } = {}) {
    this.primarySize = primarySize;
    this.secondarySize = secondarySize;
    this.activationMs = activationMs;
    this.maxUsePerToken = maxUsePerToken;
    this.ttlMs = ttlMs;
    this.proxy = proxy;
    this.logger = logger;
    this.tokens = [];     // { pxvid, headers, bornAt, ready, used }
    this.stopped = false;
    this.attempts = 0;
    this.successes = 0;
    this.lastError = null;
    this.lastStatus = null;
  }

  async start() {
    this.logger.info?.('[PxvidPool] warming up primary tokens...');
    await this._fill(this.primarySize);
    // 异步轮询补副令牌
    this._loop();
  }

  async _fetchOne() {
    // 1) 先 HTTP 快速尝试
    const httpRes = await fetchOnePxvid({ proxy: this.proxy });
    if (httpRes.token) return httpRes;
    // 2) HTTP 拿不到 -> 浏览器 fallback（PerimeterX 经常通过 JS 种 cookie）
    try {
      const brRes = await fetchOnePxvidViaBrowser({ proxy: this.proxy });
      if (brRes.token) return brRes;
      return { token: null, status: brRes.status, reason: `http:${httpRes.reason} | ${brRes.reason}` };
    } catch (e) {
      return { token: null, status: httpRes.status, reason: `http:${httpRes.reason} | browser:${e.message}` };
    }
  }

  async _fill(target) {
    let consecutiveFailures = 0;
    while (this.tokens.length < target && !this.stopped) {
      this.attempts += 1;
      try {
        const result = await this._fetchOne();
        this.lastStatus = result.status;
        if (result.token) {
          const t = result.token;
          t.used = 0;
          this.tokens.push(t);
          this.successes += 1;
          this.lastError = null;
          consecutiveFailures = 0;
          setTimeout(() => { t.ready = true; }, this.activationMs).unref?.();
        } else {
          this.lastError = result.reason;
          consecutiveFailures += 1;
          this.logger.warn?.(`[PxvidPool] no token (status=${result.status}): ${result.reason}`);
        }
      } catch (e) {
        this.lastError = e.message;
        consecutiveFailures += 1;
        this.logger.warn?.('[PxvidPool] fetch token failed:', e.message);
      }
      // 连续失败时直接放弃本轮，避免死循环（典型情况：IP 被沃尔玛 block）
      if (consecutiveFailures >= 3) {
        this.logger.warn?.('[PxvidPool] giving up _fill for now after 3 consecutive failures');
        break;
      }
      await new Promise(r => setTimeout(r, 300 + Math.random() * 700));
    }
  }

  async _loop() {
    while (!this.stopped) {
      // 淘汰过期/用完的
      const now = Date.now();
      this.tokens = this.tokens.filter(t =>
        t.used < this.maxUsePerToken && (now - t.bornAt) < this.ttlMs
      );
      const want = this.primarySize + this.secondarySize;
      if (this.tokens.length < want) {
        await this._fill(want);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  /** 取一个已 ready 的 token；若暂无则等待 */
  async acquire(timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ready = this.tokens.filter(t => t.ready && t.used < this.maxUsePerToken);
      if (ready.length) {
        const t = randomChoice(ready);
        t.used += 1;
        return t;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('PxvidPool.acquire timeout: no ready tokens');
  }

  stop() {
    this.stopped = true;
  }

  stats() {
    const now = Date.now();
    return {
      total: this.tokens.length,
      ready: this.tokens.filter(t => t.ready).length,
      avgAgeSec: this.tokens.length
        ? Math.round(this.tokens.reduce((s, t) => s + (now - t.bornAt), 0) / this.tokens.length / 1000)
        : 0,
      attempts: this.attempts,
      successes: this.successes,
      successRate: this.attempts ? +(this.successes / this.attempts).toFixed(3) : 0,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
      proxyConfigured: !!this.proxy,
      hint: (!this.tokens.length && !this.proxy)
        ? '池为空且未配置 PROXY。沃尔玛对中国大陆 IP 风控严格，请设置 PROXY=http://user:pass@host:port 后重启。'
        : undefined,
    };
  }
}
