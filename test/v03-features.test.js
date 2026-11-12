import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;

import { publicHostOrIp, publicIpv4 } from '../src/url-policy.js';
import { readLimited, validateJob } from '../src/protocol.js';
import { executeJob, listTargets, resolveJob } from '../src/executor.js';
import { browse } from '../egress/browser.js';
import { handleRequest } from '../src/worker.js';
import { createClient } from '../cli/client.js';

const baseEnv = {
  RPC_TOKEN: 'v03-secret-token-'.repeat(3),
  EGRESS_PROXY_SERVER: 'http://127.0.0.1:8080',
  EGRESS_PROXY_USERNAME: 'default-user',
  EGRESS_PROXY_PASSWORD: 'default-pass',
};

test('publicIpv4 accepts global unicast IPs and rejects private, metadata, CGNAT, and reserved ranges', () => {
  for (const ip of ['35.236.146.168', '8.8.8.8', '1.1.1.1', '198.145.82.119']) {
    assert.equal(publicIpv4(ip), true, ip);
    assert.equal(publicHostOrIp(ip), true, ip);
  }
  for (const bad of [
    '0.0.0.1', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1',
    '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '010.1.1.1', '256.1.1.1', 'example.com',
  ]) {
    assert.equal(publicIpv4(bad), false, bad);
  }
  assert.equal(publicHostOrIp('ssh.example.com'), true);
  assert.equal(publicHostOrIp('internal.localhost'), false);
});

test('HTTP tasks support allowlisted methods, paths, bodies, secret headers, named proxies, and origin-checked redirects', async () => {
  const env = {
    ...baseEnv,
    API_BEARER: 'upstream-secret-value',
    DC_USER: 'dc-user',
    DC_PASS: 'dc-pass',
    EGRESS_PROXIES: JSON.stringify({
      datacenter: { server: 'http://127.0.0.1:9090', usernameSecret: 'DC_USER', passwordSecret: 'DC_PASS' },
    }),
    HTTP_TARGETS: JSON.stringify({
      readonly: { url: 'https://api.example.com/v1/' },
      mutable: {
        url: 'https://api.example.com/v1/',
        methods: ['GET', 'POST'],
        followRedirects: true,
        maxRedirects: 3,
        allowedOrigins: ['https://cdn.example.com'],
        proxy: 'datacenter',
        headerSecrets: { Authorization: 'Bearer $API_BEARER' },
      },
    }),
  };

  assert.throws(() => resolveJob({ type: 'http', target: 'readonly', method: 'POST', body: '{}' }, env), /method_not_allowed/);
  assert.throws(() => validateJob({ type: 'http', target: 'mutable', method: 'GET', body: '{}' }), /invalid_job/);

  let captured;
  const res = await executeJob(
    { type: 'http', target: 'mutable', path: '/v1/items?limit=5', method: 'POST', body: '{"a":1}', contentType: 'application/json' },
    env,
    {
      request: async (url, proxy, options) => {
        captured = { url, proxy, options };
        return {
          status: 201,
          finalUrl: 'https://cdn.example.com/v1/items',
          redirectCount: 1,
          headers: new Headers({ 'content-type': 'application/json' }),
          bytes: Buffer.from('{"created":true}'),
        };
      },
    },
  );
  assert.equal(captured.url, 'https://api.example.com/v1/items?limit=5');
  assert.equal(captured.proxy.server, 'http://127.0.0.1:9090');
  assert.equal(captured.proxy.username, 'dc-user');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.authorization, 'Bearer upstream-secret-value');
  assert.equal(captured.options.maxRedirects, 3);
  assert.equal(Buffer.from(captured.options.body).toString('utf8'), '{"a":1}');
  assert.equal(res.status, 201);
  assert.equal(res.redirectCount, 1);
  assert.equal(res.url, 'https://cdn.example.com/v1/items');
});

