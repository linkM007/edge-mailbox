#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { fetch } from 'undici';
import { createDispatcher } from '../cli/client.js';
import { runBrowserSession } from '../egress/session-browser.js';
import { JobError } from '../src/protocol.js';

const defaultEnv = join(homedir(), '.gemini', 'credentials', 'cloudflare.env');
if (existsSync(defaultEnv) && !process.env.EDGE_RPC_TOKEN) process.loadEnvFile(defaultEnv);

const endpoint = (process.env.EDGE_ENDPOINT || '').replace(/\/+$/, '');
const token = process.env.EDGE_RPC_TOKEN || '';
const port = Number(process.env.LOCAL_SESSION_PORT || 18921);
const chromeBin = process.env.CHROME_EXECUTABLE || '/usr/bin/google-chrome';

if (!endpoint || !token) throw new Error('missing_EDGE_ENDPOINT_or_EDGE_RPC_TOKEN');

const dispatcher = createDispatcher();
const browsers = new Map();

function makeRemoteProxySession(proxyName) {
  return {
    async fetch(url, { signal, limit = 8388608, budget = null, method = 'GET', body, headers, returnOnRedirect = true } = {}) {
      const headersB64 = Buffer.from(JSON.stringify(headers ?? {}), 'utf8').toString('base64');
      const resp = await fetch(`${endpoint}/v1/proxy-fetch`, {
        method: 'POST',
        dispatcher,
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          'x-target-url': url,
          'x-target-method': method,
          'x-target-follow': returnOnRedirect ? '0' : '1',
          'x-target-headers-b64': headersB64,
          ...(proxyName ? { 'x-target-proxy': proxyName } : {}),
        },
        body: body && !['GET', 'HEAD'].includes(method) ? Buffer.from(body) : undefined,
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        throw new JobError(`relay_http_${resp.status}`, 502);
      }
      const metaRaw = resp.headers.get('x-upstream-meta');
      if (!metaRaw) throw new JobError('missing_upstream_meta', 502);
      const meta = JSON.parse(Buffer.from(metaRaw, 'base64').toString('utf8'));
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (buf.byteLength > limit) throw new JobError('size_limit_exceeded', 413);
      if (budget) {
        budget.used += buf.byteLength;
        if (budget.used > budget.max) throw new JobError('size_limit_exceeded', 413);
      }
      const h = new Headers();
      for (const [k, v] of Object.entries(meta.headers ?? {})) h.set(k, String(v));
      for (const c of meta.setCookies ?? []) h.append('set-cookie', String(c));
      return {
        status: meta.status,
        headers: h,
        bytes: buf,
        truncated: false,
        finalUrl: url,
        redirectCount: 0,
      };
    },
    async close() {},
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: browsers.size }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/browser') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = await runBrowserSession(
      input,
      { allowDynamicUrls: true },
      {
        disconnectAfterTurn: false,
        timeoutMs: 90000,
        makeProxySession: makeRemoteProxySession,
        acquireSession: async () => {
          const id = 'local-' + crypto.randomUUID().slice(0, 12);
          const browser = await chromium.launch({
            executablePath: chromeBin,
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-quic',
              '--proxy-server=http://127.0.0.1:1',
            ],
          });
          browsers.set(id, browser);
          browser.on('disconnected', () => browsers.delete(id));
          return { sessionId: id };
        },
        connectSession: async id => {
          const b = browsers.get(id);
          if (!b) throw new JobError('session_not_found', 404);
          return b;
        },
      },
    );
    if (input.close === true && input.sessionId) browsers.delete(input.sessionId);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ requestId: crypto.randomUUID(), result }));
  } catch (err) {
    res.writeHead(err?.status || 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err?.code || String(err?.message || 'daemon_error') }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'local_session_daemon_listening', host: '127.0.0.1', port }));
});
