# 架构与边界

## 数据面和控制面

客户端通过环境允许的 HTTP 代理访问 Worker，或只通过 D1 REST API 写入任务。云端 Cron 领取任务并执行，完成后将有界结果写回 D1。两条路径共用任务校验和执行代码。

普通 HTTPS POST 仍可能受域名、TLS 检查、方法和速率策略限制。CONNECT 内的 TLS 未解密时，代理也看不到内部 Upgrade，故不应声称所有 HTTP 代理必然阻止 WebSocket。本项目用短时 HTTP 请求减少协议依赖，不自动改变网络策略。

## 统一目标出口

1. Worker 的 HTTPS 目标请求使用 tunnelfetch + cloudflare:sockets + 指定 HTTP CONNECT 代理。forceTunnel=true，nativeFetch 委托抛错，证书策略保持 system 校验，禁止自动重定向。
2. Browser Run 以 guardrails.allowedDomains=[] 启动。Playwright 拦截页面和资源请求，校验 origin 后由同一代理传输层取回，再 fulfill 给 Chromium。浏览器自身直接出站被平台 guardrails 阻止；页面脚本执行、DOM 与截图都是真实浏览器结果。
3. SSH 通过 node:net/tls 只连接代理，解析有界 CONNECT 回复，再把已有 socket 交给 ssh2。未向 SSH 库提供直连目标参数，失败不回退。主机指纹固定校验。

客户端到 Cloudflare、Browser Run 控制通道与平台服务绑定是控制连接，不伪称它们经过目标出口代理。应用级路由也不是整个 Cloudflare 账户或操作系统的全局透明代理。

## 浏览限制

仅 GET/HEAD、HTTPS、同源主导航和显式 resourceOrigins。重定向、表单提交、任意用户脚本、持久 Cookie、Service Worker、Web Worker、WebSocket、WebRTC、WebTransport、下载和额外页面受限。会话结束关闭浏览器；超时后返回的迟到会话也会关闭。

页面资源按顺序领取预算，累计字节上限在并发请求间共享，避免并发超支。固定等待和可配置 waitForSelector 只定义截图时刻，不保证所有网站完成异步加载。正文包含整个主文档的 innerText；截图是指定滚动位置的 1280×800 视口，不是无限长截图。

## TLS 和 SSH 兼容

Worker 原生 fetch 没有通用 HTTP 代理配置；原生 TLS 包装 CONNECT 隧道在当前测试环境失败。tunnelfetch 在用户态实现 TLS 和 X.509 校验，不关闭证书验证。它是较新实现，上游尚未完成外部安全审计；固定版本并记录此风险。

ssh2 在 Workers 中禁用可选原生加速，Poly1305 Wasm 由构建脚本提取为静态模块。双方协商限定 AES-CTR + SHA-256 HMAC，以避开 workerd AES-GCM 流式接口差异。构建脚本检查固定上游源码结构，变动时失败，不静默修改未知版本。

代理服务是否放行目标 22、目标防火墙和服务器算法仍决定 SSH 可达性。关闭连接不保证远程进程停止，预设命令应低权限、有界、幂等。

## 任务语义

pending → running 使用单条 UPDATE ... RETURNING；写回需匹配 claim token。等待超过 1 小时变 expired；running 租约超过 120 秒变 unknown。未知结果和 SSH 失败不自动重放。外部副作用与 D1 写回不在同一事务内，不保证 exactly-once。

每次 Cron 最多顺序执行 5 个任务。Cron 分钟粒度，配置传播可能耗时最多 15 分钟；积压、配额、代理响应和轮询会进一步影响延迟。终态记录从创建起满 24 小时后清理，旧 ID 随之失去去重保护。

## 参考资料

~~~text
Cloudflare TCP sockets
https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
Browser Run guardrails
https://developers.cloudflare.com/browser-run/features/guardrails/
Cloudflare Playwright
https://github.com/cloudflare/playwright
D1 Query API
https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
Cron Triggers
https://developers.cloudflare.com/workers/configuration/cron-triggers/
tunnelfetch and security policy
https://github.com/latentharbor/tunnelfetch
https://github.com/latentharbor/tunnelfetch/security
ssh2
https://github.com/mscdex/ssh2
~~~
