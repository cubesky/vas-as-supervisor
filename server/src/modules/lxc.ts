import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env } from '../core/env.js';
import { run, which, type RunOptions, type RunResult } from '../core/exec.js';
import { startJob } from '../core/jobs.js';
import { createLogger } from '../core/logger.js';
import { HttpError, assertId, writeFileAtomic } from '../core/store.js';
import { clearCrashloop, defaultMeta, getMeta, instanceMeta, registerDriver, setDesired } from '../core/instances.js';
import { createSnapshot, deleteSnapshot, ensureDir, isSubvolume, listSnapshots, removeDir } from './btrfs.js';
import { allocate, apply as applyNetwork, lxcNetConfig, networks, release, validateNic, type NicSpec } from './network.js';
import { spawnPty } from './pty.js';
import { bus } from '../core/events.js';

/**
 * LXC containers managed with the classic lxc-* tools using a custom lxcpath
 * (VAS_LXC_DIR). Each container folder <lxcpath>/<name> is created as a
 * btrfs subvolume *before* lxc-create runs with the plain `dir` backing store,
 * so config + rootfs are snapshotted together.
 */

const log = createLogger('lxc');
const P = () => ['-P', env.lxcDir];

export interface LxcInfo {
  name: string;
  state: string;
  pid?: number;
  ipv4: string[];
}

// ---------------------------------------------------------------------------
// Where the lxc-* tools run. Inside the manager container they would use the
// image's LXC build and the container's cgroup/LSM environment, which differs
// from the host and makes starts fail. With `pid: host` + privileged, the
// manager instead enters PID 1's namespaces and runs the host's own LXC — the
// same as running the command in an SSH shell on the host.

// --cgroup matters: in the host mount namespace LXC sees the host's whole
// /sys/fs/cgroup, so /proc/self/cgroup must be relative to the host root too,
// otherwise it reads "/../../.." and fails with "Cross-device link".
const NSENTER = ['--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid', '--cgroup', '--'];

// Leave the manager container's cgroup for the host root cgroup before exec,
// like an SSH session. Unified (v2): root cgroup.procs; hybrid/legacy (v1):
// the top level of every hierarchy. A plain `*/cgroup.procs` glob on v2 would
// match child cgroups, hence the branch.
const ESCAPE_CGROUP =
  'if [ -f /sys/fs/cgroup/cgroup.controllers ]; then echo $$ > /sys/fs/cgroup/cgroup.procs; ' +
  'else for f in /sys/fs/cgroup/*/cgroup.procs; do echo $$ > "$f"; done; fi 2>/dev/null; exec "$@"';
let onHost: boolean | null = null;

export async function lxcOnHost(): Promise<boolean> {
  if (onHost !== null) return onHost;
  if (env.lxcExec !== 'auto') {
    onHost = env.lxcExec === 'host';
  } else {
    const inContainer = await fs.access('/run/.containerenv').then(() => true, () => fs.access('/.dockerenv').then(() => true, () => false));
    const [self, init] = await Promise.all([fs.readlink('/proc/self/ns/mnt').catch(() => ''), fs.readlink('/proc/1/ns/mnt').catch(() => '')]);
    // PID 1 visible with a different mount namespace = we share the host PID namespace
    onHost = inContainer && !!init && !!self && init !== self && (await which('nsenter'));
  }
  log.info(onHost ? 'running lxc-* on the host via nsenter' : 'running lxc-* locally');
  return onHost;
}

/** Command + args for an lxc-* tool, wrapped in nsenter when running on the host. */
export async function lxcCommand(cmd: string, args: string[]): Promise<[string, string[]]> {
  return (await lxcOnHost()) ? ['nsenter', [...NSENTER, 'sh', '-c', ESCAPE_CGROUP, 'sh', cmd, ...args]] : [cmd, args];
}

export async function lxcRun(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const [c, a] = await lxcCommand(cmd, args);
  return run(c, a, opts);
}

let available: boolean | null = null;

