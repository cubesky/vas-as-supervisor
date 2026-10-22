import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import YAML from 'yaml';
import { env } from '../core/env.js';
import { isAdminRequest } from '../core/admin.js';
import { run, which } from '../core/exec.js';
import { startJob } from '../core/jobs.js';
import { HttpError, assertId, writeFileAtomic } from '../core/store.js';
import { defaultMeta, getMeta, instanceMeta, registerDriver, setDesired, clearCrashloop } from '../core/instances.js';
import { createSnapshot, deleteSnapshot, ensureDir, isSubvolume, listSnapshots, removeDir } from './btrfs.js';
import { listContainers } from './podman.js';
import { bus } from '../core/events.js';

/**
 * Podman Compose projects. Every project lives in VAS_COMPOSE_DIR/<name>
 * (a btrfs subvolume when possible) containing compose.yaml and optional .env.
 * Relative bind mounts inside compose.yaml therefore stay within that folder.
 */

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml', 'podman-compose.yaml'];

export function projectDir(name: string): string {
  return path.join(env.composeDir, assertId(name, 'project name'));
}

export async function findComposeFile(name: string): Promise<string | null> {
  for (const f of COMPOSE_FILES) {
    const p = path.join(projectDir(name), f);
    try {
      await fs.access(p);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export async function listProjectNames(): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(env.composeDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(e)) continue;
    if (await findComposeFile(e)) out.push(e);
  }
  return out.sort();
}

/** Ports declared in a compose file (host side), used for the port map even when stopped. */
export async function declaredPorts(name: string): Promise<{ port: number; protocol: string; service: string }[]> {
  const file = await findComposeFile(name);
  if (!file) return [];
  try {
    const doc = YAML.parse(await fs.readFile(file, 'utf8')) ?? {};
    const out: { port: number; protocol: string; service: string }[] = [];
    for (const [svc, def] of Object.entries<any>(doc.services ?? {})) {
      for (const p of def?.ports ?? []) {
        if (typeof p === 'object') {
          if (p.published) out.push({ port: Number(p.published), protocol: p.protocol ?? 'tcp', service: svc });
          continue;
        }
        // "8080:80", "127.0.0.1:8080:80/udp", "8000-8002:8000-8002"
        const [spec, proto = 'tcp'] = String(p).split('/');
        const parts = spec.split(':');
        if (parts.length < 2) continue;
        const host = parts[parts.length - 2];
        const [a, b] = host.split('-').map(Number);
        for (let x = a; x <= (b || a); x++) if (Number.isFinite(x)) out.push({ port: x, protocol: proto, service: svc });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function composeArgs(file: string, name: string, ...rest: string[]): string[] {
  return ['-p', name, '-f', file, ...rest];
}

async function compose(name: string, args: string[], onLine?: (l: string) => void) {
  const file = await findComposeFile(name);
  if (!file) throw new HttpError(404, `project ${name} has no compose file`);
  if (!(await which(env.podman.composeBin))) throw new HttpError(503, 'podman-compose is not installed');
  return run(env.podman.composeBin, composeArgs(file, name, ...args), {
    cwd: projectDir(name),
    onLine,
    timeoutMs: 60 * 60_000,
  });
}

async function projectStatus(name: string, containers?: Awaited<ReturnType<typeof listContainers>>) {
  const all = containers ?? (await listContainers());
  const mine = all.filter((c) => c.composeProject === name);
  const running = mine.filter((c) => c.state === 'running').length;
  return {
    total: mine.length,
    running,
    state: mine.length === 0 ? 'down' : running === mine.length ? 'running' : running === 0 ? 'stopped' : 'partial',
    containers: mine,
    /** contains one of VAS's own containers: read-only in the UI */
    system: mine.some((c) => c.system),
  };
}

async function assertNotSystemProject(name: string, req: FastifyRequest): Promise<void> {
  if (!(await projectStatus(name)).system) return;
  if (isAdminRequest(req) && (req.query as any)?.force === 'true') return;
  throw new HttpError(403, `compose project ${name} runs VAS itself and can't be managed from the UI`);
}

registerDriver({
  kind: 'compose',
  async status(id) {
    const file = await findComposeFile(id);
    const s = await projectStatus(id);
    return { exists: !!file, running: s.state === 'running', failed: s.containers.some((c) => /exited \([1-9]/i.test(c.status)) };
  },
  async start(id) {
    await compose(id, ['up', '-d']);
  },
});

const ACTIONS: Record<string, string[]> = {
  up: ['up', '-d'],
  down: ['down'],
  start: ['start'],
  stop: ['stop'],
  restart: ['restart'],
  pull: ['pull'],
  build: ['build'],
};

export function routes(app: FastifyInstance): void {
  app.get('/api/compose', async () => {
    const containers = await listContainers();
    const names = await listProjectNames();
    return {
      available: await which(env.podman.composeBin),
      baseDir: env.composeDir,
      projects: await Promise.all(
        names.map(async (name) => {
          const s = await projectStatus(name, containers);
          return { name, dir: projectDir(name), meta: await getMeta('compose', name), ...s };
        }),
      ),
    };
  });

  app.get('/api/compose/:name', async (req) => {
    const { name } = req.params as { name: string };
    const file = await findComposeFile(name);
    if (!file) throw new HttpError(404, `compose project ${name} is not managed by VAS (no compose file in ${projectDir(name)})`);
    const envFile = path.join(projectDir(name), '.env');
    return {
      name,
      dir: projectDir(name),
      file: path.basename(file),
      compose: await fs.readFile(file, 'utf8'),
      env: await fs.readFile(envFile, 'utf8').catch(() => ''),
      meta: await getMeta('compose', name),
      status: await projectStatus(name),
      snapshots: await listSnapshots('compose', name),
      subvolume: await isSubvolume(projectDir(name)),
    };
  });

  app.post('/api/compose', async (req) => {
    const body = req.body as { name: string; compose: string; env?: string };
    const name = assertId(body.name, 'project name');
    if (await findComposeFile(name)) throw new HttpError(409, 'project already exists');
    validateYaml(body.compose);
    const dir = await ensureDir(projectDir(name));
    await writeFileAtomic(path.join(dir.path, 'compose.yaml'), body.compose);
    if (body.env) await writeFileAtomic(path.join(dir.path, '.env'), body.env, 0o600);
    await instanceMeta.compose.put(defaultMeta('compose', name));
    bus.publish({ type: 'ports' });
    return { ok: true, dir: dir.path, subvolume: dir.subvolume };
  });

  app.put('/api/compose/:name', async (req) => {
    const { name } = req.params as { name: string };
    const body = req.body as { compose?: string; env?: string };
    await assertNotSystemProject(assertId(name), req);
    const file = (await findComposeFile(name)) ?? path.join(projectDir(name), 'compose.yaml');
    if (body.compose !== undefined) {
      validateYaml(body.compose);
      await writeFileAtomic(file, body.compose);
    }
    if (body.env !== undefined) await writeFileAtomic(path.join(projectDir(name), '.env'), body.env, 0o600);
    bus.changed('compose', name);
    bus.publish({ type: 'ports' });
    return { ok: true };
  });

  app.put('/api/compose/:name/meta', async (req) => {
    const { name } = req.params as { name: string };
    const body = req.body as any;
    const cur = await getMeta('compose', name);
    await instanceMeta.compose.put({
      ...cur,
      autostart: !!body.autostart,
      autostartDelaySec: Math.max(0, Number(body.autostartDelaySec) || 0),
      restartPolicy: ['no', 'on-failure', 'always'].includes(body.restartPolicy) ? body.restartPolicy : 'no',
      notes: typeof body.notes === 'string' ? body.notes : cur.notes,
    });
    return { ok: true };
  });

  app.post('/api/compose/:name/:action', async (req) => {
    const { name, action } = req.params as { name: string; action: string };
    assertId(name);
    if (action === 'snapshot') return createSnapshot('compose', name, projectDir(name));
    const args = ACTIONS[action];
    if (args) await assertNotSystemProject(name, req);
    if (!args) throw new HttpError(400, 'unknown action');
    if (['up', 'start', 'restart'].includes(action)) {
      await setDesired('compose', name, 'running');
      clearCrashloop('compose', name);
    }
    if (['down', 'stop'].includes(action)) await setDesired('compose', name, 'stopped');
    return startJob(`compose ${action} ${name}`, 'compose', async (job) => {
      await compose(name, args, job.log);
      bus.publish({ type: 'ports' });
    });
  });

  app.delete('/api/compose/:name/snapshots/:snap', async (req) => {
    const { name, snap } = req.params as { name: string; snap: string };
    await deleteSnapshot('compose', assertId(name), snap);
    return { ok: true };
  });

  app.get('/api/compose/:name/logs', async (req) => {
    const { name } = req.params as { name: string };
    const tail = Math.min(5000, Number((req.query as any).tail) || 300);
    const r = await compose(name, ['logs', '-t', `--tail=${tail}`]).catch((e) => ({ stdout: '', stderr: e.message }));
    return { logs: r.stdout + r.stderr };
  });

  app.delete('/api/compose/:name', async (req) => {
    const { name } = req.params as { name: string };
    const { deleteData } = (req.query ?? {}) as { deleteData?: string };
    assertId(name);
    await assertNotSystemProject(name, req);
    return startJob(`compose remove ${name}`, 'compose', async (job) => {
      if (await findComposeFile(name)) await compose(name, ['down'], job.log).catch((e) => job.log(e.message));
      await instanceMeta.compose.remove(name);
      if (deleteData === 'true') {
        await removeDir(projectDir(name));
        job.log(`deleted ${projectDir(name)}`);
      }
      bus.publish({ type: 'ports' });
    });
  });
}

function validateYaml(text: string): void {
  try {
    const doc = YAML.parse(text);
    if (!doc || typeof doc !== 'object' || !doc.services) throw new Error('missing "services"');
  } catch (err) {
    throw new HttpError(400, `invalid compose file: ${(err as Error).message}`);
  }
}
