# Edge Mailbox

Cloudflare 原生的 HTTP、网页浏览与 SSH 任务工具。所有应用目标连接强制走配置的 HTTP(S) 代理，失败时停止，不回退直连。支持 HTTPS 同步请求和 D1 + Cron 异步信箱。

[English](README.en.md) · [部署](docs/deployment.md) · [架构](docs/architecture.md) · [验证记录](docs/verification.md) · [安全说明](SECURITY.md)

## 功能

| 任务 | 返回内容 | 出口机制 |
| --- | --- | --- |
| http | 状态、Content-Type、base64 正文 | Worker → CONNECT 代理 → 目标 HTTPS |
| browse | JPEG 截图、标题、渲染后正文、链接 | Browser Run 禁直连；资源由 Worker 通过代理取回 |
| ssh | stdout、stderr、退出码、信号 | Worker → CONNECT 代理 → 目标 SSH:22 |

无需本机常驻网关或 Cloudflare Containers。浏览器在 Cloudflare Browser Run 中运行真实 Chromium 并执行页面 JavaScript。目标地址与 SSH 操作由服务端配置，客户端只传别名；浏览任务可以在配置的同源范围内打开路径和滚动。

~~~mermaid
flowchart LR
  C[客户端] --> L[环境本地 HTTP 代理]
  L --> W[Worker HTTPS API]
  L --> A[Cloudflare D1 REST API]
  A --> D[(D1 任务信箱)]
  T[Cron] --> D
  D --> W
  W --> P[指定出口代理]
  P --> H[HTTPS 目标]
  P --> S[SSH 目标]
  W --> B[Browser Run 渲染代理取回的资源]
~~~

客户端到 Cloudflare 的链路与 Worker 到目标的出口是两层独立配置。项目不改变操作系统网络设置；Cloudflare 内部 API 和浏览器控制通道仍使用平台自身连接。

## 快速验证

Node.js 22.19+：

~~~sh
npm ci
npm test
npm audit
npm run cli -- --help
~~~

测试无需云端凭据。包含本地 HTTP CONNECT 拒绝、真实本地 SSH 服务器、workerd 中的 SSH 握手与 D1 任务、浏览器资源策略和离线预览转义。

## 浏览网页

部署后配置 EDGE_ENDPOINT 与 EDGE_RPC_TOKEN。PowerShell 示例：

~~~powershell
$env:EDGE_ENDPOINT = 'https://YOUR-WORKER.example.com'
$env:EDGE_RPC_TOKEN = '部署时设置的随机 RPC 令牌'
npm run cli -- run --job examples/browser.json --out capture-001
~~~

输出目录必须是尚不存在的新目录。生成：

- screenshot.jpg：1280 × 800 真实页面截图。
- page.txt：渲染后的正文。
- result.json：标题、链接、状态、滚动位置等元数据。
- index.html：可离线打开的预览，原页面 HTML 与脚本不执行。

任务格式：

~~~json
{ "type": "browse", "target": "example", "path": "/", "scrollY": 0 }
~~~

path 和 scrollY 可省略。下一次可使用结果 links 中 allowed=true 的 path 继续浏览；每个任务创建独立会话。当前实现为阅读与截图，不包含登录、表单提交、点击操作或持久 Cookie。服务端 waitForSelector 用于等待动态内容，settleMs 可指定短等待。

## HTTP 与 SSH

~~~json
{ "type": "http", "target": "example" }
~~~

~~~json
{ "type": "ssh", "target": "ops", "action": "uptime" }
~~~

~~~sh
npm run cli -- run --job examples/http.json
npm run cli -- run --job examples/ssh.json
~~~

SSH 主机指纹必须匹配，私钥放 Worker secret。服务器需支持 AES-CTR 与 SHA-256 HMAC。代理也必须允许 CONNECT 到目标 22；代理拒绝时返回失败。

## D1 控制面信箱

预先部署 Worker、D1 和 Cron。设置 CLOUDFLARE_ACCOUNT_ID、CLOUDFLARE_D1_DATABASE_ID、CLOUDFLARE_API_TOKEN 后：

~~~sh
npm run cli -- enqueue --plane control --job examples/browser.json --id browse-job-001
npm run cli -- wait --plane control --id browse-job-001 --timeout 300 --out capture-002
~~~

该路径只调用 D1 管理 API，不需要客户端访问 Worker 域名。截图作为有界 base64 结果存储在 D1；不依赖额外的图片下载域名。Cron 是分钟粒度，不承诺秒级调度。

数据面也支持异步任务：去掉 --plane control。提交前 CLI 会输出任务 ID；响应中断后查询该 ID，或使用相同 ID 与任务重新提交。不同内容复用 ID 会报冲突。同步 run 不去重；wait 超时不取消云端任务。

## 两层代理配置

客户端：HTTP_PROXY / HTTPS_PROXY / NO_PROXY 及小写形式；EDGE_REQUIRE_PROXY=1 强制客户端代理且忽略 NO_PROXY。此设置不决定云端目标出口。

Worker secrets：EGRESS_PROXY_SERVER、EGRESS_PROXY_USERNAME、EGRESS_PROXY_PASSWORD。HTTP、浏览器所有被允许的资源、SSH 全部使用这组配置。缺少代理配置即拒绝任务。示例文件只含占位符。

## API 与限制

| API | 作用 |
| --- | --- |
| GET /healthz | 无敏感信息存活检查 |
| POST /v1/run | 同步任务，要求 Bearer RPC_TOKEN |
| POST /v1/jobs | 异步入队，支持 Idempotency-Key |
| GET /v1/jobs/:id | 查询任务与结果 |

- JSON 请求上限 4 KiB。HTTP 输出 32 KiB；SSH 各输出流 32 KiB；普通任务期限 15 秒。
- 浏览任务期限 40 秒；截图 JPEG 最大 240 KiB，正文最多 18000 字符，链接最多 30 个。每页最多 100 次资源请求、单资源 2 MiB、累计 8 MiB，超限失败。
- Browser Run 使用空 allowedDomains，网络资源由 Worker 拦截并代理取回。WebSocket、Service Worker、Web Worker、WebRTC、WebTransport 和弹窗受限；自动重定向全部拒绝。部分动态应用因此无法完整运行。
- HTTP 只支持固定 HTTPS GET；浏览资源只允许服务端列出的 HTTPS origin。无 Cookie 复用、任意 headers、用户脚本或任意 shell 输入。
- 每次 Cron 最多处理 5 个任务；应用队列最多 100 个 pending/running。1 小时等待过期，终态记录创建满 24 小时后清理。记录清理后 ID 去重失效。
- 任务领取原子化并带 claim token；SSH 失败保守记为 unknown，避免自动重放可能已产生副作用的命令。无 exactly-once 保证。
- 单运营者共享令牌；令牌持有人可读取全部结果。D1 写令牌属于可信管理员权限。无内置全局速率限制；关注平台配额及代理流量费用。

Workers 代理 HTTPS 使用 tunnelfetch 的 TLS 与证书验证实现，其上游尚未完成外部安全审计。该限制、CPU 消耗及具体测试范围见 SECURITY.md 和验证记录。代理出口也不保证任意网页或目标服务器接受访问。

MIT。贡献前阅读 CONTRIBUTING.md。
