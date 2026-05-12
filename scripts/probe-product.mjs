// 详情页 probe：抓商品详情页的 __NEXT_DATA__，定位 brand / brandUrl / sellerName 路径
// 用法:  node scripts/probe-product.mjs "/ip/.../12345678"   (相对路径或完整 URL 都行)
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, mkdirSync } from 'node:fs';

chromium.use(StealthPlugin());

const ARG = process.argv[2];
if (!ARG) {
  console.error('usage: node scripts/probe-product.mjs "<canonicalUrl-or-fullUrl>"');
  process.exit(1);
}
const url = ARG.startsWith('http') ? ARG : 'https://www.walmart.com' + ARG;
const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';

// 工具：在大 JSON 里递归找包含某关键字的所有 key/value
function findPaths(obj, predicate, path = '$', out = [], maxDepth = 30) {
  if (maxDepth <= 0 || obj == null) return out;
  if (typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const p = `${path}.${k}`;
    if (predicate(k, v)) out.push({ path: p, value: typeof v === 'string' ? v.slice(0, 200) : v });
    if (out.length >= 60) return out;
    if (v && typeof v === 'object') findPaths(v, predicate, p, out, maxDepth - 1);
  }
  return out;
}

(async () => {
  console.log(`[probe-product] connecting to ${CDP_URL} ...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  console.log(`[probe-product] goto ${url}`);
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[probe-product] status=${resp?.status?.()}  finalUrl=${page.url()}`);
  await page.waitForTimeout(3000);

  const title = await page.title();
  console.log(`[probe-product] title="${title}"`);

  const nextData = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el ? el.textContent : null;
  });
  console.log(`[probe-product] __NEXT_DATA__ length=${nextData?.length ?? 0}`);

  mkdirSync('./tmp', { recursive: true });
  if (!nextData) {
    writeFileSync('./tmp/probe-product-fallback.html', await page.content());
    console.log('[probe-product] NO __NEXT_DATA__! HTML saved tmp/probe-product-fallback.html');
    await page.close(); await browser.close();
    return;
  }
  writeFileSync('./tmp/probe-product-raw.json', nextData);

  const nd = JSON.parse(nextData);

  // 找 pageProps 入口
  const pp = nd?.props?.pageProps;
  console.log('\n[probe-product] === pageProps keys ===');
  console.log(pp ? Object.keys(pp) : 'NULL');

  const initialData = pp?.initialData;
  console.log('\n[probe-product] === initialData keys ===');
  console.log(initialData ? Object.keys(initialData) : 'NULL');

  const product = initialData?.data?.product || initialData?.product || pp?.product;
  if (product) {
    console.log('\n[probe-product] === product top keys ===');
    console.log(Object.keys(product).sort());

    // 关键字段抓取
    const pick = (obj, paths) => Object.fromEntries(paths.map(p => [p, p.split('.').reduce((o, k) => o?.[k], obj)]));
    const snapshot = pick(product, [
      'name', 'brand', 'brandName', 'brandUrl', 'brandLink',
      'sellerName', 'sellerDisplayName', 'sellerId',
      'manufacturerName', 'manufacturer',
      'usItemId', 'itemId',
      'canonicalUrl',
    ]);
    console.log('\n[probe-product] === product field snapshot ===');
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log('\n[probe-product] no product object directly under initialData. Falling back to global search...');
  }

  // 全局搜：找所有包含 "brand" 的 key
  console.log('\n[probe-product] === global search keys containing "brand" ===');
  const brandHits = findPaths(nd, (k, v) =>
    /brand/i.test(k) && (typeof v === 'string' || typeof v === 'number' || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length < 8))
  );
  brandHits.slice(0, 30).forEach(h => {
    const vstr = typeof h.value === 'object' ? JSON.stringify(h.value).slice(0, 200) : h.value;
    console.log(`  ${h.path}  =>  ${vstr}`);
  });

  // 全局搜：包含 facet=brand 的字符串
  console.log('\n[probe-product] === global search for strings containing "facet=brand" or "/brand/" ===');
  const linkHits = findPaths(nd, (k, v) =>
    typeof v === 'string' && (/facet=brand/i.test(v) || /\/brand\//i.test(v))
  );
  linkHits.slice(0, 20).forEach(h => console.log(`  ${h.path}  =>  ${h.value}`));

  // 全局搜：seller
  console.log('\n[probe-product] === global search keys containing "seller" ===');
  const sellerHits = findPaths(nd, (k, v) =>
    /sellerName|sellerDisplayName|sellerId/i.test(k) && (typeof v === 'string' || typeof v === 'number')
  );
  sellerHits.slice(0, 20).forEach(h => console.log(`  ${h.path}  =>  ${h.value}`));

  // 看下页面 DOM 里 brand 相关锚点
  console.log('\n[probe-product] === DOM scan for brand anchors ===');
  const domBrand = await page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href*="brand"]')];
    return anchors.slice(0, 15).map(a => ({
      text: a.textContent.trim().slice(0, 80),
      href: a.getAttribute('href'),
      ariaLabel: a.getAttribute('aria-label'),
    }));
  });
  domBrand.forEach(a => console.log(`  [a] text="${a.text}"  href="${a.href}"`));

  await page.close();
  await browser.close();
  console.log('\n[probe-product] done. Raw → tmp/probe-product-raw.json');
})().catch(e => { console.error('[probe-product] FATAL:', e); process.exit(1); });
