import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { browse } from './browser.js';
import { gatewayConfig } from './config.js';
import { chromium } from 'playwright-core';
import { saveBrowserResult } from '../cli/artifacts.js';
import { JobError, INPUT_LIMIT } from '../src/protocol.js';

try {
  const { values } = parseArgs({ options: { job: { type: 'string' }, out: { type: 'string' } } });
  if (!values.job || !values.out) throw new JobError('job_and_out_required');
  const raw = await readFile(values.job);
  if (raw.byteLength > INPUT_LIMIT) throw new JobError('size_limit_exceeded');
  const result = await browse(JSON.parse(raw.toString('utf8')), gatewayConfig(process.env), { launch: chromium.launch.bind(chromium) });
  const artifacts = await saveBrowserResult(result, values.out);
  console.log(JSON.stringify({ status: result.status, title: result.title, url: result.url, artifacts }, null, 2));
  if (result.status >= 400) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof JobError ? error.code : 'capture_failed' }));
  process.exitCode = 1;
}
