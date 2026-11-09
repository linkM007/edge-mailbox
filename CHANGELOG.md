# Changelog

## 0.2.0

- Mandatory shared proxy egress for HTTP, browser resources and SSH, with no direct-target fallback.
- Cloudflare Browser Run snapshots: real JavaScript rendering, viewport JPEG, text, title, links and same-origin paths.
- Offline artifact export with escaped content, CSP and exclusive output directories.
- Cloudflare-native deployment using Worker, D1 and Browser Run; no external rendering host.
- SSH CONNECT socket transport, pinned host keys, AES-CTR/SHA-256 compatibility and a static Wasm adapter.
- Proxy failure, real SSH, browser lifecycle and workerd regression tests.

## 0.1.0

- Initial authenticated HTTP/SSH tasks, D1/Cron mailbox and proxy-aware Node client.
