#!/usr/bin/env node
// server.js —— Playwright MCP（Walmart 反人机 · CDP 接管版 v3）
//
// 反爬主线：CDP 接管模式
//   1. 用户先双击 start-chrome.bat → 启动一个 Chrome（带 --remote-debugging-port=9222）
//      并手动逛 walmart.com 2-3 分钟养号（如果弹 Press&Hold 就手动按一次）
//   2. 服务启动 → chromium.connectOverCDP('http://localhost:9222') 接管这个 Chrome
//   3. dify 调用 walmart_* → 在那个 Chrome 里新开 tab 抓取，PX 完全识别不出自动化
//
// 备选模式（MODE=persistent）：保留 v2 的 launchPersistentContext 流程做 fallback
//
// 暴露给 dify 的工具（4 个）：
//   walmart_search   walmart_product   walmart_fetch   walmart_status
// 调试工具：
//   playwright_goto  walmart_rewarmup

import path from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  // CDP
  connectToExistingChrome,
  disconnectCdp,
  getCdpInfo,
  fetchWalmartPageCdp,
  // persistent fallback
  getPersistentContext,
  closePersistent,
  getCurrentPersistentInfo,
  runWarmup,
  startMaintenance,
  isWarmedUp,
  fetchWalmartPagePersistent,
  // 通用
  getBrowser,
  closeBrowser,
} from './browser.js';

// ---------- 配置 ----------
const PORT = parseInt(process.env.PORT || '8931', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PROXY = process.env.PROXY || null;

const MODE = (process.env.MODE || 'cdp').toLowerCase();     // cdp | persistent
const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const CDP_AUTO_RECONNECT_MS = parseInt(process.env.CDP_AUTO_RECONNECT_MS || '5000', 10);

const USER_DATA_DIR = path.resolve(process.env.USER_DATA_DIR || './user-data');
const USE_LOCAL_CHROME = process.env.USE_LOCAL_CHROME !== 'false';
const WARMUP_ON_START = process.env.WARMUP_ON_START !== 'false';
const WARMUP_HEADLESS = process.env.WARMUP_HEADLESS === 'true';
const SERVING_HEADLESS = process.env.SERVING_HEADLESS === 'true';
const MAINTENANCE_INTERVAL_MS = parseInt(process.env.MAINTENANCE_INTERVAL_MS || `${30 * 60_000}`, 10);

// 运行时状态
let state = {
  mode: MODE,
  status: 'pending',      // pending | connecting | warming | ready | blocked | error
  startedAt: null,
  finishedAt: null,
  firstRun: null,
  cookies: null,
  error: null,
  lastFetchOk: null,
  lastFetchBlockedAt: null,
  fetchCount: 0,
  blockedCount: 0,
};

// ---------- MCP server 工厂 ----------
function buildMcpServer() {
  const server = new Server(
    { name: 'walmart-playwright-mcp', version: '3.0.0' },
    { capabilities: { tools: {} } }
  );

  const tools = [
    {
      name: 'walmart_status',
      description: '查看 Walmart 抓取服务当前是否就绪',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'walmart_search',
      description: '在沃尔玛搜索关键词，返回搜索结果 HTML',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          page: { type: 'number', default: 1 },
        },
        required: ['query'],
      },
    },
    {
      name: 'walmart_product',
      description: '抓取沃尔玛单个商品页（接受完整 URL 或 itemId）',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          itemId: { type: 'string' },
        },
      },
    },
    {
      name: 'walmart_fetch',
      description: '抓取任意 walmart.com 页面',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          responseType: { type: 'string', enum: ['html', 'text', 'json'], default: 'html' },
          waitForSelector: { type: 'string' },
          timeoutMs: { type: 'number', default: 60000 },
        },
        required: ['url'],
      },
    },
    {
      name: 'walmart_rewarmup',
      description: '【调试】CDP 模式下重连 Chrome；persistent 模式下强制重跑养号',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'playwright_goto',
      description: '【通用】stealth Playwright 抓取任意域名（不走 walmart 主链路）',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          responseType: { type: 'string', enum: ['html', 'text'], default: 'html' },
          waitForSelector: { type: 'string' },
        },
        required: ['url'],
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      switch (name) {
        case 'walmart_status':
          return ok({
            ...state,
            config: {
              mode: MODE, cdpUrl: CDP_URL,
              userDataDir: USER_DATA_DIR,
              useLocalChrome: USE_LOCAL_CHROME,
              warmupOnStart: WARMUP_ON_START,
              warmupHeadless: WARMUP_HEADLESS,
              servingHeadless: SERVING_HEADLESS,
              maintenanceIntervalMin: Math.round(MAINTENANCE_INTERVAL_MS / 60_000),
              proxy: PROXY,
            },
            cdp: getCdpInfo(),
            persistent: getCurrentPersistentInfo(),
            userDataExists: existsSync(USER_DATA_DIR),
            warmedUpOnDisk: isWarmedUp(USER_DATA_DIR),
          });

        case 'walmart_search': {
          const a = z.object({
            query: z.string(),
            page: z.number().int().min(1).default(1),
          }).parse(args);
          const url = `https://www.walmart.com/search?q=${encodeURIComponent(a.query)}&page=${a.page}`;
          return ok(await safeFetch(url, {
            waitForSelector: '[data-testid="item-stack"], [data-item-id]',
          }));
        }

        case 'walmart_product': {
          const a = z.object({
            url: z.string().url().optional(),
            itemId: z.string().optional(),
          }).refine(v => v.url || v.itemId, { message: 'url or itemId required' }).parse(args);
          const url = a.url || `https://www.walmart.com/ip/${a.itemId}`;
          return ok(await safeFetch(url, { waitForSelector: 'h1, [itemprop="name"]' }));
        }

        case 'walmart_fetch': {
          const a = z.object({
            url: z.string().url(),
            responseType: z.enum(['html', 'text', 'json']).default('html'),
            waitForSelector: z.string().optional(),
            timeoutMs: z.number().default(60000),
          }).parse(args);
          return ok(await safeFetch(a.url, {
            responseType: a.responseType,
            waitForSelector: a.waitForSelector,
            timeoutMs: a.timeoutMs,
          }));
        }

        case 'walmart_rewarmup': {
          if (MODE === 'cdp') {
            await disconnectCdp();
            await connectToExistingChrome({ cdpUrl: CDP_URL });
            state.status = 'ready';
            return ok({ ok: true, mode: 'cdp', cdp: getCdpInfo() });
          } else {
            state.status = 'warming';
            const r = await runWarmup({
              userDataDir: USER_DATA_DIR,
              headless: WARMUP_HEADLESS,
              proxy: PROXY,
              useLocalChrome: USE_LOCAL_CHROME,
            });
            state.firstRun = r.firstRun;
            state.cookies = r.cookies;
            state.status = r.warmed && r.cookies?.pxvid ? 'ready' : 'blocked';
            if (!r.warmed) { state.status = 'error'; state.error = r.error; }
            return ok(state);
          }
        }

        case 'playwright_goto': {
          const a = z.object({
            url: z.string().url(),
            responseType: z.enum(['html', 'text']).default('html'),
            waitForSelector: z.string().optional(),
          }).parse(args);
          const browser = await getBrowser({ headless: true, proxy: PROXY });
          const context = await browser.newContext();
          const page = await context.newPage();
          try {
            const resp = await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            if (a.waitForSelector) await page.waitForSelector(a.waitForSelector, { timeout: 30000 }).catch(() => {});
            const data = a.responseType === 'text'
              ? await page.evaluate(() => document.body.innerText)
              : await page.content();
            return ok({ status: resp?.status() ?? 0, url: page.url(), data });
          } finally {
            await context.close().catch(() => {});
          }
        }

        default:
          return err(`unknown tool: ${name}`);
      }
    } catch (e) {
      return err(e?.message || String(e));
    }
  });

  return server;
}

