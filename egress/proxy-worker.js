import { connect } from 'cloudflare:sockets';
import { Client } from 'tunnelfetch';
import { JobError, readLimited } from '../src/protocol.js';
export { proxyTunnel } from './proxy-tunnel.js';

export async function proxyFetch(url, proxy, { signal, limit = 32768, headers } = {}) {
  if (!proxy?.server || !proxy.username || !proxy.password) throw new JobError('egress_proxy_required', 503);
  const endpoint = new URL(proxy.server);
  endpoint.username = proxy.username;
  endpoint.password = proxy.password;
  const client = new Client({ connect, proxy: endpoint.href, forceTunnel: true,
    trust: { mode: 'system' }, http2: false, maxBodyBytes: limit,
    limits: { maxHeaderBytes: 16384, maxProxyReplyBytes: 8192 },
    timeouts: { connectMs: 5000, handshakeMs: 10000, totalMs: 15000 },
    nativeFetch: () => { throw new JobError('direct_egress_disabled', 503); } });
  try {
    const response = await client.fetch(url, { method: 'GET', redirect: 'manual', signal, headers });
    if (response.tunnelfetch?.proxied !== true) throw new JobError('direct_egress_disabled', 503);
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      throw new JobError('redirect_blocked', 502);
    }
    return { status: response.status, headers: response.headers, bytes: await readLimited(response.body, limit) };
  } catch (error) {
    if (signal?.aborted) throw new JobError('job_timeout', 504);
    if (error instanceof JobError) throw error;
    console.error(JSON.stringify({ event: 'proxy_error', code: String(error.code ?? error.name).replace(/[^A-Za-z0-9_]/g, '').slice(0, 80) }));
    throw new JobError('proxy_request_failed', 502);
  } finally { await client.close(); }
}
