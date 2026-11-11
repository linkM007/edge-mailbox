# Changelog

## 0.3.0

- **HTTP enhancements**: optional same-origin `path`/query suffixes, target-allowlisted `HEAD`/`POST`/`PUT`/`PATCH`/`DELETE` methods with UTF-8/base64 request bodies, server-injected `headers`/`headerSecrets` (`Bearer $SECRET`), and origin-checked redirect following (`followRedirects` / `maxRedirects`).
- **SSH enhancements**: custom ports (`1..65535`), globally routable public IPv4 targets (rejecting private/CGNAT/loopback/metadata ranges), `stdin` stream piping (`allowStdin`), 16 KiB command definitions, per-target/action `timeoutMs` (`1..60s`), named proxy profiles (`EGRESS_PROXIES`), and explicit opt-in `egress: "direct"` (`ALLOW_DIRECT_SSH=1`) when residential proxies block port 22.
- **Browser Run performance & resilience**: 6-way bounded-concurrency asset fetching with `tunnelfetch`/`undici` session reuse, shared 8 MiB atomic stream budget enforcement, non-navigation subresource fault isolation (`failedSubresources`), optional CSS `selector` extraction (`selectedText`), and policy-checked redirects.
- **Mailbox & CLI operations**: `GET /v1/targets` capability discovery, `GET /v1/jobs` listing, `POST /v1/jobs/:id/cancel` cancellation, `POST /v1/dispatch` manual queue flush, zero-wait `x-edge-dispatch: immediate` (`ctx.waitUntil`) execution on data-plane enqueue, `--inline` JSON CLI flag, adaptive `wait` backoff, `deploy:safe` secret-preserving Cloudflare deployer, and built-in Agent `SKILL.md`.

## 0.2.0

- Mandatory shared proxy egress for HTTP, browser resources and SSH, with no direct-target fallback.
- Cloudflare Browser Run snapshots: real JavaScript rendering, viewport JPEG, text, title, links and same-origin paths.
- Offline artifact export with escaped content, CSP and exclusive output directories.
- Cloudflare-native deployment using Worker, D1 and Browser Run; no external rendering host.
- SSH CONNECT socket transport, pinned host keys, AES-CTR/SHA-256 compatibility and a static Wasm adapter.
- Proxy failure, real SSH, browser lifecycle and workerd regression tests.

## 0.1.0

- Initial authenticated HTTP/SSH tasks, D1/Cron mailbox and proxy-aware Node client.
