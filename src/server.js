#!/usr/bin/env node
// server.js —— Playwright MCP（Walmart 反人机 · 持久化身份版）
//
// 思路：
//   - 启动时自动用本机 Chrome（channel:'chrome'）打开一个 persistent context（./user-data/），
//     模拟"真人闲逛"30~60s 让 PerimeterX 把我们打成 high-trust 用户。
//   - 之后所有 walmart_* 调用都复用同一个 context（cookies/storage 落盘，重启不丢）。
//   - 每次抓取都跑 humanize（鼠标贝塞尔轨迹 + 滚动 + 随机停顿）。
//   - 后台每 30 分钟做一次 "heartbeat visit" 保持身份活跃。
//
// 暴露给 dify / MCP 客户端的工具（简洁版，4 个）：
//   walmart_search   walmart_product   walmart_fetch   walmart_status
//
// 另外保留两个调试工具（不希望 dify 调，但人可以 curl）：
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
  getPersistentContext,
  closePersistent,
  getCurrentPersistentInfo,
  runWarmup,
  startMaintenance,
  isWarmedUp,
  fetchWalmartPagePersistent,
  getBrowser,
  closeBrowser,
} from './browser.js';
import { humanize } from './humanize.js';

// ---------- 配置 ----------
const PORT = parseInt(process.env.PORT || '8931', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PROXY = process.env.PROXY || null;
const USER_DATA_DIR = path.resolve(process.env.USER_DATA_DIR || './user-data');
const USE_LOCAL_CHROME = process.env.USE_LOCAL_CHROME !== 'false';
const WARMUP_ON_START = process.env.WARMUP_ON_START !== 'false';
const WARMUP_HEADLESS = process.env.WARMUP_HEADLESS === 'true';      // 默认 false：显示窗口
const SERVING_HEADLESS = process.env.SERVING_HEADLESS === 'true';    // 默认 false：显示窗口
const MAINTENANCE_INTERVAL_MS = parseInt(process.env.MAINTENANCE_INTERVAL_MS || `${30 * 60_000}`, 10);

// 运行时状态
let warmupState = {
  status: 'pending',      // pending | warming | ready | blocked | error
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
    { name: 'walmart-playwright-mcp', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  const tools = [
    {
      name: 'walmart_status',
      description:
        '查看 Walmart 抓取服务当前是否就绪（养号完成 / PX cookie 是否齐全 / 最近抓取是否被拦）',
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
      description:
        '使用持久化身份抓取任意 walmart.com 页面（会注入老用户 cookies + 模拟人类行为）',
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
    // 调试用
    {
      name: 'walmart_rewarmup',
      description: '【调试】强制重新跑一次养号流程（不会删除 ./user-data/）',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'playwright_goto',
      description: '【通用】stealth Playwright 抓取（任意域名，不走持久化身份）',
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
            ...warmupState,
            userDataDir: USER_DATA_DIR,
            userDataExists: existsSync(USER_DATA_DIR),
            warmedUpOnDisk: isWarmedUp(USER_DATA_DIR),
            persistent: getCurrentPersistentInfo(),
            config: {
              useLocalChrome: USE_LOCAL_CHROME,
              warmupHeadless: WARMUP_HEADLESS,
              servingHeadless: SERVING_HEADLESS,
              maintenanceIntervalMin: Math.round(MAINTENANCE_INTERVAL_MS / 60_000),
              proxy: PROXY,
            },
          });

        case 'walmart_search': {
          const a = z.object({
            query: z.string(),
            page: z.number().int().min(1).default(1),
          }).parse(args);
          const url = `https://www.walmart.com/search?q=${encodeURIComponent(a.query)}&page=${a.page}`;
          const result = await safeFetch(url, {
            waitForSelector: '[data-testid="item-stack"], [data-item-id]',
          });
          return ok(result);
        }

        case 'walmart_product': {
          const a = z.object({
            url: z.string().url().optional(),
            itemId: z.string().optional(),
          }).refine(v => v.url || v.itemId, { message: 'url or itemId required' }).parse(args);
          const url = a.url || `https://www.walmart.com/ip/${a.itemId}`;
          const result = await safeFetch(url, {
            waitForSelector: 'h1, [itemprop="name"]',
          });
          return ok(result);
        }

        case 'walmart_fetch': {
          const a = z.object({
            url: z.string().url(),
            responseType: z.enum(['html', 'text', 'json']).default('html'),
            waitForSelector: z.string().optional(),
            timeoutMs: z.number().default(60000),
          }).parse(args);
          const result = await safeFetch(a.url, {
            responseType: a.responseType,
            waitForSelector: a.waitForSelector,
            timeoutMs: a.timeoutMs,
          });
          return ok(result);
        }

        case 'walmart_rewarmup': {
          warmupState.status = 'warming';
          warmupState.startedAt = new Date().toISOString();
          warmupState.error = null;
          const r = await runWarmup({
            userDataDir: USER_DATA_DIR,
            headless: WARMUP_HEADLESS,
            proxy: PROXY,
            useLocalChrome: USE_LOCAL_CHROME,
          });
          warmupState.finishedAt = new Date().toISOString();
          warmupState.firstRun = r.firstRun;
          warmupState.cookies = r.cookies;
          warmupState.status = r.warmed && r.cookies?.pxvid ? 'ready' : 'blocked';
          if (!r.warmed) { warmupState.status = 'error'; warmupState.error = r.error; }
          return ok(warmupState);
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

/** 统一的"安全抓取"入口：状态机管理 + 自动重试 + 被拦时尝试 rewarmup */
async function safeFetch(url, { responseType = 'html', waitForSelector = null, timeoutMs = 60000 } = {}) {
  if (warmupState.status !== 'ready') {
    return {
      ok: false,
      blocked: false,
      error: `service not ready (warmup status=${warmupState.status}). 请等待养号完成或调用 walmart_rewarmup`,
    };
  }
  warmupState.fetchCount += 1;
  const result = await fetchWalmartPagePersistent({
    url,
    userDataDir: USER_DATA_DIR,
    headless: SERVING_HEADLESS,
    proxy: PROXY,
    useLocalChrome: USE_LOCAL_CHROME,
    responseType,
    waitForSelector,
    timeoutMs,
  });
  if (result.blocked) {
    warmupState.blockedCount += 1;
    warmupState.lastFetchBlockedAt = new Date().toISOString();
    warmupState.lastFetchOk = false;
    warmupState.status = 'blocked';
    return {
      ...result,
      hint: '检测到 PerimeterX 校验。请在弹出的浏览器窗口里手动过一次验证，然后调用 walmart_rewarmup',
    };
  }
  warmupState.lastFetchOk = result.ok;
  return result;
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
function err(msg) {
  return { isError: true, content: [{ type: 'text', text: `ERROR: ${msg}` }] };
}

// ---------- SSE HTTP 层 ----------
const app = express();
app.use(express.json({ limit: '4mb' }));

const transports = new Map();

app.get('/', (_req, res) => {
  res.json({
    name: 'walmart-playwright-mcp',
    version: '2.0.0',
    transport: 'sse',
    sse: '/sse',
    messages: '/messages',
    warmup: warmupState,
  });
});

app.get('/healthz', (_req, res) => res.json({
  ok: true,
  warmup: warmupState,
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
  console.log(`[walmart-playwright-mcp] starting...`);
  console.log(`[config] userDataDir=${USER_DATA_DIR}  useLocalChrome=${USE_LOCAL_CHROME}  warmupHeadless=${WARMUP_HEADLESS}  servingHeadless=${SERVING_HEADLESS}  proxy=${PROXY || '<none>'}`);

  // ① 先把 HTTP 起来（这样 dify 即使在养号期间连过来也能拿到 walmart_status）
  app.listen(PORT, HOST, () => {
    console.log(`[walmart-playwright-mcp] listening on http://${HOST}:${PORT}`);
    console.log(`[walmart-playwright-mcp] MCP SSE endpoint:  http://${HOST}:${PORT}/sse`);
    console.log(`[walmart-playwright-mcp] /healthz available immediately. walmart_* tools will refuse calls until warmup is ready.`);
  });

  // ② 然后异步跑养号
  if (!WARMUP_ON_START) {
    warmupState.status = 'ready';
    console.log('[startup] WARMUP_ON_START=false → skipping warmup, server enters ready directly (untested!)');
    return;
  }

  warmupState.status = 'warming';
  warmupState.startedAt = new Date().toISOString();
  console.log('[startup] running warmup ...');
  try {
    const r = await runWarmup({
      userDataDir: USER_DATA_DIR,
      headless: WARMUP_HEADLESS,
      proxy: PROXY,
      useLocalChrome: USE_LOCAL_CHROME,
    });
    warmupState.finishedAt = new Date().toISOString();
    warmupState.firstRun = r.firstRun;
    warmupState.cookies = r.cookies;
    if (r.warmed && r.cookies?.pxvid) {
      warmupState.status = 'ready';
      console.log(`[startup] ✅ warmup complete (firstRun=${r.firstRun}). Server is now serving walmart_*`);
    } else if (r.warmed) {
      warmupState.status = 'blocked';
      console.warn(`[startup] ⚠ warmup finished but PX cookies incomplete. Service marked as blocked. Try walmart_rewarmup after manually clearing captcha.`);
    } else {
      warmupState.status = 'error';
      warmupState.error = r.error;
      console.error(`[startup] ✗ warmup failed: ${r.error}`);
    }

    // ③ 开启维护轮询
    if (warmupState.status === 'ready') {
      startMaintenance({ intervalMs: MAINTENANCE_INTERVAL_MS });
      console.log(`[startup] maintenance heartbeat scheduled every ${Math.round(MAINTENANCE_INTERVAL_MS / 60_000)} min`);
    }
  } catch (e) {
    warmupState.status = 'error';
    warmupState.error = e.message;
    console.error('[startup] warmup exception:', e);
  }
})();

// ---------- 优雅退出 ----------
async function shutdown() {
  console.log('[walmart-playwright-mcp] shutting down...');
  await closePersistent();
  await closeBrowser();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