test('SSH supports custom ports, public IPv4 targets, stdin piping, and explicit opt-in direct mode', async () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
  const rsaHost = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const fingerprint = 'SHA256:' + createHash('sha256').update(utils.parseKey(rsaHost).getPublicSSH()).digest('base64').replace(/=+$/, '');

  const ssh = new Server({ hostKeys: [rsaHost] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => ctx.accept()).on('ready', () => client.on('session', accept => {
      accept().on('exec', (acceptExec, _reject, info) => {
        assert.equal(info.command, 'cat');
        const stream = acceptExec();
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => {
          stream.write('received:' + Buffer.concat(chunks).toString('utf8'));
          stream.exit(0);
          stream.end();
        });
      });
    }));
  });
  ssh.listen(0, '127.0.0.1');
  await once(ssh, 'listening');
  const sshPort = ssh.address().port;

  const targetCfg = {
    hostname: '35.236.146.168',
    port: sshPort,
    egress: 'direct',
    allowStdin: true,
    timeoutMs: 30000,
    username: 'ops',
    fingerprint,
    keySecret: 'VM_KEY',
    actions: { write_cfg: 'cat' },
  };
  const sshEnv = { ...baseEnv, VM_KEY: key, SSH_TARGETS: JSON.stringify({ vm: targetCfg }) };

  try {
    // Fails closed when ALLOW_DIRECT_SSH is not enabled
    await assert.rejects(
      executeJob({ type: 'ssh', target: 'vm', action: 'write_cfg', stdin: 'hello-world' }, sshEnv),
      /direct_ssh_not_enabled/,
    );
    // Fails closed when stdin is passed to target without allowStdin
    await assert.rejects(
      executeJob(
        { type: 'ssh', target: 'vm', action: 'write_cfg', stdin: 'hello' },
        { ...sshEnv, ALLOW_DIRECT_SSH: '1', SSH_TARGETS: JSON.stringify({ vm: { ...targetCfg, allowStdin: false } }) },
      ),
      /stdin_not_allowed/,
    );
    // Succeeds when ALLOW_DIRECT_SSH=1 and connects to exact custom port with stdin
    let dialedHost;
    let dialedPort;
    const out = await executeJob(
      { type: 'ssh', target: 'vm', action: 'write_cfg', stdin: 'config-payload-123' },
      { ...sshEnv, ALLOW_DIRECT_SSH: '1' },
      {
        connectDirect: (host, port) => new Promise((resolve, reject) => {
          dialedHost = host;
          dialedPort = port;
          const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.pause(); resolve(sock); });
          sock.on('error', reject);
        }),
      },
    );
    assert.equal(dialedHost, '35.236.146.168');
    assert.equal(dialedPort, sshPort);
    assert.equal(out.stdout, 'received:config-payload-123');
    assert.equal(out.proxyUsed, false);
    assert.equal(out.egress, 'direct');
  } finally {
    ssh.close();
  }
});

test('browser isolates non-navigation subresource failures while enforcing shared byte budgets and selector extraction', async () => {
  const cfg = {
    proxy: { server: 'http://proxy.example.com:10001', username: 'u', password: 'p' },
    BROWSER_TARGETS: {
      site: { url: 'https://example.com/', resourceOrigins: ['https://cdn.example.com'], settleMs: 0, followRedirects: true },
    },
  };
  let handler;
  const frame = {};
  const page = {
    on() {},
    mainFrame: () => frame,
    setDefaultTimeout() {},
    async goto() {
      await Promise.all([
        handler({
          request: () => ({
            url: () => 'https://example.com/',
            method: () => 'GET',
            resourceType: () => 'document',
            isNavigationRequest: () => true,
            frame: () => frame,
            headers: () => ({ accept: 'text/html' }),
          }),
          fulfill: async () => {},
          abort: async () => { throw new Error('main_aborted'); },
        }),
        handler({
          request: () => ({
            url: () => 'https://cdn.example.com/broken.png',
            method: () => 'GET',
            resourceType: () => 'image',
            isNavigationRequest: () => false,
            frame: () => frame,
            headers: () => ({ accept: 'image/*' }),
          }),
          fulfill: async () => {},
          abort: async () => {},
        }),
      ]);
      return { status: () => 200 };
    },
    async evaluate(_fn, arg) {
      if (arg === 0) return;
      if (arg === '#hero') return 'Hero Headline';
      return { url: 'https://example.com/', title: 'Title', text: 'Full body text', links: [] };
    },
    async screenshot() { return Buffer.from('/9j/2Q==', 'base64'); },
  };
  const context = {
    on() {},
    async addInitScript() {},
    async newPage() { return page; },
    async route(_pattern, cb) { handler = cb; },
    async routeWebSocket() {},
  };
  const browser = { async newContext() { return context; }, async close() {} };

  const seenHeaders = new Map();
  const res = await browse({ type: 'browse', target: 'site', selector: '#hero' }, cfg, {
    launch: async () => browser,
    requestResource: async (url, _proxy, options) => {
      seenHeaders.set(url, options.headers);
      if (url.endsWith('broken.png')) throw new Error('upstream_404');
      return { status: 200, redirectCount: 1, headers: new Headers(), bytes: Buffer.from('<h1>OK</h1>') };
    },
  });
  assert.equal(res.failedSubresources, 1);
  assert.equal(res.redirectCount, 1);
  assert.equal(res.selectedText, 'Hero Headline');
  assert.equal(seenHeaders.get('https://example.com/')?.['sec-fetch-mode'], 'navigate');
  assert.equal(seenHeaders.get('https://example.com/')?.['sec-fetch-dest'], 'document');
  assert.equal(seenHeaders.get('https://example.com/')?.['sec-fetch-site'], 'none');
  assert.equal(seenHeaders.get('https://cdn.example.com/broken.png')?.['sec-fetch-dest'], 'image');
  assert.equal(seenHeaders.get('https://cdn.example.com/broken.png')?.['sec-fetch-mode'], 'no-cors');
  assert.equal(seenHeaders.get('https://cdn.example.com/broken.png')?.['sec-fetch-site'], 'cross-site');

  // Shared byte budget rejects concurrent overruns immediately
  const budget = { used: 0, max: 15 };
  const s1 = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } });
  const s2 = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } });
  await readLimited(s1, 20, budget);
  await assert.rejects(readLimited(s2, 20, budget), /size_limit_exceeded/);
});

