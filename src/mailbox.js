import { executeJob } from './executor.js';
import { JOB_STATUSES, JobError, RESULT_LIMIT, publicError, publicJob, publicJobSummary, validateId, validateJob } from './protocol.js';

export const INSERT_JOB = `INSERT INTO jobs (id, payload)
  SELECT ?, ? WHERE (SELECT count(*) FROM jobs WHERE status IN ('pending', 'running')) < 100
  ON CONFLICT(id) DO NOTHING`;
export const SELECT_JOB = 'SELECT * FROM jobs WHERE id = ?';
export const LIST_JOBS_ALL = `SELECT id, payload, status, created_at, completed_at, error
  FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?`;
export const LIST_JOBS_BY_STATUS = `SELECT id, payload, status, created_at, completed_at, error
  FROM jobs WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?`;
export const CANCEL_JOB = `UPDATE jobs SET status = 'failed', error = 'job_canceled', completed_at = unixepoch()
  WHERE id = ? AND status = 'pending'`;
const CLAIM_JOB = `UPDATE jobs SET status = 'running', lease_until = unixepoch() + 120, claim_token = ?
  WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND expires_at > unixepoch()
    ORDER BY created_at, id LIMIT 1) AND status = 'pending' RETURNING *`;

export async function enqueue(db, id, input) {
  validateId(id);
  const payload = JSON.stringify(validateJob(input));
  await db.prepare(INSERT_JOB).bind(id, payload).run();
  const row = await db.prepare(SELECT_JOB).bind(id).first();
  if (!row) throw new JobError('mailbox_full', 429);
  if (row.payload !== payload) throw new JobError('idempotency_conflict', 409);
  return publicJob(row);
}

export async function listJobs(db, { status, limit = 20 } = {}) {
  if (status !== undefined && !JOB_STATUSES.includes(status)) throw new JobError('invalid_status_filter');
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) throw new JobError('invalid_limit');
  const stmt = status === undefined
    ? db.prepare(LIST_JOBS_ALL).bind(parsedLimit)
    : db.prepare(LIST_JOBS_BY_STATUS).bind(status, parsedLimit);
  const { results = [] } = await stmt.all();
  return results.map(publicJobSummary);
}

export async function cancelJob(db, id) {
  validateId(id);
  await db.prepare(CANCEL_JOB).bind(id).run();
  const row = await db.prepare(SELECT_JOB).bind(id).first();
  if (!row) throw new JobError('job_not_found', 404);
  return publicJob(row);
}

export async function processMailbox(env, execute = executeJob) {
  const db = env.DB;
  await db.batch([
    db.prepare(`UPDATE jobs SET status = 'expired', error = 'job_expired', completed_at = unixepoch()
      WHERE status = 'pending' AND expires_at <= unixepoch()`),
    db.prepare(`UPDATE jobs SET status = 'unknown', error = 'execution_interrupted', completed_at = unixepoch()
      WHERE status = 'running' AND lease_until <= unixepoch()`),
    db.prepare(`DELETE FROM jobs WHERE created_at < unixepoch() - 86400
      AND status NOT IN ('pending', 'running')`),
  ]);
  let processed = 0;
  for (let index = 0; index < 5; index++) {
    const claim = crypto.randomUUID();
    const row = await db.prepare(CLAIM_JOB).bind(claim).first();
    if (!row) break;
    let result = null;
    let error = null;
    let status = 'succeeded';
    let input;
    try {
      input = validateJob(JSON.parse(row.payload));
      result = JSON.stringify(await execute(input, env));
      if (new TextEncoder().encode(result).byteLength > RESULT_LIMIT) {
        result = null;
        throw new JobError('size_limit_exceeded', 413);
      }
    } catch (caught) {
      error = publicError(caught);
      // A failed SSH transport may have executed a remote command before disconnecting.
      status = input?.type === 'ssh'
        ? 'unknown' : 'failed';
    }
    await db.prepare(`UPDATE jobs SET status = ?, result = ?, error = ?, completed_at = unixepoch()
      WHERE id = ? AND status = 'running' AND claim_token = ?`)
      .bind(status, result, error, row.id, claim).run();
    processed++;
  }
  return { processed };
}
