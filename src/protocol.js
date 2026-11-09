export const INPUT_LIMIT = 4096;
export const OUTPUT_LIMIT = 32768;
export const JOB_TIMEOUT_MS = 15000;
export const BROWSER_TIMEOUT_MS = 45000;
export const RESULT_LIMIT = 524288;
export const ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
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
  const keys = job.type === 'browse' ? ['type', 'target', 'path', 'scrollY']
    : job.type === 'http' ? ['type', 'target'] : ['type', 'target', 'action'];
  if (!['http', 'ssh', 'browse'].includes(job.type) ||
      Object.keys(job).some(key => !keys.includes(key)) ||
      typeof job.target !== 'string' || !NAME_PATTERN.test(job.target) ||
      (job.type === 'ssh' && (typeof job.action !== 'string' || !NAME_PATTERN.test(job.action)))) {
    throw new JobError('invalid_job');
  }
  if (job.type === 'browse') {
    if ((job.path !== undefined && (typeof job.path !== 'string' || job.path.length > 1024 ||
        !job.path.startsWith('/') || job.path.startsWith('//') || /[\\\x00-\x20\x7f]/.test(job.path))) ||
        (job.scrollY !== undefined && (!Number.isInteger(job.scrollY) || job.scrollY < 0 || job.scrollY > 20000))) {
      throw new JobError('invalid_job');
    }
    return { type: 'browse', target: job.target,
      ...(job.path !== undefined ? { path: job.path } : {}),
      ...(job.scrollY !== undefined ? { scrollY: job.scrollY } : {}) };
  }
  return job.type === 'http'
    ? { type: 'http', target: job.target }
    : { type: 'ssh', target: job.target, action: job.action };
}

export function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new JobError('invalid_job_id');
  return id;
}

export async function readLimited(stream, limit = OUTPUT_LIMIT) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
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
