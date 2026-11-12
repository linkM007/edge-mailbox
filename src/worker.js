import { executeBrowserSession, executeJob, executeProxyFetch, listTargets, resolveJob } from './executor.js';
import { cancelJob, enqueue, listJobs, processMailbox, SELECT_JOB } from './mailbox.js';
import { INPUT_LIMIT, JobError, VERSION, publicError, publicJob, readLimited, validateId } from './protocol.js';

function json(value, status = 200) {
  return Response.json(value, { status, headers: {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } });
}

async function authenticate(request, env) {
  if (typeof env.RPC_TOKEN !== 'string' || env.RPC_TOKEN.length < 32) throw new JobError('rpc_not_configured', 503);
  const received = request.headers.get('authorization') ?? '';
  if (received.length > 1024) throw new JobError('unauthenticated', 401);
  const encoder = new TextEncoder();
  const hashes = await Promise.all([received, `Bearer ${env.RPC_TOKEN}`].map(value =>
    crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const [a, b] = hashes.map(buffer => new Uint8Array(buffer));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) throw new JobError('unauthenticated', 401);
}

async function requestJob(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new JobError('json_required', 415);
  }
  const bytes = await readLimited(request.body, INPUT_LIMIT);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new JobError('invalid_json'); }
}

export async function handleRequest(request, env, execute = executeJob, ctx = null) {
  const requestId = crypto.randomUUID();
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/healthz' && request.method === 'GET') {
      return json({ ok: true, version: VERSION, proxyRequired: true });
    }
    await authenticate(request, env);
    if (path === '/v1/targets' && request.method === 'GET') {
      return json({ requestId, targets: listTargets(env) });
    }
    if (path === '/v1/http' && (request.method === 'GET' || request.method === 'HEAD')) {
      const targetUrl = url.searchParams.get('url') ?? undefined;
      const targetName = url.searchParams.get('target') ?? undefined;
      const relPath = url.searchParams.get('path') ?? undefined;
      const follow = url.searchParams.get('follow');
      const maxBytesParam = url.searchParams.get('maxBytes');
      const truncateParam = url.searchParams.get('truncate');
      const proxyName = url.searchParams.get('proxy') ?? undefined;
      const raw = url.searchParams.get('raw') === '1';
      const input = {
        type: 'http',
        method: request.method,
        ...(targetUrl !== undefined ? { target: '_url', url: targetUrl } : {}),
        ...(targetName !== undefined ? { target: targetName } : {}),
        ...(relPath !== undefined ? { path: relPath } : {}),
        ...(follow !== null ? { followRedirects: follow !== '0' && follow !== 'false' } : {}),
        maxBytes: maxBytesParam !== null ? Number(maxBytesParam) : 262144,
        truncate: truncateParam === null ? true : (truncateParam !== '0' && truncateParam !== 'false'),
        ...(proxyName !== undefined ? { proxy: proxyName } : {}),
      };
      resolveJob(input, env);
      const result = await execute(input, env);
      if (raw) {
        const bytes = Uint8Array.from(atob(result.body), c => c.charCodeAt(0));
        return new Response(request.method === 'HEAD' ? null : bytes, {
          status: result.status,
          headers: {
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'content-type': result.contentType ?? 'application/octet-stream',
            'x-edge-request-id': requestId,
            'x-edge-final-url': result.url,
            'x-edge-redirect-count': String(result.redirectCount ?? 0),
            'x-edge-truncated': String(Boolean(result.bodyTruncated)),
            'x-edge-proxy-used': String(Boolean(result.proxyUsed)),
          },
        });
      }
      return json({ requestId, result });
    }
    if (path === '/v1/proxy-fetch' && request.method === 'POST') {
      const relayed = await executeProxyFetch(request, env);
      const metaB64 = Buffer.from(JSON.stringify({
        status: relayed.status,
        headers: relayed.headers,
        setCookies: relayed.setCookies,
      }), 'utf8').toString('base64');
      return new Response(relayed.bytes, {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-type': 'application/octet-stream',
          'x-edge-request-id': requestId,
          'x-upstream-meta': metaB64,
        },
      });
    }
    if (path === '/v1/browser' && request.method === 'POST') {
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new JobError('json_required', 415);
      }
      const bytes = await readLimited(request.body, 16384);
      let input;
      try { input = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new JobError('invalid_json'); }
      return json({ requestId, result: await executeBrowserSession(input, env) });
    }
    if (path === '/v1/run' && request.method === 'POST') {
      const input = await requestJob(request);
      resolveJob(input, env);
      return json({ requestId, result: await execute(input, env) });
    }
    if (path === '/v1/dispatch' && request.method === 'POST') {
      const { processed } = await processMailbox(env, execute);
      return json({ requestId, processed });
    }
    if (path === '/v1/jobs' && request.method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined;
      const limit = url.searchParams.get('limit') ?? 20;
      return json({ requestId, jobs: await listJobs(env.DB, { status, limit }) });
    }
    if (path === '/v1/jobs' && request.method === 'POST') {
      const input = await requestJob(request);
      resolveJob(input, env);
      const id = request.headers.get('idempotency-key') ?? crypto.randomUUID();
      const job = await enqueue(env.DB, id, input);
      if (job.status === 'pending' && request.headers.get('x-edge-dispatch') === 'immediate') {
        ctx?.waitUntil?.(processMailbox(env, execute));
      }
      return json(job, job.status === 'pending' || job.status === 'running' ? 202 : 200);
    }
    if (path.startsWith('/v1/jobs/') && path.endsWith('/cancel') && request.method === 'POST') {
      const id = validateId(path.slice('/v1/jobs/'.length, -'/cancel'.length));
      return json(await cancelJob(env.DB, id));
    }
    if (path.startsWith('/v1/jobs/') && request.method === 'GET') {
      const id = validateId(path.slice('/v1/jobs/'.length));
      const row = await env.DB.prepare(SELECT_JOB).bind(id).first();
      if (!row) throw new JobError('job_not_found', 404);
      return json(publicJob(row));
    }
    throw new JobError('route_not_found', 404);
  } catch (error) {
    return json({ requestId, error: publicError(error) }, error instanceof JobError ? error.status : 502);
  }
}

export default {
  fetch(request, env, ctx) { return handleRequest(request, env, executeJob, ctx); },
  async scheduled(_event, env) {
    const { processed } = await processMailbox(env);
    console.log(JSON.stringify({ event: 'mailbox_batch', processed }));
  },
};
