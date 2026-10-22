import { spawn } from 'node:child_process';
import { createLogger } from './logger.js';

const log = createLogger('exec');

export class ExecError extends Error {
  constructor(
    public cmd: string,
    public code: number | null,
    public stdout: string,
    public stderr: string,
  ) {
    super(`${cmd} exited with ${code}: ${(stderr || stdout).trim().slice(-2000)}`);
  }
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  /** Resolve instead of throwing on a non-zero exit code */
  allowFail?: boolean;
  /** Called for each output line (stdout + stderr), used by jobs */
  onLine?: (line: string) => void;
  /** Hide arguments from logs (e.g. secrets) */
  quiet?: boolean;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE = 8 * 1024 * 1024;

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const pretty = opts.quiet ? cmd : `${cmd} ${args.map(quote).join(' ')}`;
  log.debug(`$ ${pretty}`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    const lineBuf = { out: '', err: '' };
    const feed = (which: 'out' | 'err', chunk: string) => {
      if (!opts.onLine) return;
      lineBuf[which] += chunk;
      const parts = lineBuf[which].split(/\r?\n/);
      lineBuf[which] = parts.pop() ?? '';
      for (const p of parts) opts.onLine(p);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += d;
      feed('out', d);
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += d;
      feed('err', d);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          stderr += `\n[timeout after ${opts.timeoutMs}ms]`;
        }, opts.timeoutMs)
      : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new ExecError(pretty, null, stdout, `${stderr}${err.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (opts.onLine) {
        if (lineBuf.out) opts.onLine(lineBuf.out);
        if (lineBuf.err) opts.onLine(lineBuf.err);
      }
      if (code !== 0 && !opts.allowFail) reject(new ExecError(pretty, code, stdout, stderr));
      else resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

function quote(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

const whichCache = new Map<string, boolean>();

/** Returns true when the binary can be found on PATH. */
export async function which(bin: string): Promise<boolean> {
  if (whichCache.has(bin)) return whichCache.get(bin)!;
  let ok = false;
  try {
    const r = await run('sh', ['-c', `command -v ${quote(bin)}`], { allowFail: true, timeoutMs: 5000 });
    ok = r.code === 0;
  } catch {
    ok = false;
  }
  whichCache.set(bin, ok);
  return ok;
}

export function clearWhichCache(): void {
  whichCache.clear();
}
