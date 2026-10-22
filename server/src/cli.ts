#!/usr/bin/env node
/**
 * vas — command line for the VAS server manager.
 *
 * Talks to the running manager over its root-only admin socket
 * (VAS_ADMIN_SOCKET), so it works without the web UI, without OpenResty
 * and without a passkey. Use it interactively (`vas` opens a shell with
 * tab completion and history) or in scripts (`--json`, `--yes`, exit codes).
 *
 *   podman exec -it vas vas            # interactive shell
 *   podman exec vas vas ps --json      # scripted
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { env } from './core/env.js';

const VERSION = '0.1.0';
let SOCKET = env.adminSocket;

// ---------------------------------------------------------------------------
// output helpers

const tty = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Same rule as the web UI: installed only when the agent has the wanted version. */
function luaState(p: { version?: string; status?: { version?: string; ok: boolean } | null }): 'installed' | 'pending' | 'failed' {
  if (!p.status || (p.status.version ?? '') !== (p.version ?? '')) return 'pending';
  return p.status.ok ? 'installed' : 'failed';
}

function stateColor(s: string): string {
  const v = String(s ?? '').toLowerCase();
  if (/^(running|issued|success|online|up|ok|listening)/.test(v)) return green(s);
  if (/(error|crash|fail|offline|conflict)/.test(v)) return red(s);
  if (/(partial|pending|backoff|paused|frozen|issuing|reserved)/.test(v)) return yellow(s);
  return dim(s);
}

type Col = [key: string, header: string, fmt?: (v: any, row: any) => string];

function table(rows: any[], cols: Col[]): void {
  if (!rows.length) {
    console.log(dim('(none)'));
    return;
  }
  const cells = rows.map((r) => cols.map(([k, , fmt]) => (fmt ? fmt(r[k], r) : String(r[k] ?? '—'))));
  const widths = cols.map(([, h], i) => Math.max(h.length, ...cells.map((c) => stripAnsi(c[i]).length)));
  console.log(bold(cols.map(([, h], i) => h.padEnd(widths[i])).join('  ')));
  for (const c of cells) console.log(c.map((v, i) => v + ' '.repeat(Math.max(0, widths[i] - stripAnsi(v).length))).join('  ').trimEnd());
}

function kv(pairs: [string, unknown][]): void {
  const w = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) console.log(`${dim(k.padEnd(w))}  ${v ?? '—'}`);
}

// ---------------------------------------------------------------------------
// arguments

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that take a value (`--tail 50` or `--tail=50`); repeated flags are joined with commas. */
const VALUE_FLAGS = new Set([
  'tail', 'level', 'module', 'file', 'env-file', 'socket', 'base', 'dist', 'release', 'arch', 'variant', 'memory', 'cpus',
  'vcpus', 'disk', 'iso', 'image', 'firmware', 'domain', 'upstream', 'tls', 'protocol', 'listen', 'nic', 'message', 'id',
  'route', 'ip', 'action', 'rule', 'note', 'version',
]);
const ALIASES: Record<string, string> = { f: 'follow', y: 'yes', m: 'message', n: 'tail', h: 'help' };

function parseArgs(tokens: string[]): Args {
  const a: Args = { _: [], flags: {} };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') {
      a._.push(...tokens.slice(i + 1));
      break;
    }
    const m = t.match(/^--?([\w-]+)(?:=(.*))?$/);
    if (!m || /^-\d/.test(t)) {
      a._.push(t);
      continue;
    }
    const name = ALIASES[m[1]] ?? m[1];
    let value: string | boolean = true;
    if (m[2] !== undefined) value = m[2];
    else if (VALUE_FLAGS.has(name) && i + 1 < tokens.length) value = tokens[++i];
    const prev = a.flags[name];
    a.flags[name] = typeof prev === 'string' && typeof value === 'string' ? `${prev},${value}` : value;
  }
  return a;
}

/** Shell-like tokenizer for the interactive mode (quotes, escapes). */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const flag = (a: Args, k: string) => a.flags[k];
const str = (a: Args, k: string) => (typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined);
const json = (a: Args) => !!a.flags.json;

class UsageError extends Error {}
function need(a: Args, i: number, what: string): string {
  const v = a._[i];
  if (!v) throw new UsageError(`missing ${what}`);
  return v;
}

// ---------------------------------------------------------------------------
// transport (admin socket)

class ManagerDown extends Error {}
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function request(method: string, p: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: SOCKET,
        path: `/api${p}`,
        method,
        headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          let parsed: any = buf;
          try {
            parsed = buf ? JSON.parse(buf) : null;
          } catch {
            /* plain text */
          }
          if ((res.statusCode ?? 500) >= 400) reject(new ApiError(res.statusCode ?? 500, parsed?.error ?? String(buf).slice(0, 500)));
          else resolve(parsed);
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EACCES') reject(new ManagerDown(`permission denied on ${SOCKET} — run as root (e.g. podman exec -it vas vas)`));
      else if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') reject(new ManagerDown(`manager not reachable on ${SOCKET} (${err.code})`));
      else reject(err);
    });
    if (data) req.write(data);
    req.end();
  });
}

const get = (p: string) => request('GET', p);
const post = (p: string, b: unknown = {}) => request('POST', p, b);
const put = (p: string, b: unknown) => request('PUT', p, b);
const del = (p: string) => request('DELETE', p);
const enc = encodeURIComponent;

/** Server-sent events from /api/events; returns a function that stops the stream. */
function subscribe(onEvent: (ev: any) => void): () => void {
  const req = http.request({ socketPath: SOCKET, path: '/api/events', method: 'GET' }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {
            /* ignore */
          }
        }
      }
    });
  });
  req.on('error', () => undefined);
  req.end();
  return () => req.destroy();
}

const isJob = (r: any) => r && typeof r === 'object' && typeof r.id === 'string' && 'state' in r && 'topic' in r;

/** Prints a job's output until it finishes; exit code 0 on success. */
function followJob(job: any, a: Args): Promise<number> {
  if (flag(a, 'detach')) {
    console.log(json(a) ? JSON.stringify(job) : `job ${job.id}`);
    return Promise.resolve(0);
  }
  if (!json(a)) console.error(dim(`▶ ${job.title}`));
  return new Promise((resolve) => {
    const early: string[] = [];
    let ready = false;
    let done = false;
    const finish = (j: any) => {
      if (done) return;
      done = true;
      stop();
      if (json(a)) console.log(JSON.stringify(j));
      else console.error(j.state === 'success' ? green('✓ done') : red(`✗ ${j.error ?? 'failed'}`));
      resolve(j.state === 'success' ? 0 : 1);
    };
    const stop = subscribe((ev) => {
      if (ev.type === 'job-line' && ev.id === job.id) {
        if (ready) !json(a) && console.log(ev.line);
        else early.push(ev.line);
      }
      if (ev.type === 'job' && ev.job.id === job.id && ev.job.state !== 'running') setTimeout(() => finish(ev.job), 50);
    });
    get(`/jobs/${job.id}`)
      .then((j) => {
        // lines that arrived on the stream before the snapshot may already be in it
        let overlap = Math.min(early.length, j.lines.length);
        while (overlap > 0 && early.slice(0, overlap).join('\n') !== j.lines.slice(-overlap).join('\n')) overlap--;
        if (!json(a)) for (const l of [...j.lines, ...early.slice(overlap)]) console.log(l);
        ready = true;
        if (j.state !== 'running') finish(j);
      })
      .catch(() => (ready = true));
  });
}

