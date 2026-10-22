import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../core/env.js';
import { isAdminRequest } from '../core/admin.js';
import { run, which } from '../core/exec.js';
import { startJob } from '../core/jobs.js';
import { HttpError, assertId } from '../core/store.js';
import { ensureDir } from './btrfs.js';
import { bus } from '../core/events.js';

export interface PodmanPort {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: string;
}

export interface PodmanContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: PodmanPort[];
  labels: Record<string, string>;
  createdAt: string;
  composeProject?: string;
  composeService?: string;
  /** folder the compose project was started from (podman-compose label) */
  composeWorkingDir?: string;
  /** VAS's own container (manager, its compose project, OpenResty, acme.sh): read-only in the UI */
  system: boolean;
}

export const podmanBin = () => env.podman.bin;

// podman writes /run/.containerenv into every container; rootful podman includes our id and name
let self: { id?: string; name?: string } | null = null;
async function selfContainer(): Promise<{ id?: string; name?: string }> {
  if (!self) {
    const txt = await fs.readFile('/run/.containerenv', 'utf8').catch(() => '');
    self = { id: txt.match(/^id="([0-9a-f]+)"/m)?.[1], name: txt.match(/^name="([^"]+)"/m)?.[1] };
  }
  return self;
}

function markSystem(list: PodmanContainer[], me: { id?: string; name?: string }): void {
  const names = new Set(env.systemContainers);
  if (me.name) names.add(me.name);
  const mine = list.find((c) => (me.id && c.id.startsWith(me.id)) || (me.name && c.name === me.name));
  const project = mine?.composeProject;
  for (const c of list) {
    c.system =
      names.has(c.name) ||
      c.labels['io.vas.system'] === 'true' ||
      c.labels['io.hastur.system'] === 'true' || // label used before the rename to VAS
      (!!mine && c.id === mine.id) ||
      (!!project && c.composeProject === project);
  }
}

/** Refuses to act on VAS's own containers; the CLI (admin socket) may pass ?force=true. */
export async function assertNotSystem(ref: string, req: FastifyRequest): Promise<void> {
  const c = (await listContainers()).find((x) => x.id.startsWith(ref) || x.name === ref);
  if (!c?.system) return;
  if (isAdminRequest(req) && (req.query as any)?.force === 'true') return;
  throw new HttpError(403, `${c.name} is a VAS system container and can't be managed from the UI (on the host: vas container <action> ${c.name} --force)`);
}

export async function podmanAvailable(): Promise<boolean> {
  return which(podmanBin());
}

export async function listContainers(): Promise<PodmanContainer[]> {
  if (!(await podmanAvailable())) return [];
  const r = await run(podmanBin(), ['ps', '-a', '--format', 'json'], { timeoutMs: 30_000 });
  const raw = JSON.parse(r.stdout || '[]') as any[];
  const list = raw.map((c): PodmanContainer => {
    const labels: Record<string, string> = c.Labels ?? {};
    const ports: PodmanPort[] = [];
    for (const p of c.Ports ?? []) {
      const range = Math.max(1, p.range ?? 1);
      for (let i = 0; i < range; i++) {
        ports.push({
          hostIp: p.host_ip || '0.0.0.0',
          hostPort: p.host_port + i,
          containerPort: p.container_port + i,
          protocol: p.protocol || 'tcp',
        });
      }
    }
    return {
      id: c.Id,
      name: (c.Names ?? [])[0] ?? c.Id.slice(0, 12),
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports,
      labels,
      createdAt: c.CreatedAt ?? c.Created,
      composeProject: labels['io.podman.compose.project'] ?? labels['com.docker.compose.project'],
      composeService: labels['io.podman.compose.service'] ?? labels['com.docker.compose.service'],
      composeWorkingDir: labels['com.docker.compose.project.working_dir'] ?? labels['io.podman.compose.project.working_dir'],
      system: false,
    };
  });
  markSystem(list, await selfContainer());
  return list;
}

const ACTIONS = ['start', 'stop', 'restart', 'kill', 'pause', 'unpause', 'rm'] as const;
const REF_RE = /^[\w][\w.-]{0,127}$/;

function assertRef(ref: string): string {
  if (!REF_RE.test(ref)) throw new HttpError(400, 'invalid container reference');
  return ref;
}

interface RunSpec {
  name: string;
  image: string;
  ports?: { host: number; container: number; protocol?: 'tcp' | 'udp'; hostIp?: string }[];
  env?: Record<string, string>;
  volumes?: { host: string; container: string; ro?: boolean }[];
  restart?: 'no' | 'always' | 'on-failure' | 'unless-stopped';
  network?: string;
  command?: string[];
}

