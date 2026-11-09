import { ProxyAgent, fetch } from 'undici';
import { JobError, readLimited } from '../src/protocol.js';

function credentials(proxy) { return 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64'); }

export function proxyDispatcher(proxy) {
  if (!proxy?.server || !proxy.username || !proxy.password) throw new JobError('egress_proxy_required', 503);
  return new ProxyAgent({ uri: proxy.server, token: credentials(proxy) });
}

export async function proxyFetch(url, proxy, { signal, limit = 32768, headers } = {}) {
  const dispatcher = proxyDispatcher(proxy);
  try {
    const response = await fetch(url, { dispatcher, signal, method: 'GET', redirect: 'manual', headers });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      throw new JobError('redirect_blocked', 502);
    }
    return { status: response.status, headers: response.headers, bytes: await readLimited(response.body, limit) };
  } catch (error) {
    if (signal?.aborted) throw new JobError('job_timeout', 504);
    if (error instanceof JobError) throw error;
    throw new JobError('proxy_request_failed', 502);
  } finally { await dispatcher.destroy(); }
}

export { proxyTunnel } from './proxy-tunnel.js';
