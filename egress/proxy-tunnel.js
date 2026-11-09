import net from 'node:net';
import tls from 'node:tls';
import { JobError } from '../src/protocol.js';
const credentials = proxy => 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64');

export function proxyTunnel(hostname, port, proxy, signal) {
  if (!proxy?.server || !proxy.username || !proxy.password) throw new JobError('egress_proxy_required', 503);
  return new Promise((resolve, reject) => {
    const endpoint = new URL(proxy.server);
    const options = { host: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)) };
    const socket = endpoint.protocol === 'https:' ? tls.connect({ ...options, servername: endpoint.hostname, rejectUnauthorized: true }) : net.connect(options);
    let pending = Buffer.alloc(0);
    let settled = false;
    const fail = code => { if (settled) return; settled = true; socket.destroy(); reject(new JobError(code, 502)); };
    const abort = () => { if (settled) socket.destroy(); else fail('job_timeout'); };
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('close', () => { signal?.removeEventListener('abort', abort); if (!settled) fail('proxy_connect_closed'); });
    socket.on('error', () => fail('proxy_connect_failed'));
    socket.setTimeout(5000, () => fail('proxy_connect_timeout'));
    const onData = chunk => {
      pending = Buffer.concat([pending, chunk]);
      const split = pending.indexOf('\r\n\r\n');
      if (split < 0 && pending.length <= 8192) return;
      if (split < 0 || split > 8192) return fail('proxy_invalid_response');
      const match = /^HTTP\/1\.[01] ([0-9]{3})(?: |\r)/.exec(pending.toString('latin1', 0, split + 2));
      if (!match) return fail('proxy_invalid_response');
      if (match[1] !== '200') return fail('proxy_connect_' + match[1]);
      settled = true;
      socket.setTimeout(0);
      socket.pause();
      socket.removeListener('data', onData);
      const head = pending.subarray(split + 4);
      if (head.length) socket.unshift(head);
      resolve(socket);
    };
    socket.on('data', onData);
    socket.once(endpoint.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      socket.write('CONNECT ' + hostname + ':' + port + ' HTTP/1.1\r\nHost: ' + hostname + ':' + port +
        '\r\nProxy-Authorization: ' + credentials(proxy) + '\r\n\r\n');
    });
    if (signal?.aborted) abort();
  });
}