test('Worker and CLI support targets manifest, list, cancel, dispatch, and immediate waitUntil execution without leaking secrets', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'v03-mailbox-test',
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2026-07-30',
    d1Databases: ['DB'],
  }));
  try {
    const db = await mf.getD1Database('DB');
    const migration = await readFile(new URL('../migrations/0001_jobs.sql', import.meta.url), 'utf8');
    await db.batch(migration.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));

    const env = {
      ...baseEnv,
      DB: db,
      TW_SSH_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n-----END OPENSSH PRIVATE KEY-----',
      HTTP_TARGETS: JSON.stringify({ ip: { url: 'https://ipinfo.io/json', methods: ['GET'] } }),
      SSH_TARGETS: JSON.stringify({
        tw: { hostname: '35.236.146.168', port: 2222, username: 'ops', fingerprint: 'SHA256:' + 'B'.repeat(43), keySecret: 'TW_SSH_KEY', actions: { ping: 'uptime' } },
      }),
    };

    const manifest = listTargets(env);
    assert.equal(JSON.stringify(manifest).includes('SECRET'), false);
    assert.equal(JSON.stringify(manifest).includes('default-pass'), false);
    assert.deepEqual(manifest.ssh[0].actions, ['ping']);
    assert.equal(manifest.ssh[0].port, 2222);

    const waited = [];
    const client = createClient({
      plane: 'data',
      env: { EDGE_ENDPOINT: 'https://worker.example.com', EDGE_RPC_TOKEN: env.RPC_TOKEN },
      request: (url, init) => handleRequest(
        new Request(url, init),
        env,
        async () => ({ type: 'http', status: 200, proxyUsed: true }),
        { waitUntil: promise => waited.push(promise) },
      ),
    });

    const health = await client.health();
    assert.equal(health.version, '0.4.0');
    const targetsResp = await client.targets();
    assert.equal(targetsResp.targets.http[0].name, 'ip');
    assert.equal(targetsResp.targets.dynamicUrls, false);

    // Enqueue without immediate -> stays pending so we can list & cancel it
    const pendingJob = await client.enqueue({ type: 'http', target: 'ip' }, 'cancel-me-001');
    assert.equal(pendingJob.status, 'pending');
    const listed = await client.list({ status: 'pending', limit: 10 });
    assert.equal(listed.jobs.length, 1);
    assert.equal(listed.jobs[0].id, 'cancel-me-001');

    const canceled = await client.cancel('cancel-me-001');
    assert.equal(canceled.status, 'failed');
    assert.equal(canceled.error, 'job_canceled');

    // Enqueue with immediate: true -> triggers ctx.waitUntil(processMailbox) immediately!
    const imm = await client.enqueue({ type: 'http', target: 'ip' }, 'immediate-001', { immediate: true });
    assert.equal(imm.status, 'pending');
    assert.equal(waited.length, 1);
    await Promise.all(waited);
    const done = await client.result('immediate-001');
    assert.equal(done.status, 'succeeded');
  } finally {
    await mf.dispose();
  }
});

