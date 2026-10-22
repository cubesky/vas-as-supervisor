import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { bus, type LogEntry } from './events.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const RING_SIZE = 3000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;

const ring: LogEntry[] = [];
let stream: fs.WriteStream | null = null;
let written = 0;

function logFile(): string {
  return path.join(env.logDir, 'vas.log');
}

function openStream(): void {
  try {
    fs.mkdirSync(env.logDir, { recursive: true });
    written = fs.existsSync(logFile()) ? fs.statSync(logFile()).size : 0;
    stream = fs.createWriteStream(logFile(), { flags: 'a' });
    stream.on('error', () => (stream = null));
  } catch {
    stream = null;
  }
}

function rotate(): void {
  stream?.end();
  stream = null;
  for (let i = MAX_FILES - 1; i >= 1; i--) {
    const from = i === 1 ? logFile() : `${logFile()}.${i - 1}`;
    const to = `${logFile()}.${i}`;
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {
      /* ignore rotation races */
    }
  }
  openStream();
}

function write(entry: LogEntry): void {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

  if (LEVELS[entry.level] >= LEVELS[env.logLevel]) {
    const line = `${entry.ts} ${entry.level.toUpperCase().padEnd(5)} [${entry.module}] ${entry.msg}`;
    (entry.level === 'error' || entry.level === 'warn' ? process.stderr : process.stdout).write(
      line + (entry.data !== undefined ? ` ${safeJson(entry.data)}` : '') + '\n',
    );
  }

  if (!stream) openStream();
  if (stream) {
    const json = safeJson(entry) + '\n';
    stream.write(json);
    written += Buffer.byteLength(json);
    if (written > MAX_FILE_BYTES) rotate();
  }
  bus.publish({ type: 'log', entry });
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Error ? { message: val.message, stack: val.stack } : val));
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(sub: string): Logger;
}

export function createLogger(module: string): Logger {
  const mk = (level: Level) => (msg: string, data?: unknown) =>
    write({ ts: new Date().toISOString(), level, module, msg, data });
  return {
    debug: mk('debug'),
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    child: (sub) => createLogger(`${module}:${sub}`),
  };
}

export function recentLogs(opts: { level?: Level; module?: string; limit?: number; q?: string } = {}): LogEntry[] {
  const min = LEVELS[opts.level ?? 'debug'];
  const q = opts.q?.toLowerCase();
  const out = ring.filter(
    (e) =>
      LEVELS[e.level] >= min &&
      (!opts.module || e.module === opts.module || e.module.startsWith(opts.module + ':')) &&
      (!q || e.msg.toLowerCase().includes(q) || e.module.toLowerCase().includes(q)),
  );
  return out.slice(-(opts.limit ?? 500));
}

export function flushLogs(): Promise<void> {
  return new Promise((resolve) => (stream ? stream.end(resolve) : resolve()));
}
