import { connect } from 'cloudflare:sockets';
import { Client } from 'tunnelfetch';
import { JobError, readLimited } from '../src/protocol.js';
import { publicHttpsUrl } from '../src/url-policy.js';
export { proxyTunnel, directTunnel } from './proxy-tunnel.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function createProxySession(proxy) {
  if (!proxy?.server || !proxy.username || !proxy.password) throw new JobError('egress_proxy_required', 503);
  const endpoint = new URL(proxy.server);
  endpoint.username = proxy.username;
  endpoint.password = proxy.password;
  const client = new Client({
    connect,
    proxy: endpoint.href,
    forceTunnel: true,
    trust: { mode: 'system' },
    http2: false,
    maxBodyBytes: 16777216,
    limits: { maxHeaderBytes: 32768, maxProxyReplyBytes: 8192 },
    timeouts: { connectMs: 5000, handshakeMs: 10000, totalMs: 20000 },
    nativeFetch: () => { throw new JobError('direct_egress_disabled', 503); },
  });

  return {
    async fetch(url, { signal, limit = 32768, budget = null, method = 'GET', body, headers, maxRedirects = 0, allowedOrigins = null } = {}) {
      let currentUrl = url;
      let currentMethod = method;
      let currentBody = body;
      let currentHeaders = headers ? { ...headers } : undefined;
      let redirects = 0;
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
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            void response.body?.cancel().catch(() => {});
            if (!REDIRECT_STATUSES.has(response.status) || redirects >= maxRedirects || !location) {
              throw new JobError('redirect_blocked', 502);
            }
            let nextUrl;
            try { nextUrl = publicHttpsUrl(new URL(location, currentUrl).href); }
            catch { throw new JobError('redirect_blocked', 502); }
            if (nextUrl.hash || (allowedOrigins && !allowedOrigins.has(nextUrl.origin))) {
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
            currentUrl = nextUrl.href;
            redirects++;
            continue;
          }
          const bytes = currentMethod === 'HEAD'
            ? (void response.body?.cancel().catch(() => {}), new Uint8Array())
            : await readLimited(response.body, limit, budget);
          return {
            status: response.status,
            headers: response.headers,
            bytes,
            finalUrl: currentUrl,
            redirectCount: redirects,
          };
        }
      } catch (error) {
        if (signal?.aborted) throw new JobError('job_timeout', 504);
        if (error instanceof JobError) throw error;
        console.error(JSON.stringify({
          event: 'proxy_error',
          code: String(error.code ?? error.name).replace(/[^A-Za-z0-9_]/g, '').slice(0, 80),
        }));
        throw new JobError('proxy_request_failed', 502);
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
