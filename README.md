# walmart-playwright-mcp · v2 持久化身份版

> 一个**本地部署**的 Playwright MCP 服务，专门用于绕过 **Walmart (PerimeterX)** 的人机验证。
> 通过 SSE 暴露在 `http://host.docker.internal:8931/sse`，可直接接入 Dify / Cline / Claude Desktop 等 MCP Client。

## 1. 核心思路（v2 ≠ v1）

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