/** Runs an API action: follows jobs, otherwise prints a short confirmation. */
async function act(promise: Promise<any>, a: Args, ok = 'ok'): Promise<number> {
  const r = await promise;
  if (isJob(r)) return followJob(r, a);
  if (json(a)) console.log(JSON.stringify(r ?? { ok: true }, null, 2));
  else console.log(green(ok));
  return 0;
}

// ---------------------------------------------------------------------------
// interactive helpers

let shellRl: readline.Interface | null = null;

async function confirm(question: string, a: Args): Promise<boolean> {
  if (flag(a, 'yes')) return true;
  if (!process.stdin.isTTY) throw new UsageError(`${question} — refusing without --yes (not interactive)`);
  const ask = (rl: readline.Interface) => new Promise<string>((r) => rl.question(`${yellow(question)} [y/N] `, r));
  let answer: string;
  if (shellRl) answer = await ask(shellRl);
  else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    answer = await ask(rl);
    rl.close();
  }
  return /^y(es)?$/i.test(answer.trim());
}

/** Raw terminal over the WebSocket API (LXC shell/console, VM serial). Ctrl+] detaches. */
function attachTerminal(apiPath: string, title: string): Promise<number> {
  if (process.platform === 'win32') throw new UsageError('terminals need the unix admin socket (Linux)');
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws+unix://${SOCKET}:/api${apiPath}`);
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    shellRl?.pause();
    const sendSize = () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'r', c: process.stdout.columns ?? 120, r: process.stdout.rows ?? 32 }));
    const onData = (d: Buffer) => {
      if (d.includes(0x1d)) return ws.close(); // Ctrl+]
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'i', d: d.toString('utf8') }));
    };
    const cleanup = () => {
      stdin.off('data', onData);
      process.stdout.off('resize', sendSize);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      if (!shellRl) stdin.pause();
      shellRl?.resume();
    };
    ws.on('open', () => {
      console.error(dim(`— connected to ${title}, detach with Ctrl+] —`));
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      process.stdout.on('resize', sendSize);
      sendSize();
    });
    ws.on('message', (d: Buffer) => process.stdout.write(d));
    ws.on('close', (_code, reason) => {
      cleanup();
      console.error(dim(`\n— disconnected${reason?.length ? `: ${reason}` : ''} —`));
      resolve(0);
    });
    ws.on('error', (err) => {
      cleanup();
      console.error(red(err.message));
      resolve(1);
    });
  });
}

function editText(initial: string, suffix: string): string | null {
  const file = path.join(os.tmpdir(), `vas-edit-${process.pid}${suffix}`);
  fs.writeFileSync(file, initial);
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  shellRl?.pause();
  const r = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
  shellRl?.resume();
  const text = fs.readFileSync(file, 'utf8');
  fs.rmSync(file, { force: true });
  if (r.status !== 0) throw new Error(`${editor} exited with ${r.status}`);
  return text === initial ? null : text;
}

const readFileArg = (p: string) => fs.readFileSync(p === '-' ? 0 : p, 'utf8');

// ---------------------------------------------------------------------------
// offline diagnostics (manager down)

function offlineReport(): void {
  console.log(red(bold('manager is not reachable')) + dim(` (${SOCKET})`));
  const boots = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(env.stateDir, 'boot-history.json'), 'utf8')).boots as any[];
    } catch {
      return [];
    }
  })();
  if (boots.length) {
    console.log(bold('\nrecent starts'));
    for (const b of boots.slice(-5)) console.log(`  ${b.ts}  ${b.clean === null ? yellow('running/killed') : b.clean ? green('clean') : red('crashed')}`);
  }
  const crashDir = path.join(env.logDir, 'crashes');
  const crashes = fs.existsSync(crashDir) ? fs.readdirSync(crashDir).filter((n) => n.endsWith('.json')).sort() : [];
  if (crashes.length) {
    const last = JSON.parse(fs.readFileSync(path.join(crashDir, crashes.at(-1)!), 'utf8'));
    console.log(bold('\nlast crash report') + dim(` ${crashes.at(-1)}`));
    console.log(`  ${last.kind}: ${red(last.message)}`);
    console.log(dim((last.stack ?? '').split('\n').slice(1, 6).join('\n')));
  }
  const logFile = path.join(env.logDir, 'vas.log');
  if (fs.existsSync(logFile)) {
    // info and above: debug output (every command run) would push the interesting lines out
    const entries = fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .slice(-2000)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { ts: '', level: 'info', module: '?', msg: l };
        }
      })
      .filter((e) => e.level !== 'debug')
      .slice(-15);
    console.log(bold('\nlast log lines') + dim(` ${logFile}`));
    for (const e of entries) {
      const data = e.data !== undefined ? dim(` ${JSON.stringify(e.data).slice(0, 200)}`) : '';
      console.log(`  ${dim(String(e.ts).slice(11, 19))} ${stateColor(e.level.padEnd(5))} [${e.module}] ${e.msg}${data}`);
    }
  }
  console.log(dim('\nstart it on the host with: podman start vas   (logs: podman logs vas)'));
}

// ---------------------------------------------------------------------------
// commands

type Run = (a: Args) => Promise<number | void>;
interface Sub {
  usage?: string;
  help: string;
  run: Run;
  /** completion source for the first positional argument */
  arg?: keyof typeof completers;
}
interface Command {
  help: string;
  usage?: string;
  run?: Run;
  sub?: Record<string, Sub>;
}

const completers = {
  container: async () => ((await get('/podman/containers')).containers as any[]).map((c) => c.name),
  compose: async () => ((await get('/compose')).projects as any[]).map((p) => p.name),
  lxc: async () => ((await get('/lxc')).containers as any[]).map((c) => c.name),
  vm: async () => ((await get('/vms')).vms as any[]).map((v) => v.name),
  route: async () => ((await get('/openresty')).routes as any[]).map((r) => r.id),
  stream: async () => ((await get('/openresty')).streams as any[]).map((s) => s.id),
  cert: async () => ((await get('/acme')).certificates as any[]).map((c) => c.id),
  job: async () => ((await get('/jobs')) as any[]).map((j) => j.id),
};

const show = (a: Args, data: unknown, render: () => void) => (json(a) ? console.log(JSON.stringify(data, null, 2)) : render());

const portsText = (ports: any[]) => (ports ?? []).map((p) => `${p.hostIp && p.hostIp !== '0.0.0.0' ? `${p.hostIp}:` : ''}${p.hostPort}→${p.containerPort}/${p.protocol}`).join(', ');

function simpleActions(base: (name: string) => string, names: string[], arg: keyof typeof completers, destructive: string[] = []): Record<string, Sub> {
  return Object.fromEntries(
    names.map((n) => [
      n,
      {
        usage: `<name>${destructive.includes(n) ? ' [--yes]' : ''}`,
        help: n,
        arg,
        run: async (a: Args) => {
          const name = need(a, 0, 'name');
          if (destructive.includes(n) && !(await confirm(`${n} ${name}?`, a))) return 1;
          return act(post(`${base(name)}/${n}`), a);
        },
      } satisfies Sub,
    ]),
  );
}

