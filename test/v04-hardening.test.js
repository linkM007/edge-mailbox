import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Duplex } from 'node:stream';
import { Client } from 'tunnelfetch';
import { chrome } from 'tunnelfetch/profile/chrome';
import { gatewayConfig, resolveGatewayJob } from '../egress/config.js';
import { applyRedirectHop, createRedirectState } from '../egress/redirect-cookies.js';
import { handleRequest } from '../src/worker.js';

const baseEnv = {
  EGRESS_TOKEN: 't'.repeat(40),
  RPC_TOKEN: 't'.repeat(40),
  ALLOW_DYNAMIC_URLS: '1',
  EGRESS_PROXY_SERVER: 'http://127.0.0.1:8080',
  EGRESS_PROXY_USERNAME: 'u',
  EGRESS_PROXY_PASSWORD: 'p',
};

test('Chrome TLS profile completes TLS 1.3, HelloRetryRequest (P-256), and TLS 1.2 against OpenSSL', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-tls-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost',
      '-addext', 'basicConstraints=critical,CA:TRUE',
    ], { stdio: 'ignore' });
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);

    for (const [label, tlsOpts] of [
      ['tls13-x25519', { ALPNProtocols: ['http/1.1'] }],
      ['tls13-hrr-p256', { ALPNProtocols: ['http/1.1'], ecdhCurve: 'prime256v1' }],
      ['tls12-fallback', { ALPNProtocols: ['http/1.1'], maxVersion: 'TLSv1.2' }],
    ]) {
      const server = tls.createServer({ key, cert, ...tlsOpts }, sock => {
        sock.once('data', () => {
          sock.end(`HTTP/1.1 200 OK\r\nContent-Length: ${label.length}\r\nConnection: close\r\n\r\n${label}`);
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const client = new Client({
        profile: chrome,
        trust: { mode: 'anchors', anchors: [cert.toString('utf8')] },
        connect: ({ hostname, port: p }) => {
          const s = net.connect(p, hostname);
          const d = Duplex.toWeb(s);
          return {
            readable: d.readable,
            writable: d.writable,
            closed: new Promise(r => s.on('close', r)),
            close: () => s.destroy(),
          };
        },
      });
      try {
        const res = await client.fetch(`https://localhost:${port}/`);
        assert.equal(res.status, 200);
        assert.equal(await res.text(), label);
      } finally {
        await client.close();
        server.close();
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Dynamic URL default headers differentiate document navigation from CORS/API requests', () => {
  const cfg = gatewayConfig(baseEnv);
  const nav = resolveGatewayJob({ type: 'http', target: '_url', url: 'https://example.com/' }, cfg);
  assert.ok(nav.headers['sec-ch-ua'].includes('Google Chrome'));
  assert.equal(nav.headers['sec-ch-ua-mobile'], '?0');
  assert.equal(nav.headers['sec-ch-ua-platform'], '"Windows"');
  assert.equal(nav.headers['sec-fetch-mode'], 'navigate');
  assert.equal(nav.headers['sec-fetch-dest'], 'document');
  assert.equal(nav.headers['sec-fetch-user'], '?1');
  assert.equal(nav.headers['upgrade-insecure-requests'], '1');

  const apiPost = resolveGatewayJob({
    type: 'http',
    target: '_url',
    url: 'https://example.com/api',
    method: 'POST',
    body: '{"a":1}',
  }, cfg);
  assert.ok(apiPost.headers['sec-ch-ua'].includes('Google Chrome'));
  assert.equal(apiPost.headers['sec-fetch-mode'], 'cors');
  assert.equal(apiPost.headers['sec-fetch-dest'], 'empty');
  assert.equal(apiPost.headers['upgrade-insecure-requests'], undefined);

  const apiGetJson = resolveGatewayJob({
    type: 'http',
    target: '_url',
    url: 'https://example.com/feed.json',
    headers: { Accept: 'application/json' },
  }, cfg);
  assert.equal(apiGetJson.headers['sec-fetch-mode'], 'cors');
  assert.equal(apiGetJson.headers['sec-fetch-dest'], 'empty');
});

test('Redirect cookie jar forwards same-site Set-Cookie and strips cross-origin credentials', () => {
  const initHeaders = { authorization: 'Bearer secret', cookie: 'init=1' };
  const state = createRedirectState('https://app.example.com/login', initHeaders);

  // Hop 1: same-site subdomain redirect setting a Domain=example.com cookie
  const afterHop1 = applyRedirectHop(
    state,
    'https://app.example.com/login',
    new URL('https://www.example.com/home'),
    ['sid=abc123; Domain=example.com; Path=/; Secure; HttpOnly'],
    initHeaders,
  );
  // Different origin (app.example.com -> www.example.com) strips Authorization
  assert.equal(afterHop1.authorization, undefined);
  // Domain=example.com cookie is forwarded; host-only caller cookie from app.example.com is not leaked to sibling subdomain unless subdomain-related
  assert.equal(afterHop1.cookie, 'sid=abc123');

  // Hop 2: cross-site redirect to external CDN strips both Authorization and example.com cookies
  const afterHop2 = applyRedirectHop(
    state,
    'https://www.example.com/home',
    new URL('https://cdn.other-domain.net/asset'),
    [],
    afterHop1,
  );
  assert.equal(afterHop2?.authorization, undefined);
  assert.equal(afterHop2?.cookie, undefined);
});

test('Synchronous /v1/run accepts 32 KiB POST payloads', async () => {
  const bigBody = JSON.stringify({ payload: 'a'.repeat(32768) });
  const req = new Request('https://worker.example.com/v1/run', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${baseEnv.RPC_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'http',
      target: '_url',
      url: 'https://example.com/upload',
      method: 'POST',
      body: bigBody,
    }),
  });
  const res = await handleRequest(req, baseEnv, async input => ({
    type: 'http',
    status: 200,
    receivedLen: input.body.length,
  }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.result.receivedLen, bigBody.length);
});
