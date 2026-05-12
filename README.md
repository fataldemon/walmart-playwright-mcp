# walmart-playwright-mcp

一个**本地可部署**的 Playwright MCP 服务，专门用于绕过 **Walmart (PerimeterX / `_pxvid`) 人机验证**。

方案参考：<https://www.iotword.com/33395.html>
（核心：随机化指纹 HEAD 请求拿 `_pxvid` → 等 ~10s 生效 → 主/副令牌池轮转使用）

本服务把这套思路 **MCP 化** —— 通过 SSE 暴露在 **`http://host.docker.internal:8931/sse`**，可直接被 Cline / Claude Desktop / 其它 MCP Client 接入。

```jsonc
{
  "playwright": {
    "transport": "sse",
    "url": "http://host.docker.internal:8931/sse"
  }
}
```

---

## 1. 架构

```
┌──────────────────────────────────────────────────────────┐
│  MCP Client (Cline / Claude / Cursor ...)                │
│        │   transport: sse                                │
│        ▼                                                 │
│  http://host.docker.internal:8931/sse                    │
│        │                                                 │
│ ┌──────┴────────────────── walmart-playwright-mcp ─────┐ │
│ │  Express + @modelcontextprotocol/sdk (SSE)           │ │
│ │  ┌────────────────────────┐    ┌──────────────────┐  │ │
│ │  │  PxvidPool (undici)    │───▶│  Playwright +    │  │ │
│ │  │  • 随机 UA / Sec-Ch-Ua │    │  stealth plugin  │  │ │
│ │  │  • 主令牌 + 副令牌     │    │  • 注入 _pxvid   │  │ │
│ │  │  • 10s 生效, TTL 30min │    │  • 渲染 / 抓取   │  │ │
│ │  └────────────────────────┘    └──────────────────┘  │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

---

## 2. 提供的 MCP Tools

| 工具 | 说明 |
| --- | --- |
| `pxvid_stats` | 查看令牌池：`{ total, ready, avgAgeSec }` |
| `pxvid_refresh` | 强制清空并重新生成一批令牌 |
| `walmart_fetch` | 抓任意 `walmart.com` 页面（自动注入 `_pxvid`、被拦自动重试） |
| `walmart_search` | `query` → 搜索结果 HTML |
| `walmart_product` | `url` 或 `itemId` → 商品详情 HTML |
| `playwright_goto` | 通用 stealth Playwright 抓取（非 walmart 域名） |

---

## 3. 本地部署

### 3.1 Docker（推荐）

```bash
# 构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f walmart-playwright-mcp

# 健康检查
curl http://localhost:8931/healthz
```

容器启动后 ~10–20 秒令牌池就绪，可在 MCP 客户端用如下配置接入：

```jsonc
{
  "playwright": {
    "transport": "sse",
    "url": "http://host.docker.internal:8931/sse"
  }
}
```

> Windows / Mac Docker Desktop 默认就支持 `host.docker.internal`。
> Linux 上 `docker-compose.yml` 里加的 `extra_hosts: host-gateway` 也已经替你解决了。

### 3.2 Node 直接运行（无 Docker）

```bash
cd walmart-playwright-mcp
npm install
npx playwright install chromium    # 第一次需下载浏览器
cp .env.example .env               # 改下端口/代理
npm start
```

启动后同样监听 `http://localhost:8931/sse`。

---

## 4. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8931` | 监听端口（与连接端点 url 一致） |
| `HEADLESS` | `true` | Playwright 无头模式 |
| `PROXY` | _空_ | 代理 URL，强烈推荐配海外住宅 IP |
| `PXVID_PRIMARY` | `5` | 主令牌数 |
| `PXVID_SECONDARY` | `5` | 副令牌数（备用） |
| `PXVID_ACTIVATION_MS` | `10000` | 令牌生成后多久才能用，文章实测 ~10s |

---

## 5. 文章方案在本项目中的落地点

| 文章里的要点 | 代码位置 |
| --- | --- |
| 随机化 `User-Agent` / `Sec-Ch-Ua` / 自定义混淆头 | `src/pxvid-pool.js → buildRandomHeaders()` |
| HEAD/GET 请求拿 `_pxvid` | `src/pxvid-pool.js → fetchOnePxvid()` |
| 等 ~10s 才能用 | `PxvidPool.activationMs` → `setTimeout(ready=true, 10s)` |
| 主令牌池 + 副令牌异步补充 | `PxvidPool._fill()` / `_loop()` |
| 令牌过期/达上限即换 | `maxUsePerToken`, `ttlMs` |
| IP 池 / 海外代理 | `PROXY` 环境变量（`undici.ProxyAgent` + Playwright `--proxy-server`） |

---

## 6. 接入 MCP Client 后的用法示例

让 LLM 调用：

```
tool: walmart_search
args: { "query": "airpods pro", "page": 1 }
```

服务内部流程：

1. `PxvidPool.acquire()` → 拿一个 `ready=true` 的 `_pxvid`；
2. 起一个新的 stealth `BrowserContext`，注入 `_pxvid` cookie + 一致的 UA/客户端提示；
3. 访问搜索页 → 等到 `[data-testid="item-stack"]` 出现 → 返回 HTML；
4. 若识别到 "Robot or human?" / `px-captcha` → 自动换另一个 token 再试一次。

---

## 7. 调试

```bash
# 看令牌池状态（增强版，含诊断信息）
curl http://localhost:8931/healthz
```

返回示例：

```jsonc
{
  "ok": true,
  "pool": {
    "total": 0, "ready": 0,
    "attempts": 31, "successes": 0, "successRate": 0,
    "lastStatus": 200,
    "lastError": "no _pxvid in cookies (status 200)",
    "proxyConfigured": false,
    "hint": "池为空且未配置 PROXY。沃尔玛对中国大陆 IP 风控严格，请设置 PROXY=http://user:pass@host:port 后重启。"
  }
}
```

### ⚠️ 常见诊断 → 处置

| lastStatus | lastError 关键词 | 含义 | 解决 |
| --- | --- | --- | --- |
| `0` | `network: ENOTFOUND / ETIMEDOUT` | 出站连不上 walmart.com | 检查网络/代理 |
| `200` | `no _pxvid in cookies` | 已连上但**沃尔玛对你的 IP 走匿名分流**，不下发 PerimeterX 指纹 | **必须配海外代理 `PROXY=...`** |
| `403` / `429` | `no _pxvid in cookies` | IP 已被 PX 拉黑 | 换代理或换出口 |
| `200` | `browser: no _pxvid cookie` | 浏览器 fallback 也没拿到 → 强地区限制 | 同上，海外住宅 IP 必备 |

> 本服务内部对每次令牌生成会做 **两级 fallback**：
> 1. 先用 `undici` 发 HTTP 请求拿 `Set-Cookie` 里的 `_pxvid`（快）；
> 2. 拿不到再启 **stealth Playwright** 打开首页，让 PerimeterX 的 JS 自己种 `_pxvid` 后从 cookie 读出（慢但稳）。
>
> 不管 HTTP 还是浏览器，**没有海外 IP 都是白搭** —— 这就是文章里强调"用海外 IP 池"的根本原因。

---

## 8. 法律 / 合规

仅供学习与抓取**公开**商品信息。请遵守 Walmart 的 `robots.txt` 及当地法律法规，**自行承担**风险。
