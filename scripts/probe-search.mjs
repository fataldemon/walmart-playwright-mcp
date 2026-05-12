// 一次性探针：连接到你 9222 端口开着的 Chrome，抓搜索页 __NEXT_DATA__ 看真实结构
// 用法:  node scripts/probe-search.mjs "airpods"
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

chromium.use(StealthPlugin());

const QUERY = process.argv[2] || 'airpods';
const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';

(async () => {
  console.log(`[probe] connecting to ${CDP_URL} ...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error('no existing context');
  const page = await context.newPage();
  const url = `https://www.walmart.com/search?q=${encodeURIComponent(QUERY)}`;
  console.log(`[probe] goto ${url}`);

  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[probe] status=${resp?.status?.()}  url=${page.url()}`);

  await page.waitForTimeout(3000);   // 给 next-data 注水的时间

  // 抓 __NEXT_DATA__
  const nextData = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el ? el.textContent : null;
  });

  const title = await page.title();
  console.log(`[probe] title="${title}"`);
  console.log(`[probe] __NEXT_DATA__ length=${nextData?.length ?? 0}`);

  mkdirSync('./tmp', { recursive: true });

  if (!nextData) {
    const html = await page.content();
    writeFileSync('./tmp/probe-fallback.html', html);
    console.log('[probe] no __NEXT_DATA__! saved full HTML → tmp/probe-fallback.html');
    await page.close();
    await browser.close();
    return;
  }

  writeFileSync('./tmp/probe-next-raw.json', nextData);
  console.log('[probe] raw next-data → tmp/probe-next-raw.json');

  let nd;
  try { nd = JSON.parse(nextData); } catch (e) { console.error('[probe] parse error:', e.message); process.exit(1); }

  // 探测路径
  const sr = nd?.props?.pageProps?.initialData?.searchResult;
  console.log('\n[probe] === searchResult keys ===');
  console.log(sr ? Object.keys(sr) : 'NULL');

  if (sr) {
    const stacks = sr.itemStacks || [];
    console.log(`[probe] itemStacks.length = ${stacks.length}`);
    stacks.forEach((s, i) => {
      const items = s.items || [];
      const typenames = {};
      items.forEach(it => { const t = it.__typename || '(none)'; typenames[t] = (typenames[t] || 0) + 1; });
      console.log(`  stack[${i}]  meta=${JSON.stringify(s.meta || {})}  items=${items.length}  typenames=${JSON.stringify(typenames)}`);
    });

    // dump 第一个 Product item 完整字段
    let firstProduct = null;
    outer: for (const s of stacks) {
      for (const it of (s.items || [])) {
        if (it.__typename === 'Product') { firstProduct = it; break outer; }
      }
    }
    if (firstProduct) {
      console.log('\n[probe] === first Product item keys ===');
      console.log(Object.keys(firstProduct).sort());
      console.log('\n[probe] === selected fields ===');
      const pick = (obj, paths) => Object.fromEntries(paths.map(p => [p, p.split('.').reduce((o, k) => o?.[k], obj)]));
      const snapshot = pick(firstProduct, [
        'name', 'brand', 'brandName',
        'sellerName', 'sellerDisplayName', 'sellerId',
        'priceInfo.linePrice', 'priceInfo.currentPrice.price', 'priceInfo.itemPrice',
        'canonicalUrl', 'usItemId', 'itemId',
        'averageRating', 'numberOfReviews',
        'isSponsoredFlag', 'isAtcBoosted', 'sponsoredProduct',
        'availabilityStatusV2.display', 'availabilityStatus',
        'imageInfo.thumbnailUrl', 'imageUrl',
        '__typename',
      ]);
      console.log(JSON.stringify(snapshot, null, 2));
      writeFileSync('./tmp/probe-first-product.json', JSON.stringify(firstProduct, null, 2));
      console.log('\n[probe] full first product → tmp/probe-first-product.json');

      // dump 前 3 个全部商品的精选字段
      const top3 = [];
      let collected = 0;
      for (const s of stacks) {
        for (const it of (s.items || [])) {
          if (it.__typename !== 'Product') continue;
          top3.push({ rank: collected + 1, ...pick(it, ['name','brand','sellerName','sellerDisplayName','priceInfo.linePrice','priceInfo.currentPrice.price','usItemId','canonicalUrl','isSponsoredFlag']) });
          collected++;
          if (collected >= 3) break;
        }
        if (collected >= 3) break;
      }
      console.log('\n[probe] === top 3 brief ===');
      console.log(JSON.stringify(top3, null, 2));
    } else {
      console.log('[probe] no Product typenames found! check stacks');
    }
  }

  await page.close();
  await browser.close();
  console.log('\n[probe] done. 看 tmp/probe-first-product.json 获得完整商品对象。');
})().catch(e => { console.error('[probe] FATAL:', e); process.exit(1); });
