import { gatewayConfig, listConfiguredTargets, resolveGatewayJob } from '../egress/config.js';
import { JobError } from './protocol.js';

export function resolveJob(input, env) {
  return resolveGatewayJob(input, gatewayConfig({ ...env, EGRESS_TOKEN: env.RPC_TOKEN }));
}

export function listTargets(env) {
  return listConfiguredTargets(gatewayConfig({ ...env, EGRESS_TOKEN: env.RPC_TOKEN }));
}

export async function executeJob(input, env, deps = {}) {
  const config = gatewayConfig({ ...env, EGRESS_TOKEN: env.RPC_TOKEN });
  let executeGatewayJob;
  try { ({ executeGatewayJob } = await import('../egress/executor.js')); }
  catch { throw new JobError('runtime_init_failed', 503); }
  return executeGatewayJob(input, config, {
    ...deps,
    launch: deps.launch ?? (async () => {
      const { launch } = await import('@cloudflare/playwright');
      return launch(env.BROWSER, { guardrails: { allowedDomains: [] } });
    }),
  });
}
