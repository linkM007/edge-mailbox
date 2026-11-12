import { gatewayConfig, listConfiguredTargets, resolveGatewayJob, resolveProxy } from '../egress/config.js';
import { HTTP_METHODS, JobError, readLimited } from './protocol.js';
import { publicJobHttpsUrl } from './url-policy.js';

const RELAY_DROP_REQ_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length',
]);
const RELAY_DROP_RESP_HEADERS = new Set([
  'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie',
]);

export function resolveJob(input, env) {
  return resolveGatewayJob(input, gatewayConfig({ ...env, EGRESS_TOKEN: env.RPC_TOKEN }));
}

export function listTargets(env) {
  return listConfiguredTargets(gatewayConfig({ ...env, EGRESS_TOKEN: env.RPC_TOKEN }));
}

export async function executeJob(input, env, deps = {}) {
  const config = gatewayConfig({ ...env, EGRESS_TOKEN: env.RPC_TOKEN });
  let executeGatewayJob;
  try { ({ executeGatewayJob } = await import('../egress/executor.js')); }
  catch { throw new JobError('runtime_init_failed', 503); }
  return executeGatewayJob(input, config, {
    ...deps,
    launch: deps.launch ?? (async () => {
      const { launch } = await import('@cloudflare/playwright');
      return launch(env.BROWSER, { guardrails: { allowedDomains: [] } });
    }),
  });
}

export async function executeProxyFetch(request, env, deps = {}) {
  const config = gatewayConfig({ ...env, EGRESS_TOKEN: env.RPC_TOKEN });
  if (!config.allowDynamicUrls) throw new JobError('dynamic_url_not_enabled', 403);
  const rawUrl = request.headers.get('x-target-url') ?? '';
  const targetUrl = publicJobHttpsUrl(rawUrl);
  const method = (request.headers.get('x-target-method') ?? 'GET').toUpperCase();
  if (!HTTP_METHODS.includes(method)) throw new JobError('invalid_job', 400);
  const proxyName = request.headers.get('x-target-proxy') ?? undefined;
  const proxy = resolveProxy(config, proxyName);

  const outHeaders = {};
  const headersB64 = request.headers.get('x-target-headers-b64');
  if (headersB64) {
    if (headersB64.length > 32768) throw new JobError('invalid_job', 400);
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(headersB64, 'base64').toString('utf8'));
    } catch {
      throw new JobError('invalid_job', 400);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new JobError('invalid_job', 400);
    for (const [k, v] of Object.entries(parsed)) {
      const lower = k.toLowerCase();
      if (RELAY_DROP_REQ_HEADERS.has(lower) || typeof v !== 'string' || v.length > 16384 || /[\r\n\x00]/.test(v)) continue;
      outHeaders[lower] = v;
    }
  }
  outHeaders['accept-encoding'] = 'gzip, deflate';

  let body;
  if (!['GET', 'HEAD'].includes(method) && request.body) {
    const buf = await readLimited(request.body, 262144);
    if (buf.byteLength > 0) body = buf;
  }

  let requestFn = deps.request;
  if (!requestFn) {
    const mod = await import('../egress/proxy.js');
    requestFn = mod.proxyFetch;
  }
  const follow = request.headers.get('x-target-follow') === '1';
  const upstream = await requestFn(targetUrl.href, proxy, {
    method,
    body,
    headers: outHeaders,
    limit: 8388608,
    truncate: false,
    maxRedirects: follow ? 5 : 0,
    returnOnRedirect: !follow,
  });

  const respHeaders = {};
  for (const [k, v] of upstream.headers) {
    const lower = k.toLowerCase();
    if (RELAY_DROP_RESP_HEADERS.has(lower)) continue;
    respHeaders[lower] = v;
  }
  const setCookies = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie()
    : (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')] : []);

  return {
    status: upstream.status,
    headers: respHeaders,
    setCookies,
    bytes: upstream.bytes,
  };
}

export async function executeBrowserSession(input, env, deps = {}) {
  const config = gatewayConfig({ ...env, EGRESS_TOKEN: env.RPC_TOKEN });
  let runBrowserSession;
  try { ({ runBrowserSession } = await import('../egress/session-browser.js')); }
  catch { throw new JobError('runtime_init_failed', 503); }
  return runBrowserSession(input, config, {
    ...deps,
    acquireSession: deps.acquireSession ?? (async ({ keepAliveMs }) => {
      const { acquire, sessions } = await import('@cloudflare/playwright');
      try {
        return await acquire(env.BROWSER, { keep_alive: keepAliveMs, guardrails: { allowedDomains: [] } });
      } catch (err) {
        const list = await sessions(env.BROWSER).catch(() => []);
        const idle = list.find(s => !s.connectionId && s.sessionId);
        if (idle) return { sessionId: idle.sessionId, reused: true };
        const msg = String(err?.message ?? '');
        if (msg.includes('429')) throw new JobError('browser_rate_limited', 429);
        throw new JobError('browser_acquire_failed', 502);
      }
    }),
    connectSession: deps.connectSession ?? (async sessionId => {
      const { connect } = await import('@cloudflare/playwright');
      try {
        return await connect(env.BROWSER, { sessionId, persistent: true });
      } catch {
        throw new JobError('browser_connect_failed', 502);
      }
    }),
  });
}
