#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient, createDispatcher } from './client.js';
import { INPUT_LIMIT } from '../src/protocol.js';
import { saveBrowserResult } from './artifacts.js';

const HELP = `edge-mailbox
  npm run cli -- run --job examples/http.json
  npm run cli -- enqueue --plane control --job examples/http.json --id unique-job-001
  npm run cli -- result --plane control --id unique-job-001
  npm run cli -- wait --plane control --id unique-job-001 --timeout 300
  npm run cli -- run --job examples/browser.json --out capture-directory

Planes: data (default) or control. Credentials are read from environment variables.
Use EDGE_REQUIRE_PROXY=1 to require a proxy and ignore NO_PROXY exclusions.
See README.md for configuration and deployment.
`;

let dispatcher;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, plane: { type: 'string', default: 'data' },
    job: { type: 'string' }, id: { type: 'string' }, timeout: { type: 'string', default: '300' },
    out: { type: 'string' },
  } });
  if (values.help || positionals.length === 0) {
    console.log(HELP);
  } else {
    if (positionals.length !== 1 || !['run', 'enqueue', 'result', 'wait'].includes(positionals[0])) {
      throw new Error('invalid_command');
    }
    const command = positionals[0];
    const timeout = Number(values.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('invalid_timeout');
    let job;
    if (['run', 'enqueue'].includes(command)) {
      if (!values.job) throw new Error('missing_job_file');
      const bytes = await readFile(values.job);
      if (bytes.byteLength > INPUT_LIMIT) throw new Error('job_file_too_large');
      job = JSON.parse(bytes.toString('utf8'));
    }
    if (['result', 'wait'].includes(command) && !values.id) throw new Error('missing_job_id');
    dispatcher = createDispatcher();
    const client = createClient({ plane: values.plane, dispatcher });
    let result;
    if (command === 'run') result = await client.run(job);
    if (command === 'enqueue') {
      const id = values.id ?? crypto.randomUUID();
      console.error(JSON.stringify({ id, note: 'Keep this ID if the response is interrupted.' }));
      result = await client.enqueue(job, id);
    }
    if (command === 'result') result = await client.result(values.id);
    if (command === 'wait') {
      const end = Date.now() + timeout * 1000;
      while (true) {
        result = await client.result(values.id);
        if (!['pending', 'running'].includes(result.status)) break;
        const remaining = end - Date.now();
        if (remaining <= 0) throw new Error('wait_timeout_job_still_exists');
        await delay(Math.min(5000, remaining));
      }
    }
    let output = result;
    if (values.out && result.result?.type === 'browse') {
      const artifacts = await saveBrowserResult(result.result, values.out);
      output = { ...result, result: { ...result.result, screenshot: { ...result.result.screenshot, data: undefined } }, artifacts };
    }
    console.log(JSON.stringify(output, null, 2));
    if (['failed', 'expired', 'unknown'].includes(result.status) ||
        (result.result?.type === 'ssh' && result.result.code !== 0) ||
        (['http', 'browse'].includes(result.result?.type) && result.result.status >= 400)) process.exitCode = 1;
  }
} catch (error) {
  const code = /^[a-zA-Z0-9_]+$/.test(error.message) ? error.message : 'invalid_input_or_request_failed';
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
} finally {
  if (dispatcher) await dispatcher.close();
}
