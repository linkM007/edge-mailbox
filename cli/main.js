#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient, createDispatcher } from './client.js';
import { INPUT_LIMIT } from '../src/protocol.js';
import { saveBrowserResult } from './artifacts.js';

const COMMANDS = ['run', 'enqueue', 'result', 'wait', 'list', 'cancel', 'targets', 'health', 'dispatch'];

const HELP = `edge-mailbox
  npm run cli -- health
  npm run cli -- targets
  npm run cli -- run --job examples/http.json
  npm run cli -- run --inline '{"type":"http","target":"example","path":"/"}'
  npm run cli -- enqueue --plane control --job examples/http.json --id unique-job-001
  npm run cli -- wait --plane control --id unique-job-001 --timeout 300
  npm run cli -- list --plane control --status pending --limit 20
  npm run cli -- cancel --plane control --id unique-job-001
  npm run cli -- dispatch
  npm run cli -- run --job examples/browser.json --out capture-directory

Planes: data (default) or control. Credentials are read from environment variables.
Use EDGE_REQUIRE_PROXY=1 to require a proxy and ignore NO_PROXY exclusions.
See README.md for configuration and deployment.
`;

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
      out: { type: 'string' },
      'no-dispatch': { type: 'boolean', default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(HELP);
  } else {
    if (positionals.length !== 1 || !COMMANDS.includes(positionals[0])) {
      throw new Error('invalid_command');
    }
    const command = positionals[0];
    const timeout = Number(values.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('invalid_timeout');
    let job;
    if (['run', 'enqueue'].includes(command)) {
      if (values.job && values.inline) throw new Error('conflicting_job_inputs');
      if (!values.job && !values.inline) throw new Error('missing_job_file');
      const bytes = values.inline !== undefined
        ? Buffer.from(values.inline, 'utf8')
        : await readFile(values.job);
      if (bytes.byteLength > INPUT_LIMIT) throw new Error('job_file_too_large');
      job = JSON.parse(bytes.toString('utf8'));
    }
    if (['result', 'wait', 'cancel'].includes(command) && !values.id) throw new Error('missing_job_id');
    dispatcher = createDispatcher();
    const client = createClient({ plane: values.plane, dispatcher });
    let result;
    if (command === 'health') result = await client.health();
    if (command === 'targets') result = await client.targets();
    if (command === 'dispatch') result = await client.dispatch();
    if (command === 'run') result = await client.run(job);
    if (command === 'enqueue') {
      const id = values.id ?? crypto.randomUUID();
      console.error(JSON.stringify({ id, note: 'Keep this ID if the response is interrupted.' }));
      result = await client.enqueue(job, id, { immediate: values.plane === 'data' && !values['no-dispatch'] });
    }
    if (command === 'result') result = await client.result(values.id);
    if (command === 'list') result = await client.list({ status: values.status, limit: Number(values.limit) });
    if (command === 'cancel') result = await client.cancel(values.id);
    if (command === 'wait') {
      const end = Date.now() + timeout * 1000;
      const schedule = values.plane === 'data' ? [500, 1000, 2000, 3500, 5000] : [2000, 3500, 5000];
      let attempt = 0;
      while (true) {
        result = await client.result(values.id);
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
    }
    console.log(JSON.stringify(output, null, 2));
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
