import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { env } from '../core/env.js';
import { run, which } from '../core/exec.js';
import { bus } from '../core/events.js';
import { instanceMeta } from '../core/instances.js';
import { declaredPorts, listProjectNames } from './compose.js';
import { listContainers } from './podman.js';
import { openrestyReservations } from './openresty.js';
import { vncPort } from './vm.js';

/**
 * Port usage map: live listening sockets (ss, or /proc/net as fallback)
 * merged with every port the manager knows it reserved (OpenResty http/https
 * and stream proxies, podman published ports, compose declarations, VM
 * VNC/serial). OpenResty changes publish a `ports` event so the UI refreshes.
 */

export interface Listener {
  protocol: 'tcp' | 'udp';
  address: string;
  port: number;
  process?: string;
  pid?: number;
}

export interface PortRow {
  port: number;
  protocol: 'tcp' | 'udp';
  listening: boolean;
  addresses: string[];
  process?: string;
  pid?: number;
  owners: { owner: string; detail: string }[];
  conflict: boolean;
}

export function parseSs(out: string): Listener[] {
  const res: Listener[] = [];
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0].startsWith('tcp') ? 'tcp' : cols[0].startsWith('udp') ? 'udp' : null;
    if (!proto) continue;
    const local = cols[4];
    const idx = local.lastIndexOf(':');
    const port = Number(local.slice(idx + 1));
    if (!Number.isFinite(port)) continue;
    const proc = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    res.push({
      protocol: proto,
      address: local.slice(0, idx).replace(/%\w+$/, ''),
      port,
      process: proc?.[1],
      pid: proc ? Number(proc[2]) : undefined,
    });
  }
  return res;
}

function hexAddr(h: string): string {
  if (h.length === 8) {
    return [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16)).join('.');
  }
  return h === '00000000000000000000000000000000' ? '::' : `[${h.toLowerCase()}]`;
}

async function parseProcNet(): Promise<Listener[]> {
  const out: Listener[] = [];
  for (const [file, proto, state] of [
    ['tcp', 'tcp', '0A'],
    ['tcp6', 'tcp', '0A'],
    ['udp', 'udp', '07'],
    ['udp6', 'udp', '07'],
  ] as const) {
    const text = await fs.readFile(`/proc/net/${file}`, 'utf8').catch(() => '');
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 4 || c[3] !== state) continue;
      const [addr, port] = c[1].split(':');
      out.push({ protocol: proto, address: hexAddr(addr), port: parseInt(port, 16) });
    }
  }
  return out;
}

export async function listeners(): Promise<Listener[]> {
  if (await which('ss')) {
    const r = await run('ss', ['-H', '-tulnp'], { allowFail: true, timeoutMs: 10_000 });
    if (r.code === 0) return parseSs(r.stdout);
  }
  return parseProcNet();
}

async function reservations(): Promise<{ port: number; protocol: string; owner: string; detail: string }[]> {
  const out = env.listen.map((l) => ({ port: l.port, protocol: 'tcp', owner: 'vas', detail: `manager web UI / API on ${l.host} (direct fallback)` }));
  out.push(...(await openrestyReservations()));
  const containers = await listContainers().catch(() => []);
  for (const c of containers) {
    for (const p of c.ports) {
      out.push({
        port: p.hostPort,
        protocol: p.protocol,
        owner: c.composeProject ? `compose:${c.composeProject}` : `podman:${c.name}`,
        detail: `${c.name} → ${p.containerPort}/${p.protocol}`,
      });
    }
  }
  const running = new Set(containers.map((c) => c.composeProject).filter(Boolean));
  for (const name of await listProjectNames()) {
    if (running.has(name)) continue;
    for (const p of await declaredPorts(name)) {
      out.push({ port: p.port, protocol: p.protocol, owner: `compose:${name}`, detail: `${p.service} (declared, not running)` });
    }
  }
  for (const m of await instanceMeta.vm.list()) {
    if (m.serialPort) out.push({ port: m.serialPort, protocol: 'tcp', owner: `vm:${m.id}`, detail: 'serial console (127.0.0.1)' });
    const vnc = await vncPort(m.id).catch(() => null);
    if (vnc) out.push({ port: vnc, protocol: 'tcp', owner: `vm:${m.id}`, detail: 'VNC (127.0.0.1)' });
  }
  return out;
}

export async function portMap(): Promise<PortRow[]> {
  const [live, reserved] = await Promise.all([listeners(), reservations()]);
  const rows = new Map<string, PortRow>();
  const key = (p: number, proto: string) => `${proto}/${p}`;
  for (const l of live) {
    const k = key(l.port, l.protocol);
    const row = rows.get(k) ?? {
      port: l.port,
      protocol: l.protocol,
      listening: true,
      addresses: [],
      owners: [],
      conflict: false,
    };
    if (!row.addresses.includes(l.address)) row.addresses.push(l.address);
    row.process ??= l.process;
    row.pid ??= l.pid;
    rows.set(k, row);
  }
  for (const r of reserved) {
    const proto = r.protocol === 'udp' ? 'udp' : 'tcp';
    const k = key(r.port, proto);
    const row = rows.get(k) ?? { port: r.port, protocol: proto, listening: false, addresses: [], owners: [], conflict: false };
    if (!row.owners.some((o) => o.owner === r.owner && o.detail === r.detail)) row.owners.push({ owner: r.owner, detail: r.detail });
    rows.set(k, row);
  }
  for (const row of rows.values()) {
    // conflict: two different owners want the same port (owners like "compose:x" count once)
    const distinct = new Set(row.owners.map((o) => o.owner));
    // or OpenResty wants a port that some other process is already bound to
    const foreign = distinct.size === 1 && distinct.has('openresty') && !!row.process && !/nginx|openresty/.test(row.process);
    row.conflict = distinct.size > 1 || foreign;
  }
  return [...rows.values()].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}

export function routes(app: FastifyInstance): void {
  app.get('/api/ports', async () => ({ ports: await portMap(), generatedAt: new Date().toISOString() }));

  app.get('/api/ports/check', async (req) => {
    const q = req.query as { port: string; protocol?: string };
    const port = Number(q.port);
    const protocol = q.protocol === 'udp' ? 'udp' : 'tcp';
    const row = (await portMap()).find((r) => r.port === port && r.protocol === protocol);
    return { port, protocol, free: !row || (!row.listening && !row.owners.length), row };
  });

  // throttle port-change notifications coming from many sources
  let pending: NodeJS.Timeout | null = null;
  bus.on('event', (ev) => {
    if (ev.type !== 'changed' || !['openresty.streams', 'settings'].includes(ev.topic)) return;
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      bus.publish({ type: 'ports' });
    }, 500);
  });
}
