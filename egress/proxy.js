import { ProxyAgent, fetch } from 'undici';
import { JobError, readLimitedWithMeta } from '../src/protocol.js';
import { publicJobHttpsUrl } from '../src/url-policy.js';
import { applyRedirectHop, createRedirectState, getSetCookieList } from './redirect-cookies.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function credentials(proxy) {
  return 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64');
}

export function proxyDispatcher(proxy) {
  if (!proxy?.server || !proxy.username || !proxy.password) throw new JobError('egress_proxy_required', 503);
  return new ProxyAgent({ uri: proxy.server, token: credentials(proxy) });
}

export function createProxySession(proxy) {
  const dispatcher = proxyDispatcher(proxy);
  return {
    async fetch(url, { signal, limit = 32768, budget = null, truncate = false, method = 'GET', body, headers, maxRedirects = 0, returnOnRedirect = false, allowedOrigins = null } = {}) {
      let currentUrl = url;
      let currentMethod = method;
      let currentBody = body;
      let currentHeaders = headers ? { ...headers } : undefined;
      let redirects = 0;
      const redirectCookies = [];
      const redirectState = createRedirectState(url, currentHeaders);
      try {
        while (true) {
          const response = await fetch(currentUrl, {
            dispatcher,
            signal,
            method: currentMethod,
            body: currentBody,
            redirect: 'manual',
            headers: currentHeaders,
          });
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
        throw new JobError('proxy_request_failed', 502);
      }
    },
    async close() {
      await dispatcher.destroy();
    },
  };
}

export async function proxyFetch(url, proxy, options = {}) {
  const session = createProxySession(proxy);
  try { return await session.fetch(url, options); }
  finally { await session.close(); }
}

export { proxyTunnel, directTunnel } from './proxy-tunnel.js';
