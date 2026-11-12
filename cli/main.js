#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient, createDispatcher } from './client.js';
import { INPUT_LIMIT } from '../src/protocol.js';
import { saveBrowserResult } from './artifacts.js';

process.stdout.on('error', err => { if (err?.code === 'EPIPE') process.exit(0); });

const HTTP_VERBS = ['get', 'head', 'options', 'post', 'put', 'patch', 'delete'];
const COMMANDS = [
  ...HTTP_VERBS, 'browse', 'ssh',
  'run', 'enqueue', 'result', 'wait', 'list', 'cancel', 'targets', 'health', 'dispatch',
];

const HELP = `edge-mailbox
  npm run cli -- health
  npm run cli -- targets
  npm run cli -- get https://ipinfo.io/json
  npm run cli -- get cf_trace -b
  npm run cli -- head https://ai.meta.com/muse/
  npm run cli -- post https://httpbin.org/post -d '{"hello":"world"}' -H 'Accept: application/json'
  npm run cli -- put https://httpbin.org/put -d '{"k":"v"}'
  npm run cli -- patch https://httpbin.org/patch -d '{"k":"v2"}'
  npm run cli -- delete https://httpbin.org/delete
  npm run cli -- browse https://dev.meta.ai/products/muse-code --out ./capture-001
  npm run cli -- ssh tw ping
  npm run cli -- run --inline '{"type":"http","target":"example","path":"/"}'
  npm run cli -- enqueue --plane control --job examples/http.json --id unique-job-001
  npm run cli -- wait --plane control --id unique-job-001 --timeout 300
  npm run cli -- list --plane control --status pending --limit 20
  npm run cli -- cancel --plane control --id unique-job-001
  npm run cli -- dispatch

Planes: data (default) or control. Credentials are read from environment variables.
Use EDGE_REQUIRE_PROXY=1 to require a proxy and ignore NO_PROXY exclusions.
`;

function parseHeaderFlags(headerList = []) {
  if (!headerList.length) return undefined;
  const headers = {};
  for (const entry of headerList) {
    const idx = entry.indexOf(':');
    if (idx <= 0) throw new Error('invalid_header_flag');
    headers[entry.slice(0, idx).trim()] = entry.slice(idx + 1).trim();
  }
  return headers;
}

function targetOrUrl(spec, relPath) {
  if (/^https?:\/\//i.test(spec)) return { target: '_url', url: spec };
  return { target: spec, ...(relPath !== undefined ? { path: relPath } : {}) };
}

function decodeHttpResult(res) {
  if (res?.result?.type !== 'http' || typeof res.result.body !== 'string') return res;
  const buf = Buffer.from(res.result.body, 'base64');
  const ct = (res.result.contentType ?? '').toLowerCase();
  const isText = !ct || /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|xhtml\+xml))/.test(ct) || ct.includes('charset=') || ct.includes('+json') || ct.includes('+xml');
  if (!isText) return { ...res, result: { ...res.result, byteLength: buf.byteLength } };
  const text = buf.toString('utf8');
  let jsonBody;
  if (ct.includes('json')) {
    try { jsonBody = JSON.parse(text); } catch {}
  }
  return {
    ...res,
    result: {
      ...res.result,
      byteLength: buf.byteLength,
      text,
      ...(jsonBody !== undefined ? { json: jsonBody } : {}),
    },
  };
}

