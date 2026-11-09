import { createHash } from 'node:crypto';
import { JobError, JOB_TIMEOUT_MS, OUTPUT_LIMIT } from '../src/protocol.js';
import { resolveGatewayJob } from './config.js';
import { browse } from './browser.js';
import { proxyFetch, proxyTunnel } from './proxy.js';

export async function executeGatewayJob(input, config, { signal, tunnel = proxyTunnel, makeSshClient, request = proxyFetch, launch } = {}) {
  const resolved = resolveGatewayJob(input, config);
  if (resolved.job.type === 'browse') return browse(input, config, { signal, launch });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, JOB_TIMEOUT_MS);
  let socket;
  let client;
  try {
    if (resolved.job.type === 'http') {
      const response = await request(resolved.url, config.proxy, { signal: controller.signal, limit: OUTPUT_LIMIT,
        headers: { accept: '*/*', 'user-agent': 'edge-mailbox/0.2' } });
      return { type: 'http', status: response.status, contentType: response.headers.get('content-type')?.slice(0, 256) ?? null,
        encoding: 'base64', body: Buffer.from(response.bytes).toString('base64'), proxyUsed: true };
    }
    socket = await tunnel(resolved.target.hostname, 22, config.proxy, controller.signal);
    if (controller.signal.aborted) throw new JobError('job_timeout', 504);
    if (makeSshClient) client = makeSshClient();
    else { const { default: Client } = await import('ssh2/lib/client.js'); client = new Client(); }
    if (controller.signal.aborted) throw new JobError('job_timeout', 504);
    return await new Promise((resolve, reject) => {
      const onAbort = () => { client.destroy(); reject(new JobError('job_timeout', 504)); };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener('abort', onAbort);
        error ? reject(error) : resolve(value);
      };
      client.on('error', () => finish(new JobError('ssh_failed', 502)));
      client.on('close', () => finish(new JobError('ssh_disconnected', 502)));
      client.once('ready', () => {
        if (controller.signal.aborted) { onAbort(); return; }
        client.exec(resolved.command, (error, stream) => {
          if (error) return finish(new JobError('ssh_exec_failed', 502));
          const stdout = []; const stderr = [];
          let outSize = 0; let errSize = 0; let code = null; let exitSignal = null;
          stream.on('data', chunk => { outSize += chunk.length; if (outSize > OUTPUT_LIMIT) {
            finish(new JobError('size_limit_exceeded', 413)); client.destroy();
          } else stdout.push(chunk); });
          stream.stderr.on('data', chunk => { errSize += chunk.length; if (errSize > OUTPUT_LIMIT) {
            finish(new JobError('size_limit_exceeded', 413)); client.destroy();
          } else stderr.push(chunk); });
          stream.on('error', () => finish(new JobError('ssh_disconnected', 502)));
          stream.on('exit', (exitCode, signalName) => { code = exitCode ?? null; exitSignal = signalName ?? null; });
          stream.on('close', () => finish(null, { type: 'ssh', code, signal: exitSignal,
            stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), proxyUsed: true }));
          stream.end();
        });
      });
      client.connect({ sock: socket, username: resolved.target.username, privateKey: resolved.pem, readyTimeout: 5000,
        algorithms: { cipher: ['aes256-ctr', 'aes128-ctr'], hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-256'] },
        hostVerifier: key => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') === resolved.target.fingerprint });
    });
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.abort(); client?.destroy(); socket?.destroy();
  }
}
