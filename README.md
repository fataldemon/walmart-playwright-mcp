# walmart-playwright-mcp · v3.1 CDP 接管 + 精简侵权排查端点

> 一个**本地部署**的 Playwright MCP 服务，专门用于绕过 **Walmart (PerimeterX)** 的人机验证。
> 通过 SSE 暴露在 `http://host.docker.internal:8931/sse`，可直接接入 Dify / Cline / Claude Desktop 等 MCP Client。

---

## ★ v3.1 新增：精简结构化端点（强烈推荐使用）

v3.0 的 `walmart_search` / `walmart_product` 返回**完整 HTML**（一次 200KB+），扔给 LLM 既慢又烧 token。
v3.1 新增 3 个**专为 dify/LLM 工作流**设计的端点，返回 JSON、**节省 98% token**：

| 工具 | 输入 | 输出大小（实测） | 用途 |
| --- | --- | --- | --- |
| `walmart_search_brief` | `query`, `topN`（默认 10）| ~900 B/item × 10 ≈ 9 KB | **搜索 + 提取前 10 商品**：title, brand, **seller** (★关键), price, itemId, productUrl, rating, sponsored... |
| `walmart_search_brief_batch` | `queries[]`（≤20）| 上面 × N | **批量搜索**：内部串行 + 每次随机 sleep 3-8s + 任意 PX_BLOCKED 立即中止 |
| `walmart_product_brand` | `url` 或 `itemId` | ~700 B | **详情页品牌核对**：brand, **brandUrl**（`/browse/0?facet=brand:Xxx` 完整链接）, sellerDisplayName, sellerLegalName |

### 字段说明（重要）

- **搜索页的 `brand` 字段经常为 null**（Walmart 行为）→ 用 `seller` 和 `inferredBrand`（标题首词）兜底
- **第三方小品牌**（侵权排查主要场景）的 `sellerName` 通常 = 品牌名（实测 LaLuLa / AOLALA / NATYSWAN 都是这样）
- **真正的品牌核对**用 `walmart_product_brand`：`brand` 字段在详情页 100% 可靠，且 `brandUrl` 就是你 prompt 里要的 `facet=brand:Xxx` 链接

### dify 侵权排查 workflow 示例

```text
用户输入：商品标题 = "CNRATYE 20\" Modern Farmhouse Crystal Chandeliers ..."
                     涉嫌侵权品牌 = "CNRATYE"

步骤 1：调用 walmart_search_brief(query="CNRATYE Crystal Chandelier", topN=10)
        → 拿到前 10 个商品的精简 JSON（含 seller 字段，~9 KB）

步骤 2：LLM 判断
        - 看 items[].seller 和 items[].inferredBrand
        - 如果前 10 个 seller 里没有 "CNRATYE" → 直接判"未侵权"（最常见，1 次访问搞定）
        - 如果有疑似 → 进入步骤 3

步骤 3：对疑似商品调用 walmart_product_brand(itemId=...)
        → 拿到详情页真实 brand + brandUrl
        → LLM 比对 brand == "CNRATYE" 决定是否真的侵权
```

### 调用示例

```jsonc
// dify 工具调用
{
  "tool": "walmart_search_brief",
  "args": { "query": "lalula chandelier", "topN": 10 }
}
// 返回：
{
  "ok": true,
  "query": "lalula chandelier",
  "url": "https://www.walmart.com/search?q=lalula%20chandelier",
  "totalResults": 4,
  "stacksCount": 1,
  "parseSource": "next-data",
  "items": [
    {
      "rank": 1,
      "title": "4-Light Elegant Black Finish Plug-in Crystal Chandelier...",
      "brand": null,
      "inferredBrand": "Elegant",
      "seller": "LaLuLa",            // ★ 第三方品牌 seller 通常 = 品牌名
      "price": 50.95,
      "priceDisplay": "$50.95",
      "productUrl": "https://www.walmart.com/ip/.../3488989197?...",
      "itemId": "3488989197",
      "rating": 4.7,
      "reviewCount": 36,
      "sponsored": false,
      "availability": "In stock",
      "imageUrl": "https://i5.walmartimages.com/..."
    }
    // ... 共 10 条
  ]
}

// 再调一次品牌核对：
{
  "tool": "walmart_product_brand",
  "args": { "itemId": "3488989197" }
}
// 返回：
{
  "ok": true,
  "brand": "LaLuLa",
  "brandUrl": "https://www.walmart.com/browse/0?facet=brand:LaLuLa",   // ★ 这就是你要的链接
  "seller": "LaLuLa",
  "sellerLegalName": "GUANGZHOU SHI XI MA LA YA GUO JI MAO YI YOU XIAN GONG SI",
  "title": "...",
  "itemId": "3488989197",
  "price": 50.95
}
```

### 错误码

所有新端点返回 `{ ok: false, errorCode, errorMessage, ... }`，错误码：