const commands: Record<string, Command> = {
  status: {
    help: 'manager, host and OpenResty overview (works offline too)',
    run: async (a) => {
      let s;
      try {
        s = await get('/system');
      } catch (err) {
        if (err instanceof ManagerDown && !json(a)) {
          offlineReport();
          return 2;
        }
        throw err;
      }
      const or = await get('/openresty').catch(() => null);
      show(a, { system: s, openresty: or?.agent }, () => {
        kv([
          ['host', `${s.hostname} · ${s.platform} · ${s.arch}`],
          ['uptime', `${Math.floor(s.uptime / 3600)}h`],
          ['load', s.load.map((x: number) => x.toFixed(2)).join(' ')],
          ['memory', `${((s.memory.total - s.memory.free) / 2 ** 30).toFixed(1)} / ${(s.memory.total / 2 ** 30).toFixed(1)} GiB`],
          ['login', s.auth ? 'passkey' : yellow('disabled')],
          ['listen', (s.listen ?? []).map((l: any) => `${l.host}:${l.port}`).join(', ')],
          ['public UI', s.public?.domains?.length ? `${s.public.domains.join(', ')} → ${s.managerUrl}` : dim('not configured')],
          ['safe mode', s.boot.safeMode ? red(`ON — ${s.boot.safeModeReason}`) : green('off')],
          ['podman', s.versions.podman ?? red('not available')],
          ['lxc', s.versions.lxc ?? red('not available')],
          ['libvirt', s.versions.libvirt ?? red('not available')],
          ['acme.sh', s.capabilities.acme.ok ? green(s.capabilities.acme.detail) : red(s.capabilities.acme.detail)],
          [
            'openresty',
            or
              ? `${or.agent.online ? green('online') : red('offline')} · ${or.agent.inSync ? green('in sync') : yellow('pending')} · rev ${or.revision}` +
                (or.agent.lastReport && !or.agent.lastReport.ok ? red(` · last apply failed`) : '')
              : '—',
          ],
        ]);
        if (or?.agent.lastReport && !or.agent.lastReport.ok) console.log(red(or.agent.lastReport.message.trim().split('\n').slice(0, 4).join('\n')));
      });
    },
  },

  ps: {
    help: 'list podman containers (system = VAS’s own, protected)',
    run: async (a) => {
      const d = await get('/podman/containers');
      show(a, d.containers, () =>
        table(d.containers, [
          ['name', 'NAME', (v, r) => (r.system ? `${v} ${cyan('[system]')}` : v)],
          ['state', 'STATE', stateColor],
          ['image', 'IMAGE'],
          ['ports', 'PORTS', portsText],
          ['composeProject', 'PROJECT'],
        ]),
      );
    },
  },

  container: {
    help: 'act on a podman container',
    sub: {
      ...Object.fromEntries(
        ['start', 'stop', 'restart', 'kill', 'pause', 'unpause', 'rm'].map((n) => [
          n,
          {
            usage: '<name|id> [--force] [--yes]',
            help: `${n} (--force: allow VAS's own containers)`,
            arg: 'container' as const,
            run: async (a: Args) => {
              const ref = need(a, 0, 'container');
              if ((n === 'rm' || flag(a, 'force')) && !(await confirm(`${n} container ${ref}${flag(a, 'force') ? ' (forced)' : ''}?`, a))) return 1;
              return act(post(`/podman/containers/${enc(ref)}/${n}${flag(a, 'force') ? '?force=true' : ''}`), a);
            },
          } satisfies Sub,
        ]),
      ),
      logs: {
        usage: '<name|id> [--tail N]',
        help: 'show logs',
        arg: 'container',
        run: async (a) => {
          const r = await get(`/podman/containers/${enc(need(a, 0, 'container'))}/logs?tail=${Number(str(a, 'tail')) || 200}`);
          process.stdout.write(r.logs);
        },
      },
      inspect: {
        usage: '<name|id>',
        help: 'podman inspect (JSON)',
        arg: 'container',
        run: async (a) => console.log(JSON.stringify(await get(`/podman/containers/${enc(need(a, 0, 'container'))}/inspect`), null, 2)),
      },
      pull: { usage: '<image>', help: 'pull an image', run: async (a) => act(post('/podman/images/pull', { image: need(a, 0, 'image') }), a) },
    },
  },

  compose: {
    help: 'podman compose projects',
    sub: {
      ls: {
        help: 'list projects',
        run: async (a) => {
          const d = await get('/compose');
          show(a, d.projects, () =>
            table(d.projects, [
              ['name', 'NAME', (v, r) => (r.system ? `${v} ${cyan('[system]')}` : v)],
              ['state', 'STATE', stateColor],
              ['running', 'UP', (v, r) => `${v}/${r.total}`],
              ['meta', 'AUTOSTART', (m) => (m.autostart ? 'yes' : '—')],
              ['dir', 'DIR', (v) => dim(v)],
            ]),
          );
        },
      },
      show: {
        usage: '<name>',
        help: 'compose file, .env and containers',
        arg: 'compose',
        run: async (a) => {
          const d = await get(`/compose/${enc(need(a, 0, 'project'))}`);
          show(a, d, () => {
            kv([['dir', d.dir], ['state', stateColor(d.status.state)], ['file', d.file]]);
            console.log(bold(`\n${d.file}`));
            console.log(d.compose);
            if (d.env) console.log(bold('.env') + '\n' + d.env);
          });
        },
      },
      ...simpleActions((n) => `/compose/${enc(n)}`, ['up', 'down', 'start', 'stop', 'restart', 'pull', 'build', 'snapshot'], 'compose', ['down']),
      logs: {
        usage: '<name> [--tail N]',
        help: 'project logs',
        arg: 'compose',
        run: async (a) => {
          process.stdout.write((await get(`/compose/${enc(need(a, 0, 'project'))}/logs?tail=${Number(str(a, 'tail')) || 200}`)).logs);
        },
      },
      create: {
        usage: '<name> --file compose.yaml [--env-file .env] [--up]',
        help: 'create a project from a file (- = stdin)',
        run: async (a) => {
          const name = need(a, 0, 'project name');
          const file = str(a, 'file');
          if (!file) throw new UsageError('--file is required');
          const envFile = str(a, 'env-file');
          await post('/compose', { name, compose: readFileArg(file), env: envFile ? readFileArg(envFile) : '' });
          console.log(green(`created ${name}`));
          return flag(a, 'up') ? act(post(`/compose/${enc(name)}/up`), a) : 0;
        },
      },
      edit: {
        usage: '<name> [--env] [--up]',
        help: 'edit compose.yaml (or .env) in $EDITOR',
        arg: 'compose',
        run: async (a) => {
          const name = need(a, 0, 'project');
          const d = await get(`/compose/${enc(name)}`);
          const which = flag(a, 'env') ? 'env' : 'compose';
          const text = editText(which === 'env' ? d.env : d.compose, which === 'env' ? '.env' : '.yaml');
          if (text === null) {
            console.log(dim('no changes'));
            return 0;
          }
          await put(`/compose/${enc(name)}`, { [which]: text });
          console.log(green('saved'));
          if (flag(a, 'up') || (process.stdin.isTTY && (await confirm('apply now (compose up)?', a)))) return act(post(`/compose/${enc(name)}/up`), a);
        },
      },
      rm: {
        usage: '<name> [--delete-data] [--yes]',
        help: 'compose down and remove (data kept unless --delete-data)',
        arg: 'compose',
        run: async (a) => {
          const name = need(a, 0, 'project');
          const deleteData = !!flag(a, 'delete-data');
          if (!(await confirm(`remove project ${name}${deleteData ? ' AND ITS DATA' : ''}?`, a))) return 1;
          return act(del(`/compose/${enc(name)}?deleteData=${deleteData}`), a);
        },
      },
    },
  },

  lxc: {
    help: 'LXC containers',
    sub: {
      ls: {
        help: 'list containers',
        run: async (a) => {
          const d = await get('/lxc');
          show(a, d.containers, () =>
            table(d.containers, [
              ['name', 'NAME'],
              ['state', 'STATE', stateColor],
              ['ipv4', 'IPV4', (v) => (v ?? []).join(', ') || '—'],
              ['network', 'NETWORK', (n) => (n ? `${n.cidr} (${n.bridge})` : '—')],
              ['meta', 'AUTOSTART', (m) => (m.autostart ? 'yes' : '—')],
            ]),
          );
        },
      },
      info: {
        usage: '<name>',
        help: 'lxc-info, network and last start log',
        arg: 'lxc',
        run: async (a) => {
          const d = await get(`/lxc/${enc(need(a, 0, 'name'))}`);
          show(a, d, () => {
            console.log(d.info.trim());
            if (d.network) kv([['network', `${d.network.address}/${d.network.prefix} via ${d.network.gateway} on ${d.network.bridge}`]]);
            if (d.startLog?.trim()) console.log(bold('\nlast start log\n') + dim(d.startLog.trim().split('\n').slice(-10).join('\n')));
          });
        },
      },
      ...simpleActions((n) => `/lxc/${enc(n)}`, ['start', 'stop', 'kill', 'restart', 'freeze', 'unfreeze', 'snapshot'], 'lxc', ['kill']),
      attach: { usage: '<name>', help: 'shell inside the container (Ctrl+] detaches)', arg: 'lxc', run: async (a) => attachTerminal(`/lxc/${enc(need(a, 0, 'name'))}/terminal?mode=attach`, `lxc ${a._[0]}`) },
      console: { usage: '<name>', help: 'container console (tty)', arg: 'lxc', run: async (a) => attachTerminal(`/lxc/${enc(need(a, 0, 'name'))}/terminal?mode=console`, `lxc ${a._[0]} console`) },
      create: {
        usage: '<name> --dist debian --release trixie [--arch amd64] [--variant default] [--nic dedicated|bridge:<br>|none] [--memory MiB] [--cpus 0-1]',
        help: 'create from the image server',
        run: async (a) => {
          const nicFlag = str(a, 'nic') ?? 'dedicated';
          const nic = nicFlag.startsWith('bridge:') ? { mode: 'bridge', bridge: nicFlag.slice(7) } : { mode: nicFlag };
          return act(
            post('/lxc', {
              name: need(a, 0, 'name'),
              dist: str(a, 'dist') ?? 'debian',
              release: str(a, 'release'),
              arch: str(a, 'arch'),
              variant: str(a, 'variant'),
              memoryMiB: Number(str(a, 'memory')) || undefined,
              cpus: str(a, 'cpus'),
              nic,
            }),
            a,
          );
        },
      },
      images: {
        usage: '[dist]',
        help: 'releases available on the image server',
        run: async (a) => {
          const d = await get('/lxc/images');
          const imgs = (d.images as any[]).filter((i) => i.arch === (str(a, 'arch') ?? d.hostArch) && (!a._[0] || i.dist === a._[0]));
          const rows = Object.values(
            imgs.reduce((acc: Record<string, any>, i) => {
              const k = `${i.dist}/${i.release}`;
              acc[k] ??= { dist: i.dist, release: i.release, variants: [] as string[] };
              acc[k].variants.push(i.variant);
              return acc;
            }, {}),
          );
          show(a, rows, () => table(rows, [['dist', 'DIST'], ['release', 'RELEASE'], ['variants', 'VARIANTS', (v) => v.join(', ')]]));
        },
      },
      destroy: {
        usage: '<name> [--yes]',
        help: 'stop and delete the container and its folder',
        arg: 'lxc',
        run: async (a) => {
          const name = need(a, 0, 'name');
          if (!(await confirm(`destroy LXC ${name} and delete its folder?`, a))) return 1;
          return act(del(`/lxc/${enc(name)}`), a);
        },
      },
    },
  },

  vm: {
    help: 'virtual machines',
    sub: {
      ls: {
        help: 'list VMs',
        run: async (a) => {
          const d = await get('/vms');
          show(a, d.vms, () =>
            table(d.vms, [
              ['name', 'NAME'],
              ['state', 'STATE', stateColor],
              ['vcpus', 'CPU'],
              ['memoryKiB', 'MEMORY', (v) => (v ? `${Math.round(v / 1024)} MiB` : '—')],
              ['network', 'NETWORK', (n) => (n ? `${n.address}/${n.prefix}` : '—')],
            ]),
          );
        },
      },
      info: {
        usage: '<name>',
        help: 'state, network, console ports',
        arg: 'vm',
        run: async (a) => {
          const d = await get(`/vms/${enc(need(a, 0, 'name'))}`);
          show(a, d, () =>
            kv([
              ['state', stateColor(`${d.state.state}${d.state.reason ? ` (${d.state.reason})` : ''}`)],
              ['network', d.network ? `${d.network.address}/${d.network.prefix} via ${d.network.gateway} on ${d.network.bridge}` : '—'],
              ['vnc', d.vncPort ? `127.0.0.1:${d.vncPort}  (ssh -L ${d.vncPort}:127.0.0.1:${d.vncPort} <host>)` : '—'],
              ['serial', d.meta.serialPort ? `127.0.0.1:${d.meta.serialPort} — vas vm serial ${d.name}` : '—'],
            ]),
          );
        },
      },
      ...simpleActions((n) => `/vms/${enc(n)}`, ['start', 'shutdown', 'reboot', 'reset', 'suspend', 'resume', 'snapshot'], 'vm', ['reset']),
      'force-off': {
        usage: '<name> [--yes]',
        help: 'cut power (virsh destroy)',
        arg: 'vm',
        run: async (a) => {
          const name = need(a, 0, 'name');
          if (!(await confirm(`force off ${name}?`, a))) return 1;
          return act(post(`/vms/${enc(name)}/destroy`), a);
        },
      },
      serial: { usage: '<name>', help: 'serial console (Ctrl+] detaches)', arg: 'vm', run: async (a) => attachTerminal(`/vms/${enc(need(a, 0, 'name'))}/serial`, `vm ${a._[0]} serial`) },
      rm: {
        usage: '<name> [--delete-disk] [--yes]',
        help: 'undefine the VM (disk kept unless --delete-disk)',
        arg: 'vm',
        run: async (a) => {
          const name = need(a, 0, 'name');
          const disk = !!flag(a, 'delete-disk');
          if (!(await confirm(`delete VM ${name}${disk ? ' AND ITS DISK' : ''}?`, a))) return 1;
          return act(del(`/vms/${enc(name)}?deleteDisk=${disk}`), a);
        },
      },
    },
  },

  route: {
    help: 'OpenResty HTTP routes',
    sub: {
      ls: {
        help: 'list routes (incl. the VAS UI route)',
        run: async (a) => {
          const d = await get('/openresty');
          const rows = [...(d.system ? [{ ...d.system, system: true }] : []), ...d.routes];
          show(a, rows, () =>
            table(rows, [
              ['id', 'ID', (v, r) => (r.system ? `${v} ${cyan('[system]')}` : r.enabled ? v : dim(`${v} (disabled)`))],
              ['domains', 'DOMAINS', (v) => v.join(', ')],
              ['locations', 'UPSTREAMS', (ls: any[]) => ls.map((l) => `${l.path} → ${l.luaContent ? 'Lua' : l.upstreams.map((u: any) => u.target).join(' ')}`).join('; ')],
              ['tls', 'TLS', (t) => (t.mode === 'off' ? '—' : `${t.mode} (${t.certId})`)],
            ]),
          );
        },
      },
      show: {
        usage: '<id>',
        help: 'route as JSON',
        arg: 'route',
        run: async (a) => {
          const d = await get('/openresty');
          const id = need(a, 0, 'route id');
          const r = d.system?.id === id ? d.system : d.routes.find((x: any) => x.id === id);
          if (!r) throw new ApiError(404, `route ${id} not found`);
          console.log(JSON.stringify(r, null, 2));
        },
      },
      add: {
        usage: '<id> --domain a.com[,b.com] --upstream <url|ref> [--upstream …] [--tls off|on|redirect]',
        help: 'create/replace a simple route',
        run: async (a) => {
          const id = need(a, 0, 'route id');
          const upstreams = (str(a, 'upstream') ?? '').split(',').filter(Boolean).map((target) => ({ target }));
          const r = await put(`/openresty/routes/${enc(id)}`, {
            domains: (str(a, 'domain') ?? '').split(','),
            tls: { mode: str(a, 'tls') ?? 'redirect', certId: 'auto' },
            locations: [{ path: '/', upstreams }],
          });
          show(a, r, () => console.log(green(`route ${r.id} saved`)));
        },
      },
      import: {
        usage: '<file.json|-> [--id id]',
        help: 'create/replace routes from JSON (object or array)',
        run: async (a) => {
          const data = JSON.parse(readFileArg(need(a, 0, 'file')));
          for (const r of Array.isArray(data) ? data : [data]) {
            const id = r.id ?? str(a, 'id');
            if (!id) throw new UsageError('route without id (use --id)');
            await put(`/openresty/routes/${enc(id)}`, r);
            console.log(green(`route ${id} saved`));
          }
        },
      },
      export: {
        usage: '[id]',
        help: 'routes as JSON (for import / version control)',
        arg: 'route',
        run: async (a) => {
          const routes = (await get('/openresty')).routes as any[];
          console.log(JSON.stringify(a._[0] ? routes.find((r) => r.id === a._[0]) ?? null : routes, null, 2));
        },
      },
      rm: {
        usage: '<id> [--yes]',
        help: 'delete a route',
        arg: 'route',
        run: async (a) => {
          const id = need(a, 0, 'route id');
          if (!(await confirm(`delete route ${id}?`, a))) return 1;
          return act(del(`/openresty/routes/${enc(id)}`), a);
        },
      },
      preview: {
        usage: '[file]',
        help: 'generated OpenResty config (list files, or print one)',
        run: async (a) => {
          const b = await get('/openresty/preview');
          if (a._[0]) {
            const f = b.files[a._[0]] ?? b.files[`http/route-${a._[0]}.conf`];
            if (f === undefined) throw new ApiError(404, `no file ${a._[0]}`);
            process.stdout.write(f);
          } else {
            console.log(dim(`revision ${b.revision}`));
            for (const k of Object.keys(b.files).sort()) console.log(k);
          }
        },
      },
      reapply: { help: 'bump the revision so the agent reloads', run: async (a) => act(post('/openresty/reapply'), a, 'revision bumped') },
    },
  },

  stream: {
    help: 'OpenResty TCP/UDP forwards',
    sub: {
      ls: {
        help: 'list forwards',
        run: async (a) => {
          const d = await get('/openresty');
          show(a, d.streams, () =>
            table(d.streams, [
              ['id', 'ID'],
              ['listen', 'LISTEN', (v, r) => `${v}/${r.protocol}`],
              ['upstreams', 'UPSTREAMS', (u: any[]) => u.map((x) => x.target).join(', ')],
            ]),
          );
        },
      },
      add: {
        usage: '<id> --listen PORT --upstream host:port|ref [--protocol tcp|udp]',
        help: 'create/replace a forward',
        run: async (a) => {
          const id = need(a, 0, 'id');
          const r = await put(`/openresty/streams/${enc(id)}`, {
            listen: Number(str(a, 'listen')),
            protocol: str(a, 'protocol') ?? 'tcp',
            upstreams: (str(a, 'upstream') ?? '').split(',').filter(Boolean).map((target) => ({ target })),
          });
          show(a, r, () => console.log(green(`forward ${r.id} saved`)));
        },
      },
      rm: {
        usage: '<id> [--yes]',
        help: 'delete a forward',
        arg: 'stream',
        run: async (a) => {
          const id = need(a, 0, 'id');
          if (!(await confirm(`delete forward ${id}?`, a))) return 1;
          return act(del(`/openresty/streams/${enc(id)}`), a);
        },
      },
    },
  },

  waf: {
    help: 'web application firewall',
    sub: {
      status: {
        help: 'last 24 h summary and per-route modes',
        run: async (a) => {
          const d = await get('/waf');
          show(a, d, () => {
            const s = d.stats.last24h;
            kv([
              ['default mode', d.settings.defaultMode],
              ['paranoia / threshold', `${d.settings.paranoia} / ${d.settings.threshold}`],
              ['last 24 h', `${s.total} events · ${red(`${s.blocked} blocked`)} · ${yellow(`${s.detected} detected`)} · ${s.logged} logged`],
              ['blocklist', `${d.settings.blockedIps.length} entries`],
            ]);
            console.log();
            table(d.routes, [
              ['id', 'ROUTE', (v, r) => (r.system ? `${v} ${cyan('[system]')}` : v)],
              ['mode', 'MODE', (m) => (m === 'block' ? green(m) : m === 'detect' ? yellow(m) : dim(m))],
              ['explicit', 'SET', (e) => (e === 'inherit' ? dim('inherit') : e)],
            ]);
            if (d.stats.topRules.length) {
              console.log(bold('\ntop rules'));
              table(d.stats.topRules, [['key', 'RULE'], ['count', 'COUNT'], ['msg', 'DESCRIPTION']]);
            }
          });
        },
      },
      events: {
        usage: '[--route id] [--ip addr] [--action block|detect|log|blocklist] [--rule id] [--tail N] [-f]',
        help: 'recent events (newest first; -f follows new ones)',
        run: async (a) => {
          const q = new URLSearchParams({ limit: String(Number(str(a, 'tail')) || 50) });
          for (const k of ['route', 'ip', 'action', 'rule']) if (str(a, k)) q.set(k, str(a, k)!);
          const print = (e: any) =>
            json(a)
              ? console.log(JSON.stringify(e))
              : console.log(
                  `${dim(new Date(e.ts * 1000).toISOString().slice(0, 19).replace('T', ' '))} ${e.action === 'detect' || e.action === 'log' ? yellow(e.action.padEnd(9)) : red(e.action.padEnd(9))} ${e.ip.padEnd(15)} ${e.method} ${e.host ?? ''}${e.uri.slice(0, 70)} ${dim(e.rules.map((r: any) => r.id).join(','))}`,
                );
          const first = (await get(`/waf/events?${q}`)) as any[];
          for (const e of [...first].reverse()) print(e);
          if (!flag(a, 'follow')) return;
          let last = first[0]?.ts ?? Date.now() / 1000;
          await new Promise<void>((resolve) => {
            const stop = subscribe(async (ev) => {
              if (ev.type !== 'changed' || ev.topic !== 'waf') return;
              const fresh = ((await get(`/waf/events?${q}`)) as any[]).filter((e) => e.ts > last);
              if (fresh.length) last = fresh[0].ts;
              for (const e of fresh.reverse()) print(e);
            });
            const end = () => {
              stop();
              process.off('SIGINT', end);
              resolve();
            };
            process.on('SIGINT', end);
          });
        },
      },
      blocklist: {
        help: 'list blocked addresses',
        run: async (a) => {
          const list = (await get('/waf')).settings.blockedIps;
          show(a, list, () => table(list, [['cidr', 'ADDRESS'], ['note', 'NOTE'], ['addedAt', 'ADDED', (v) => v?.slice(0, 19)]]));
        },
      },
      block: {
        usage: '<ip|cidr> [--note text]',
        help: 'add to the blocklist (all WAF routes)',
        run: async (a) => act(post('/waf/blocklist', { cidr: need(a, 0, 'address'), note: str(a, 'note') }), a, 'blocked'),
      },
      unblock: {
        usage: '<ip|cidr>',
        help: 'remove from the blocklist',
        run: async (a) => act(del(`/waf/blocklist?cidr=${enc(need(a, 0, 'address'))}`), a, 'unblocked'),
      },
      exclude: {
        usage: '<route> <rule-id>',
        help: 'exclude a rule on one route (false positive)',
        arg: 'route',
        run: async (a) => act(post('/waf/exclude', { route: need(a, 0, 'route'), rule: Number(need(a, 1, 'rule id')) }), a, 'excluded'),
      },
    },
  },

  lua: {
    help: 'LuaRocks packages for OpenResty Lua',
    sub: {
      ls: {
        help: 'wanted packages (global + routes) and install status',
        run: async (a) => {
          const d = await get('/openresty');
          const rows = (d.luaPackages as any[]).map((p) => ({ ...p, state: luaState(p) }));
          show(a, rows, () => {
            if (!rows.length) return console.log(dim('no Lua packages'));
            table(rows, [
              ['name', 'PACKAGE'],
              ['version', 'VERSION', (v, r) => `${v || dim('latest')}${r.conflict ? ` ${yellow('(conflict)')}` : ''}`],
              ['sources', 'USED BY', (s: string[]) => s.join(', ')],
              ['state', 'STATUS', (s, r) => (s === 'installed' ? green(`installed ${r.status?.installed ?? ''}`) : s === 'failed' ? red('failed') : dim('pending'))],
            ]);
            if (d.settings.luarocksServer) console.log(dim(`\nserver: ${d.settings.luarocksServer}`));
            if (rows.some((r) => r.state === 'failed')) console.log(dim(`\nsee the error with: vas lua log <package>`));
          });
        },
      },
      add: {
        usage: '<name[@version]> [--version v] [--route id]',
        help: 'add a package (global, or to one route)',
        run: async (a) => {
          const [name, at] = need(a, 0, 'package').split('@');
          const p = { name, ...((str(a, 'version') ?? at) ? { version: str(a, 'version') ?? at } : {}) };
          const route = str(a, 'route');
          const d = await get('/openresty');
          if (route) {
            const r = d.routes.find((x: any) => x.id === route);
            if (!r) throw new ApiError(404, `route ${route} not found`);
            const list = (r.luaPackages ?? []).filter((x: any) => x.name !== p.name);
            await put(`/openresty/routes/${enc(route)}`, { ...r, luaPackages: [...list, p] });
          } else {
            const list = (d.settings.luaPackages ?? []).filter((x: any) => x.name !== p.name);
            await put('/openresty/settings', { luaPackages: [...list, p] });
          }
          console.log(green(`${p.name}${p.version ? ` ${p.version}` : ''} added${route ? ` to ${route}` : ''}; the agent installs it on its next poll`));
        },
      },
      rm: {
        usage: '<name> [--route id]',
        help: 'remove a package (global, or from one route)',
        run: async (a) => {
          const name = need(a, 0, 'package');
          const route = str(a, 'route');
          const d = await get('/openresty');
          if (route) {
            const r = d.routes.find((x: any) => x.id === route);
            if (!r) throw new ApiError(404, `route ${route} not found`);
            if (!(r.luaPackages ?? []).some((x: any) => x.name === name)) throw new ApiError(404, `${name} is not listed on route ${route}`);
            await put(`/openresty/routes/${enc(route)}`, { ...r, luaPackages: r.luaPackages.filter((x: any) => x.name !== name) });
          } else {
            if (!(d.settings.luaPackages ?? []).some((x: any) => x.name === name)) {
              const w = (d.luaPackages as any[]).find((x) => x.name === name);
              throw new UsageError(w ? `${name} is not global; it comes from: ${w.sources.join(', ')} (use --route)` : `${name} is not listed`);
            }
            await put('/openresty/settings', { luaPackages: d.settings.luaPackages.filter((x: any) => x.name !== name) });
          }
          console.log(green(`${name} removed`));
        },
      },
      log: {
        usage: '<name>',
        help: 'LuaRocks output of the last install attempt',
        run: async (a) => {
          const name = need(a, 0, 'package');
          const p = ((await get('/openresty')).luaPackages as any[]).find((x) => x.name === name);
          if (!p) throw new ApiError(404, `${name} is not wanted by any route or the global list`);
          console.log(p.status?.message || dim('(no output reported yet)'));
        },
      },
      server: {
        usage: '[url | --clear]',
        help: 'show or set the LuaRocks mirror',
        run: async (a) => {
          if (!a._[0] && !flag(a, 'clear')) return void console.log((await get('/openresty')).settings.luarocksServer || dim('luarocks.org (default)'));
          return act(put('/openresty/settings', { luarocksServer: flag(a, 'clear') ? '' : a._[0] }), a, 'saved');
        },
      },
      retry: { help: 're-check all packages and retry failed installs now', run: async (a) => act(post('/openresty/reapply'), a, 'the agent re-checks the packages within a few seconds') },
    },
  },

  cert: {
    help: 'certificates (acme.sh)',
    sub: {
      ls: {
        help: 'list certificates',
        run: async (a) => {
          const d = await get('/acme');
          show(a, d.certificates, () =>
            table(d.certificates, [
              ['id', 'ID'],
              ['domains', 'DOMAINS', (v) => v.join(', ')],
              ['status', 'STATE', (s) => stateColor(s.state)],
              ['status', 'EXPIRES', (s) => (s.notAfter ? s.notAfter.slice(0, 10) : '—')],
              ['aliasMode', 'MODE', (m, r) => (r.source === 'manual' ? 'manual' : m === 'none' ? 'dns' : `alias → ${r.aliasDomain}`)],
            ]),
          );
        },
      },
      issue: { usage: '<id> [--force]', help: 'issue (or re-issue with --force)', arg: 'cert', run: async (a) => act(post(`/acme/certs/${enc(need(a, 0, 'id'))}/issue${flag(a, 'force') ? '?force=true' : ''}`), a) },
      renew: { usage: '<id>', help: 'force renewal', arg: 'cert', run: async (a) => act(post(`/acme/certs/${enc(need(a, 0, 'id'))}/renew`), a) },
      rm: {
        usage: '<id> [--yes]',
        help: 'delete a certificate',
        arg: 'cert',
        run: async (a) => {
          const id = need(a, 0, 'id');
          if (!(await confirm(`delete certificate ${id}?`, a))) return 1;
          return act(del(`/acme/certs/${enc(id)}`), a);
        },
      },
    },
  },

  ports: {
    help: 'port usage (--conflicts, --managed)',
    run: async (a) => {
      const d = await get('/ports');
      const rows = (d.ports as any[]).filter((p) => (!flag(a, 'conflicts') || p.conflict) && (!flag(a, 'managed') || p.owners.length));
      show(a, rows, () =>
        table(rows, [
          ['port', 'PORT', (v, r) => `${v}/${r.protocol}`],
          ['listening', 'STATE', (v, r) => (r.conflict ? red('conflict') : v ? green('listening') : yellow('reserved'))],
          ['addresses', 'ADDRESS', (v) => v.join(', ') || '—'],
          ['process', 'PROCESS'],
          ['owners', 'USED BY', (o: any[]) => o.map((x) => `${x.owner} ${dim(x.detail)}`).join('; ') || '—'],
        ]),
      );
    },
  },

  net: {
    help: 'instance networks',
    sub: {
      ls: {
        help: 'dedicated networks',
        run: async (a) => {
          const d = await get('/networks');
          show(a, d.allocations, () =>
            table(d.allocations, [
              ['owner', 'INSTANCE', (o) => `${o.kind}/${o.name}`],
              ['cidr', 'CIDR'],
              ['gateway', 'GATEWAY'],
              ['address', 'ADDRESS'],
              ['bridge', 'BRIDGE', (b, r) => `${b} ${r.bridgeUp ? green('up') : red('down')}`],
              ['dhcpState', 'DHCP', stateColor],
            ]),
          );
        },
      },
      reconcile: { help: 're-create bridges, NAT and DHCP', run: async (a) => act(post('/networks/reconcile'), a) },
      nft: {
        help: 'show the nftables ruleset',
        run: async () => {
          process.stdout.write((await get('/networks/nftables')).ruleset);
        },
      },
    },
  },

  jobs: {
    help: 'list jobs, or follow one: jobs <id>',
    usage: '[id]',
    run: async (a) => {
      const list = (await get('/jobs')) as any[];
      if (a._[0]) {
        const j = list.find((x) => x.id.startsWith(a._[0]));
        if (!j) throw new ApiError(404, `no job ${a._[0]}`);
        return followJob(j, a);
      }
      show(a, list, () =>
        table(list.slice(0, 30), [
          ['id', 'ID', (v) => v.slice(0, 8)],
          ['startedAt', 'STARTED', (v) => v.slice(0, 19).replace('T', ' ')],
          ['state', 'STATE', stateColor],
          ['title', 'TITLE'],
        ]),
      );
    },
  },

  logs: {
    help: 'manager logs (-f to follow, --level, --module, --tail)',
    usage: '[-f] [--level info|warn|error] [--module name] [--tail N]',
    run: async (a) => {
      const level = str(a, 'level') ?? 'info';
      const mod = str(a, 'module');
      const levels = ['debug', 'info', 'warn', 'error'];
      const print = (e: any) =>
        json(a)
          ? console.log(JSON.stringify(e))
          : console.log(`${dim(e.ts.slice(11, 19))} ${stateColor(e.level.toUpperCase().padEnd(5))} ${cyan(`[${e.module}]`)} ${e.msg}${e.data !== undefined ? dim(` ${JSON.stringify(e.data)}`) : ''}`);
      const q = new URLSearchParams({ level, limit: String(Number(str(a, 'tail')) || 50), ...(mod ? { module: mod } : {}) });
      for (const e of await get(`/logs?${q}`)) print(e);
      if (!flag(a, 'follow')) return;
      await new Promise<void>((resolve) => {
        const stop = subscribe((ev) => {
          if (ev.type !== 'log') return;
          if (levels.indexOf(ev.entry.level) < levels.indexOf(level)) return;
          if (mod && ev.entry.module !== mod && !ev.entry.module.startsWith(`${mod}:`)) return;
          print(ev.entry);
        });
        const end = () => {
          stop();
          process.off('SIGINT', end);
          resolve();
        };
        process.on('SIGINT', end);
      });
    },
  },

  auth: {
    help: 'login recovery and passkeys',
    sub: {
      'login-link': {
        usage: '[--base https://manager.example.com]',
        help: 'one-time login link (10 min) — use when passkeys are unavailable',
        run: async (a) => {
          const r = await post('/admin/login-link');
          if (r.disabled) {
            console.log(yellow('login is disabled (VAS_AUTH_ENABLED=false) — no link needed'));
            return;
          }
          const sys = await get('/system');
          const bases = str(a, 'base')
            ? [str(a, 'base')!]
            : [
                ...(sys.public?.domains ?? []).map((d: string) => `https://${d}`),
                ...(sys.listen ?? []).map((l: any) => `http://${['0.0.0.0', '::'].includes(l.host) ? 'localhost' : l.host.includes(':') ? `[${l.host}]` : l.host}:${l.port}`),
              ];
          if (json(a)) return console.log(JSON.stringify({ ...r, urls: bases.map((b) => b.replace(/\/$/, '') + r.path) }, null, 2));
          console.log(bold(`one-time login link, valid ${r.expiresInSec / 60} minutes, works once:`));
          for (const b of bases) console.log(`  ${cyan(b.replace(/\/$/, '') + r.path)}`);
          console.log(dim('for a 127.0.0.1-only port, tunnel first: ssh -L 8080:127.0.0.1:8080 <host>, then open the localhost URL'));
        },
      },
      passkeys: {
        help: 'list registered passkeys',
        run: async (a) => {
          const list = await get('/auth-admin/passkeys');
          show(a, list, () => table(list, [['name', 'NAME'], ['id', 'ID', (v) => v.slice(0, 20) + '…'], ['createdAt', 'CREATED', (v) => v?.slice(0, 10)], ['lastUsedAt', 'LAST USED', (v) => v?.slice(0, 10) ?? '—']]));
        },
      },
      'rm-passkey': {
        usage: '<id-prefix> [--yes]',
        help: 'remove a passkey',
        run: async (a) => {
          const prefix = need(a, 0, 'passkey id');
          const pk = ((await get('/auth-admin/passkeys')) as any[]).find((p) => p.id.startsWith(prefix));
          if (!pk) throw new ApiError(404, `no passkey ${prefix}`);
          if (!(await confirm(`remove passkey "${pk.name}"?`, a))) return 1;
          return act(del(`/auth-admin/passkeys/${enc(pk.id)}`), a);
        },
      },
      'agent-token': { help: 'show the OpenResty agent token', run: async () => console.log((await get('/auth-admin/agent-token')).token) },
    },
  },

  'safe-mode': {
    help: 'safe mode status / exit',
    sub: {
      status: {
        help: 'show safe mode',
        run: async () => {
          const b = (await get('/system')).boot;
          console.log(b.safeMode ? red(`ON — ${b.safeModeReason}`) : green('off'));
        },
      },
      exit: { help: 'leave safe mode (enables autostart/watchdog)', run: async (a) => act(post('/system/safe-mode/exit'), a, 'safe mode cleared') },
    },
  },

  git: {
    help: 'configuration repository',
    sub: {
      status: {
        help: 'last commits and errors',
        run: async (a) => {
          const g = await get('/git');
          show(a, g, () => {
            kv([['enabled', g.settings.enabled], ['remote', g.settings.remote || '—'], ['last error', g.status.lastError ? red(g.status.lastError) : '—']]);
            table(g.commits.slice(0, 10), [['hash', 'HASH'], ['date', 'DATE', (v) => v.slice(0, 19)], ['message', 'MESSAGE']]);
          });
        },
      },
      commit: {
        usage: '[-m message]',
        help: 'commit now',
        run: async (a) => {
          const r = await post('/git/commit', { message: str(a, 'message') });
          show(a, r, () => console.log(r.committed ? green(`committed ${r.hash}`) : dim('nothing to commit')));
        },
      },
      push: { help: 'push now', run: async (a) => act(post('/git/push'), a, 'pushed') },
    },
  },

  backup: {
    help: 'S3 backups',
    sub: {
      run: { help: 'back up now', run: async (a) => act(post('/backup/run'), a) },
      ls: {
        help: 'backups in the bucket',
        run: async (a) => {
          const list = await get('/backup/list');
          show(a, list, () => table(list, [['key', 'KEY'], ['size', 'SIZE', (v) => `${(v / 1024).toFixed(0)} KiB`], ['lastModified', 'DATE', (v) => v?.slice(0, 19)]]));
        },
      },
    },
  },

  settings: {
    help: 'read/write settings by dotted path',
    sub: {
      get: {
        usage: '[path, e.g. openresty.httpPort]',
        help: 'show settings',
        run: async (a) => {
          const s = (await get('/settings')).settings;
          const v = a._[0] ? a._[0].split('.').reduce((o: any, k) => o?.[k], s) : s;
          console.log(typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
        },
      },
      set: {
        usage: '<path> <value (JSON or text)>',
        help: 'change one setting',
        run: async (a) => {
          const p = need(a, 0, 'path').split('.');
          const raw = need(a, 1, 'value');
          let value: unknown = raw;
          try {
            value = JSON.parse(raw);
          } catch {
            /* plain string */
          }
          const patch = p.reduceRight((acc: unknown, k) => ({ [k]: acc }), value);
          await put('/settings', patch);
          console.log(green(`${p.join('.')} = ${JSON.stringify(value)}`));
        },
      },
    },
  },

  api: {
    help: 'raw API call: api GET /system | api POST /compose/x/up | api PUT /path @body.json',
    usage: '<METHOD> <path> [json|@file]',
    run: async (a) => {
      const method = need(a, 0, 'method').toUpperCase();
      const p = need(a, 1, 'path').replace(/^\/api/, '');
      if (!/^\/?[\w\-./%?=&:+@,~]*$/.test(p)) throw new UsageError(`invalid API path "${p}"`);
      const rawBody = a._[2];
      const body = rawBody === undefined ? (method === 'GET' || method === 'DELETE' ? undefined : {}) : JSON.parse(rawBody.startsWith('@') ? readFileArg(rawBody.slice(1)) : rawBody);
      const r = await request(method, p.startsWith('/') ? p : `/${p}`, body);
      if (isJob(r) && !flag(a, 'detach')) return followJob(r, a);
      console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
    },
  },

  version: { help: 'CLI version', run: async () => console.log(`vas ${VERSION}`) },
};

// ---------------------------------------------------------------------------
// help

function printHelp(topic?: string): void {
  const c = topic ? commands[topic] : undefined;
  if (c) {
    console.log(`${bold(`vas ${topic}`)} — ${c.help}`);
    if (c.usage) console.log(`  usage: vas ${topic} ${c.usage}`);
    for (const [n, s] of Object.entries(c.sub ?? {})) console.log(`  ${cyan(`${topic} ${n}`)} ${s.usage ? dim(s.usage) : ''}\n      ${s.help}`);
    return;
  }
  console.log(`${bold('vas')} ${dim(VERSION)} — command line for the VAS server manager
${dim('usage: vas [command] [args] [--json] [--yes] [--socket path]   (no command: interactive shell)')}
`);
  for (const [n, c2] of Object.entries(commands)) {
    const subs = c2.sub ? dim(` [${Object.keys(c2.sub).join('|')}]`) : '';
    console.log(`  ${cyan(n.padEnd(10))} ${c2.help}${subs}`);
  }
  console.log(`
${dim('global flags: --json machine-readable output · --yes skip confirmations · --detach don’t follow jobs')}
${dim('exit codes: 0 ok · 1 failed · 2 manager unreachable · 64 usage error')}
${dim('help <command> for details')}`);
}

// ---------------------------------------------------------------------------
// dispatch

async function dispatch(tokens: string[]): Promise<number> {
  const a = parseArgs(tokens);
  if (typeof a.flags.socket === 'string') SOCKET = a.flags.socket;
  const [name, ...rest] = a._;
  if (!name || name === 'help' || a.flags.help) {
    printHelp(name === 'help' ? rest[0] : name);
    return 0;
  }
  const cmd = commands[name];
  if (!cmd) throw new UsageError(`unknown command "${name}" (try: help)`);
  try {
    if (cmd.sub) {
      const subName = rest[0];
      const sub = subName ? cmd.sub[subName] : undefined;
      if (!sub) {
        if (!subName && cmd.sub.ls) return (await cmd.sub.ls.run({ ...a, _: [] })) ?? 0;
        throw new UsageError(`usage: vas ${name} <${Object.keys(cmd.sub).join('|')}>`);
      }
      return (await sub.run({ ...a, _: rest.slice(1) })) ?? 0;
    }
    return (await cmd.run!({ ...a, _: rest })) ?? 0;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    if (err instanceof ManagerDown) {
      console.error(red(err.message));
      return 2;
    }
    if (err instanceof ApiError) {
      console.error(red(`error ${err.status}: ${err.message}`));
      return 1;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// interactive shell

const completionCache = new Map<string, { at: number; values: string[] }>();

async function completeValues(kind: keyof typeof completers): Promise<string[]> {
  const hit = completionCache.get(kind);
  if (hit && Date.now() - hit.at < 5000) return hit.values;
  const values = await completers[kind]().catch(() => [] as string[]);
  completionCache.set(kind, { at: Date.now(), values });
  return values;
}

function completer(line: string, cb: (err: null, result: [string[], string]) => void): void {
  const tokens = tokenize(line);
  if (/\s$/.test(line) || !line) tokens.push('');
  const cur = tokens.at(-1) ?? '';
  const done = (options: string[]) => {
    const hits = options.filter((o) => o.startsWith(cur));
    cb(null, [hits.length ? hits : options, cur]);
  };
  if (tokens.length === 1) return done([...Object.keys(commands), 'help', 'exit']);
  const cmd = commands[tokens[0]];
  if (tokens[0] === 'help' && tokens.length === 2) return done(Object.keys(commands));
  if (!cmd?.sub) return done([]);
  if (tokens.length === 2) return done(Object.keys(cmd.sub));
  const sub = cmd.sub[tokens[1]];
  if (sub?.arg && tokens.length === 3) {
    void completeValues(sub.arg).then(done);
    return;
  }
  done([]);
}

async function shell(): Promise<number> {
  try {
    const s = await get('/system');
    console.log(`${bold('vas')} ${dim(VERSION)} — ${s.hostname} · ${s.boot.safeMode ? red('SAFE MODE') : green('manager running')} · ${dim('Tab completes, "help" lists commands, Ctrl+D exits')}`);
  } catch (err) {
    if (err instanceof ManagerDown) offlineReport();
    else throw err;
  }
  const historyFile = path.join(os.homedir(), '.vas_history');
  let history: string[] = [];
  try {
    history = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).reverse().slice(0, 500);
  } catch {
    /* none yet */
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer, history, historySize: 500, prompt: `${cyan('vas')}> ` });
  shellRl = rl;
  rl.prompt();
  for await (const line of rl) {
    const tokens = tokenize(line.trim());
    if (tokens.length) {
      if (['exit', 'quit'].includes(tokens[0])) break;
      try {
        const code = await dispatch(tokens);
        if (code) console.log(dim(`(exit ${code})`));
      } catch (err) {
        console.error(red((err as Error).message));
      }
    }
    rl.prompt();
  }
  try {
    fs.writeFileSync(historyFile, [...(rl as any).history].reverse().join('\n') + '\n', { mode: 0o600 });
  } catch {
    /* read-only home */
  }
  rl.close();
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const a = parseArgs(argv);
  if (typeof a.flags.socket === 'string') SOCKET = a.flags.socket;
  let code: number;
  try {
    code = a._.length === 0 && !a.flags.help && process.stdin.isTTY ? await shell() : await dispatch(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(red(err.message));
      code = 64;
    } else {
      console.error(red((err as Error).stack ?? String(err)));
      code = 1;
    }
  }
  process.exit(code);
}

void main();
