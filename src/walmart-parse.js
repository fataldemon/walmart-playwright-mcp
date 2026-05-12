// walmart-parse.js —— 基于 probe 实证的 __NEXT_DATA__ 解析
//
// 路径来源：scripts/probe-search.mjs 与 scripts/probe-product.mjs 真实抓取
//
// 搜索页:  props.pageProps.initialData.searchResult.itemStacks[].items[]
// 详情页:  props.pageProps.initialData.data.product  + initialData.data.seoItemMetaData

/** 错误码 */
export const ParseError = {
  PX_BLOCKED:           'PX_BLOCKED',
  NEXT_DATA_NOT_FOUND:  'NEXT_DATA_NOT_FOUND',
  NEXT_DATA_PARSE_FAIL: 'NEXT_DATA_PARSE_FAIL',
  EMPTY_RESULT:         'EMPTY_RESULT',
  NAVIGATION_TIMEOUT:   'NAVIGATION_TIMEOUT',
  PRODUCT_NOT_FOUND:    'PRODUCT_NOT_FOUND',
};

/** 检测是否落到 PX 挑战页 */
export async function detectChallenge(page) {
  return await page.evaluate(() => {
    const t = (document.title || '').toLowerCase();
    const b = (document.body?.innerText || '').slice(0, 600).toLowerCase();
    return /robot or human|verify you are|access denied|px-captcha|are you a human|press (?:and|&) hold/.test(t + ' ' + b);
  }).catch(() => false);
}

/** 读 __NEXT_DATA__ 并解析；抛出标准错误码 */
async function readNextData(page) {
  const raw = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el ? el.textContent : null;
  });
  if (!raw) {
    const e = new Error('No <script id="__NEXT_DATA__"> found on page');
    e.code = ParseError.NEXT_DATA_NOT_FOUND;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const e = new Error('Failed to JSON.parse __NEXT_DATA__: ' + err.message);
    e.code = ParseError.NEXT_DATA_PARSE_FAIL;
    throw e;
  }
}

