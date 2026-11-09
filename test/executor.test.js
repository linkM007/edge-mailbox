import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { executeJob, resolveJob } from '../src/executor.js';
import { readLimited, validateJob } from '../src/protocol.js';
import { gatewayConfig, resolveBrowserJob, requestAllowed } from '../egress/config.js';
import { proxyTunnel } from '../egress/proxy-tunnel.js';
import { proxyFetch } from '../egress/proxy.js';

const env = { RPC_TOKEN: 'x'.repeat(48), EGRESS_PROXY_SERVER: 'http://127.0.0.1:8080',
  EGRESS_PROXY_USERNAME: 'test', EGRESS_PROXY_PASSWORD: 'test', HTTP_TARGETS: JSON.stringify({ example: { url: 'https://example.com/' } }),
  BROWSER_TARGETS: JSON.stringify({ example: { url: 'https://example.com/', resourceOrigins: ['https://cdn.example.com'] } }) };
const job = { type: 'http', target: 'example' };

test('task protocol rejects arbitrary URLs, shell commands and escaped browse paths', () => {
  assert.deepEqual(validateJob(job), job);
  for (const input of [null, [], {}, { ...job, url: 'https://other.com' },
    { type: 'ssh', target: 'ops', action: 'uptime', cmd: 'id' },
    { type: 'browse', target: 'example', path: '//other.com' },
    { type: 'browse', target: 'example', path: '/\\other.com' },
    { type: 'browse', target: 'example', scrollY: -1 }]) assert.throws(() => validateJob(input), /invalid_job/);
  assert.throws(() => resolveJob({ ...job, target: 'toString' }, env), /target_not_allowed/);
});

test('HTTP configuration rejects local names, IPs, credentials and insecure schemes', () => {
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost',
    'https://api.internal', 'https://u:p@example.com', 'https://example.com:8443', 'https://example.com/#x']) {
    assert.throws(() => resolveJob(job, { ...env, HTTP_TARGETS: JSON.stringify({ example: { url } }) }), /invalid_server_config/);
  }
});

test('missing proxy fails closed for every task type before execution', async () => {
  for (const type of ['http', 'browse', 'ssh']) {
    let called = false;
    await assert.rejects(executeJob({ type, target: 'example', ...(type === 'ssh' ? { action: 'uptime' } : {}) },
      { ...env, EGRESS_PROXY_SERVER: '' }, { request: async () => { called = true; } }), /egress_proxy_required/);
    assert.equal(called, false);
  }
});

test('HTTP executor passes the mandatory proxy and returns binary-safe data', async () => {
  const result = await executeJob(job, env, { request: async (url, proxy, options) => {
    assert.equal(url, 'https://example.com/');
    assert.equal(proxy.server, env.EGRESS_PROXY_SERVER);
    assert.ok(options.signal);
    return { status: 200, headers: new Headers(), bytes: new Uint8Array([0, 255, 1]) };
  } });
  assert.equal(result.body, 'AP8B');
  assert.equal(result.proxyUsed, true);
});

test('response size limit cancels the source', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } });
  await assert.rejects(readLimited(stream, 9), /size_limit_exceeded/);
  assert.equal(cancelled, true);
});

test('browser navigation and subresources have separate explicit boundaries', () => {
  const config = gatewayConfig({ ...env, EGRESS_TOKEN: env.RPC_TOKEN });
  const target = resolveBrowserJob({ type: 'browse', target: 'example', path: '/news?q=1', scrollY: 800 }, config);
  assert.equal(target.url, 'https://example.com/news?q=1');
  assert.equal(requestAllowed('https://cdn.example.com/a.js', 'GET', 'script', false, target), true);
  assert.equal(requestAllowed('https://cdn.example.com/', 'GET', 'document', true, target), false);
  assert.equal(requestAllowed('https://example.com/', 'POST', 'fetch', false, target), false);
  assert.equal(requestAllowed('https://other.com/', 'GET', 'image', false, target), false);
});

test('proxy denial propagates for HTTP and SSH without direct fallback', async () => {
  const destinations = [];
  const server = http.createServer();
  server.on('connect', (request, socket) => {
    destinations.push(request.url);
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const proxy = { server: 'http://127.0.0.1:' + server.address().port, username: 'test', password: 'test' };
  try {
    await assert.rejects(proxyFetch('https://blocked.invalid/', proxy, { signal: AbortSignal.timeout(2000) }), /proxy_request_failed/);
    await assert.rejects(proxyTunnel('ssh.example.com', 22, proxy, AbortSignal.timeout(2000)), /proxy_connect_403/);
    assert.deepEqual(destinations, ['blocked.invalid:443', 'ssh.example.com:22']);
  } finally { server.close(); await once(server, 'close'); }
});

test('real SSH handshake and command execution use the CONNECT socket and pinned host key', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const fingerprint = 'SHA256:' + createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const ssh = new Server({ hostKeys: [key] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => ctx.accept()).on('ready', () => client.on('session', accept => {
      accept().on('exec', (acceptExec, _reject, info) => {
        assert.equal(info.command, 'uptime'); const stream = acceptExec(); stream.write('fixture uptime'); stream.exit(0); stream.end();
      });
    }));
  });
  ssh.listen(0, '127.0.0.1'); await once(ssh, 'listening');
  const proxy = http.createServer(); const destinations = [];
  proxy.on('connect', (request, socket, head) => {
    destinations.push(request.url);
    const upstream = net.connect(ssh.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n'); if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    socket.on('close', () => upstream.destroy()); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const config = { hostname: 'ssh.example.com', username: 'ops', fingerprint, keySecret: 'OPS_KEY', actions: { uptime: 'uptime' } };
  const sshEnv = { ...env, EGRESS_PROXY_SERVER: 'http://127.0.0.1:' + proxy.address().port, SSH_TARGETS: JSON.stringify({ ops: config }), OPS_KEY: key };
  try {
    const result = await executeJob({ type: 'ssh', target: 'ops', action: 'uptime' }, sshEnv);
    assert.equal(result.stdout, 'fixture uptime'); assert.equal(result.code, 0); assert.equal(result.proxyUsed, true);
    assert.deepEqual(destinations, ['ssh.example.com:22']);
    await assert.rejects(executeJob({ type: 'ssh', target: 'ops', action: 'uptime' },
      { ...sshEnv, SSH_TARGETS: JSON.stringify({ ops: { ...config, fingerprint: 'SHA256:' + 'A'.repeat(43) } }) }), /ssh_failed/);
    const modules = [{ type: 'ESModule', path: path.resolve('dist/worker.js') }];
    for (const file of await readdir('dist')) if (file.endsWith('.wasm')) modules.push({ type: 'CompiledWasm', path: path.resolve('dist', file) });
    const mf = new Miniflare(convertV4MiniflareOptions({ name: 'ssh-test', modules, modulesRoot: path.resolve('dist'),
      compatibilityDate: '2026-11-04', compatibilityFlags: ['nodejs_compat'], bindings: sshEnv }));
    try {
      const response = await mf.dispatchFetch('http://localhost/v1/run', { method: 'POST',
        headers: { authorization: 'Bearer ' + sshEnv.RPC_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'ssh', target: 'ops', action: 'uptime' }) });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.result.stdout, 'fixture uptime');
    } finally { await mf.dispose(); }
  } finally { proxy.close(); ssh.close(); }
});
