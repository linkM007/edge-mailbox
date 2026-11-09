# Contributing

Use Node.js 22.19+ and npm. Run npm ci, npm test, and npm audit before proposing a change.

Keep changes focused. Any new job type must validate input at the execution boundary, keep secrets out of payloads, enforce bounded execution/output, and include failure-path tests. Queue changes need D1-backed concurrency and idempotency tests. Proxy changes need a local CONNECT test.

The tests use the same Miniflare release bundled with the pinned Wrangler version. That release currently carries a beta version suffix; do not independently upgrade one without running the complete suite. Its official convertV4MiniflareOptions helper is used by the tests.

Test categories:

- executor.test.js: target/proxy validation, CONNECT rejection, and real SSH handshakes in Node and workerd against a local fixture.
- mailbox.test.js: actual local D1 SQL, atomic claims, retention, errors and Worker routes.
- client.test.js: request formats, D1 response handling and local HTTP CONNECT behavior.
- runtime.test.js: bundled Worker fetch/scheduled handlers under workerd, with a rejecting CONNECT proxy and an assertion that direct fetch is unused.
- browser.test.js: resource proxying, late-launch cleanup, output validation and escaped offline artifacts.

Tests require no cloud credentials. npm test performs a dry-run build first. The GitHub workflow only validates code; it never deploys and receives no cloud secrets.

scripts/prepare-worker.mjs extracts the pinned ssh2 Poly1305 Wasm into a static module for Workers. Native acceleration is disabled only in the Worker bundle. Keep both Node and workerd SSH tests passing when upgrading this dependency. Worker HTTP uses tunnelfetch; the local debug helper uses undici. Neither path may fall back to direct target access.

Document known limitations in docs/architecture.md. Keep the README's claims aligned with what the tests actually establish. Avoid describing a local fixture test as proof of cloud or external-server connectivity.
