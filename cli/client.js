import { EnvHttpProxyAgent, ProxyAgent, fetch } from 'undici';
import { CANCEL_JOB, INSERT_JOB, LIST_JOBS_ALL, LIST_JOBS_BY_STATUS, SELECT_JOB } from '../src/mailbox.js';
import { JOB_STATUSES, publicJob, publicJobSummary, readLimited, validateId, validateJob } from '../src/protocol.js';

export function createDispatcher(env = process.env) {
  const httpProxy = env.http_proxy || env.HTTP_PROXY;
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY || httpProxy;
  if (env.EDGE_REQUIRE_PROXY === '1' && !httpsProxy) throw new Error('proxy_required');
  for (const proxy of [httpProxy, httpsProxy].filter(Boolean)) {
    const url = new URL(proxy);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('http_proxy_required');
  }
  return env.EDGE_REQUIRE_PROXY === '1'
    ? new ProxyAgent(httpsProxy)
    : new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: env.no_proxy ?? env.NO_PROXY ?? '' });
}

function required(env, name) {
  if (!env[name]) throw new Error(`missing_${name}`);
  return env[name];
}

export function createClient({ plane = 'data', env = process.env, dispatcher, request = fetch } = {}) {
  if (!['data', 'control'].includes(plane)) throw new Error('invalid_plane');
  let base;
  let token;
  if (plane === 'data') {
    const url = new URL(required(env, 'EDGE_ENDPOINT'));
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/') throw new Error('invalid_endpoint');
    base = url.origin;
    token = required(env, 'EDGE_RPC_TOKEN');
    if (token.length < 32) throw new Error('rpc_token_too_short');
  } else {
    const account = required(env, 'CLOUDFLARE_ACCOUNT_ID');
    const database = required(env, 'CLOUDFLARE_D1_DATABASE_ID');
    if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database)) {
      throw new Error('invalid_cloudflare_id');
    }
    base = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`;
    token = required(env, 'CLOUDFLARE_API_TOKEN');
  }

  async function send(url, { method = 'GET', body, headers = {}, auth = true } = {}) {
    let response;
    try {
      const mergedHeaders = {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined || method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...headers,
      };
      // Preserve exact header contract expected by existing callers/tests.
      if (auth && mergedHeaders['content-type'] === undefined) {
        mergedHeaders['content-type'] = 'application/json';
      }
      response = await request(url, {
        method,
        redirect: 'manual',
        dispatcher,
        signal: AbortSignal.timeout(60000),
        headers: mergedHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new Error('network_request_failed'); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`remote_http_${response.status}`);
    }
    try { return JSON.parse(new TextDecoder().decode(await readLimited(response.body, 4194304))); }
    catch { throw new Error('invalid_remote_response'); }
  }

  async function query(sql, params) {
    const data = await send(base, { method: 'POST', body: { sql, params } });
    if (data.success !== true || !Array.isArray(data.result) ||
        data.result.length !== 1 || data.result[0].success !== true ||
        (data.result[0].results !== undefined && !Array.isArray(data.result[0].results))) {
      throw new Error('cloudflare_query_failed');
    }
    return data.result[0].results ?? [];
  }

  return {
    async health() {
      if (plane !== 'data') throw new Error('control_plane_has_no_health_endpoint');
      return send(`${base}/healthz`, { auth: false });
    },
    async targets() {
      if (plane !== 'data') throw new Error('control_plane_has_no_targets_endpoint');
      return send(`${base}/v1/targets`);
    },
    async httpGet({ url, target, path, followRedirects, maxBytes, truncate, proxy } = {}) {
      if (plane !== 'data') throw new Error('control_plane_is_asynchronous');
      const params = new URLSearchParams();
      if (url !== undefined) params.set('url', url);
      if (target !== undefined) params.set('target', target);
      if (path !== undefined) params.set('path', path);
      if (followRedirects !== undefined) params.set('follow', followRedirects ? '1' : '0');
      if (maxBytes !== undefined) params.set('maxBytes', String(maxBytes));
      if (truncate !== undefined) params.set('truncate', truncate ? '1' : '0');
      if (proxy !== undefined) params.set('proxy', proxy);
      return send(`${base}/v1/http?${params.toString()}`);
    },
    async dispatch() {
      if (plane !== 'data') throw new Error('control_plane_is_asynchronous');
      return send(`${base}/v1/dispatch`, { method: 'POST', body: {} });
    },
    async run(input) {
      if (plane !== 'data') throw new Error('control_plane_is_asynchronous');
      return send(`${base}/v1/run`, { method: 'POST', body: validateJob(input) });
    },
    async enqueue(input, id, { immediate = false } = {}) {
      const payload = validateJob(input);
      validateId(id);
      if (plane === 'data') {
        const headers = {
          'idempotency-key': id,
          ...(immediate ? { 'x-edge-dispatch': 'immediate' } : {}),
        };
        return send(`${base}/v1/jobs`, { method: 'POST', body: payload, headers });
      }
      const encoded = JSON.stringify(payload);
      await query(INSERT_JOB, [id, encoded]);
      const [row] = await query(SELECT_JOB, [id]);
      if (!row) throw new Error('mailbox_full');
      if (row.payload !== encoded) throw new Error('idempotency_conflict');
      return publicJob(row);
    },
    async result(id) {
      validateId(id);
      if (plane === 'data') return send(`${base}/v1/jobs/${id}`);
      const [row] = await query(SELECT_JOB, [id]);
      if (!row) throw new Error('job_not_found');
      return publicJob(row);
    },
    async list({ status, limit = 20 } = {}) {
      if (status !== undefined && !JOB_STATUSES.includes(status)) throw new Error('invalid_status_filter');
      const parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) throw new Error('invalid_limit');
      if (plane === 'data') {
        const params = new URLSearchParams({ limit: String(parsedLimit) });
        if (status !== undefined) params.set('status', status);
        return send(`${base}/v1/jobs?${params.toString()}`);
      }
      const rows = status === undefined
        ? await query(LIST_JOBS_ALL, [parsedLimit])
        : await query(LIST_JOBS_BY_STATUS, [status, parsedLimit]);
      return { jobs: rows.map(publicJobSummary) };
    },
    async cancel(id) {
      validateId(id);
      if (plane === 'data') return send(`${base}/v1/jobs/${id}/cancel`, { method: 'POST', body: {} });
      await query(CANCEL_JOB, [id]);
      const [row] = await query(SELECT_JOB, [id]);
      if (!row) throw new Error('job_not_found');
      return publicJob(row);
    },
  };
}
