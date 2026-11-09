import { JobError } from './protocol.js';

export function publicHostname(hostname) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname) &&
    !/\.(localhost|local|internal|test|invalid)$/i.test(hostname);
}

export function publicHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new JobError('invalid_server_config', 503); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.port || !publicHostname(url.hostname)) throw new JobError('invalid_server_config', 503);
  return url;
}
