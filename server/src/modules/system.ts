import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env } from '../core/env.js';
import { clearWhichCache, run, which } from '../core/exec.js';
import { bus, type VASEvent } from '../core/events.js';
import { getJob, listJobs } from '../core/jobs.js';
import { recentLogs } from '../core/logger.js';
import { bootStatus, exitSafeMode, listCrashReports, readCrashReport } from '../core/boot.js';
import { supervisor } from '../core/supervisor.js';
import { startWatchdog, watchdogStatus } from '../core/instances.js';
import { HttpError, getSecrets, getSettings, maskSecrets, updateSecrets, updateSettings, type Settings } from '../core/store.js';
import { parseCidr } from './network.js';
import { storageInfo } from './btrfs.js';
import { acmeAvailable } from './acme.js';
import { lxcAvailable, lxcOnHost, lxcRun } from './lxc.js';

const BINARIES = ['podman', 'podman-compose', 'lxc-ls', 'virsh', 'qemu-img', 'btrfs', 'ip', 'nft', 'dnsmasq', 'ss', 'git', 'findmnt'];

async function capabilities() {
  const bins: Record<string, boolean> = {};
  await Promise.all(BINARIES.map(async (b) => (bins[b] = await which(b))));
  bins.podman = await which(env.podman.bin);
  bins['podman-compose'] = await which(env.podman.composeBin);
  // LXC may run on the host through nsenter, so ask the LXC module
  bins['lxc-ls'] = await lxcAvailable();
  return { bins, acme: await acmeAvailable(), lxcOnHost: await lxcOnHost() };
}

async function lxcVersion(): Promise<string | undefined> {
  if (!(await lxcAvailable())) return undefined;
  const r = await lxcRun('lxc-ls', ['--version'], { allowFail: true, timeoutMs: 5000 }).catch(() => null);
  const v = r?.stdout.split('\n')[0].trim();
  return v ? `${v}${(await lxcOnHost()) ? ' (host)' : ''}` : undefined;
}

async function version(cmd: string, args: string[]): Promise<string | undefined> {
  if (!(await which(cmd))) return undefined;
  const r = await run(cmd, args, { allowFail: true, timeoutMs: 5000 }).catch(() => null);
  return r?.stdout.split('\n')[0].trim() || undefined;
}

export function routes(app: FastifyInstance): void {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/system', async () => {
    const [podman, lxc, libvirt] = await Promise.all([
      version(env.podman.bin, ['--version']),
      lxcVersion(),
      version('virsh', ['--version']),
    ]);
    return {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      uptime: os.uptime(),
      load: os.loadavg(),
      memory: { total: os.totalmem(), free: os.freemem() },
      cpus: os.cpus().length,
      node: process.version,
      versions: { podman, lxc, libvirt },
      paths: {
        data: env.dataDir,
        compose: env.composeDir,
        lxc: env.lxcDir,
        vm: env.vmDir,
        iso: env.isoDir,
        config: env.configDir,
        state: env.stateDir,
        logs: env.logDir,
      },
      auth: env.auth.enabled,
      listen: env.listen,
      managerUrl: env.managerUrl,
      public: { domains: env.public.domains, tls: env.public.tls, autoCertificate: !!env.public.dnsProvider },
      boot: bootStatus(),
      capabilities: await capabilities(),
    };
  });

  app.post('/api/system/capabilities/refresh', async () => {
    clearWhichCache();
    return capabilities();
  });

  app.get('/api/system/storage', async () => storageInfo());

  app.get('/api/system/processes', async () => ({ processes: supervisor.list(), watchdog: watchdogStatus() }));

  app.post('/api/system/safe-mode/exit', async () => {
    exitSafeMode();
    await startWatchdog();
    return { ok: true };
  });

  app.get('/api/logs', async (req) => {
    const q = req.query as { level?: any; module?: string; limit?: string; q?: string };
    return recentLogs({ level: q.level, module: q.module, q: q.q, limit: Math.min(3000, Number(q.limit) || 500) });
  });

  app.get('/api/logs/file', async (req) => {
    const lines = Math.min(10000, Number((req.query as any).lines) || 1000);
    const text = await fs.readFile(path.join(env.logDir, 'vas.log'), 'utf8').catch(() => '');
    return { lines: text.split('\n').filter(Boolean).slice(-lines) };
  });

  app.get('/api/crashes', async () => listCrashReports());
  app.get('/api/crashes/:name', async (req) => {
    const r = readCrashReport((req.params as any).name);
    if (!r) throw new HttpError(404, 'not found');
    return r;
  });

  app.get('/api/jobs', async () => listJobs());
  app.get('/api/jobs/:id', async (req) => {
    const j = getJob((req.params as any).id);
    if (!j) throw new HttpError(404, 'job not found');
    return j;
  });

  app.get('/api/settings', async () => ({ settings: await getSettings(), secrets: maskSecrets(await getSecrets()) }));

  app.put('/api/settings', async (req) => {
    const b = req.body as Partial<Settings>;
    if (b.network?.pool) parseCidr(b.network.pool);
    if (b.network?.defaultPrefix !== undefined && (b.network.defaultPrefix < 16 || b.network.defaultPrefix > 30)) {
      throw new HttpError(400, 'default prefix must be /16../30');
    }
    if (b.general?.language && !['en', 'ja', 'ko', 'zh-TW', 'zh-CN'].includes(b.general.language)) {
      throw new HttpError(400, 'unsupported language');
    }
    if (b.git?.remote && !/^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/.test(b.git.remote)) throw new HttpError(400, 'invalid git remote');
    const s = await updateSettings(b);
    if (b.watchdog) await startWatchdog();
    return s;
  });

  app.put('/api/settings/secrets', async (req) => {
    const b = req.body as Record<string, string | undefined>;
    const allowed = ['gitToken', 's3AccessKeyId', 's3SecretAccessKey'];
    await updateSecrets(Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k))));
    return maskSecrets(await getSecrets());
  });

  // Server-sent events: logs, jobs, change notifications
  app.get('/api/events', (req, reply) => {
    const debug = (req.query as any).debug === '1';
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const onEvent = (ev: VASEvent) => {
      if (ev.type === 'log' && ev.entry.level === 'debug' && !debug) return;
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    bus.on('event', onEvent);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('event', onEvent);
    });
  });
}
