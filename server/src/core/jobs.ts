import { randomUUID } from 'node:crypto';
import { bus, type JobSummary } from './events.js';
import { createLogger } from './logger.js';

const log = createLogger('jobs');
const MAX_JOBS = 200;
const MAX_LINES = 5000;

interface Job extends JobSummary {
  lines: string[];
}

const jobs = new Map<string, Job>();

export interface JobContext {
  id: string;
  log: (line: string) => void;
}

function summary(j: Job): JobSummary {
  const { lines: _lines, ...s } = j;
  return s;
}

/**
 * Starts a long-running operation (compose up, acme issue, VM create...) in the
 * background. Output lines are streamed to the UI over the event bus.
 */
export function startJob(title: string, topic: string, fn: (ctx: JobContext) => Promise<void>): JobSummary {
  const job: Job = {
    id: randomUUID(),
    title,
    topic,
    state: 'running',
    startedAt: new Date().toISOString(),
    lines: [],
  };
  jobs.set(job.id, job);
  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].find((j) => j.state !== 'running');
    if (oldest) jobs.delete(oldest.id);
  }
  const ctx: JobContext = {
    id: job.id,
    log: (line) => {
      job.lines.push(line);
      if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
      bus.publish({ type: 'job-line', id: job.id, line });
    },
  };
  bus.publish({ type: 'job', job: summary(job) });
  log.info(`job started: ${title}`, { id: job.id });
  fn(ctx)
    .then(() => {
      job.state = 'success';
    })
    .catch((err: Error) => {
      job.state = 'error';
      job.error = err.message;
      ctx.log(`ERROR: ${err.message}`);
      log.error(`job failed: ${title}`, { id: job.id, error: err.message });
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      bus.publish({ type: 'job', job: summary(job) });
      bus.changed(topic);
    });
  return summary(job);
}

export function listJobs(): JobSummary[] {
  return [...jobs.values()].map(summary).reverse();
}

export function getJob(id: string): (JobSummary & { lines: string[] }) | undefined {
  const j = jobs.get(id);
  return j ? { ...summary(j), lines: [...j.lines] } : undefined;
}
