#!/usr/bin/env node
// server.js —— Playwright MCP（Walmart 反人机版）SSE 服务
// 暴露在 http://0.0.0.0:8931/sse  (Docker 内即 host.docker.internal:8931)
//
// 提供给 MCP 客户端的工具：
//   - pxvid_stats        : 看令牌池状态
//   - pxvid_refresh      : 立即补充一批新令牌
//   - walmart_fetch      : 抓任意 walmart.com 页面 (自动用 ready 的 _pxvid)
//   - walmart_search     : 搜索词 -> 商品列表
//   - walmart_product    : 商品 URL/ID -> 商品详情
//   - playwright_goto    : 通用 playwright 导航（带 stealth，可抓非沃尔玛站点）

import express from 'express';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { existsSync } from 'node:fs';
import { chromium as pwBaseChromium } from 'playwright';
import { PxvidPool } from './pxvid-pool.js';
import { fetchWalmartPage, getBrowser, closeBrowser, getCurrentBrowserMode } from './browser.js';

// 启动自检：Playwright 是否装了完整 chromium 可执行文件
function preflightCheckChromium() {
  try {
    const exe = pwBaseChromium.executablePath();
    if (!exe || !existsSync(exe)) {
      console.error('');
      console.error('╔══════════════════════════════════════════════════════════════╗');
      console.error('║  Playwright chromium 浏览器未安装或路径丢失！                 ║');
      console.error('║  请在项目目录执行：                                            ║');
      console.error('║      npx playwright install chromium                          ║');
      console.error('║  没有它，浏览器 fallback 将无法获取 _pxvid。                   ║');
      console.error('╚══════════════════════════════════════════════════════════════╝');
      console.error('');
    } else {
      console.log(`[preflight] chromium executable OK: ${exe}`);
    }
  } catch (e) {
    console.warn('[preflight] cannot resolve chromium path:', e.message);
  }
}
preflightCheckChromium();

