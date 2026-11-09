import { EnvHttpProxyAgent, ProxyAgent, fetch } from 'undici';
import { INSERT_JOB, SELECT_JOB } from '../src/mailbox.js';
import { publicJob, readLimited, validateId, validateJob } from '../src/protocol.js';

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
  async function send(url, { method = 'GET', body, headers = {} } = {}) {
    let response;
    try {
      response = await request(url, { method, redirect: 'manual', dispatcher,
        signal: AbortSignal.timeout(60000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new Error('network_request_failed'); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`remote_http_${response.status}`);
    }
    try { return JSON.parse(new TextDecoder().decode(await readLimited(response.body, 1048576))); }
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
    async run(input) {
      if (plane !== 'data') throw new Error('control_plane_is_asynchronous');
      return send(`${base}/v1/run`, { method: 'POST', body: validateJob(input) });
    },
    async enqueue(input, id) {
      const payload = validateJob(input);
      validateId(id);
      if (plane === 'data') return send(`${base}/v1/jobs`, { method: 'POST',
        body: payload, headers: { 'idempotency-key': id } });
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
  };
}
