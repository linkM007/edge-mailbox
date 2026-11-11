---
name: edge-mailbox
description: Run Cloudflare-native HTTP, headless Browser Run, and SSH tasks through mandatory proxy egress or asynchronous D1 mailbox queues (linkM007/edge-mailbox). Use when executing remote HTTP/API probes, capturing real rendered web pages via residential/datacenter proxies, running allowlisted SSH operations, or deploying/updating edge-mailbox on Cloudflare without losing Worker secrets.
---
# Edge Mailbox (`linkM007/edge-mailbox` v0.3+)

`edge-mailbox` executes predefined `http`, `browse`, and `ssh` jobs from a Cloudflare Worker with mandatory HTTP(S) `CONNECT` proxy egress, Browser Run rendering, and a D1 + Cron asynchronous mailbox.

## 1. Two Operating Planes

1. **Data Plane (`--plane data`, default)**:
   - Env: `EDGE_ENDPOINT` (`https://edge-mailbox.oiyun.top`) and `EDGE_RPC_TOKEN` (>= 32 chars).
   - Supports synchronous `run`, zero-wait async `enqueue` (`x-edge-dispatch: immediate`), `wait`, `result`, `list`, `cancel`, `targets`, `health`, and `dispatch`.
2. **Control Plane (`--plane control`)**:
   - Env: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`.
   - Talks **only** to `https://api.cloudflare.com/client/v4/.../d1/database/.../query` (works even when only `api.cloudflare.com` is reachable).
   - Supports `enqueue`, `wait`, `result`, `list`, and `cancel`.

## 2. Discovering Targets & Running Jobs

```bash
# Discover configured targets, allowed HTTP methods, and SSH action names (Data Plane)
npm run cli -- targets

# Synchronous HTTP GET/POST with path & body
npm run cli -- run --inline '{"type":"http","target":"egress"}'
npm run cli -- run --inline '{"type":"http","target":"api","path":"/v1/items?limit=5","method":"POST","body":"{\"ok\":true}"}'

# Headless Browser Run capture (writes screenshot.jpg, page.txt, result.json, index.html)
npm run cli -- run --inline '{"type":"browse","target":"example","path":"/","scrollY":0,"selector":"main"}' --out ./capture-001

# SSH action with optional stdin piping
npm run cli -- run --inline '{"type":"ssh","target":"tw","action":"ping"}'
npm run cli -- run --inline '{"type":"ssh","target":"tw","action":"write_cfg","stdin":"key=value\n"}'

# Asynchronous D1 Control-Plane queue & manage
npm run cli -- enqueue --plane control --inline '{"type":"http","target":"egress"}' --id check-egress-001
npm run cli -- wait --plane control --id check-egress-001 --timeout 180
npm run cli -- list --plane control --status pending --limit 20
npm run cli -- cancel --plane control --id check-egress-001
```

## 3. Target Configuration Capabilities (v0.3+)

- **`HTTP_TARGETS`**:
  - `url` (public HTTPS base URL), `methods` (default `["GET"]`; opt-in `POST`/`PUT`/`PATCH`/`DELETE`/`HEAD`), `followRedirects` (`boolean`, up to `maxRedirects: 5` within `allowedOrigins`), `headers`, `headerSecrets` (`{"Authorization": "Bearer $SECRET_NAME"}`), `proxy` (named profile in `EGRESS_PROXIES`).
- **`BROWSER_TARGETS`**:
  - `url`, `resourceOrigins` (array of HTTPS origins), `waitForSelector`, `settleMs` (`0..3000`), `followRedirects` (`boolean`, up to `3` hops), `proxy`. Uses 6-way concurrent proxy asset fetching with an 8 MiB shared byte cap and subresource fault isolation.
- **`SSH_TARGETS`**:
  - `hostname` (public domain **or** public IPv4; on Cloudflare Workers `egress: "direct"`, prefer a DNS `A` hostname such as `static.example.com` for `cloudflare:sockets` compatibility), `port` (`1..65535`, default `22`), `username`, `fingerprint` (`SHA256:...`) or `fingerprints` (`["SHA256:..."]` up to 5), `hostKeyAlgorithms` (optional allowlist e.g. `["ssh-ed25519","ecdsa-sha2-nistp256"]`), `keySecret`, `actions` (up to `16 KiB` per command), `allowStdin` (`boolean`), `timeoutMs` (`1000..60000`), `proxy`, or `egress: "direct"` (requires `ALLOW_DIRECT_SSH="1"` when residential proxies block TCP port 22). Emits safe diagnostic subcodes (`ssh_failed_host_key`, `ssh_failed_auth`, `ssh_failed_key_parse`).

## 4. Safe Secret-Preserving Cloudflare Updates

> **CRITICAL**: Never use Cloudflare `PATCH /workers/scripts/{name}/settings` alone to update vars — Cloudflare's `/settings` endpoint ignores `keep_bindings` and wipes `secret_text` bindings!

Always use `npm run deploy:safe` (which runs `PUT /workers/scripts/{name}` with `keep_bindings: ["secret_text"]` and bundles the Poly1305 Wasm module):

```bash
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
  npm run deploy:safe -- --name edge-mailbox --vars-file updated-vars.json
```
