# Security model

Single-operator, shared-token task runner. Only use access paths approved by the relevant network and service operators. This is an application proxy policy, not an operating-system firewall or transparent VPN.

## Enforced boundaries

- Missing proxy configuration fails closed. HTTP and browser resource requests require the configured proxy; no direct-fetch fallback is available in the Worker transport.
- Browser Run starts with empty allowedDomains guardrails. Application code intercepts every allowed HTTP(S) resource and fulfills proxy-fetched bytes. WebSockets, service/workers, WebRTC, WebTransport, popups and downloads are restricted. Only GET/HEAD and configured HTTPS origins are allowed; redirects are rejected.
- SSH receives an already-established HTTP CONNECT socket, never direct host connection options. Host keys are SHA256-pinned; fixed actions run with the configured remote account. AES-CTR and SHA-256 HMAC are required.
- Inputs, outputs, resource budgets and execution time are bounded. Errors do not include upstream credentials. Offline previews escape remote strings and use a restrictive CSP; captured page scripts are not embedded.
- Atomic D1 claims and fencing tokens prevent competing claimants from normally executing the same pending row. Interrupted or failed SSH jobs are not automatically replayed.

## Trust and limitations

RPC token holders can run all configured actions and read every result. D1 write tokens are administrative: holders can alter queue state, limits and results. No tenant isolation or global rate limiter is included. Configure platform access/rate controls and budgets before broad use.

Targets and DNS administrators are trusted. Syntax checks do not pin DNS. Commands are server-side code interpreted by the remote shell. Results may contain sensitive data; limit what commands and pages return.

Worker HTTPS proxying relies on tunnelfetch 1.13.1, which implements TLS/X.509 in user space and has not completed an independent security audit. The system trust policy uses its bundled roots, with hostname/chain validation enabled. Dependency audits do not replace a cryptographic audit. No certificate bypass or fingerprint impersonation profile is configured.

An HTTP proxy sends proxy authentication over its plaintext first hop; use a trusted path, or an HTTPS proxy when supported. Proxy providers see destination metadata and control reachability. A proxy address is not a guarantee that every target will accept traffic.

Browser restrictions deliberately limit compatibility with login flows and complex applications. Each task uses a fresh session; there are no user cookies or persistent credentials in the browser. The project exposes no arbitrary evaluate, input or click endpoint.

The SSH library's optional native acceleration is disabled only in the Worker bundle. Its existing Poly1305 Wasm is precompiled as a static module. The build checks the pinned dependency structure. Closing SSH does not guarantee termination of remote child processes.

Exactly-once side effects are not guaranteed. Deduplication lasts only while a row exists, and synchronous requests have no idempotency ledger. SSH errors are conservatively marked unknown.

## Reporting

Report security issues privately to the repository owner or through private GitHub security reporting when enabled. Do not put live credentials, private keys, user data or captured page contents into public issues.
