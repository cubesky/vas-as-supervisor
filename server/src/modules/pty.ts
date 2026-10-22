import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Minimal pseudo-terminal abstraction for web consoles. Uses node-pty when it
 * is installed (proper resize support), otherwise falls back to util-linux
 * `script`, which allocates a pty without native modules.
 */

export interface Pty {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

const require = createRequire(import.meta.url);
let nodePty: any;
try {
  nodePty = require('node-pty');
} catch {
  nodePty = null;
}

export function spawnPty(cmd: string, args: string[], cols = 120, rows = 32): Pty {
  if (nodePty) {
    const p = nodePty.spawn(cmd, args, { name: 'xterm-256color', cols, rows, env: { ...process.env, TERM: 'xterm-256color' } });
    return {
      write: (d) => p.write(typeof d === 'string' ? d : d.toString('utf8')),
      resize: (c, r) => p.resize(Math.max(10, c), Math.max(5, r)),
      kill: () => p.kill(),
      onData: (cb) => p.onData(cb),
      onExit: (cb) => p.onExit((e: { exitCode: number }) => cb(e.exitCode)),
    };
  }
  const line = [cmd, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const child = spawn('script', ['-qfc', `stty cols ${cols} rows ${rows}; exec ${line}`, '/dev/null'], {
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    write: (d) => child.stdin.write(d),
    resize: () => undefined,
    kill: () => child.kill('SIGHUP'),
    onData: (cb) => {
      child.stdout.on('data', (d: Buffer) => cb(d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => cb(d.toString('utf8')));
    },
    onExit: (cb) => child.on('exit', (code) => cb(code)),
  };
}
