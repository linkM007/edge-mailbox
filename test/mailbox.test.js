import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { enqueue, processMailbox } from '../src/mailbox.js';
import { handleRequest } from '../src/worker.js';
import { JobError } from '../src/protocol.js';

let mf;
let db;
const job = { type: 'http', target: 'example' };
const env = { RPC_TOKEN: 'test-token-'.repeat(5), HTTP_TARGETS: JSON.stringify({ example: { url: 'https://example.com/' } }),
  EGRESS_PROXY_SERVER: 'http://127.0.0.1:8080', EGRESS_PROXY_USERNAME: 'test', EGRESS_PROXY_PASSWORD: 'test' };
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'test', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2026-07-30', d1Databases: ['DB'] }));
  db = await mf.getD1Database('DB');
  const migration = await readFile(new URL('../migrations/0001_jobs.sql', import.meta.url), 'utf8');
  await db.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  env.DB = db;
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => { await db.prepare('DELETE FROM jobs').run(); });

test('idempotent insertion rejects a changed payload', async () => {
  const first = await enqueue(db, 'unique-job-001', job);
  const second = await enqueue(db, 'unique-job-001', job);
  assert.equal(first.id, second.id);
  await assert.rejects(enqueue(db, first.id, { ...job, target: 'other' }), /idempotency_conflict/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM jobs').first()).n, 1);
});

test('overlapping cron handlers atomically claim each job once', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => enqueue(db, 'parallel-job-' + i, { ...job, target: 'target' + i })));
  const calls = [];
  const execute = async input => { calls.push(input.target); await new Promise(resolve => setTimeout(resolve, 5)); return { ok: true }; };
  await Promise.all([processMailbox(env, execute), processMailbox(env, execute)]);
  assert.equal(calls.length, 8);
  assert.equal(new Set(calls).size, 8);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM jobs WHERE status='succeeded'").first()).n, 8);
});

test('expired tasks and abandoned leases are terminal without automatic retry', async () => {
  await enqueue(db, 'expired-job-001', job);
  await enqueue(db, 'unknown-job-001', job);
  await db.prepare("UPDATE jobs SET expires_at=0 WHERE id='expired-job-001'").run();
  await db.prepare("UPDATE jobs SET status='running', lease_until=0 WHERE id='unknown-job-001'").run();
  let calls = 0;
  await processMailbox(env, async () => { calls++; });
  assert.equal(calls, 0);
  assert.equal((await db.prepare("SELECT status FROM jobs WHERE id='expired-job-001'").first()).status, 'expired');
  assert.equal((await db.prepare("SELECT status FROM jobs WHERE id='unknown-job-001'").first()).status, 'unknown');
});

test('SSH timeout is unknown and unexpected errors are redacted', async () => {
  await enqueue(db, 'ssh-timeout-001', { type: 'ssh', target: 'ops', action: 'uptime' });
  await enqueue(db, 'http-error-001', job);
  await processMailbox(env, async input => {
    if (input.type === 'ssh') throw new JobError('job_timeout', 504);
    throw new Error('secret from remote host');
  });
  assert.equal((await db.prepare("SELECT status FROM jobs WHERE id='ssh-timeout-001'").first()).status, 'unknown');
  const row = await db.prepare("SELECT status,error FROM jobs WHERE id='http-error-001'").first();
  assert.deepEqual(row, { status: 'failed', error: 'upstream_failed' });
});

test('control-plane writes are revalidated by the execution path', async () => {
  await db.prepare('INSERT INTO jobs(id,payload) VALUES(?,?)').bind('invalid-job-001', JSON.stringify({ type: 'http', url: 'https://evil.example.com/' })).run();
  let called = false;
  await processMailbox(env, async () => { called = true; });
  assert.equal(called, false);
  assert.equal((await db.prepare("SELECT error FROM jobs WHERE id='invalid-job-001'").first()).error, 'invalid_job');
});

test('queue capacity is bounded while existing IDs remain readable', async () => {
  await db.batch(Array.from({ length: 100 }, (_, i) => db.prepare('INSERT INTO jobs(id,payload) VALUES(?,?)').bind('capacity-job-' + i, JSON.stringify(job))));
  await assert.rejects(enqueue(db, 'overflow-job-001', job), /mailbox_full/);
  assert.equal((await enqueue(db, 'capacity-job-0', job)).status, 'pending');
});

test('completed jobs are removed after the retention window', async () => {
  await enqueue(db, 'retention-job-001', job);
  await db.prepare("UPDATE jobs SET status='succeeded', created_at=0 WHERE id='retention-job-001'").run();
  await processMailbox(env);
  assert.equal(await db.prepare("SELECT id FROM jobs WHERE id='retention-job-001'").first(), null);
});

test('a stale executor cannot overwrite a terminal state', async () => {
  await enqueue(db, 'stale-job-001', job);
  await processMailbox(env, async () => {
    await db.prepare("UPDATE jobs SET status='unknown', error='execution_interrupted' WHERE id='stale-job-001'").run();
    return { data: 'late response' };
  });
  const row = await db.prepare("SELECT status,result FROM jobs WHERE id='stale-job-001'").first();
  assert.deepEqual(row, { status: 'unknown', result: null });
});

function req(path, body, headers = {}) {
  return new Request('https://worker.example.com' + path, { method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + env.RPC_TOKEN, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined });
}

test('Worker authenticates requests and applies bounded input', async () => {
  assert.equal((await handleRequest(req('/v1/run', job, { authorization: '' }), env)).status, 401);
  assert.equal((await handleRequest(req('/v1/run', job), { ...env, RPC_TOKEN: '' })).status, 503);
  assert.equal((await handleRequest(req('/v1/run', { ...job, extra: 'x'.repeat(4096) }), env)).status, 413);
  assert.equal((await handleRequest(req('/v1/run', job, { 'content-type': 'text/plain' }), env)).status, 415);
  const result = await handleRequest(req('/v1/run', job), env, async () => ({ ok: true }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await result.json()).result, { ok: true });
});

test('Worker enqueue and result endpoints round-trip through D1', async () => {
  const response = await handleRequest(req('/v1/jobs', job, { 'idempotency-key': 'worker-job-001' }), env);
  assert.equal(response.status, 202);
  await processMailbox(env, async () => ({ status: 200 }));
  const read = await handleRequest(req('/v1/jobs/worker-job-001'), env);
  assert.equal((await read.json()).status, 'succeeded');
  assert.equal((await handleRequest(req('/v1/jobs/missing-job-001'), env)).status, 404);
});
