export function validateRelativePath(path) {
  return typeof path === 'string' && path.length >= 1 && path.length <= 1024 &&
    path.startsWith('/') && !path.startsWith('//') && !/[\\\x00-\x20\x7f]/.test(path);
}

export const VERSION = '0.3.0';
export const INPUT_LIMIT = 4096;
export const OUTPUT_LIMIT = 32768;
export const JOB_TIMEOUT_MS = 15000;
export const MAX_SSH_TIMEOUT_MS = 60000;
export const BROWSER_TIMEOUT_MS = 45000;
export const RESULT_LIMIT = 524288;
export const ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'expired', 'unknown'];
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/;

export class JobError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function validateJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new JobError('invalid_job');
  const keys = job.type === 'browse' ? ['type', 'target', 'path', 'scrollY', 'selector']
    : job.type === 'http' ? ['type', 'target', 'path', 'method', 'body', 'bodyEncoding', 'contentType']
    : ['type', 'target', 'action', 'stdin'];
  if (!['http', 'ssh', 'browse'].includes(job.type) ||
      Object.keys(job).some(key => !keys.includes(key)) ||
      typeof job.target !== 'string' || !NAME_PATTERN.test(job.target) ||
      (job.type === 'ssh' && (typeof job.action !== 'string' || !NAME_PATTERN.test(job.action)))) {
    throw new JobError('invalid_job');
  }
  if (job.type === 'browse') {
    if ((job.path !== undefined && !validateRelativePath(job.path)) ||
        (job.scrollY !== undefined && (!Number.isInteger(job.scrollY) || job.scrollY < 0 || job.scrollY > 20000)) ||
        (job.selector !== undefined && (typeof job.selector !== 'string' || !job.selector.length ||
          job.selector.length > 200 || /[\x00-\x1f\x7f]/.test(job.selector)))) {
      throw new JobError('invalid_job');
    }
    return {
      type: 'browse',
      target: job.target,
      ...(job.path !== undefined ? { path: job.path } : {}),
      ...(job.scrollY !== undefined ? { scrollY: job.scrollY } : {}),
      ...(job.selector !== undefined ? { selector: job.selector } : {}),
    };
  }
  if (job.type === 'http') {
    const method = job.method ?? 'GET';
    if ((job.path !== undefined && !validateRelativePath(job.path)) ||
        (job.method !== undefined && !HTTP_METHODS.includes(job.method)) ||
        (job.bodyEncoding !== undefined && !['utf8', 'base64'].includes(job.bodyEncoding)) ||
        (job.contentType !== undefined && (typeof job.contentType !== 'string' || !job.contentType.length ||
          job.contentType.length > 128 || /[\x00-\x1f\x7f]/.test(job.contentType)))) {
      throw new JobError('invalid_job');
    }
    if (job.body !== undefined) {
      if (typeof job.body !== 'string' || job.body.length > 3072 || ['GET', 'HEAD'].includes(method)) {
        throw new JobError('invalid_job');
      }
      if (job.bodyEncoding === 'base64' && (!/^[A-Za-z0-9+/]*={0,2}$/.test(job.body) || job.body.length % 4 !== 0)) {
        throw new JobError('invalid_job');
      }
    } else if (job.bodyEncoding !== undefined || job.contentType !== undefined) {
      throw new JobError('invalid_job');
    }
    return {
      type: 'http',
      target: job.target,
      ...(job.path !== undefined ? { path: job.path } : {}),
      ...(job.method !== undefined ? { method: job.method } : {}),
      ...(job.body !== undefined ? { body: job.body } : {}),
      ...(job.bodyEncoding !== undefined ? { bodyEncoding: job.bodyEncoding } : {}),
      ...(job.contentType !== undefined ? { contentType: job.contentType } : {}),
    };
  }
  if (job.stdin !== undefined && (typeof job.stdin !== 'string' ||
      new TextEncoder().encode(job.stdin).byteLength > 3584)) {
    throw new JobError('invalid_job');
  }
  return {
    type: 'ssh',
    target: job.target,
    action: job.action,
    ...(job.stdin !== undefined ? { stdin: job.stdin } : {}),
  };
}

export function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new JobError('invalid_job_id');
  return id;
}

export async function readLimited(stream, limit = OUTPUT_LIMIT, budget = null) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (budget) budget.used += value.byteLength;
      if (size > limit || (budget && budget.used > budget.max)) {
        void reader.cancel().catch(() => {});
        throw new JobError('size_limit_exceeded', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function publicError(error) {
  return error instanceof JobError ? error.code : 'upstream_failed';
}

export function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id, status: row.status, createdAt: row.created_at,
    completedAt: row.completed_at, result: row.result ? JSON.parse(row.result) : null,
    error: row.error ?? null,
  };
}

export function publicJobSummary(row) {
  if (!row) return null;
  let parsed = null;
  try { parsed = row.payload ? JSON.parse(row.payload) : null; } catch { parsed = null; }
  return {
    id: row.id,
    type: parsed?.type ?? null,
    target: parsed?.target ?? null,
    ...(parsed?.action ? { action: parsed.action } : {}),
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    error: row.error ?? null,
  };
}
