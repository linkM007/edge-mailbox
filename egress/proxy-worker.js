import { connect } from 'cloudflare:sockets';
import { Client, warmup } from 'tunnelfetch';
import { chrome } from 'tunnelfetch/profile/chrome';
import { JobError, readLimitedWithMeta } from '../src/protocol.js';
import { publicJobHttpsUrl } from '../src/url-policy.js';
import { applyRedirectHop, createRedirectState, getSetCookieList } from './redirect-cookies.js';
export { proxyTunnel, directTunnel } from './proxy-tunnel.js';

// Pre-tier V8 JIT for proxy CONNECT + TLS 1.3 + X.509 + HTTP during Worker startup so cold
// isolates do not burn Cloudflare Free Plan's 10ms per-request CPU limit in the interpreter.
await warmup({ iterations: 6 });

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Share single-use TLS 1.3 PSK session tickets across requests in the same Worker isolate
// (strictly keyed by tunnelfetch's poolKey: scheme + host + port + proxy + trust + tls).
const baseTicketStore = new Client({ nativeFetch: () => {} }).tickets;
const sharedTickets = {
  put(key, captured) {
    if (!baseTicketStore._byKey.has(key) && baseTicketStore._byKey.size >= 256) {
      const oldest = baseTicketStore._byKey.keys().next().value;
      if (oldest !== undefined) baseTicketStore._byKey.delete(oldest);
    }
    return baseTicketStore.put(key, captured);
  },
  take(key) {
    return baseTicketStore.take(key);
  },
  clear() {},
};

function hasHeaderCaseInsensitive(headers, targetLower) {
  if (!headers) return false;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === targetLower) return true;
  }
  return false;
}

export function createProxySession(proxy) {
  if (!proxy?.server || !proxy.username || !proxy.password) throw new JobError('egress_proxy_required', 503);
  const endpoint = new URL(proxy.server);
  endpoint.username = proxy.username;
  endpoint.password = proxy.password;
  const client = new Client({
    profile: chrome,
    // Keep Chrome GREASE, shuffled extensions, sigSchemes, ALPN, HTTP/2 SETTINGS/PRIORITY/HPACK,
    // and header order, while delegating ECDH + AEAD to native C++ WebCrypto (X25519 + AES-GCM)
    // instead of Wasm ML-KEM-768 / ChaCha20 and fitting ClientHello in a single TCP segment.
    tls: {
      ciphers: [0x1301, 0x1302, 0xc02b, 0xc02f, 0xc02c, 0xc030],
      groups: [0x001d, 0x0017, 0x0018],
      offerGroups: [0x001d],
    },
    connect,
    proxy: endpoint.href,
    forceTunnel: true,
    trust: { mode: 'system' },
    maxBodyBytes: 16777216,
    limits: { maxHeaderBytes: 32768, maxProxyReplyBytes: 8192 },
    timeouts: { connectMs: 10000, handshakeMs: 12000, totalMs: 25000 },
    nativeFetch: () => { throw new JobError('direct_egress_disabled', 503); },
  });
  client.tickets = sharedTickets;

  return {
    async fetch(url, { signal, limit = 32768, budget = null, truncate = false, method = 'GET', body, headers, maxRedirects = 0, returnOnRedirect = false, allowedOrigins = null } = {}) {
      let currentUrl = url;
      let currentMethod = method;
      let currentBody = body;
      let currentHeaders = headers ? { ...headers } : {};
      // Prefer C++ DecompressionStream ('gzip, deflate') unless caller explicitly requested a coding;
      // br/zstd Wasm decoders remain registered in `chrome` if a caller asks for br/zstd or an origin sends them.
      if (!hasHeaderCaseInsensitive(currentHeaders, 'accept-encoding')) {
        currentHeaders['accept-encoding'] = 'gzip, deflate';
      }
      let redirects = 0;
      const redirectCookies = [];
      const redirectState = createRedirectState(url, headers);
      try {
        while (true) {
          const response = await client.fetch(currentUrl, {
            method: currentMethod,
            body: currentBody,
            redirect: 'manual',
            signal,
            headers: currentHeaders,
          });
          if (response.tunnelfetch?.proxied !== true) throw new JobError('direct_egress_disabled', 503);
          if (response.status === 304) {
            void response.body?.cancel().catch(() => {});
            let outHeaders = response.headers;
            if (redirectCookies.length) {
              outHeaders = new Headers(response.headers);
              for (const c of redirectCookies) outHeaders.append('set-cookie', c);
            }
            return {
              status: 304,
              headers: outHeaders,
              bytes: new Uint8Array(),
              truncated: false,
              finalUrl: currentUrl,
              redirectCount: redirects,
            };
          }
          if (response.status >= 300 && response.status < 400) {
            if (returnOnRedirect) {
              void response.body?.cancel().catch(() => {});
              return {
                status: response.status,
                headers: response.headers,
                bytes: new Uint8Array(),
                truncated: false,
                finalUrl: currentUrl,
                redirectCount: redirects,
              };
            }
            const hopCookies = getSetCookieList(response.headers);
            for (const c of hopCookies) redirectCookies.push(c);
            const location = response.headers.get('location');
            void response.body?.cancel().catch(() => {});
            if (!REDIRECT_STATUSES.has(response.status) || redirects >= maxRedirects || !location) {
              throw new JobError('redirect_blocked', 502);
            }
            let nextUrl;
            try { nextUrl = publicJobHttpsUrl(new URL(location, currentUrl).href); }
            catch { throw new JobError('redirect_blocked', 502); }
            if (allowedOrigins && !allowedOrigins.has(nextUrl.origin)) {
              throw new JobError('redirect_blocked', 502);
            }
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && !['GET', 'HEAD'].includes(currentMethod))) {
              currentMethod = 'GET';
              currentBody = undefined;
              if (currentHeaders) {
                delete currentHeaders['content-type'];
                delete currentHeaders['content-length'];
              }
            }
            currentHeaders = applyRedirectHop(redirectState, currentUrl, nextUrl, hopCookies, currentHeaders);
            currentUrl = nextUrl.href;
            redirects++;
            continue;
          }
          const { bytes, truncated } = currentMethod === 'HEAD'
            ? (void response.body?.cancel().catch(() => {}), { bytes: new Uint8Array(), truncated: false })
            : await readLimitedWithMeta(response.body, limit, budget, { truncate });
          let outHeaders = response.headers;
          if (redirectCookies.length) {
            outHeaders = new Headers(response.headers);
            for (const c of redirectCookies) outHeaders.append('set-cookie', c);
          }
          return {
            status: response.status,
            headers: outHeaders,
            bytes,
            truncated,
            finalUrl: currentUrl,
            redirectCount: redirects,
          };
        }
      } catch (error) {
        if (signal?.aborted) throw new JobError('job_timeout', 504);
        if (error instanceof JobError) throw error;
        const detailRaw = [error.code ?? error.name, error.detail?.name].filter(Boolean).join(':');
        const safeCode = detailRaw.replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 64);
        console.error(JSON.stringify({
          event: 'proxy_error',
          code: safeCode,
        }));
        throw new JobError('proxy_request_failed', 502, safeCode || undefined);
      }
    },
    async close() {
      await client.close();
    },
  };
}

export async function proxyFetch(url, proxy, options = {}) {
  const session = createProxySession(proxy);
  try { return await session.fetch(url, options); }
  finally { await session.close(); }
}
