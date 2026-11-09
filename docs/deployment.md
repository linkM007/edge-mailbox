# Cloudflare 部署

运行时只需 Workers、D1 和 Browser Run。无本机网关或 Containers 依赖。检查账户套餐的浏览器会话、CPU、D1 和请求配额；不要把本地测试结果当作套餐保证。

## 配置

~~~sh
npm ci
npx wrangler login
npx wrangler d1 create edge-mailbox
~~~

将数据库 UUID 填入自己的 Wrangler 配置，保留公共模板的全零 UUID。可复制成被 Git 忽略的 .wrangler.deploy.jsonc。选择自己的 Worker 名、域名和目标列表，不覆盖已有应用。

~~~sh
npx wrangler d1 migrations apply edge-mailbox --remote -c .wrangler.deploy.jsonc
npm test
npx wrangler deploy -c .wrangler.deploy.jsonc
npx wrangler secret put RPC_TOKEN -c .wrangler.deploy.jsonc
npx wrangler secret put EGRESS_PROXY_SERVER -c .wrangler.deploy.jsonc
npx wrangler secret put EGRESS_PROXY_USERNAME -c .wrangler.deploy.jsonc
npx wrangler secret put EGRESS_PROXY_PASSWORD -c .wrangler.deploy.jsonc
~~~

RPC_TOKEN 至少 32 字符，使用随机生成值。代理地址格式为 http://HOST:PORT 或 https://HOST:PORT，用户名与密码单独设置。HTTP 代理认证发生在未加密的第一跳，部署者应信任该网络路径；支持时优先使用 HTTPS 代理。

Browser Run 绑定 BROWSER 已在模板中。公开数据面入口前先设置 secrets；选择 workers_dev=true 或自己的 custom_domain 路由。纯控制面可关闭 HTTP 入口，但本版执行仍要求 RPC_TOKEN 配置，以保持统一凭据检查。

## 目标列表

Wrangler vars 中各值为 JSON 字符串；下例展示解码后的对象。

HTTP_TARGETS：

~~~json
{ "example": { "url": "https://example.com/" } }
~~~

BROWSER_TARGETS：

~~~json
{
  "example": {
    "url": "https://example.com/",
    "resourceOrigins": [],
    "settleMs": 1000
  }
}
~~~

外部 CSS/脚本域名需逐项加入 resourceOrigins，只接受完整 HTTPS origin，不支持通配符。动态页面可添加 waitForSelector，例如 main 或 #app。路径参数只能在初始 origin 内打开；HTTP 重定向全部拒绝。

SSH_TARGETS：

~~~json
{
  "ops": {
    "hostname": "ssh.example.com",
    "port": 22,
    "username": "ops",
    "fingerprint": "SHA256:REPLACE_WITH_VERIFIED_HOST_FINGERPRINT",
    "keySecret": "OPS_SSH_KEY",
    "actions": { "uptime": "uptime" }
  }
}
~~~

从可信服务器控制台取得主机密钥 SHA256 指纹，独立核对后配置。私钥通过 wrangler secret put OPS_SSH_KEY 存储，不写 Git。命令由远程 shell 解释，配置者需像审查代码一样审查命令。代理必须允许 CONNECT HOST:22；服务端需支持 AES-CTR 和 SHA-256 HMAC。

## 客户端

复制 .env.example 为 .env，填入自己的入口和 RPC 令牌：

~~~sh
node --env-file=.env cli/main.js run --job examples/browser.json --out capture-001
~~~

控制面另需 D1 API token 与账户/数据库 ID。D1 写 token 可修改数据库，并非只能提交单个任务；仅用于可信管理员。Cloudflare 平台账户级权限不等同于数据库行级隔离。

## 本地开发

复制 .dev.vars.example 为 .dev.vars 并填入真实代理及 RPC 令牌，运行 npm run db:local 和 npm run dev。本地定时任务通过 /cdn-cgi/local/scheduled 手动触发。Browser Run 本地/远程绑定行为取决于 Wrangler，正式验收以部署后的结果为准。

可选本机浏览调试：复制 egress/.env.example 为 .env.egress，安装 Chromium 或指定已有 Chrome 路径，再运行 npm run browser:capture -- --job examples/browser.json --out local-capture。该脚本仅为调试辅助，不是生产依赖。

## 验收

检查无令牌 401、未知目标拒绝、代理错误无直连回退；HTTP 与浏览器分别打开可信 IP 检测端点，核对出口。通过 D1 提交任务并读取截图结果。真实 SSH 另需核对目标服务器上的执行记录；unknown 状态先查远程结果再决定是否重试。
