import fs from 'node:fs/promises';
import YAML from 'yaml';
import { env } from '../core/env.js';
import { run, which } from '../core/exec.js';
import { findComposeFile, listProjectNames } from './compose.js';
import { listLxc } from './lxc.js';
import { networks } from './network.js';
import { podmanBin } from './podman.js';
import { instanceMeta } from '../core/instances.js';

/**
 * Dynamic proxy targets. Instead of a fixed host:port, an OpenResty upstream
 * can reference a workload; it is resolved to the workload's current address
 * every time the config bundle is built, so container restarts / re-creation
 * (new IPs) are followed automatically:
 *
 *   [http+|https+]podman://<container>:<port>
 *   [http+|https+]compose://<project>/<service>:<port>   (all replicas)
 *   [http+|https+]lxc://<name>:<port>
 *   [http+|https+]vm://<name>:<port>
 *
 * Container ports are addressed directly on the container IP, so ports that
 * are only `expose`d (not published to the host) work too. OpenResty runs
 * with host networking, which can reach rootful podman bridge networks.
 */

export type TargetKind = 'podman' | 'compose' | 'lxc' | 'vm';

export interface TargetRef {
  scheme?: 'http' | 'https';
  kind: TargetKind;
  name: string;
  service?: string;
  port: number;
}

const REF_RE = /^(?:(https?)\+)?(podman|compose|lxc|vm):\/\/([A-Za-z0-9][\w.-]*)(?:\/([A-Za-z0-9][\w.-]*))?:(\d{1,5})$/;

export function parseRef(s: string): TargetRef | null {
  const m = s.trim().match(REF_RE);
  if (!m) return null;
  const kind = m[2] as TargetKind;
  const port = Number(m[5]);
  if (port < 1 || port > 65535) return null;
  if ((kind === 'compose') !== !!m[4]) return null; // compose needs project/service, others must not have a service
  return { scheme: m[1] as TargetRef['scheme'], kind, name: m[3], service: m[4], port };
}

export function formatRef(r: TargetRef, withScheme = true): string {
  const prefix = withScheme && r.scheme ? `${r.scheme}+` : '';
  return `${prefix}${r.kind}://${r.name}${r.service ? `/${r.service}` : ''}:${r.port}`;
}

export interface Resolution {
  /** host:port pairs reachable from the host network */
  addresses: string[];
  /** why nothing (or something unusual) was resolved */
  note?: string;
}

// ---------------------------------------------------------------------------
// podman state (cached briefly; the bundle is rebuilt on every agent poll)

interface PortInfo {
  port: number;
  protocol: string;
  source: 'expose' | 'ports' | 'published';
  hostPort?: number;
}

interface CtrState {
  id: string;
  name: string;
  running: boolean;
  project?: string;
  service?: string;
  ips: string[];
  networkMode: string;
  ports: PortInfo[];
}

const CACHE_MS = 3000;
let podmanCache: { at: number; data: Promise<CtrState[]> } | null = null;

function addPort(list: PortInfo[], p: PortInfo): void {
  const cur = list.find((x) => x.port === p.port && x.protocol === p.protocol);
  if (!cur) list.push(p);
  else if (p.hostPort && !cur.hostPort) Object.assign(cur, { hostPort: p.hostPort, source: 'published' });
}

