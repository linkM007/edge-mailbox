import { ProxyAgent, fetch } from 'undici';
import { gatewayConfig } from './config.js';
import { JobError, readLimited } from '../src/protocol.js';

let dispatcher;
try {
  const { proxy } = gatewayConfig(process.env);
  const token = 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64');
  dispatcher = new ProxyAgent({ uri: proxy.server, token });
  const response = await fetch('https://ip.decodo.com/json', {
    dispatcher, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new JobError('proxy_check_http_' + response.status);
  const data = JSON.parse(new TextDecoder().decode(await readLimited(response.body, 4096)));
  console.log(JSON.stringify({ ok: true, result: data }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof JobError ? error.code : 'proxy_check_failed' }));
  process.exitCode = 1;
} finally { if (dispatcher) await dispatcher.destroy(); }