/** Builds `podman run` args. Relative host volume paths live inside the container's own data dir (a subvolume). */
export function runArgs(spec: RunSpec, dataDir: string): string[] {
  const args = ['run', '-d', '--name', spec.name, '--label', 'io.vas.managed=true'];
  if (spec.restart && spec.restart !== 'no') args.push('--restart', spec.restart);
  if (spec.network) args.push('--network', spec.network);
  for (const p of spec.ports ?? []) {
    const ip = p.hostIp ? `${p.hostIp}:` : '';
    args.push('-p', `${ip}${Number(p.host)}:${Number(p.container)}/${p.protocol ?? 'tcp'}`);
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new HttpError(400, `invalid env name ${k}`);
    args.push('-e', `${k}=${v}`);
  }
  for (const v of spec.volumes ?? []) {
    const host = path.isAbsolute(v.host) ? v.host : path.resolve(dataDir, v.host);
    if (!path.isAbsolute(v.host) && !host.startsWith(dataDir + path.sep)) throw new HttpError(400, `volume ${v.host} escapes ${dataDir}`);
    args.push('-v', `${host}:${v.container}${v.ro ? ':ro' : ''}`);
  }
  args.push(spec.image, ...(spec.command ?? []));
  return args;
}

export function routes(app: FastifyInstance): void {
  app.get('/api/podman/containers', async () => {
    // compose.ts imports this module, so load it lazily
    const { listProjectNames } = await import('./compose.js');
    const managed = new Set(await listProjectNames());
    return {
      available: await podmanAvailable(),
      // composeManaged: the project lives in VAS_COMPOSE_DIR and has a page; others (VAS's own
      // stack in deploy/, projects started by hand elsewhere) are only shown
      containers: (await listContainers()).map((c) => ({ ...c, composeManaged: !!c.composeProject && managed.has(c.composeProject) })),
    };
  });

  app.post('/api/podman/containers/:ref/:action', async (req) => {
    const { ref, action } = req.params as { ref: string; action: string };
    if (!(ACTIONS as readonly string[]).includes(action)) throw new HttpError(400, 'unknown action');
    await assertNotSystem(assertRef(ref), req);
    const args = action === 'rm' ? ['rm', '-f', assertRef(ref)] : [action, assertRef(ref)];
    await run(podmanBin(), args, { timeoutMs: 120_000 });
    bus.changed('podman');
    bus.publish({ type: 'ports' });
    return { ok: true };
  });

  app.get('/api/podman/containers/:ref/logs', async (req) => {
    const { ref } = req.params as { ref: string };
    const tail = Math.min(5000, Number((req.query as any).tail) || 300);
    const r = await run(podmanBin(), ['logs', '--timestamps', '--tail', String(tail), assertRef(ref)], {
      allowFail: true,
      timeoutMs: 30_000,
    });
    return { logs: r.stdout + r.stderr };
  });

  app.get('/api/podman/containers/:ref/inspect', async (req) => {
    const { ref } = req.params as { ref: string };
    const r = await run(podmanBin(), ['inspect', assertRef(ref)]);
    return JSON.parse(r.stdout)[0];
  });

  app.post('/api/podman/containers', async (req) => {
    const spec = req.body as RunSpec;
    assertId(spec.name, 'container name');
    if (!spec.image || /\s/.test(spec.image)) throw new HttpError(400, 'image required');
    return startJob(`podman run ${spec.name}`, 'podman', async (job) => {
      const dir = await ensureDir(path.join(env.composeDir, spec.name));
      job.log(`data dir ${dir.path}${dir.subvolume ? ' (btrfs subvolume)' : ''}`);
      await run(podmanBin(), runArgs(spec, dir.path), { onLine: job.log, timeoutMs: 30 * 60_000 });
      bus.publish({ type: 'ports' });
    });
  });

  app.get('/api/podman/images', async () => {
    if (!(await podmanAvailable())) return [];
    const r = await run(podmanBin(), ['images', '--format', 'json']);
    return (JSON.parse(r.stdout || '[]') as any[]).map((i) => ({
      id: i.Id,
      names: i.Names ?? [],
      size: i.Size,
      created: i.CreatedAt ?? i.Created,
    }));
  });

  app.post('/api/podman/images/pull', async (req) => {
    const { image } = req.body as { image: string };
    if (!image || /\s/.test(image)) throw new HttpError(400, 'image required');
    return startJob(`podman pull ${image}`, 'podman', async (job) => {
      await run(podmanBin(), ['pull', image], { onLine: job.log, timeoutMs: 60 * 60_000 });
    });
  });

  app.delete('/api/podman/images/:id', async (req) => {
    const { id } = req.params as { id: string };
    await run(podmanBin(), ['rmi', assertRef(id)]);
    return { ok: true };
  });
}