test('ALLOW_DYNAMIC_URLS supports full HTTP methods, GET /v1/http raw/JSON modes, truncation, and dynamic browse while blocking SSRF', async () => {
  // Fails closed by default when ALLOW_DYNAMIC_URLS is unset
  assert.throws(() => resolveJob({ type: 'http', target: '_url', url: 'https://example.com/api' }, baseEnv), /dynamic_url_not_enabled/);
  assert.throws(() => resolveJob({ type: 'browse', target: '_url', url: 'https://example.com/' }, baseEnv), /dynamic_url_not_enabled/);

  const dynEnv = { ...baseEnv, ALLOW_DYNAMIC_URLS: '1' };

  // SSRF protection still rejects insecure schemes, private/metadata IPs, localhost, credentials, and custom ports
  for (const badUrl of [
    'http://example.com/',
    'https://localhost/admin',
    'https://127.0.0.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://user:pass@example.com/',
    'https://example.com:8443/',
  ]) {
    assert.throws(() => resolveJob({ type: 'http', target: '_url', url: badUrl }, dynEnv), /target_not_allowed/, badUrl);
    assert.throws(() => resolveJob({ type: 'browse', target: '_url', url: badUrl }, dynEnv), /target_not_allowed/, badUrl);
  }

  // Forbidden framing headers are rejected at validation time
  assert.throws(() => validateJob({
    type: 'http', target: '_url', url: 'https://example.com/', headers: { Host: 'evil.com' },
  }), /invalid_job/);

  // All HTTP methods (GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE) work with custom headers & response headers
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const res = await executeJob(
      {
        type: 'http',
        target: '_url',
        url: 'https://api.example.com/v2/resource#frag',
        method,
        headers: { 'X-Custom-Trace': 'trace-123' },
        ...(hasBody ? { body: '{"ok":true}', contentType: 'application/json' } : {}),
        maxBytes: 10,
        truncate: true,
      },
      dynEnv,
      {
        request: async (url, _proxy, options) => {
          assert.equal(url, 'https://api.example.com/v2/resource');
          assert.equal(options.method, method);
          assert.equal(options.headers['x-custom-trace'], 'trace-123');
          assert.equal(options.limit, 10);
          assert.equal(options.truncate, true);
          return {
            status: 200,
            finalUrl: 'https://www.example.com/v2/resource',
            redirectCount: 1,
            headers: new Headers({ 'content-type': 'text/plain', 'x-upstream': 'yes', 'set-cookie': 'sid=secret' }),
            bytes: Buffer.from('0123456789'),
            truncated: true,
          };
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(res.bodyTruncated, true);
    assert.equal(res.headers['x-upstream'], 'yes');
    assert.equal(res.headers['set-cookie'], undefined);
  }

  // GET /v1/http supports both JSON envelope and raw=1 direct body response
  const mockExec = async input => ({
    type: 'http',
    status: 200,
    url: input.url,
    redirectCount: 0,
    contentType: 'application/json',
    headers: { 'content-type': 'application/json' },
    encoding: 'base64',
    body: Buffer.from('{"ip":"1.2.3.4"}').toString('base64'),
    bodyTruncated: false,
    proxyUsed: true,
  });

  const jsonResp = await handleRequest(
    new Request('https://worker.example.com/v1/http?url=' + encodeURIComponent('https://ipinfo.io/json'), {
      headers: { authorization: `Bearer ${dynEnv.RPC_TOKEN}` },
    }),
    dynEnv,
    mockExec,
  );
  assert.equal(jsonResp.status, 200);
  const jsonPayload = await jsonResp.json();
  assert.equal(jsonPayload.result.url, 'https://ipinfo.io/json');

  const rawResp = await handleRequest(
    new Request('https://worker.example.com/v1/http?url=' + encodeURIComponent('https://ipinfo.io/json') + '&raw=1', {
      headers: { authorization: `Bearer ${dynEnv.RPC_TOKEN}` },
    }),
    dynEnv,
    mockExec,
  );
  assert.equal(rawResp.status, 200);
  assert.equal(rawResp.headers.get('x-edge-proxy-used'), 'true');
  assert.equal(await rawResp.text(), '{"ip":"1.2.3.4"}');
});