/** 统一抓取入口（按 MODE 路由） */
async function safeFetch(url, { responseType = 'html', waitForSelector = null, timeoutMs = 60000 } = {}) {
  if (state.status !== 'ready') {
    return {
      ok: false, blocked: false,
      error: `service not ready (status=${state.status}, mode=${MODE}). ${
        MODE === 'cdp'
          ? '请确保已经双击 start-chrome.bat 启动了 Chrome，然后调用 walmart_rewarmup 重连。'
          : '请等待 warmup 完成或调用 walmart_rewarmup。'
      }`,
    };
  }
  state.fetchCount += 1;

  let result;
  if (MODE === 'cdp') {
    result = await fetchWalmartPageCdp({ url, cdpUrl: CDP_URL, responseType, waitForSelector, timeoutMs });
  } else {
    result = await fetchWalmartPagePersistent({
      url, userDataDir: USER_DATA_DIR, headless: SERVING_HEADLESS,
      proxy: PROXY, useLocalChrome: USE_LOCAL_CHROME,
      responseType, waitForSelector, timeoutMs,
    });
  }

  if (result.blocked) {
    state.blockedCount += 1;
    state.lastFetchBlockedAt = new Date().toISOString();
    state.lastFetchOk = false;
    state.status = 'blocked';
    return {
      ...result,
      hint: MODE === 'cdp'
        ? '检测到 PerimeterX 挑战。请到那个 Chrome 窗口手动过一次验证，然后调用 walmart_rewarmup'
        : '检测到 PerimeterX 挑战。请到弹出窗口手动验证后调用 walmart_rewarmup',
    };
  }
  state.lastFetchOk = result.ok;
  return result;
}

