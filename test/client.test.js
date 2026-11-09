import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fetch } from 'undici';
import { createClient, createDispatcher } from '../cli/client.js';

const job = { type: 'http', target: 'example' };
const dataEnv = { EDGE_ENDPOINT: 'https://worker.example.com', EDGE_RPC_TOKEN: 'x'.repeat(48) };
const controlEnv = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_D1_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_API_TOKEN: 'test-control-token' };

test('data-plane client sends a plain POST and never follows redirects', async () => {
  const client = createClient({ env: dataEnv, request: async (url, init) => {
    assert.equal(url, 'https://worker.example.com/v1/run');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, 'Bearer ' + dataEnv.EDGE_RPC_TOKEN);
    assert.deepEqual(JSON.parse(init.body), job);
    return Response.json({ result: { status: 200 } });
  } });
  assert.equal((await client.run(job)).result.status, 200);
});

test('control-plane submits parameterized SQL only to the Cloudflare API', async () => {
  const calls = [];
  const row = { id: 'control-job-001', payload: JSON.stringify(job), status: 'pending', created_at: 123, completed_at: null };
  const client = createClient({ plane: 'control', env: controlEnv, request: async (url, init) => {
    assert.equal(new URL(url).hostname, 'api.cloudflare.com');
    assert.equal(init.redirect, 'manual');
    const data = JSON.parse(init.body);
    calls.push(data);
    return Response.json({ success: true, result: [{ success: true,
      results: data.sql.startsWith('SELECT') ? [row] : [] }] });
  } });
  const result = await client.enqueue(job, row.id);
  assert.equal(result.status, 'pending');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, [row.id, JSON.stringify(job)]);
  assert.ok(calls[0].sql.includes('?'));
  await assert.rejects(client.run(job), /control_plane_is_asynchronous/);
});

test('API failure and redirect bodies never leak secrets to errors', async () => {
  const client = createClient({ env: dataEnv, request: async () => new Response('secret detail', { status: 302 }) });
  await assert.rejects(client.run(job), { message: 'remote_http_302' });
  const bad = createClient({ plane: 'control', env: controlEnv, request: async () =>
    Response.json({ success: false, errors: [{ message: 'secret detail' }] }) });
  await assert.rejects(bad.result('control-job-001'), { message: 'cloudflare_query_failed' });
  assert.throws(() => createClient({ env: { ...dataEnv, EDGE_ENDPOINT: 'http://example.com' } }), /invalid_endpoint/);
});

test('D1 insert response may omit an empty results array', async () => {
  const id = 'optional-result-001';
  const client = createClient({ plane: 'control', env: controlEnv, request: async (_url, init) => {
    const { sql } = JSON.parse(init.body);
    const result = sql.startsWith('SELECT')
      ? { success: true, results: [{ id, payload: JSON.stringify(job), status: 'pending' }] }
      : { success: true, meta: { changes: 1 } };
    return Response.json({ success: true, result: [result] });
  } });
  assert.equal((await client.enqueue(job, id)).id, id);
});

test('proxy-required mode rejects missing proxy and ignores NO_PROXY using CONNECT', async () => {
  assert.throws(() => createDispatcher({ EDGE_REQUIRE_PROXY: '1' }), /proxy_required/);
  assert.throws(() => createDispatcher({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' }), /http_proxy_required/);
  const server = http.createServer();
  const destinations = [];
  server.on('connect', (req, socket) => {
    destinations.push(req.url);
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dispatcher = createDispatcher({ EDGE_REQUIRE_PROXY: '1', NO_PROXY: '*',
    HTTP_PROXY: 'http://127.0.0.1:' + server.address().port });
  try {
    await assert.rejects(fetch('https://blocked.invalid/', { dispatcher, signal: AbortSignal.timeout(1000) }));
    assert.deepEqual(destinations, ['blocked.invalid:443']);
  } finally {
    await dispatcher.destroy();
    server.close();
    await once(server, 'close');
  }
});
