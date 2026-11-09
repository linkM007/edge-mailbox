import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
loadEnvFile('.env.egress');
const token = 'test'.repeat(12), bindings = { RPC_TOKEN: token };
for (const name of ['EGRESS_PROXY_SERVER', 'EGRESS_PROXY_USERNAME', 'EGRESS_PROXY_PASSWORD', 'HTTP_TARGETS']) bindings[name] = process.env[name];
const modules = [{ type: 'ESModule', path: path.resolve('dist/worker.js') }];
for (const file of await readdir('dist')) if (file.endsWith('.wasm')) modules.push({ type: 'CompiledWasm', path: path.resolve('dist', file) });
const mf = new Miniflare(convertV4MiniflareOptions({ name: 'proxy-live-local', modules, modulesRoot: path.resolve('dist'),
  compatibilityDate: '2026-11-04', compatibilityFlags: ['nodejs_compat'], bindings }));
try {
  const response = await mf.dispatchFetch('http://localhost/v1/run', { method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'http', target: 'egress' }) });
  const body = await response.json();
  if (body.result?.body) {
    const ip = JSON.parse(Buffer.from(body.result.body, 'base64').toString());
    console.log(JSON.stringify({ status: response.status, proxyUsed: body.result.proxyUsed, ip: ip.proxy?.ip }));
  } else { console.log(JSON.stringify({ status: response.status, error: body.error })); process.exitCode = 1; }
} finally { await mf.dispose(); }