async function loadPodman(): Promise<CtrState[]> {
  if (!(await which(podmanBin()))) return [];
  const ps = await run(podmanBin(), ['ps', '-a', '--format', '{{.ID}}'], { allowFail: true, timeoutMs: 20_000 });
  const ids = ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return [];
  const r = await run(podmanBin(), ['container', 'inspect', ...ids], { allowFail: true, timeoutMs: 30_000 });
  let raw: any[] = [];
  try {
    raw = JSON.parse(r.stdout || '[]');
  } catch {
    return [];
  }
  return raw.map((c) => {
    const labels: Record<string, string> = c.Config?.Labels ?? {};
    const nets: Record<string, any> = c.NetworkSettings?.Networks ?? {};
    const ips = [c.NetworkSettings?.IPAddress, ...Object.values(nets).map((n) => n?.IPAddress)].filter(
      (ip, i, a): ip is string => !!ip && a.indexOf(ip) === i,
    );
    const ports: PortInfo[] = [];
    for (const key of Object.keys(c.Config?.ExposedPorts ?? {})) {
      const [p, proto = 'tcp'] = key.split('/');
      addPort(ports, { port: Number(p), protocol: proto, source: 'expose' });
    }
    for (const [key, binds] of Object.entries<any>(c.NetworkSettings?.Ports ?? {})) {
      const [p, proto = 'tcp'] = key.split('/');
      const hostPort = Array.isArray(binds) && binds[0]?.HostPort ? Number(binds[0].HostPort) : undefined;
      addPort(ports, { port: Number(p), protocol: proto, source: hostPort ? 'published' : 'ports', hostPort });
    }
    return {
      id: c.Id,
      name: String(c.Name ?? '').replace(/^\//, ''),
      running: !!c.State?.Running,
      project: labels['io.podman.compose.project'] ?? labels['com.docker.compose.project'],
      service: labels['io.podman.compose.service'] ?? labels['com.docker.compose.service'],
      ips,
      networkMode: String(c.HostConfig?.NetworkMode ?? ''),
      ports: ports.sort((a, b) => a.port - b.port),
    };
  });
}

function podmanState(): Promise<CtrState[]> {
  if (!podmanCache || Date.now() - podmanCache.at > CACHE_MS) {
    podmanCache = { at: Date.now(), data: loadPodman().catch(() => []) };
  }
  return podmanCache.data;
}

/** Container-side ports declared in compose.yaml (`expose:` and `ports:`), per service. */
function parsePortSpec(spec: string | number, out: PortInfo[], source: 'expose' | 'ports'): void {
  const [body, proto = 'tcp'] = String(spec).split('/');
  const parts = body.split(':');
  const container = parts[parts.length - 1];
  const hostPart = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  const [a, b] = container.split('-').map(Number);
  const [ha] = (hostPart ?? '').split('-').map(Number);
  for (let p = a, i = 0; p <= (b || a) && i < 1000; p++, i++) {
    if (!Number.isFinite(p) || p < 1) continue;
    const hostPort = Number.isFinite(ha) && ha > 0 ? ha + i : undefined;
    addPort(out, { port: p, protocol: proto, source: hostPort ? 'published' : source, hostPort });
  }
}

async function composeDeclarations(): Promise<{ project: string; service: string; ports: PortInfo[] }[]> {
  const out: { project: string; service: string; ports: PortInfo[] }[] = [];
  for (const project of await listProjectNames()) {
    const file = await findComposeFile(project);
    if (!file) continue;
    let doc: any;
    try {
      doc = YAML.parse(await fs.readFile(file, 'utf8')) ?? {};
    } catch {
      continue;
    }
    for (const [service, def] of Object.entries<any>(doc.services ?? {})) {
      const ports: PortInfo[] = [];
      for (const e of def?.expose ?? []) parsePortSpec(e, ports, 'expose');
      for (const p of def?.ports ?? []) {
        if (p && typeof p === 'object') {
          if (p.target) {
            const hostPort = p.published ? Number(p.published) : undefined;
            addPort(ports, { port: Number(p.target), protocol: p.protocol ?? 'tcp', source: hostPort ? 'published' : 'ports', hostPort });
          }
        } else parsePortSpec(p, ports, 'ports');
      }
      out.push({ project, service, ports });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LXC / VM addresses

/** true/false when libvirt knows the domain, undefined when it can't tell (no virsh, unknown domain) */
async function vmRunning(name: string): Promise<boolean | undefined> {
  if (!(await which('virsh'))) return undefined;
  const r = await run('virsh', ['-c', env.libvirtUri, 'domstate', name], { allowFail: true, timeoutMs: 10_000 });
  if (r.code !== 0) return undefined;
  return r.stdout.trim() === 'running';
}

async function vmAddress(name: string): Promise<string | undefined> {
  const alloc = await networks.get(`vm-${name}`);
  if (alloc) return alloc.address;
  if (!(await which('virsh'))) return undefined;
  for (const source of ['lease', 'agent', 'arp']) {
    const r = await run('virsh', ['-c', env.libvirtUri, 'domifaddr', name, '--source', source], { allowFail: true, timeoutMs: 10_000 });
    const m = r.stdout.match(/ipv4\s+(\d+\.\d+\.\d+\.\d+)\//);
    if (m && m[1] !== '127.0.0.1') return m[1];
  }
  return undefined;
}

async function lxcAddress(name: string, cache: { list?: Awaited<ReturnType<typeof listLxc>> }): Promise<{ addr?: string; running?: boolean }> {
  const alloc = await networks.get(`lxc-${name}`);
  cache.list ??= await listLxc().catch(() => []);
  const info = cache.list.find((c) => c.name === name);
  return { addr: alloc?.address ?? info?.ipv4[0], running: info ? info.state === 'running' : undefined };
}

const hostPort = (ip: string, port: number) => (ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`);

function containerAddress(c: CtrState, port: number): string | null {
  if (c.networkMode === 'host') return hostPort('127.0.0.1', port);
  if (c.ips.length) return hostPort(c.ips[0], port);
  // rootless / slirp: only published ports are reachable from the host
  const pub = c.ports.find((p) => p.port === port && p.hostPort);
  return pub ? hostPort('127.0.0.1', pub.hostPort!) : null;
}

/** Resolves upstream references to current addresses. Keys are canonical refs (without scheme). */
export async function resolveRefs(refs: string[]): Promise<Record<string, Resolution>> {
  const parsed = [...new Set(refs)].map(parseRef).filter((r): r is TargetRef => !!r);
  const out: Record<string, Resolution> = {};
  if (!parsed.length) return out;
  const needPodman = parsed.some((r) => r.kind === 'podman' || r.kind === 'compose');
  const ctrs = needPodman ? await podmanState() : [];
  const lxcCache: { list?: Awaited<ReturnType<typeof listLxc>> } = {};

  for (const r of parsed) {
    const key = formatRef(r, false);
    if (out[key]) continue;
    if (r.kind === 'podman') {
      const c = ctrs.find((x) => x.name === r.name);
      if (!c) out[key] = { addresses: [], note: 'container not found' };
      else if (!c.running) out[key] = { addresses: [], note: 'not running' };
      else {
        const a = containerAddress(c, r.port);
        out[key] = a ? { addresses: [a] } : { addresses: [], note: 'no routable address' };
      }
    } else if (r.kind === 'compose') {
      const replicas = ctrs.filter((x) => x.project === r.name && x.service === r.service);
      const running = replicas.filter((x) => x.running);
      const addrs = running.map((c) => containerAddress(c, r.port)).filter((a): a is string => !!a);
      out[key] = addrs.length
        ? { addresses: addrs }
        : { addresses: [], note: replicas.length === 0 ? 'service not created' : running.length === 0 ? 'not running' : 'no routable address' };
    } else if (r.kind === 'lxc') {
      // a stopped instance keeps its dedicated address; render it as down so
      // OpenResty answers with the offline page at once instead of waiting on connect
      const { addr, running } = await lxcAddress(r.name, lxcCache);
      if (running === false) out[key] = { addresses: [], note: 'not running' };
      else out[key] = addr ? { addresses: [hostPort(addr, r.port)] } : { addresses: [], note: 'no address' };
    } else {
      if ((await vmRunning(r.name)) === false) {
        out[key] = { addresses: [], note: 'not running' };
        continue;
      }
      const addr = await vmAddress(r.name);
      out[key] = addr ? { addresses: [hostPort(addr, r.port)] } : { addresses: [], note: 'no address' };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// target catalogue for the UI picker

export interface Target {
  kind: TargetKind;
  name: string;
  service?: string;
  label: string;
  running: boolean;
  address?: string;
  ports: PortInfo[];
}

export async function listTargets(): Promise<Target[]> {
  const [ctrs, decls] = await Promise.all([podmanState(), composeDeclarations().catch(() => [])]);
  const out: Target[] = [];

  // compose services: declared ports from compose.yaml merged with what the running replicas expose
  const services = new Map<string, Target>();
  for (const d of decls) {
    services.set(`${d.project}/${d.service}`, {
      kind: 'compose',
      name: d.project,
      service: d.service,
      label: `${d.project} / ${d.service}`,
      running: false,
      ports: [...d.ports],
    });
  }
  for (const c of ctrs.filter((x) => x.project && x.service)) {
    const k = `${c.project}/${c.service}`;
    const t = services.get(k) ?? { kind: 'compose' as const, name: c.project!, service: c.service!, label: `${c.project} / ${c.service}`, running: false, ports: [] };
    t.running ||= c.running;
    t.address ??= c.running ? c.ips[0] : undefined;
    for (const p of c.ports) addPort(t.ports, p);
    services.set(k, t);
  }
  out.push(...[...services.values()].map((t) => ({ ...t, ports: t.ports.sort((a, b) => a.port - b.port) })));

  for (const c of ctrs.filter((x) => !x.project)) {
    out.push({ kind: 'podman', name: c.name, label: c.name, running: c.running, address: c.ips[0], ports: c.ports });
  }

  const lxcList = await listLxc().catch(() => []);
  const lxcCache = { list: lxcList };
  for (const c of lxcList) {
    const { addr } = await lxcAddress(c.name, lxcCache);
    out.push({ kind: 'lxc', name: c.name, label: c.name, running: c.state === 'running', address: addr, ports: [] });
  }

  const vmNames = new Set((await instanceMeta.vm.list()).map((m) => m.id));
  for (const n of await networks.list()) if (n.owner.kind === 'vm') vmNames.add(n.owner.name);
  if (await which('virsh')) {
    const r = await run('virsh', ['-c', env.libvirtUri, 'list', '--all', '--name'], { allowFail: true, timeoutMs: 10_000 });
    for (const n of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) vmNames.add(n);
  }
  for (const name of [...vmNames].sort()) {
    const st = await run('virsh', ['-c', env.libvirtUri, 'domstate', name], { allowFail: true, timeoutMs: 10_000 }).catch(() => null);
    out.push({ kind: 'vm', name, label: name, running: st?.stdout.trim() === 'running', address: await vmAddress(name), ports: [] });
  }

  return out;
}