let dispatcher;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      plane: { type: 'string', default: 'data' },
      job: { type: 'string' },
      inline: { type: 'string' },
      id: { type: 'string' },
      status: { type: 'string' },
      limit: { type: 'string', default: '20' },
      timeout: { type: 'string', default: '300' },
      out: { type: 'string', short: 'o' },
      path: { type: 'string' },
      header: { type: 'string', short: 'H', multiple: true },
      data: { type: 'string', short: 'd' },
      'data-file': { type: 'string' },
      'content-type': { type: 'string' },
      'max-bytes': { type: 'string' },
      'no-truncate': { type: 'boolean', default: false },
      'no-follow': { type: 'boolean', default: false },
      proxy: { type: 'string' },
      selector: { type: 'string' },
      'wait-for': { type: 'string' },
      settle: { type: 'string' },
      'scroll-y': { type: 'string' },
      stdin: { type: 'string' },
      'body-only': { type: 'boolean', short: 'b', default: false },
      'include-headers': { type: 'boolean', short: 'i', default: false },
      'via-http-get': { type: 'boolean', default: false },
      'no-dispatch': { type: 'boolean', default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(HELP);
  } else {
    const command = positionals[0];
    if (!COMMANDS.includes(command)) throw new Error('invalid_command');
    const timeout = Number(values.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('invalid_timeout');
    let job;
    if (HTTP_VERBS.includes(command)) {
      const spec = positionals[1];
      if (!spec || positionals.length > 2) throw new Error('missing_target_or_url');
      let body = values.data;
      let bodyEncoding;
      if (values['data-file']) {
        if (body !== undefined) throw new Error('conflicting_body_inputs');
        body = (await readFile(values['data-file'])).toString('base64');
        bodyEncoding = 'base64';
      }
      const headers = parseHeaderFlags(values.header);
      const maxBytes = values['max-bytes'] !== undefined ? Number(values['max-bytes']) : 262144;
      job = {
        type: 'http',
        method: command.toUpperCase(),
        ...targetOrUrl(spec, values.path),
        ...(headers ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(bodyEncoding ? { bodyEncoding } : {}),
        ...(values['content-type'] ? { contentType: values['content-type'] } : {}),
        ...(values['no-follow'] ? { followRedirects: false } : {}),
        maxBytes,
        truncate: !values['no-truncate'],
        ...(values.proxy ? { proxy: values.proxy } : {}),
      };
    } else if (command === 'browse') {
      const spec = positionals[1];
      if (!spec || positionals.length > 2) throw new Error('missing_target_or_url');
      job = {
        type: 'browse',
        ...targetOrUrl(spec, values.path),
        ...(values.selector ? { selector: values.selector } : {}),
        ...(values['wait-for'] ? { waitForSelector: values['wait-for'] } : {}),
        ...(values.settle !== undefined ? { settleMs: Number(values.settle) } : {}),
        ...(values['scroll-y'] !== undefined ? { scrollY: Number(values['scroll-y']) } : {}),
        ...(values['no-follow'] ? { followRedirects: false } : {}),
        ...(values.proxy ? { proxy: values.proxy } : {}),
      };
    } else if (command === 'ssh') {
      const target = positionals[1];
      const action = positionals[2];
      if (!target || !action || positionals.length > 3) throw new Error('missing_ssh_target_or_action');
      job = {
        type: 'ssh',
        target,
        action,
        ...(values.stdin !== undefined ? { stdin: values.stdin } : {}),
      };
    } else if (['run', 'enqueue'].includes(command)) {
      if (positionals.length !== 1) throw new Error('invalid_command');
      if (values.job && values.inline) throw new Error('conflicting_job_inputs');
      if (!values.job && !values.inline) throw new Error('missing_job_file');
      const bytes = values.inline !== undefined
        ? Buffer.from(values.inline, 'utf8')
        : await readFile(values.job);
      if (bytes.byteLength > INPUT_LIMIT) throw new Error('job_file_too_large');
      job = JSON.parse(bytes.toString('utf8'));
    }
    const jobId = values.id ?? positionals[1];
    if (['result', 'wait', 'cancel'].includes(command) && !jobId) throw new Error('missing_job_id');
    dispatcher = createDispatcher();
    const client = createClient({ plane: values.plane, dispatcher });
    let result;
    if (command === 'health') result = await client.health();
    else if (command === 'targets') result = await client.targets();
    else if (command === 'dispatch') result = await client.dispatch();
    else if (command === 'get' && values['via-http-get'] && !job.headers) {
      result = await client.httpGet({
        ...(job.url ? { url: job.url } : { target: job.target }),
        path: job.path,
        followRedirects: job.followRedirects,
        maxBytes: job.maxBytes,
        truncate: job.truncate,
        proxy: job.proxy,
      });
    } else if (command === 'run' || HTTP_VERBS.includes(command) || command === 'browse' || command === 'ssh') {
      result = await client.run(job);
    } else if (command === 'enqueue') {
      const id = values.id ?? crypto.randomUUID();
      console.error(JSON.stringify({ id, note: 'Keep this ID if the response is interrupted.' }));
      result = await client.enqueue(job, id, { immediate: values.plane === 'data' && !values['no-dispatch'] });
    } else if (command === 'result') result = await client.result(jobId);
    else if (command === 'list') result = await client.list({ status: values.status, limit: Number(values.limit) });
    else if (command === 'cancel') result = await client.cancel(jobId);
    else if (command === 'wait') {
      const end = Date.now() + timeout * 1000;
      const schedule = values.plane === 'data' ? [500, 1000, 2000, 3500, 5000] : [2000, 3500, 5000];
      let attempt = 0;
      while (true) {
        result = await client.result(jobId);
        if (!['pending', 'running'].includes(result.status)) break;
        const remaining = end - Date.now();
        if (remaining <= 0) throw new Error('wait_timeout_job_still_exists');
        const step = schedule[Math.min(attempt++, schedule.length - 1)];
        await delay(Math.min(step, remaining));
      }
    }
    let output = result;
    if (values.out && result?.result?.type === 'browse') {
      const artifacts = await saveBrowserResult(result.result, values.out);
      output = { ...result, result: { ...result.result, screenshot: { ...result.result.screenshot, data: undefined } }, artifacts };
    } else if (result?.result?.type === 'http') {
      if (values.out) {
        await writeFile(values.out, Buffer.from(result.result.body, 'base64'));
      }
      output = decodeHttpResult(result);
    }
    if (values['body-only'] && result?.result?.type === 'http') {
      if (values['include-headers']) {
        process.stdout.write(`HTTP ${result.result.status} (${result.result.url})\n`);
        for (const [k, v] of Object.entries(result.result.headers ?? {})) {
          process.stdout.write(`${k}: ${v}\n`);
        }
        process.stdout.write('\n');
      }
      process.stdout.write(Buffer.from(result.result.body, 'base64'));
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
    if (['failed', 'expired', 'unknown'].includes(result?.status) ||
        (result?.result?.type === 'ssh' && result.result.code !== 0) ||
        (['http', 'browse'].includes(result?.result?.type) && result.result.status >= 400)) process.exitCode = 1;
  }
} catch (error) {
  const code = /^[a-zA-Z0-9_]+$/.test(error.message) ? error.message : 'invalid_input_or_request_failed';
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
} finally {
  if (dispatcher) await dispatcher.close();
}