export async function lxcAvailable(): Promise<boolean> {
  if (available !== null) return available;
  if (await lxcOnHost()) {
    const r = await run('nsenter', [...NSENTER, 'sh', '-c', 'command -v lxc-ls'], { allowFail: true, timeoutMs: 10_000 }).catch(() => null);
    available = r?.code === 0;
  } else {
    available = await which('lxc-ls');
  }
  return available;
}

/** Parses the fixed-width `lxc-ls --fancy` table using header column offsets. */
export function parseLxcLs(out: string): LxcInfo[] {
  const lines = out.split('\n').filter((l) => l.trim());
  if (lines.length < 1) return [];
  const header = lines[0];
  const cols = ['NAME', 'STATE', 'PID', 'IPV4'].map((c) => ({ c, i: header.indexOf(c) }));
  const sorted = [...cols].filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
  const slice = (line: string, c: string) => {
    const idx = sorted.findIndex((x) => x.c === c);
    if (idx < 0) return '';
    const end = sorted[idx + 1]?.i ?? line.length;
    return line.slice(sorted[idx].i, end).trim();
  };
  return lines.slice(1).map((l) => {
    const ips = slice(l, 'IPV4');
    const pid = Number(slice(l, 'PID'));
    return {
      name: slice(l, 'NAME'),
      state: slice(l, 'STATE').toLowerCase(),
      pid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
      ipv4: ips && ips !== '-' ? ips.split(/,\s*/) : [],
    };
  });
}

export async function listLxc(): Promise<LxcInfo[]> {
  if (!(await lxcAvailable())) return [];
  await fs.mkdir(env.lxcDir, { recursive: true }).catch(() => undefined);
  const r = await lxcRun('lxc-ls', [...P(), '--fancy', '-F', 'NAME,STATE,PID,IPV4'], { allowFail: true, timeoutMs: 30_000 });
  return parseLxcLs(r.stdout);
}

const cfgPath = (name: string) => path.join(env.lxcDir, assertId(name, 'container name'), 'config');

async function rewriteConfig(name: string, fn: (lines: string[]) => string[]): Promise<void> {
  const file = cfgPath(name);
  const lines = (await fs.readFile(file, 'utf8')).split('\n');
  await writeFileAtomic(file, fn(lines).join('\n').replace(/\n*$/, '\n'));
}

async function applyNic(name: string, nic: NicSpec): Promise<void> {
  const alloc = nic.mode === 'dedicated' ? await allocate({ kind: 'lxc', name }, nic) : undefined;
  if (nic.mode !== 'dedicated') await release(`lxc-${name}`);
  await rewriteConfig(name, (lines) => [
    // "# hastur network": marker written before the rename to VAS
    ...lines.filter((l) => !/^\s*lxc\.net\./.test(l) && !l.startsWith('# vas network') && !l.startsWith('# hastur network')),
    '# vas network',
    ...lxcNetConfig(nic, alloc),
  ]);
}

async function applyLimits(name: string, memoryMiB?: number, cpus?: string): Promise<void> {
  await rewriteConfig(name, (lines) => {
    const out = lines.filter((l) => !/^\s*lxc\.cgroup2\.(memory\.max|cpuset\.cpus)\s*=/.test(l));
    if (memoryMiB) out.push(`lxc.cgroup2.memory.max = ${Math.floor(memoryMiB)}M`);
    if (cpus && /^[\d,-]+$/.test(cpus)) out.push(`lxc.cgroup2.cpuset.cpus = ${cpus}`);
    return out;
  });
}

