import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from './logger.js';
import { writeCrashReport } from './boot.js';
import { bus } from './events.js';

const log = createLogger('supervisor');

export interface ProcSpec {
  id: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

type ProcStateName = 'running' | 'backoff' | 'crashloop' | 'stopped';

interface Proc {
  spec: ProcSpec;
  child?: ChildProcess;
  state: ProcStateName;
  restarts: number;
  crashes: number[];
  startedAt?: number;
  lastExit?: { code: number | null; signal: string | null; ts: string };
  timer?: NodeJS.Timeout;
  tail: string[];
  wanted: boolean;
}

const CRASH_WINDOW_MS = 120_000;
const CRASH_LIMIT = 5;
const CRASHLOOP_COOLDOWN_MS = 300_000;
const STABLE_MS = 60_000;

const procs = new Map<string, Proc>();

function specKey(s: ProcSpec): string {
  return JSON.stringify([s.cmd, s.args, s.env ?? {}, s.cwd ?? '']);
}

function launch(p: Proc): void {
  const plog = log.child(p.spec.id);
  p.startedAt = Date.now();
  let child: ChildProcess;
  try {
    child = spawn(p.spec.cmd, p.spec.args, {
      cwd: p.spec.cwd,
      env: { ...process.env, ...p.spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    onExit(p, null, null, err as Error);
    return;
  }
  p.child = child;
  p.state = 'running';
  bus.changed('supervisor', p.spec.id);
  const onData = (d: Buffer) => {
    for (const line of d.toString('utf8').split(/\r?\n/).filter(Boolean)) {
      p.tail.push(line);
      if (p.tail.length > 200) p.tail.shift();
      plog.debug(line);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (err) => onExit(p, null, null, err));
  child.on('exit', (code, signal) => onExit(p, code, signal));
}

function onExit(p: Proc, code: number | null, signal: string | null, err?: Error): void {
  if (p.child === undefined && !err) return;
  p.child = undefined;
  p.lastExit = { code, signal, ts: new Date().toISOString() };
  bus.changed('supervisor', p.spec.id);
  if (!p.wanted) {
    p.state = 'stopped';
    return;
  }
  const now = Date.now();
  if (p.startedAt && now - p.startedAt > STABLE_MS) p.restarts = 0;
  p.crashes = p.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
  p.crashes.push(now);
  const msg = err ? err.message : `exited code=${code} signal=${signal}`;
  log.warn(`process ${p.spec.id} ${msg}`, { tail: p.tail.slice(-10) });

  let delay: number;
  if (p.crashes.length >= CRASH_LIMIT) {
    p.state = 'crashloop';
    delay = CRASHLOOP_COOLDOWN_MS;
    writeCrashReport(`process-${p.spec.id}`, err ?? new Error(msg), { spec: p.spec, tail: p.tail.slice(-50) });
    log.error(`process ${p.spec.id} is crash looping; retrying in ${delay / 1000}s`);
    p.crashes = [];
  } else {
    p.state = 'backoff';
    delay = Math.min(60_000, 1000 * 2 ** p.restarts);
  }
  p.restarts++;
  p.timer = setTimeout(() => p.wanted && launch(p), delay);
}

export const supervisor = {
  /** Starts the process, or restarts it when the spec changed. */
  ensure(spec: ProcSpec): void {
    const cur = procs.get(spec.id);
    if (cur && specKey(cur.spec) === specKey(spec) && cur.wanted) return;
    if (cur) this.stop(spec.id);
    const p: Proc = { spec, state: 'stopped', restarts: 0, crashes: [], tail: [], wanted: true };
    procs.set(spec.id, p);
    log.info(`starting ${spec.id}: ${spec.cmd} ${spec.args.join(' ')}`);
    launch(p);
  },

  stop(id: string): void {
    const p = procs.get(id);
    if (!p) return;
    p.wanted = false;
    if (p.timer) clearTimeout(p.timer);
    p.child?.kill('SIGTERM');
    procs.delete(id);
    bus.changed('supervisor', id);
  },

  stopAll(): void {
    for (const id of [...procs.keys()]) this.stop(id);
  },

  list() {
    return [...procs.values()].map((p) => ({
      id: p.spec.id,
      cmd: [p.spec.cmd, ...p.spec.args].join(' '),
      state: p.state,
      pid: p.child?.pid,
      restarts: p.restarts,
      startedAt: p.startedAt ? new Date(p.startedAt).toISOString() : undefined,
      lastExit: p.lastExit,
      tail: p.tail.slice(-20),
    }));
  },
};