| Code | 含义 | dify 该怎么办 |
| --- | --- | --- |
| `SERVICE_NOT_READY` | Chrome 还没起 / 服务还在 connecting | 等几秒重试，或通知运维双击 `start-chrome.bat` |
| `PX_BLOCKED` | 落到 PerimeterX 验证页 | **立即停止后续调用**，通知人工去那个 Chrome 窗口手动过验证后调 `walmart_rewarmup` |
| `NEXT_DATA_NOT_FOUND` | 页面没有 `__NEXT_DATA__`（罕见，可能 Walmart 改版）| 当作软失败，跳过 |
| `EMPTY_RESULT` | 关键词查无结果 | 业务正常，不算错误 |
| `PRODUCT_NOT_FOUND` | 详情页 `data.product` 缺失 | 当作软失败 |
| `NAVIGATION_TIMEOUT` | 页面加载超时 | 网络抖动，可重试一次 |

### 并发保护

服务内部有**全局 mutex**串行化所有 walmart 访问，防止并发触发 PX。dify 即使多路并发调，所有请求会自动排队。

---

## 🚀 快速开始（v3 推荐流程）

```
1. 双击 start-chrome.bat
   → 弹出一个 Chrome 窗口，自动打开 walmart.com
   → 在这个窗口里手动逛 2-3 分钟（搜个东西、点几个商品）
   → 如果弹 "Press And Hold" 验证，手动按住一次
   → **不要关这个 Chrome**，最小化即可

2. 在 PowerShell 里启动服务：
   cd F:\GitRepository\walmart-playwright-mcp
   node src\server.js
   → 看到 [startup] ✅ CDP connected 就 OK 了

3. dify 那边直接调 walmart_search / walmart_fetch ...
   → 程序在那个 Chrome 里新开 tab 抓取
   → PX 完全识别不出来是自动化（浏览器是真人启动的，只是被附加控制）
```

> 重启服务不需要重新 1，只要 Chrome 还开着就 OK。重启 Chrome 也只需重做第 1 步（cookies 已落盘在 `./user-data/`，不会重复弹验证）。

---

## 0. 为什么是 CDP（v3 ≠ v2）

| 版本 | 反爬主线 | 实战效果 |
| --- | --- | --- |
| v1 | iotword.com/33395：HTTP 刷 `_pxvid` 令牌池 | 2025 年 PX 已升级，**失效** |
| v2 | Playwright `launchPersistentContext` + stealth + 本机 Chrome | **一打开就被识破**，PX 立刻判 high-risk |
| **v3 (当前)** | **chromium.connectOverCDP()** 接管你手动启动的 Chrome | **PX 完全看不出** |

### 为什么 v3 能成？
PX 检测自动化的核心信号是 **"浏览器是被 CDP _启动_ 的"**（CDP 启动 vs CDP 附加是两种完全不同的指纹）。

- v2：Playwright 用 `--remote-debugging-pipe` 启动 Chrome → 命令行里有 `--enable-automation` → PX 看出来
- v3：你手动用 `--remote-debugging-port=9222` 启动 Chrome → 命令行**完全干净** → Playwright 只是"附加上去看看"→ PX 完全看不出区别

---

## 1. 核心思路（v2 vs v1 历史对比，保留参考）

| | v1（参考 iotword.com/33395） | **v2（本仓库当前）** |
| --- | --- | --- |
| 主线 | 用 HTTP/HEAD 随机指纹批量造 `_pxvid` 令牌池 | **持久化 BrowserContext** + 本机 Chrome |
| 身份载体 | 临时 `_pxvid` cookie | 整个 `./user-data/`（cookies + localStorage + fingerprint history） |
| 反检测重点 | 随机 UA / sec-ch-ua | stealth plugin + **真人化行为**（贝塞尔鼠标 / 滚动 / 停顿） |
| 启动后 | 池子常驻轮询，屏幕不断弹窗 | **启动跑一次 ~40s 养号**，之后只在收到请求时干活 |
| 重启 | 全部 token 失效，重新刷 | **复用磁盘 user-data，无需重新养号** |
| 适用 | 国外 IP + 文章假设的 PX 弱状态 | **本机能正常访问 walmart.com 的环境**（你的情况） |

文章方案（v1）当时（2023）有效，但 2025 年的 PerimeterX 已经升级，单靠 `_pxvid` 几乎不行。v2 用"长期持有身份 + 行为模拟"代替"频繁刷 token"，更稳更安静。

## 2. 部署

### 2.1 前置条件
- Node.js ≥ 18
- 本机已安装 **Google Chrome**（默认路径：`C:\Program Files\Google\Chrome\Application\chrome.exe`）
- **本机能正常打开 walmart.com**（不被弹蓝色 Robot or Human 拦截）
- Playwright 自带 chromium 也要装一份做 fallback：`npx playwright install chromium`

### 2.2 一键启动

```powershell
cd F:\GitRepository\walmart-playwright-mcp
npm install                         # 首次
npx playwright install chromium     # 首次
copy .env.example .env              # 可选，按需改
node src/server.js                  # 启动
```

