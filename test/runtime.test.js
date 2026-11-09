import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('bundled Worker uses proxy CONNECT and records proxy failures in scheduled D1 jobs', async () => {
  const destinations = [];
  const proxy = http.createServer();
  proxy.on('connect', (request, socket) => {
    destinations.push(request.url);
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const token = 'runtime-test-token-'.repeat(3);
  let directRequests = 0;
  const modules = [{ type: 'ESModule', path: path.resolve('dist/worker.js') }];
  for (const file of await readdir('dist')) if (file.endsWith('.wasm')) modules.push({ type: 'CompiledWasm', path: path.resolve('dist', file) });
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'edge-test', modules, modulesRoot: path.resolve('dist'),
    compatibilityDate: '2026-11-04', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { RPC_TOKEN: token, EGRESS_PROXY_SERVER: 'http://127.0.0.1:' + proxy.address().port,
      EGRESS_PROXY_USERNAME: 'test', EGRESS_PROXY_PASSWORD: 'test', HTTP_TARGETS: JSON.stringify({ example: { url: 'https://example.com/' } }) },
    outboundService: async () => { directRequests++; throw new Error('Direct target fetch is forbidden'); },
  }));
  try {
    const db = await mf.getD1Database('DB');
    const sql = await readFile(new URL('../migrations/0001_jobs.sql', import.meta.url), 'utf8');
    await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    const body = JSON.stringify({ type: 'http', target: 'example' });
    assert.equal((await mf.dispatchFetch('http://localhost/healthz')).status, 200);
    const sync = await mf.dispatchFetch('http://localhost/v1/run', { method: 'POST', headers, body });
    assert.equal(sync.status, 502);
    const submit = await mf.dispatchFetch('http://localhost/v1/jobs', { method: 'POST', headers: { ...headers, 'idempotency-key': 'runtime-job-001' }, body });
    assert.equal(submit.status, 202);
    await (await mf.getWorker()).scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
    const data = await (await mf.dispatchFetch('http://localhost/v1/jobs/runtime-job-001', { headers })).json();
    assert.equal(data.status, 'failed');
    assert.equal(data.error, 'proxy_request_failed');
    assert.deepEqual(destinations, ['example.com:443', 'example.com:443']);
    assert.equal(directRequests, 0);
  } finally { await mf.dispose(); proxy.close(); }
});