async function lxcState(name: string): Promise<string> {
  const r = await lxcRun('lxc-info', [...P(), '-n', name, '-s', '-H'], { allowFail: true, timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim().toLowerCase() : 'missing';
}

const startLogPath = (name: string) => path.join(env.lxcDir, name, 'lxc-start.log');

/**
 * Starts a container daemonized. LXC only reports "Failed to receive the
 * container state" on stderr when the child dies; the actual reason goes to
 * --logfile, so the log is captured per start and its errors are returned.
 */
async function startLxc(name: string): Promise<void> {
  const alloc = await networks.get(`lxc-${name}`);
  if (alloc) await applyNetwork(alloc);
  const logFile = startLogPath(name);
  await fs.writeFile(logFile, '').catch(() => undefined);
  const r = await lxcRun(
    'lxc-start',
    [...P(), '-n', name, '-d', '-L', path.join(env.lxcDir, name, 'console.log'), '--logfile', logFile, '--logpriority', 'INFO'],
    { allowFail: true, timeoutMs: 120_000 },
  );
  if (r.code === 0) return;
  const lines = (await fs.readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const errors = lines.filter((l) => /\b(ERROR|CRIT|FATAL)\b/.test(l));
  const detail = (errors.length ? errors : lines).slice(-12).map((l) => l.replace(/^lxc \S+ \d+\.\d+ /, '')).join('\n');
  log.error(`lxc-start ${name} failed`, { log: detail });
  throw new HttpError(500, `lxc-start ${name} failed:\n${detail || (r.stderr || r.stdout).trim()}`);
}

// ---------------------------------------------------------------------------
// image index of the `download` template's server. It only keeps supported
// releases, so the UI offers what really exists instead of hard-coded presets.

export interface LxcImage {
  dist: string;
  release: string;
  arch: string;
  variant: string;
  build: string;
}

const INDEX_TTL_MS = 3600_000;
let indexCache: { at: number; images: LxcImage[] } | null = null;

export async function imageIndex(): Promise<LxcImage[]> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.images;
  const res = await fetch(`https://${env.lxcImageServer}/meta/1.0/index-system`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`image index on ${env.lxcImageServer}: HTTP ${res.status}`);
  const images = (await res.text())
    .split('\n')
    .map((l) => l.trim().split(';'))
    .filter((p) => p.length >= 5 && p[0])
    .map(([dist, release, arch, variant, build]) => ({ dist, release, arch, variant, build }));
  indexCache = { at: Date.now(), images };
  return images;
}

/** Maps Node's arch names to the ones used by the image server. */
export function hostArch(): string {
  const map: Record<string, string> = { x64: 'amd64', arm64: 'arm64', arm: 'armhf', ia32: 'i386', ppc64: 'ppc64el', s390x: 's390x', riscv64: 'riscv64' };
  return map[process.arch] ?? process.arch;
}

registerDriver({
  kind: 'lxc',
  async status(id) {
    const s = await lxcState(id);
    return { exists: s !== 'missing', running: s === 'running' };
  },
  start: startLxc,
});

export function routes(app: FastifyInstance): void {
  app.get('/api/lxc', async () => {
    const list = await listLxc();
    const allocs = await networks.list();
    return {
      available: await lxcAvailable(),
      baseDir: env.lxcDir,
      containers: await Promise.all(
        list.map(async (c) => ({
          ...c,
          meta: await getMeta('lxc', c.name),
          network: allocs.find((a) => a.id === `lxc-${c.name}`),
        })),
      ),
    };
  });

  app.get('/api/lxc/images', async (req) => {
    if ((req.query as any).refresh === '1') indexCache = null;
    return { server: env.lxcImageServer, hostArch: hostArch(), images: await imageIndex() };
  });

  app.post('/api/lxc', async (req) => {
    const body = req.body as {
      name: string;
      dist: string;
      release: string;
      arch?: string;
      variant?: string;
      nic?: NicSpec;
      memoryMiB?: number;
      cpus?: string;
      autostart?: boolean;
      restartPolicy?: 'no' | 'on-failure' | 'always';
    };
    const name = assertId(body.name, 'container name');
    const re = /^[\w.-]+$/;
    if (![body.dist, body.release, body.arch ?? hostArch()].every((v) => re.test(v ?? ''))) {
      throw new HttpError(400, 'invalid template parameters');
    }
    const nic = validateNic(body.nic ?? { mode: 'dedicated' });
    if (!(await lxcAvailable())) throw new HttpError(503, 'LXC tools are not installed');
    // a folder without a config is a leftover of a failed create and may be reused
    if (await fs.access(cfgPath(name)).then(() => true, () => false)) throw new HttpError(409, `container ${name} already exists`);

    // fail fast with the releases that do exist (skipped when the index can't be fetched)
    const arch = body.arch ?? hostArch();
    const images = await imageIndex().catch(() => null);
    if (images && !images.some((i) => i.dist === body.dist && i.release === body.release && i.arch === arch && (!body.variant || i.variant === body.variant))) {
      const releases = [...new Set(images.filter((i) => i.dist === body.dist && i.arch === arch).map((i) => i.release))];
      throw new HttpError(
        400,
        releases.length
          ? `${body.dist} ${body.release}${body.variant ? ` (${body.variant})` : ''} for ${arch} is not on ${env.lxcImageServer}; available releases: ${releases.join(', ')}`
          : `${body.dist} is not available for ${arch} on ${env.lxcImageServer}`,
      );
    }

    return startJob(`lxc create ${name}`, 'lxc', async (job) => {
      const dir = await ensureDir(path.join(env.lxcDir, name));
      job.log(`container dir ${dir.path}${dir.subvolume ? ' (btrfs subvolume)' : ''}`);
      const tplArgs = ['--server', env.lxcImageServer, '--dist', body.dist, '--release', body.release, '--arch', arch];
      if (body.variant && re.test(body.variant)) tplArgs.push('--variant', body.variant);
      try {
        await lxcRun('lxc-create', [...P(), '-n', name, '-B', 'dir', '-t', 'download', '--', ...tplArgs], {
          onLine: job.log,
          timeoutMs: 60 * 60_000,
        });
        await applyNic(name, nic);
        await applyLimits(name, body.memoryMiB, body.cpus);
        await instanceMeta.lxc.put(
          defaultMeta('lxc', name, {
            nic,
            autostart: !!body.autostart,
            restartPolicy: body.restartPolicy ?? 'no',
          }),
        );
      } catch (err) {
        // don't leave a half-created folder, network or config behind
        job.log('creation failed, cleaning up');
        await lxcRun('lxc-destroy', [...P(), '-n', name], { allowFail: true });
        await removeDir(dir.path).catch((e) => job.log(`could not remove ${dir.path}: ${(e as Error).message}`));
        await release(`lxc-${name}`).catch(() => undefined);
        throw err;
      }
      job.log('created');
    });
  });

  app.post('/api/lxc/:name/:action', async (req) => {
    const { name, action } = req.params as { name: string; action: string };
    assertId(name);
    switch (action) {
      case 'start':
        await setDesired('lxc', name, 'running');
        clearCrashloop('lxc', name);
        await startLxc(name);
        break;
      case 'stop':
        await setDesired('lxc', name, 'stopped');
        await lxcRun('lxc-stop', [...P(), '-n', name, '-t', '30'], { timeoutMs: 60_000 });
        break;
      case 'kill':
        await setDesired('lxc', name, 'stopped');
        await lxcRun('lxc-stop', [...P(), '-n', name, '-k'], { timeoutMs: 30_000 });
        break;
      case 'restart':
        await lxcRun('lxc-stop', [...P(), '-n', name, '-r', '-t', '30'], { timeoutMs: 60_000 });
        break;
      case 'freeze':
        await lxcRun('lxc-freeze', [...P(), '-n', name]);
        break;
      case 'unfreeze':
        await lxcRun('lxc-unfreeze', [...P(), '-n', name]);
        break;
      case 'snapshot':
        return createSnapshot('lxc', name, path.join(env.lxcDir, name));
      default:
        throw new HttpError(400, 'unknown action');
    }
    bus.changed('lxc', name);
    return { ok: true };
  });

  app.get('/api/lxc/:name', async (req) => {
    const { name } = req.params as { name: string };
    const info = await lxcRun('lxc-info', [...P(), '-n', assertId(name)], { allowFail: true });
    return {
      name,
      info: info.stdout,
      config: await fs.readFile(cfgPath(name), 'utf8').catch(() => ''),
      meta: await getMeta('lxc', name),
      network: await networks.get(`lxc-${name}`),
      snapshots: await listSnapshots('lxc', name),
      subvolume: await isSubvolume(path.join(env.lxcDir, name)),
      consoleLog: await fs.readFile(path.join(env.lxcDir, name, 'console.log'), 'utf8').then((s) => s.slice(-20000)).catch(() => ''),
      startLog: await fs.readFile(startLogPath(name), 'utf8').then((s) => s.slice(-20000)).catch(() => ''),
    };
  });

  app.put('/api/lxc/:name/config', async (req) => {
    const { name } = req.params as { name: string };
    const { config } = req.body as { config: string };
    if (typeof config !== 'string' || !config.includes('lxc.')) throw new HttpError(400, 'config looks invalid');
    await writeFileAtomic(cfgPath(name), config);
    return { ok: true };
  });

  app.put('/api/lxc/:name/settings', async (req) => {
    const { name } = req.params as { name: string };
    const body = req.body as any;
    const cur = await getMeta('lxc', assertId(name));
    const nic = body.nic ? validateNic(body.nic) : cur.nic;
    if (body.nic) await applyNic(name, nic!);
    if (body.memoryMiB !== undefined || body.cpus !== undefined) await applyLimits(name, body.memoryMiB, body.cpus);
    await instanceMeta.lxc.put({
      ...cur,
      nic,
      autostart: body.autostart ?? cur.autostart,
      autostartDelaySec: body.autostartDelaySec ?? cur.autostartDelaySec,
      restartPolicy: body.restartPolicy ?? cur.restartPolicy,
    });
    return { ok: true };
  });

  app.delete('/api/lxc/:name/snapshots/:snap', async (req) => {
    const { name, snap } = req.params as { name: string; snap: string };
    await deleteSnapshot('lxc', assertId(name), snap);
    return { ok: true };
  });

  app.delete('/api/lxc/:name', async (req) => {
    const { name } = req.params as { name: string };
    assertId(name);
    return startJob(`lxc destroy ${name}`, 'lxc', async (job) => {
      await lxcRun('lxc-stop', [...P(), '-n', name, '-k'], { allowFail: true });
      const r = await lxcRun('lxc-destroy', [...P(), '-n', name], { allowFail: true, onLine: job.log });
      if (r.code !== 0) job.log('lxc-destroy reported an error, removing folder directly');
      await removeDir(path.join(env.lxcDir, name));
      await release(`lxc-${name}`);
      await instanceMeta.lxc.remove(name);
      job.log('destroyed');
    });
  });

  // Web terminal: lxc-attach shell (default) or the container console
  app.get('/api/lxc/:name/terminal', { websocket: true }, (socket, req) => {
    const { name } = req.params as { name: string };
    const mode = (req.query as any).mode === 'console' ? 'console' : 'attach';
    try {
      assertId(name);
    } catch {
      socket.close(1008, 'bad name');
      return;
    }
    const args =
      mode === 'console'
        ? ['lxc-console', ...P(), '-n', name, '-t', '0', '-e', '^b']
        : ['lxc-attach', ...P(), '-n', name, '--', '/bin/sh', '-c', 'if [ -x /bin/bash ]; then exec /bin/bash -l; else exec /bin/sh -l; fi'];
    // the pty is created asynchronously (host/local detection); queue input until then
    let pty: ReturnType<typeof spawnPty> | null = null;
    let closed = false;
    const queue: Buffer[] = [];
    const handle = (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'i') pty!.write(msg.d);
        else if (msg.t === 'r') pty!.resize(msg.c, msg.r);
      } catch {
        /* ignore malformed */
      }
    };
    socket.on('message', (raw: Buffer) => (pty ? handle(raw) : queue.push(raw)));
    socket.on('close', () => {
      closed = true;
      pty?.kill();
    });
    void lxcCommand(args[0], args.slice(1)).then(([cmd, cmdArgs]) => {
      if (closed) return;
      pty = spawnPty(cmd, cmdArgs);
      log.info(`terminal (${mode}) opened for ${name}`);
      pty.onData((d) => socket.readyState === 1 && socket.send(d));
      pty.onExit(() => socket.close());
      for (const raw of queue.splice(0)) handle(raw);
    });
  });
}