启动时会发生：
1. `[preflight] chromium executable OK: ...`
2. 弹出 **Chrome 窗口**（用的是你本机 Chrome 二进制）
3. 自动访问 walmart.com 首页，模拟人类行为 ~40 秒（鼠标自己飘、滚动、在搜索框试探性打字）
4. 写入 `./user-data/`（cookies / storage）
5. 日志 `[startup] ✅ warmup complete`
6. **服务进入 ready 状态，开始接受 dify 调用**

如果首次启动时遇到 Robot or Human 页面：**在弹出的窗口里手动按住"Press & Hold"按钮**，程序会自动检测到通过并继续。**之后多天/多周不需要再做这个操作**。

### 2.3 MCP 客户端配置

```jsonc
{
  "playwright": {
    "transport": "sse",
    "url": "http://host.docker.internal:8931/sse"
  }
}
```

## 3. 对外工具

### v3.1 推荐（精简 JSON，省 token）
| 工具 | 说明 |
| --- | --- |
| `walmart_search_brief` | `{ query, topN? }` → 前 N 个商品的精简 JSON（详见上文 ★ 章节） |
| `walmart_search_brief_batch` | `{ queries[], topN?, intervalMinMs?, intervalMaxMs? }` → 批量搜索，内部串行 + 随机 sleep |
| `walmart_product_brand` | `{ url? \| itemId? }` → 详情页 brand/brandUrl/seller |

### v3.0 原有（返回完整 HTML，慎用）
| 工具 | 说明 |
| --- | --- |
| `walmart_status` | 当前服务状态（养号完成？最近抓取被拦了吗？cookie 完不完整？） |
| `walmart_search` | `{ query, page? }` → 搜索结果 HTML |
| `walmart_product` | `{ url? \| itemId? }` → 商品详情 HTML |
| `walmart_fetch` | `{ url, responseType?, waitForSelector?, timeoutMs? }` → 通用抓取 |
| `walmart_rewarmup` | 【调试】强制重跑一次养号（保留 user-data） |
| `playwright_goto` | 【通用】stealth Playwright 抓任意域名 |

> 强烈建议 dify 调用前先 `walmart_status` 看 `status==='ready'` 再调 `walmart_search` / `walmart_fetch`。

## 4. 关键 .env 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8931` | SSE 端口 |
| `USER_DATA_DIR` | `./user-data` | 身份目录（cookies/storage 落盘位置） |
| `USE_LOCAL_CHROME` | `true` | 用本机 Chrome 二进制（最强反检测） |
| `WARMUP_ON_START` | `true` | 启动时自动养号 |
| `WARMUP_HEADLESS` | `false` | 养号窗口可见（便于手动救援 captcha） |
| `SERVING_HEADLESS` | `false` | 抓取窗口可见 |
| `MAINTENANCE_INTERVAL_MS` | `1800000` | 维护心跳访问频率（30 分钟） |
| `PROXY` | _空_ | 代理 URL（仅在你本机 IP 受限时配置） |

## 5. 状态机

```
pending  ─启动→  warming  ─养号完成→  ready  ─dify 调用→  ready  (循环)
                                       │
                                       └ 收到 px-captcha → blocked → 手动过验证 → walmart_rewarmup → ready
```

## 6. 调试 / 验证

```powershell
# 看健康状态
curl.exe -s http://localhost:8931/healthz

# 看 MCP 工具列表（需要 SSE 客户端，简单看可以用 scripts/test-connection.mjs）
node scripts/test-connection.mjs
```

`/healthz` 示例返回：
```jsonc
{
  "ok": true,
  "warmup": {
    "status": "ready",
    "firstRun": true,
    "cookies": { "pxvid": true, "px3": true, "pxhd": true },
    "fetchCount": 0, "blockedCount": 0
  },
  "persistent": { "running": true, "headless": false, "userDataDir": "F:\\...\\user-data" }
}
```

## 7. 常见问题

**Q: 重启服务是不是又要养号 40 秒？**
A: 不会。只要 `./user-data/` 还在，重启时只跑 5-10 秒的"轻量验证"，cookies 全部复用。

**Q: 我能不能删掉 `./user-data/` 重来？**
A: 可以，但是要小心：所有"老访客信用"会丢，下次首次养号时大概率被弹 captcha 要你手动过一次。

**Q: 想跑无人值守 / 服务器部署怎么办？**
A: 设置 `SERVING_HEADLESS=true`（抓取无头），`WARMUP_HEADLESS=true`（养号无头）。但**首次养号还是建议有图形界面**手动过一次 captcha，之后拷贝 `./user-data/` 到服务器，再设 `WARMUP_ON_START=true WARMUP_HEADLESS=true`，重启就秒进 ready。

**Q: 文章里那个 `_pxvid` 令牌池代码还在吗？**
A: 还在 `src/pxvid-pool.js`，但**不在主链路使用**了，server.js 默认不启动它。需要的时候可以单独 import 使用。

## 8. 法律 / 合规

仅供学习与抓取**公开**商品信息。请遵守 Walmart 的 `robots.txt` 及当地法律法规，**自行承担**风险。
