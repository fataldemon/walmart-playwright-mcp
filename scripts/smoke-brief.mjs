// smoke 测试：直接 import server.js 那一套提取函数，跑一次完整调用链
// 不走 MCP 协议，模拟一个工具调用，更快验证端到端
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { extractSearchBrief, extractProductBrand } from '../src/walmart-parse.js';

chromium.use(StealthPlugin());

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';

async function runOnNewTab(ctx, url, extractor) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    return await extractor(page);
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  console.log(`[smoke] connecting to ${CDP_URL} ...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];

  // 1) walmart_search_brief("lalula")
  console.log('\n=== TEST 1: walmart_search_brief("lalula", topN=10) ===');
  try {
    const r = await runOnNewTab(ctx, 'https://www.walmart.com/search?q=lalula',
      (p) => extractSearchBrief(p, { topN: 10 }));
    console.log(`OK  totalResults=${r.totalResults}  stacks=${r.stacksCount}  items=${r.items.length}`);
    const payloadStr = JSON.stringify(r);
    console.log(`payload size: ${payloadStr.length} bytes  (~${Math.round(payloadStr.length / r.items.length)} bytes/item)`);
    console.log('first item:', JSON.stringify(r.items[0], null, 2));
  } catch (e) {
    console.error('FAIL', e.code, e.message);
  }

  // 2) walmart_product_brand 第一个 lalula 商品
  console.log('\n=== TEST 2: walmart_product_brand(lalula chandelier) ===');
  try {
    const r = await runOnNewTab(ctx,
      'https://www.walmart.com/ip/Plug-in-Chandelier-Black-4-Light-Modern-Crystal-Light-Fixtures-Ceiling-Hanging-Pendant-Lights-Kitchen-Island/3488989197',
      (p) => extractProductBrand(p));
    const payloadStr = JSON.stringify(r);
    console.log(`payload size: ${payloadStr.length} bytes`);
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error('FAIL', e.code, e.message);
  }

  // 3) 一个无品牌结果的查询（看 inferredBrand 退路）
  console.log('\n=== TEST 3: walmart_search_brief("4-light crystal chandelier", topN=5) ===');
  try {
    const r = await runOnNewTab(ctx, 'https://www.walmart.com/search?q=4-light+crystal+chandelier',
      (p) => extractSearchBrief(p, { topN: 5 }));
    console.log(`OK  totalResults=${r.totalResults}  items=${r.items.length}`);
    r.items.forEach(it => {
      console.log(`  #${it.rank}  brand=${it.brand}  inferred=${it.inferredBrand}  seller=${it.seller}  $${it.price}  ${it.title.slice(0, 60)}`);
    });
  } catch (e) {
    console.error('FAIL', e.code, e.message);
  }

  await browser.close();
  console.log('\n[smoke] done.');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