function ok(payload) { return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }; }
function err(msg)    { return { isError: true, content: [{ type: 'text', text: `ERROR: ${msg}` }] }; }

// ---------- SSE HTTP 层 ----------
const app = express();
app.use(express.json({ limit: '4mb' }));
const transports = new Map();

app.get('/', (_req, res) => {
  res.json({ name: 'walmart-playwright-mcp', version: '3.0.0', transport: 'sse', sse: '/sse', state });
});

app.get('/healthz', (_req, res) => res.json({
  ok: true,
  mode: MODE,
  state,
  cdp: getCdpInfo(),
  persistent: getCurrentPersistentInfo(),
}));

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);
  res.on('close', () => transports.delete(transport.sessionId));
  const server = buildMcpServer();
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) return res.status(400).send('No active SSE session for sessionId');
  await transport.handlePostMessage(req, res, req.body);
});

// ---------- 启动序列 ----------
(async () => {
  console.log(`[walmart-playwright-mcp] starting v3.0.0...`);
  console.log(`[config] mode=${MODE}  cdpUrl=${CDP_URL}  userDataDir=${USER_DATA_DIR}`);

  app.listen(PORT, HOST, () => {
    console.log(`[walmart-playwright-mcp] listening on http://${HOST}:${PORT}`);
    console.log(`[walmart-playwright-mcp] MCP SSE endpoint:  http://${HOST}:${PORT}/sse`);
  });

  if (MODE === 'cdp') {
    await startCdpMode();
  } else {
    await startPersistentMode();
  }
})();

async function startCdpMode() {
  state.status = 'connecting';
  state.startedAt = new Date().toISOString();
  console.log(`[startup] MODE=cdp → 尝试连接 ${CDP_URL}`);

  while (true) {
    try {
      await connectToExistingChrome({ cdpUrl: CDP_URL });
      state.status = 'ready';
      state.finishedAt = new Date().toISOString();
      console.log(`[startup] ✅ CDP connected. Server is now serving walmart_*`);
      console.log(`[startup] **重要**：不要关闭那个 Chrome 窗口，它就是我们的"身份载体"`);
      break;
    } catch (e) {
      state.status = 'pending';
      state.error = e.message;
      console.error('');
      console.error('╔══════════════════════════════════════════════════════════════╗');
      console.error('║  无法连接到 Chrome 调试端口！                                  ║');
      console.error('║  请先双击项目根目录下的：  start-chrome.bat                    ║');
      console.error('║  然后等待 Chrome 启动，在 walmart.com 手动逛 2-3 分钟          ║');
      console.error('║  (如果弹 Press And Hold 验证，手动按住完成它即可)              ║');
      console.error('║  我会每 5 秒自动重试一次连接，无需重启此服务。                 ║');
      console.error('╚══════════════════════════════════════════════════════════════╝');
      console.error('');
      await new Promise(r => setTimeout(r, CDP_AUTO_RECONNECT_MS));
    }
  }
}

async function startPersistentMode() {
  if (!WARMUP_ON_START) {
    state.status = 'ready';
    console.log('[startup] WARMUP_ON_START=false → skipping warmup');
    return;
  }
  state.status = 'warming';
  state.startedAt = new Date().toISOString();
  console.log('[startup] MODE=persistent → running warmup...');
  try {
    const r = await runWarmup({
      userDataDir: USER_DATA_DIR,
      headless: WARMUP_HEADLESS,
      proxy: PROXY,
      useLocalChrome: USE_LOCAL_CHROME,
    });
    state.finishedAt = new Date().toISOString();
    state.firstRun = r.firstRun;
    state.cookies = r.cookies;
    if (r.warmed && r.cookies?.pxvid) {
      state.status = 'ready';
      console.log(`[startup] ✅ warmup complete (firstRun=${r.firstRun})`);
      startMaintenance({ intervalMs: MAINTENANCE_INTERVAL_MS });
    } else if (r.warmed) {
      state.status = 'blocked';
      console.warn('[startup] ⚠ warmup finished but PX cookies incomplete');
    } else {
      state.status = 'error';
      state.error = r.error;
      console.error('[startup] ✗ warmup failed:', r.error);
    }
  } catch (e) {
    state.status = 'error';
    state.error = e.message;
    console.error('[startup] warmup exception:', e);
  }
}

// ---------- 优雅退出 ----------
async function shutdown() {
  console.log('[walmart-playwright-mcp] shutting down...');
  await disconnectCdp();          // CDP 模式：仅断开附加，不杀 Chrome
  await closePersistent();
  await closeBrowser();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
