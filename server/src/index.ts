import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { env, startupNotes } from './core/env.js';
import { createLogger, flushLogs } from './core/logger.js';
import { initBoot, installCrashHandlers, isSafeMode, markCleanShutdown } from './core/boot.js';
import { HttpError } from './core/store.js';
import { ExecError } from './core/exec.js';
import { supervisor } from './core/supervisor.js';
import { runAutostart, startWatchdog, stopWatchdog } from './core/instances.js';
import * as auth from './modules/auth.js';
import * as system from './modules/system.js';
import * as podman from './modules/podman.js';
import * as compose from './modules/compose.js';
import * as lxc from './modules/lxc.js';
import * as vm from './modules/vm.js';
import * as network from './modules/network.js';
import * as openresty from './modules/openresty.js';
import * as acme from './modules/acme.js';
import * as ports from './modules/ports.js';
import * as git from './modules/git.js';
import * as backup from './modules/backup.js';
import * as waf from './modules/waf.js';
import { ensureDir } from './modules/btrfs.js';
import { listenAdminSocket, listenExtra } from './core/admin.js';

const log = createLogger('main');

async function main(): Promise<void> {
  for (const d of [env.configDir, env.stateDir, env.logDir]) fs.mkdirSync(d, { recursive: true });
  initBoot();
  for (const n of startupNotes) log[n.level](n.msg);

  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 16 * 1024 * 1024 });

  installCrashHandlers(async () => {
    supervisor.stopAll();
    await app.close().catch(() => undefined);
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });
  app.addHook('onRequest', auth.authHook);

  app.setErrorHandler((err: any, req, reply) => {
    const status = err instanceof HttpError ? err.status : err instanceof ExecError ? 500 : err.statusCode ?? 500;
    if (status >= 500) log.error(`${req.method} ${req.url} failed`, { error: err.message });
    reply.code(status).send({ error: err.message });
  });

  for (const m of [auth, system, podman, compose, lxc, vm, network, openresty, acme, ports, git, backup, waf]) m.routes(app);

  // Web UI (SPA)
  if (fs.existsSync(env.webDir)) {
    await app.register(fastifyStatic, { root: env.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  } else {
    log.warn(`web UI not found at ${env.webDir} (run \`npm run build -w web\`)`);
  }

  await auth.initAuth();
  git.initGit();
  await waf.initWaf();

  // base folders become subvolumes too (when on btrfs), so they can be snapshotted as a whole
  for (const d of [env.composeDir, env.lxcDir, env.vmDir]) {
    await ensureDir(d).catch((err) => log.warn(`cannot prepare ${d}: ${err.message}`));
  }
  fs.mkdirSync(path.join(env.acme.home, 'vas-certs'), { recursive: true });

  // direct listeners (VAS_LISTEN) stay usable when OpenResty is broken
  const [primary, ...more] = env.listen;
  await app.listen({ host: primary.host, port: primary.port });
  const extraServers: (http.Server | null)[] = [];
  for (const addr of more) extraServers.push(await listenExtra(app, addr));
  const urls = env.listen.map((a) => `http://${a.host.includes(':') ? `[${a.host}]` : a.host}:${a.port}`).join(', ');
  log.info(`VAS listening on ${urls} (data: ${env.dataDir}, auth: ${env.auth.enabled ? 'passkey' : 'disabled'})`);
  if (env.public.domains.length) log.info(`public UI: ${env.public.domains.join(', ')} via OpenResty → ${env.managerUrl}`);
  extraServers.push(await listenAdminSocket(app).catch((err) => {
    log.error(`admin socket unavailable: ${err.message}`);
    return null;
  }));

  // background services (failures here must never take the API down)
  await network.reconcileAll().catch((err) => log.error('network reconcile failed', err));
  acme.startCertWatcher();
  void acme.ensurePublicCertificate().catch((err) => log.error('public certificate setup failed', err));
  openresty.startUpstreamWatcher();
  backup.startBackupScheduler();
  await startWatchdog();
  if (!isSafeMode()) void runAutostart().catch((err) => log.error('autostart failed', err));

  const shutdown = async (sig: string) => {
    log.info(`received ${sig}, shutting down`);
    stopWatchdog();
    supervisor.stopAll();
    for (const s of extraServers) s?.close();
    await app.close().catch(() => undefined);
    markCleanShutdown();
    await flushLogs();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (err) => {
  log.error('startup failed', err);
  await flushLogs();
  process.exit(1);
});
