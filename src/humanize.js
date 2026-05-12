// humanize.js —— 模拟"真人浏览行为"的小工具集
// 在每次抓取/导航前后调用，让 PerimeterX 的行为模型把我们打成 high-trust 用户。
//
// 用法：
//   import { humanize } from './humanize.js';
//   await page.goto(url);
//   await humanize.afterLand(page);
//   const html = await page.content();

import { randomInt } from 'node:crypto';

function rand(min, max) {
  return min + Math.random() * (max - min);
}
function randInt(min, max) {
  return randomInt(min, max + 1);
}

/** 随机停留 */
async function idle(page, minMs = 600, maxMs = 1800) {
  await page.waitForTimeout(Math.floor(rand(minMs, maxMs))).catch(() => {});
}

/** 贝塞尔曲线鼠标移动：从当前位置到目标位置 */
async function moveMouseSmooth(page, toX, toY, steps = 20) {
  // 从一个随机起点开始，画一条带噪声的二次贝塞尔到目标点
  const fromX = randInt(50, 400);
  const fromY = randInt(50, 400);
  const cpX = (fromX + toX) / 2 + randInt(-150, 150);
  const cpY = (fromY + toY) / 2 + randInt(-150, 150);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) ** 2 * fromX + 2 * (1 - t) * t * cpX + t ** 2 * toX;
    const y = (1 - t) ** 2 * fromY + 2 * (1 - t) * t * cpY + t ** 2 * toY;
    // 加点抖动
    const jx = x + rand(-1.5, 1.5);
    const jy = y + rand(-1.5, 1.5);
    await page.mouse.move(jx, jy).catch(() => {});
    await page.waitForTimeout(rand(8, 22)).catch(() => {});
  }
}

/** 随机鼠标飘几个点 */
async function randomMouseWander(page, n = 3) {
  const viewport = page.viewportSize() || { width: 1366, height: 768 };
  for (let i = 0; i < n; i++) {
    const x = randInt(50, viewport.width - 50);
    const y = randInt(50, viewport.height - 50);
    await moveMouseSmooth(page, x, y, randInt(10, 25));
    await idle(page, 100, 400);
  }
}

/** 模拟"用鼠标轮"或"轨迹板"滚动 */
async function humanScroll(page, distance = null) {
  const total = distance ?? randInt(400, 1500);
  let scrolled = 0;
  while (scrolled < total) {
    const step = randInt(80, 220);
    await page.mouse.wheel(0, step).catch(() => {});
    scrolled += step;
    await page.waitForTimeout(rand(80, 280)).catch(() => {});
  }
  // 偶尔往回滚一点
  if (Math.random() < 0.3) {
    await page.mouse.wheel(0, -randInt(100, 250)).catch(() => {});
    await idle(page, 200, 600);
  }
}

/** 抓取页面着陆后跑这一套，~1-3 秒 */
async function afterLand(page) {
  await idle(page, 400, 1200);
  await randomMouseWander(page, randInt(2, 4));
  if (Math.random() < 0.7) await humanScroll(page, randInt(300, 900));
  await idle(page, 200, 800);
}

/** 养号专用：在 walmart 首页模拟一个"真人闲逛"的流程，~30-60 秒 */
async function warmupBrowse(page, logger = console) {
  logger.log?.('[humanize] warmup: landing on walmart.com homepage...');
  await page.goto('https://www.walmart.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await idle(page, 2500, 4500);
  await randomMouseWander(page, 4);
  await humanScroll(page, randInt(800, 1600));
  await idle(page, 1500, 3000);

  // 滚回顶部，看一下导航栏
  await page.mouse.wheel(0, -3000).catch(() => {});
  await idle(page, 1000, 2500);
  await randomMouseWander(page, 3);

  // 点击搜索框 + 输入但不提交（模拟真人在思考要搜什么）
  try {
    const searchBox = await page.$('input[type="search"], input[name="q"], input[aria-label*="Search"]');
    if (searchBox) {
      const box = await searchBox.boundingBox();
      if (box) {
        await moveMouseSmooth(page, box.x + box.width / 2, box.y + box.height / 2, 25);
        await idle(page, 300, 800);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
        await idle(page, 300, 600);
        const word = ['airpods', 'nintendo', 'coffee', 'shoes'][randInt(0, 3)];
        for (const ch of word) {
          await page.keyboard.type(ch).catch(() => {});
          await page.waitForTimeout(rand(80, 240)).catch(() => {});
        }
        await idle(page, 800, 1800);
        // 清空，模拟"算了不搜了"
        for (let i = 0; i < word.length; i++) {
          await page.keyboard.press('Backspace').catch(() => {});
          await page.waitForTimeout(rand(40, 120)).catch(() => {});
        }
      }
    }
  } catch (e) {
    logger.warn?.('[humanize] warmup: search-box interaction skipped:', e.message);
  }

  await idle(page, 1000, 2500);
  await randomMouseWander(page, 2);
  await humanScroll(page, randInt(400, 900));
  logger.log?.('[humanize] warmup: done');
}

export const humanize = {
  idle,
  moveMouseSmooth,
  randomMouseWander,
  humanScroll,
  afterLand,
  warmupBrowse,
};
