# Edge Mailbox

Cloudflare 原生的 HTTP、网页浏览与 SSH 任务工具（`v0.3.0`）。默认所有应用目标连接强制走配置的 HTTP(S) 代理，失败时停止，不回退直连。支持 HTTPS 同步请求、零等待异步派发与 D1 + Cron 异步信箱。

[English](README.en.md) · [部署](docs/deployment.md) · [架构](docs/architecture.md) · [验证记录](docs/verification.md) · [安全说明](SECURITY.md) · [Agent Skill](skills/edge-mailbox/SKILL.md)

## 功能

| 任务 | 支持特性（v0.3） | 返回内容 | 出口机制 |
| --- | --- | --- | --- |
| `http` | 同源 `path`/查询、白名单方法（`GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`HEAD`）、请求体、`headerSecrets`、安全重定向 | 状态、最终 URL、重定向次数、Content-Type、base64 正文 | Worker → CONNECT 代理 → 目标 HTTPS |
| `browse` | 6 路并发资源拉取、连接池复用、子资源容错隔离、CSS `selector` 提取、同源/白名单安全重定向 | JPEG 截图、标题、正文、`selectedText`、链接、统计元数据 | Browser Run 禁直连；资源由 Worker 经代理并发取回 |
| `ssh` | 自定义端口（`1..65535`）、公网 IPv4 或域名、`stdin` 管道输入、16 KiB 动作脚本、最长 60s 超时、多代理池或显式 `direct` | stdout、stderr、退出码、信号、出口模式 | 默认 CONNECT 代理（住宅代理封禁 22 端口时可显式开启 `ALLOW_DIRECT_SSH=1` + `egress: "direct"`） |

无需本机常驻网关或 Cloudflare Containers。浏览器在 Cloudflare Browser Run 中运行真实 Chromium 并执行页面 JavaScript。目标地址、方法白名单与 SSH 动作均由服务端受控配置，客户端只传别名与受限参数。

~~~mermaid
flowchart LR
  C[客户端 / AI Agent] --> L[环境本地 HTTP 代理]
  L --> W[Worker HTTPS API]
  L --> A[Cloudflare D1 REST API]
  A --> D[(D1 任务信箱)]
  T[Cron / waitUntil 即时派发] --> D
  D --> W
  W --> P[默认代理 / EGRESS_PROXIES 代理池]
  P --> H[HTTPS / API 目标]
  P --> S[SSH 目标]
  W --> B[Browser Run 渲染代理并发取回的资源]
~~~

## 快速验证

Node.js 22.19+：

~~~sh
npm ci
npm test
npm audit
npm run cli -- --help
~~~

## CLI 与 API 用法

配置 `EDGE_ENDPOINT` 与 `EDGE_RPC_TOKEN`（数据面）或 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_D1_DATABASE_ID`、`CLOUDFLARE_API_TOKEN`（D1 控制面）：

~~~sh
# 1. 自发现服务端已配置的目标别名、动态 URL 开关、允许的 HTTP 方法与 SSH 动作名（不含任何密钥）
npm run cli -- targets

# 2. 快捷 HTTP 请求（支持 GET / HEAD / OPTIONS / POST / PUT / PATCH / DELETE，开启 ALLOW_DYNAMIC_URLS=1 后可直接请求任意公网 HTTPS URL）
npm run cli -- get https://ipinfo.io/json -b
npm run cli -- head https://ai.meta.com/muse/
npm run cli -- post https://httpbin.org/post -d '{"hello":"world"}' -H 'Accept: application/json'
npm run cli -- put https://httpbin.org/put -d '{"k":"v"}'
npm run cli -- patch https://httpbin.org/patch -d '{"k":"v2"}'
npm run cli -- delete https://httpbin.org/delete

# 3. 快捷无头浏览器渲染与 SSH 动作（或使用 --inline / --job 执行原始 JSON 任务）
npm run cli -- browse https://dev.meta.ai/products/muse-code --out capture-001
npm run cli -- ssh ops uptime
npm run cli -- run --inline '{"type":"http","target":"example","path":"/"}'

# 4. 队列管理：入队、自适应轮询等待、列表查询、取消排队任务、手动触发消费
npm run cli -- enqueue --plane control --job examples/browser.json --id browse-job-001
npm run cli -- wait --plane control --id browse-job-001 --timeout 300 --out capture-002
npm run cli -- list --plane control --status pending --limit 20
npm run cli -- cancel --plane control --id browse-job-001
npm run cli -- dispatch
~~~

### 安全无损部署（保留全部 Worker Secrets）

使用内置的 `deploy:safe` 通过 Cloudflare Multipart ES Module + Wasm 接口原子更新代码与环境变量，自动携带 `keep_bindings: ["secret_text"]`，避免 Cloudflare `/settings` 接口覆盖已有密钥：

~~~sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
  npm run deploy:safe -- --name edge-mailbox --vars-file vars.json
~~~

## API 概览与限制

| API | 作用 |
| --- | --- |
| `GET /healthz` | 无敏感信息存活与版本检查 |
| `GET /v1/targets` | 查询服务端允许的目标别名、`dynamicUrls` 状态、HTTP 方法与 SSH 动作清单 |
| `GET /v1/http` | 认证后直接发起代理 `GET` / `HEAD` 请求（支持 `?url=...` 或 `?target=...&path=...`，`&raw=1` 直接返回原始响应体） |
| `POST /v1/run` | 同步执行任务（支持全部 HTTP 方法、自定义请求头、`browse`、`ssh`），要求 Bearer `RPC_TOKEN` |
| `POST /v1/jobs` | 异步入队（支持 `Idempotency-Key` 与 `x-edge-dispatch: immediate` 零等待后台执行） |
| `GET /v1/jobs` | 按状态分页列出最近任务摘要（`?status=pending&limit=20`） |
| `GET /v1/jobs/:id` | 查询单个任务详情与结果 |
| `POST /v1/jobs/:id/cancel` | 取消尚处于 `pending` 状态的任务 |
| `POST /v1/dispatch` | 立即触发一次 D1 信箱任务消费 |

- JSON 请求上限 4 KiB；HTTP 输出默认 32 KiB（同步执行最高可设 `maxBytes: 1048576` 即 1 MiB，支持 `truncate: true` 自动截断超大网页而不报错）；SSH 各输出流 32 KiB；普通任务默认 15 秒（SSH 可按目标/动作配置最高 60 秒）。
- 浏览任务期限 40 秒；截图 JPEG 最大 240 KiB，正文最多 18000 字符，链接最多 30 个；每页最多 100 次资源请求、单资源 6 MiB、共享原子总预算 16 MiB（6 路并发复用代理会话）。非主文档子资源加载失败仅计入 `failedSubresources`，不会中断整页截图。
- 每次消费最多处理 5 个任务；队列上限 100 个 `pending`/`running`；1 小时未领取过期，终态记录满 24 小时自动清理。SSH 中断保守记为 `unknown`，避免自动重放产生副作用。

MIT。贡献前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
