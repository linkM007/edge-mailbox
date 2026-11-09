# Edge Mailbox

Cloudflare-native HTTP, browser and SSH tasks with mandatory proxy egress. Supports synchronous HTTPS requests and asynchronous D1/Cron jobs. No local gateway or Containers deployment is required.

[中文](README.md) · [Deployment](docs/deployment.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md)

## Tasks

~~~json
{ "type": "http", "target": "example" }
~~~

~~~json
{ "type": "browse", "target": "example", "path": "/", "scrollY": 0 }
~~~

~~~json
{ "type": "ssh", "target": "ops", "action": "uptime" }
~~~

Targets and SSH commands are configured server-side. Every target connection uses the configured proxy. Missing configuration, a rejected CONNECT, or a TLS failure terminates the task without a direct fallback.

Browser Run executes JavaScript and returns a JPEG screenshot, rendered text, title and links. Its direct HTTP(S) network access is blocked with session guardrails. Allowed resources are fetched by the Worker through the same proxy and fulfilled into the page. This read-only capture workflow blocks redirects, cookies, popups, WebSockets, service/workers, WebRTC and WebTransport. Each task starts a fresh session. It does not implement login, forms, arbitrary scripts or persistent interactive sessions.

## Run

Node.js 22.19+:

~~~sh
npm ci
npm test
npm audit
~~~

After deploying, set EDGE_ENDPOINT and EDGE_RPC_TOKEN:

~~~sh
npm run cli -- run --job examples/browser.json --out capture-001
~~~

The new output directory contains screenshot.jpg, page.txt, result.json and an escaped offline index.html preview. An existing directory is never overwritten.

Control-plane mode needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_API_TOKEN:

~~~sh
npm run cli -- enqueue --plane control --job examples/browser.json --id browser-job-001
npm run cli -- wait --plane control --id browser-job-001 --out capture-002
~~~

Screenshot bytes are stored in the bounded D1 result, so control-plane clients do not need a separate image-host connection. Keep the task ID if a response is interrupted. Synchronous run has no deduplication; queued task deduplication lasts only while the row remains stored.

## Configuration

Worker secrets: RPC_TOKEN, EGRESS_PROXY_SERVER, EGRESS_PROXY_USERNAME, EGRESS_PROXY_PASSWORD and any configured SSH private key. Target maps: HTTP_TARGETS, BROWSER_TARGETS and SSH_TARGETS. The public template starts with empty maps and public Worker URLs disabled.

Client HTTP_PROXY/HTTPS_PROXY are separate from Worker egress. EDGE_REQUIRE_PROXY=1 requires a client proxy and ignores NO_PROXY. Platform management APIs and browser control traffic remain platform connections; the mandatory egress policy covers application target connections.

Limits: 4 KiB input; HTTP output 32 KiB; SSH output 32 KiB per stream; browser JPEG 240 KiB, text 18000 characters, up to 30 links. HTTP/SSH have a 15-second deadline and browser tasks 40 seconds. Cron handles up to five jobs per invocation. Pending tasks expire after an hour; terminal rows are cleaned up after 24 hours. Ambiguous SSH outcomes are not automatically replayed.

Workers proxy HTTPS uses tunnelfetch, a newer user-space TLS implementation with certificate validation but no completed independent security audit. SSH uses ssh2 through an explicit CONNECT socket, pinned host fingerprints, AES-CTR and SHA-256 HMAC. See SECURITY.md for trust boundaries and docs/verification.md for what was actually tested.

MIT license.