/** 从商品标题提取首词作为 inferredBrand（用于搜索页 brand 为 null 时的备选） */
function inferBrandFromTitle(name) {
  if (!name || typeof name !== 'string') return null;
  // 取第一个 token；如果是常见词（"4-light", "20\"")则用第二个
  const tokens = name.split(/[\s,]+/).filter(Boolean);
  for (const t of tokens) {
    // 跳过纯数字、尺寸、明显的描述词
    if (/^\d/.test(t)) continue;
    if (/^["']/.test(t)) continue;
    if (t.length < 2 || t.length > 25) continue;
    // 必须看起来像品牌：全大写 或 首字母大写
    if (/^[A-Z][A-Za-z0-9'-]*$/.test(t) || /^[A-Z]{2,}/.test(t)) {
      return t;
    }
  }
  return null;
}

/** 解析 priceInfo → 数字价格 + display string */
function parsePrice(priceInfo) {
  if (!priceInfo) return { price: null, priceDisplay: null };
  const display = priceInfo.linePrice || priceInfo.itemPrice || priceInfo.priceDisplay || null;
  let price = priceInfo.currentPrice?.price;
  if (typeof price !== 'number') {
    if (typeof display === 'string') {
      const m = display.match(/[\d.]+/);
      price = m ? parseFloat(m[0]) : null;
    } else {
      price = null;
    }
  }
  return { price, priceDisplay: display };
}

/**
 * 提取搜索页前 topN 个商品（精简结构）。
 * 输入: 已经 page.goto 完毕的 Page，返回 { ok, items, totalResults, parseSource, ... }
 */
export async function extractSearchBrief(page, { topN = 10 } = {}) {
  if (await detectChallenge(page)) {
    const e = new Error(`Page is a PerimeterX challenge: title="${await page.title()}" url="${page.url()}"`);
    e.code = ParseError.PX_BLOCKED;
    throw e;
  }

  const nd = await readNextData(page);
  const sr = nd?.props?.pageProps?.initialData?.searchResult;
  if (!sr) {
    const e = new Error('searchResult node missing in __NEXT_DATA__');
    e.code = ParseError.NEXT_DATA_NOT_FOUND;
    throw e;
  }

  const stacks = sr.itemStacks || [];
  const items = [];
  let stackIdx = -1;
  for (const stack of stacks) {
    stackIdx++;
    for (const it of (stack.items || [])) {
      if (it.__typename !== 'Product') continue;        // 过滤 AdPlaceholder 等
      if (items.length >= topN) break;
      const { price, priceDisplay } = parsePrice(it.priceInfo);
      items.push({
        rank: items.length + 1,
        stackIndex: stackIdx,
        title: it.name ?? null,
        brand: it.brand ?? null,                          // 搜索页常 null
        inferredBrand: inferBrandFromTitle(it.name),     // 标题首词推断
        seller: it.sellerName ?? it.sellerDisplayName ?? null,
        sellerId: it.sellerId ?? null,
        price,
        priceDisplay,
        currency: 'USD',
        productUrl: it.canonicalUrl ? `https://www.walmart.com${it.canonicalUrl}` : null,
        itemId: it.usItemId ?? it.itemId ?? null,
        rating: typeof it.averageRating === 'number' ? it.averageRating : null,
        reviewCount: typeof it.numberOfReviews === 'number' ? it.numberOfReviews : null,
        sponsored: !!it.isSponsoredFlag,
        availability: it.availabilityStatusV2?.display ?? it.availabilityStatusDisplayValue ?? null,
        imageUrl: it.imageInfo?.thumbnailUrl ?? null,
      });
    }
    if (items.length >= topN) break;
  }

  if (items.length === 0) {
    const e = new Error(`searchResult has ${stacks.length} stacks but no Product items found`);
    e.code = ParseError.EMPTY_RESULT;
    throw e;
  }

  return {
    items,
    totalResults: sr.count ?? sr.aggregatedCount ?? null,
    stacksCount: stacks.length,
    parseSource: 'next-data',
  };
}

/**
 * 提取商品详情页的品牌 + 商家信息（精简结构）。
 * 输入: 已经 page.goto 完毕的详情页 Page
 *
 * 字段路径 (probe 实证):
 *   product.brand                                 -> "LaLuLa"
 *   product.brandUrl                              -> "/search?q=LaLuLa&facet=brand:LaLuLa"
 *   seoItemMetaData.brandCanonical                -> "/browse/0?facet=brand:LaLuLa"  ★ 最规范
 *   product.sellerDisplayName                     -> "LaLuLa"   (用户看到的)
 *   product.sellerName                            -> "GUANGZHOU SHI XI MA LA YA..."  (法人公司名)
 */
export async function extractProductBrand(page) {
  if (await detectChallenge(page)) {
    const e = new Error(`Page is a PerimeterX challenge: title="${await page.title()}" url="${page.url()}"`);
    e.code = ParseError.PX_BLOCKED;
    throw e;
  }

  const nd = await readNextData(page);
  const data = nd?.props?.pageProps?.initialData?.data;
  const product = data?.product;
  if (!product) {
    const e = new Error('product node missing in __NEXT_DATA__.props.pageProps.initialData.data.product');
    e.code = ParseError.PRODUCT_NOT_FOUND;
    throw e;
  }

  const brand = product.brand ?? data?.seoItemMetaData?.brand ?? null;
  const brandUrlRel = data?.seoItemMetaData?.brandCanonical || product.brandUrl || null;
  const brandUrl = brandUrlRel
    ? (brandUrlRel.startsWith('http') ? brandUrlRel : 'https://www.walmart.com' + brandUrlRel)
    : null;

  // 还做一次 DOM fallback（probe 显示 a[href*="facet=brand"] 总是存在）
  let domBrandHref = null;
  if (!brandUrl) {
    domBrandHref = await page.evaluate(() => {
      const a = document.querySelector('a[href*="facet=brand"]');
      return a ? a.getAttribute('href') : null;
    }).catch(() => null);
  }

  const { price, priceDisplay } = parsePrice(product.priceInfo);

  return {
    parseSource: 'next-data',
    title: product.name ?? null,
    brand,
    brandUrl: brandUrl || (domBrandHref ? 'https://www.walmart.com' + domBrandHref : null),
    seller: product.sellerDisplayName ?? null,           // 用户看到的店名
    sellerLegalName: product.sellerName ?? null,         // 法人公司名（可能很长）
    sellerId: product.sellerId ?? null,
    itemId: product.usItemId ?? product.id ?? null,
    productUrl: page.url(),
    price,
    priceDisplay,
    currency: 'USD',
    manufacturer: product.manufacturerName ?? null,
    rating: typeof product.averageRating === 'number' ? product.averageRating : null,
    reviewCount: typeof product.numberOfReviews === 'number' ? product.numberOfReviews : null,
    availability: product.availabilityStatusV2?.display ?? product.availabilityStatus ?? null,
  };
}
