#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fetch } from 'undici';
import { createDispatcher } from '../cli/client.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string', default: process.env.CLOUDFLARE_WORKER_NAME || 'edge-mailbox' },
    outdir: { type: 'string', default: 'dist' },
    'vars-file': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`deploy-safe: upload Worker ES module + Wasm while preserving existing secret_text bindings
  CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run deploy:safe -- [--name edge-mailbox] [--vars-file vars.json]`);
  process.exit(0);
}

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error('missing_or_invalid_CLOUDFLARE_ACCOUNT_ID');
if (!token) throw new Error('missing_CLOUDFLARE_API_TOKEN');
if (!/^[a-z0-9-]{1,63}$/.test(values.name)) throw new Error('invalid_worker_name');

const outdir = resolve(values.outdir);
const workerCode = await readFile(join(outdir, 'worker.js'));
const files = await readdir(outdir);
const wasmFiles = await Promise.all(
  files.filter(f => f.endsWith('.wasm')).map(async name => ({ name, bytes: await readFile(join(outdir, name)) })),
);

const extraVars = values['vars-file'] ? JSON.parse(await readFile(values['vars-file'], 'utf8')) : {};
const dispatcher = createDispatcher();

try {
  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${values.name}`;
  const settingsResp = await fetch(`${apiBase}/settings`, {
    dispatcher,
    headers: { authorization: `Bearer ${token}` },
  });
  let bindings = [];
  if (settingsResp.ok) {
    const settingsData = await settingsResp.json();
    // Preserve non-secret bindings explicitly; secret_text bindings are preserved via keep_bindings.
    bindings = (settingsData.result?.bindings ?? []).filter(b => b.type !== 'secret_text');
  } else {
    await settingsResp.body?.cancel().catch(() => {});
  }

  for (const [varName, varValue] of Object.entries(extraVars)) {
    const text = typeof varValue === 'string' ? varValue : JSON.stringify(varValue);
    const idx = bindings.findIndex(b => b.name === varName);
    const entry = { type: 'plain_text', name: varName, text };
    if (idx >= 0) bindings[idx] = entry;
    else bindings.push(entry);
  }

  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2026-11-04',
    compatibility_flags: ['nodejs_compat'],
    keep_bindings: ['secret_text'],
    bindings,
  };

  const boundary = '----EdgeMailboxDeploy' + crypto.randomUUID().replace(/-/g, '');
  const parts = [];
  const pushPart = (headers, content) => {
    parts.push(Buffer.from(`--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n`, 'utf8'));
    parts.push(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  };

  pushPart([
    'Content-Disposition: form-data; name="metadata"',
    'Content-Type: application/json',
  ], JSON.stringify(metadata));

  pushPart([
    'Content-Disposition: form-data; name="worker.js"; filename="worker.js"',
    'Content-Type: application/javascript+module',
  ], workerCode);

  for (const wasm of wasmFiles) {
    pushPart([
      `Content-Disposition: form-data; name="${wasm.name}"; filename="${wasm.name}"`,
      'Content-Type: application/wasm',
    ], wasm.bytes);
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  const putResp = await fetch(apiBase, {
    method: 'PUT',
    dispatcher,
    signal: AbortSignal.timeout(90000),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
  });
  const putData = await putResp.json();
  if (!putResp.ok || putData.success !== true) {
    console.error(JSON.stringify({ error: 'deploy_failed', status: putResp.status }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({
      ok: true,
      worker: values.name,
      wasmModules: wasmFiles.map(w => w.name),
      preservedSecrets: true,
      bindingsUpdated: bindings.map(b => `${b.type}:${b.name}`),
    }, null, 2));
  }
} finally {
  await dispatcher.close();
}