// ---------- 配置（运行时可变） ----------
const PORT = parseInt(process.env.PORT || '8931', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PROXY = process.env.PROXY || null;          // e.g. http://user:pass@host:port
// HEADLESS 改为可变全局：可通过 MCP tool `set_headless` 在运行时切换
let HEADLESS = process.env.HEADLESS !== 'false';
const PRIMARY = parseInt(process.env.PXVID_PRIMARY || '5', 10);
const SECONDARY = parseInt(process.env.PXVID_SECONDARY || '5', 10);
const ACTIVATION_MS = parseInt(process.env.PXVID_ACTIVATION_MS || '10000', 10);

// ---------- 令牌池启动 ----------
const pool = new PxvidPool({
  primarySize: PRIMARY,
  secondarySize: SECONDARY,
  activationMs: ACTIVATION_MS,
  proxy: PROXY,
  getHeadless: () => HEADLESS,   // 让池里浏览器 fallback 跟随 set_headless
});
pool.start().catch(err => console.error('[pool] start error:', err));

// ---------- MCP server 工厂 ----------
function buildMcpServer() {
  const server = new Server(
    { name: 'walmart-playwright-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // 工具元数据
  const tools = [
    {
      name: 'pxvid_stats',
      description: '获取 _pxvid 令牌池当前状态（总数 / 已生效 / 平均年龄）',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'pxvid_refresh',
      description: '强制丢弃所有现有令牌并重新批量生成',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'walmart_fetch',
      description:
        '使用反人机方案抓取任意 walmart.com 页面。自动从池中取一个已生效的 _pxvid 注入 cookie，并使用 stealth 浏览器渲染。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整的 walmart.com URL' },
          responseType: { type: 'string', enum: ['html', 'text', 'json'], default: 'html' },
          waitForSelector: { type: 'string', description: '可选：抓取前等待出现的 CSS 选择器' },
          timeoutMs: { type: 'number', default: 45000 },
        },
        required: ['url'],
      },
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
          url: { type: 'string', description: '商品页 URL（与 itemId 二选一）' },
          itemId: { type: 'string', description: '商品 ID（如 1234567890）' },
        },
      },
    },
    {
      name: 'playwright_goto',
      description: '通用 stealth Playwright 抓取（任意域名，不注入 _pxvid）',
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
    {
      name: 'set_headless',
      description:
        '运行时切换浏览器是否无头。true=不显示窗口；false=弹出 Chromium 窗口（仅本地非容器/非服务化运行时可见）。切换后会关闭并重启浏览器。',
      inputSchema: {
        type: 'object',
        properties: {
          headless: { type: 'boolean' },
        },
        required: ['headless'],
      },
    },
    {
      name: 'browser_status',
      description: '查看当前浏览器是否在运行、当前是有头还是无头、是否配置代理',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  // 工具调度
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      switch (name) {
        case 'pxvid_stats':
          return ok(pool.stats());

        case 'pxvid_refresh': {
          pool.tokens.length = 0;
          await pool._fill(PRIMARY + SECONDARY);
          return ok({ refreshed: true, ...pool.stats() });
        }

        case 'walmart_fetch': {
          const schema = z.object({
            url: z.string().url(),
            responseType: z.enum(['html', 'text', 'json']).default('html'),
            waitForSelector: z.string().optional(),
            timeoutMs: z.number().default(45000),
          });
          const a = schema.parse(args);
          const token = await pool.acquire();
          const result = await fetchWalmartPage({
            url: a.url,
            token,
            headless: HEADLESS,
            proxy: PROXY,
            responseType: a.responseType,
            waitForSelector: a.waitForSelector || null,
            timeoutMs: a.timeoutMs,
          });
          // 若被拦截，尝试换一个 token 再试一次
          if (result.blocked) {
            const token2 = await pool.acquire();
            const retry = await fetchWalmartPage({
              url: a.url,
              token: token2,
              headless: HEADLESS,
              proxy: PROXY,
              responseType: a.responseType,
              waitForSelector: a.waitForSelector || null,
              timeoutMs: a.timeoutMs,
            });
            return ok(retry);
          }
          return ok(result);
        }

        case 'walmart_search': {
          const schema = z.object({
            query: z.string(),
            page: z.number().int().min(1).default(1),
          });
          const a = schema.parse(args);
          const url = `https://www.walmart.com/search?q=${encodeURIComponent(a.query)}&page=${a.page}`;
          const token = await pool.acquire();
          const result = await fetchWalmartPage({
            url, token,
            headless: HEADLESS, proxy: PROXY,
            responseType: 'html',
            waitForSelector: '[data-testid="item-stack"], [data-item-id]',
          });
          return ok(result);
        }

        case 'walmart_product': {
          const schema = z.object({
            url: z.string().url().optional(),
            itemId: z.string().optional(),
          }).refine(v => v.url || v.itemId, { message: 'url or itemId required' });
          const a = schema.parse(args);
          const url = a.url || `https://www.walmart.com/ip/${a.itemId}`;
          const token = await pool.acquire();
          const result = await fetchWalmartPage({
            url, token,
            headless: HEADLESS, proxy: PROXY,
            responseType: 'html',
            waitForSelector: 'h1, [itemprop="name"]',
          });
          return ok(result);
        }

        case 'playwright_goto': {
          const schema = z.object({
            url: z.string().url(),
            responseType: z.enum(['html', 'text']).default('html'),
            waitForSelector: z.string().optional(),
          });
          const a = schema.parse(args);
          const browser = await getBrowser({ headless: HEADLESS, proxy: PROXY });
          const context = await browser.newContext();
          const page = await context.newPage();
          try {
            const resp = await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            if (a.waitForSelector) {
              await page.waitForSelector(a.waitForSelector, { timeout: 30000 }).catch(() => {});
            }
            const data = a.responseType === 'text'
              ? await page.evaluate(() => document.body.innerText)
              : await page.content();
            return ok({ status: resp?.status() ?? 0, url: page.url(), data });
          } finally {
            await context.close().catch(() => {});
          }
        }

        case 'set_headless': {
          const schema = z.object({ headless: z.boolean() });
          const a = schema.parse(args);
          HEADLESS = a.headless;
          // 主动触发浏览器重启，使变更立刻可见
          await closeBrowser();
          await getBrowser({ headless: HEADLESS, proxy: PROXY });
          console.log(`[server] HEADLESS set to ${HEADLESS} via MCP tool`);
          return ok({ headless: HEADLESS, browser: getCurrentBrowserMode() });
        }

        case 'browser_status':
          return ok({ headless: HEADLESS, ...getCurrentBrowserMode() });

        default:
          return err(`unknown tool: ${name}`);
      }
    } catch (e) {
      return err(e?.message || String(e));
    }
  });

  return server;
}

function ok(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}
function err(msg) {
  return {
    isError: true,
    content: [{ type: 'text', text: `ERROR: ${msg}` }],
  };
}

// ---------- SSE HTTP 层 ----------
const app = express();
app.use(express.json({ limit: '4mb' }));

// 维护 sessionId -> transport
const transports = new Map();

app.get('/', (_req, res) => {
  res.json({
    name: 'walmart-playwright-mcp',
    transport: 'sse',
    sse: `/sse`,
    messages: `/messages`,
    poolStats: pool.stats(),
  });
});

app.get('/healthz', (_req, res) => res.json({
  ok: true,
  pool: pool.stats(),
  headless: HEADLESS,
  browser: getCurrentBrowserMode(),
}));

// SSE 端点（MCP client 连这里）
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);

  res.on('close', () => {
    transports.delete(transport.sessionId);
  });

  const server = buildMcpServer();
  await server.connect(transport);
});

// 客户端 -> 服务端的消息回传通道
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) {
    return res.status(400).send('No active SSE session for sessionId');
  }
  await transport.handlePostMessage(req, res, req.body);
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`[walmart-playwright-mcp] listening on http://${HOST}:${PORT}`);
  console.log(`[walmart-playwright-mcp] MCP SSE endpoint:  http://${HOST}:${PORT}/sse`);
  console.log(`[walmart-playwright-mcp] config: headless=${HEADLESS} proxy=${PROXY || '<none>'} primary=${PRIMARY} secondary=${SECONDARY}`);
});

// 优雅退出
async function shutdown() {
  console.log('[walmart-playwright-mcp] shutting down...');
  pool.stop();
  await closeBrowser();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
