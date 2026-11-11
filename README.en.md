# Edge Mailbox

Cloudflare-native HTTP, browser and SSH task runner (`v0.3.0`) with mandatory proxy egress, synchronous HTTPS execution, zero-wait background dispatch, and an asynchronous D1/Cron mailbox. No local gateway or Containers deployment is required.

[中文](README.md) · [Deployment](docs/deployment.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md) · [Agent Skill](skills/edge-mailbox/SKILL.md)

## Highlights in v0.3

- **HTTP Tasks**: Same-origin `path`/query overrides, per-target allowlisted methods (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`), UTF-8/base64 request bodies, server-injected `headers` / `headerSecrets` (`Bearer $SECRET`), and origin-checked redirect following (`followRedirects`).
- **Browser Run**: 6-way concurrent proxy asset fetching with connection reuse, shared 8 MiB atomic stream byte budget, subresource fault isolation (`failedSubresources`), optional CSS `selector` extraction (`selectedText`), and policy-checked redirects.
- **SSH Tasks**: Custom ports (`1..65535`), globally routable public IPv4 or hostname targets, bounded `stdin` piping (`allowStdin`), 16 KiB server action scripts, configurable `timeoutMs` (`1..60s`), named proxy pools (`EGRESS_PROXIES`), and explicit opt-in `egress: "direct"` (`ALLOW_DIRECT_SSH=1`) when residential proxies block TCP port 22.
- **Self-Discovery & Queue Ops**: `targets`, `list`, `cancel`, `health`, `dispatch`, `--inline` JSON jobs, adaptive `wait` backoff, and `npm run deploy:safe` secret-preserving Cloudflare deployment.

## Quick Start

Node.js 22.19+:

~~~sh
npm ci
npm test
npm audit
~~~

Data-plane (`EDGE_ENDPOINT`, `EDGE_RPC_TOKEN`) and Control-plane (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`) examples:

~~~sh
npm run cli -- targets
npm run cli -- run --inline '{"type":"http","target":"example","path":"/"}'
npm run cli -- run --job examples/browser.json --out capture-001
npm run cli -- enqueue --plane control --job examples/browser.json --id browser-job-001
npm run cli -- wait --plane control --id browser-job-001 --out capture-002
npm run cli -- list --plane control --status pending
npm run cli -- cancel --plane control --id browser-job-001
~~~

Safe secret-preserving Worker deployment via Cloudflare API:

~~~sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
  npm run deploy:safe -- --name edge-mailbox --vars-file vars.json
~~~

MIT license.
