import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env } from '../core/env.js';
import { run, which } from '../core/exec.js';
import { createLogger } from '../core/logger.js';
import { Collection, HttpError, getSettings } from '../core/store.js';
import { supervisor } from '../core/supervisor.js';

/**
 * Dedicated per-instance networks for LXC and VMs. Each allocation gets its own
 * Linux bridge and an independent subnet carved from the pool (default /30:
 * network, host gateway .1, instance .2, broadcast). NAT and inter-instance
 * isolation are implemented in a single nftables table `inet vas`, and an
 * optional supervised dnsmasq hands the fixed address out via DHCP.
 */

const log = createLogger('network');

export interface NetAlloc {
  id: string;
  owner: { kind: 'lxc' | 'vm'; name: string };
  cidr: string;
  prefix: number;
  gateway: string;
  address: string;
  bridge: string;
  mac: string;
  nat: boolean;
  dhcp: boolean;
  isolated: boolean;
  createdAt: string;
}

/** How an instance NIC is connected */
export type NicSpec =
  | { mode: 'dedicated'; prefix?: number; nat?: boolean; dhcp?: boolean; isolated?: boolean; cidr?: string }
  | { mode: 'bridge'; bridge: string }
  | { mode: 'none' };

export const networks = new Collection<NetAlloc>('networks', 'networks');

export function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) throw new HttpError(400, `bad IPv4 ${ip}`);
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}

export function intToIp(n: number): string {
  return [Math.floor(n / 2 ** 24) % 256, Math.floor(n / 2 ** 16) % 256, Math.floor(n / 2 ** 8) % 256, n % 256].join('.');
}

export function parseCidr(cidr: string): { base: number; prefix: number; size: number } {
  const m = cidr.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (!m) throw new HttpError(400, `bad CIDR ${cidr}`);
  const prefix = Number(m[2]);
  if (prefix < 8 || prefix > 30) throw new HttpError(400, `prefix /${prefix} not supported (8..30)`);
  const size = 2 ** (32 - prefix);
  const base = Math.floor(ipToInt(m[1]) / size) * size;
  return { base, prefix, size };
}

function netmask(prefix: number): string {
  return intToIp(2 ** 32 - 2 ** (32 - prefix));
}

function randomMac(): string {
  const b = crypto.randomBytes(3);
  return `52:54:00:${[...b].map((x) => x.toString(16).padStart(2, '0')).join(':')}`;
}

function bridgeName(id: string): string {
  return `vas-${crypto.createHash('sha1').update(id).digest('hex').slice(0, 8)}`;
}

export const BRIDGE_RE = /^[a-zA-Z0-9_.-]{1,15}$/;

export async function allocate(
  owner: NetAlloc['owner'],
  spec: Extract<NicSpec, { mode: 'dedicated' }>,
): Promise<NetAlloc> {
  const settings = await getSettings();
  const id = `${owner.kind}-${owner.name}`;
  const existing = await networks.get(id);
  if (existing) return existing;

  const pool = parseCidr(settings.network.pool);
  const prefix = spec.prefix ?? settings.network.defaultPrefix;
  if (prefix < pool.prefix || prefix > 30) throw new HttpError(400, `prefix must be between /${pool.prefix} and /30`);
  const size = 2 ** (32 - prefix);
  const used = (await networks.list()).map((n) => parseCidr(n.cidr));
  const overlaps = (start: number) => used.some((u) => start < u.base + u.size && u.base < start + size);

  let start: number | undefined;
  if (spec.cidr) {
    const want = parseCidr(spec.cidr);
    if (want.prefix !== prefix && spec.prefix) throw new HttpError(400, 'cidr prefix does not match prefix');
    if (overlaps(want.base)) throw new HttpError(409, `${spec.cidr} overlaps an existing allocation`);
    start = want.base;
  } else {
    for (let s = pool.base; s + size <= pool.base + pool.size; s += size) {
      if (!overlaps(s)) {
        start = s;
        break;
      }
    }
  }
  if (start === undefined) throw new HttpError(507, `address pool ${settings.network.pool} exhausted`);
  const realPrefix = spec.cidr ? parseCidr(spec.cidr).prefix : prefix;
  const alloc: NetAlloc = {
    id,
    owner,
    cidr: `${intToIp(start)}/${realPrefix}`,
    prefix: realPrefix,
    gateway: intToIp(start + 1),
    address: intToIp(start + 2),
    bridge: bridgeName(id),
    mac: randomMac(),
    nat: spec.nat ?? true,
    dhcp: spec.dhcp ?? owner.kind === 'vm',
    isolated: spec.isolated ?? settings.network.isolate,
    createdAt: new Date().toISOString(),
  };
  await networks.put(alloc);
  log.info(`allocated ${alloc.cidr} on ${alloc.bridge} for ${id}`);
  await apply(alloc);
  return alloc;
}

export async function release(id: string): Promise<void> {
  const a = await networks.get(id);
  if (!a) return;
  supervisor.stop(`dnsmasq-${a.bridge}`);
  await run('ip', ['link', 'del', a.bridge], { allowFail: true });
  await networks.remove(id);
  await applyFirewall();
  log.info(`released ${a.cidr} (${a.bridge})`);
}

async function ensureBridge(a: NetAlloc): Promise<void> {
  const exists = (await run('ip', ['link', 'show', a.bridge], { allowFail: true })).code === 0;
  if (!exists) await run('ip', ['link', 'add', 'name', a.bridge, 'type', 'bridge']);
  await run('ip', ['addr', 'replace', `${a.gateway}/${a.prefix}`, 'dev', a.bridge]);
  await run('ip', ['link', 'set', a.bridge, 'up']);
}

export function renderNftables(list: NetAlloc[]): string {
  const lines = [
    // table of the same rules from before the rename to VAS; dropped so NAT isn't applied twice
    'table inet hastur',
    'delete table inet hastur',
    'table inet vas',
    'delete table inet vas',
    'table inet vas {',
    '  chain forward {',
    '    type filter hook forward priority filter - 1; policy accept;',
    '    ct state established,related accept',
  ];
  // explicit bridge names instead of a "vas-*" wildcard: bridges created
  // before the rename are called hst-*, and the allocations remember them
  for (const a of list.filter((n) => n.isolated)) {
    const others = list.filter((n) => n.bridge !== a.bridge).map((n) => `"${n.bridge}"`);
    if (!others.length) continue;
    lines.push(`    iifname "${a.bridge}" oifname { ${others.join(', ')} } drop`);
    lines.push(`    iifname { ${others.join(', ')} } oifname "${a.bridge}" drop`);
  }
  lines.push('  }', '  chain postrouting {', '    type nat hook postrouting priority srcnat; policy accept;');
  for (const a of list.filter((n) => n.nat)) {
    lines.push(`    ip saddr ${a.cidr} oifname != "${a.bridge}" masquerade`);
  }
  lines.push('  }', '}', '');
  return lines.join('\n');
}

async function applyFirewall(): Promise<void> {
  if (!(await which('nft'))) {
    log.warn('nft not found; NAT/isolation rules not applied');
    return;
  }
  await run('nft', ['-f', '-'], { input: renderNftables(await networks.list()) });
}

async function applyDhcp(a: NetAlloc): Promise<void> {
  const id = `dnsmasq-${a.bridge}`;
  if (!a.dhcp) {
    supervisor.stop(id);
    return;
  }
  if (!(await which('dnsmasq'))) {
    log.warn(`dnsmasq not found; DHCP for ${a.bridge} disabled`);
    return;
  }
  const settings = await getSettings();
  const leaseDir = path.join(env.stateDir, 'dnsmasq');
  const pidFile = path.join(leaseDir, `${a.bridge}.pid`);
  await fs.mkdir(leaseDir, { recursive: true });
  if (!supervisor.list().some((p) => p.id === id)) {
    // a dnsmasq left over from a previous manager run would hold the DHCP port
    const pid = Number((await fs.readFile(pidFile, 'utf8').catch(() => '')).trim());
    const comm = pid ? (await fs.readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim() : '';
    if (comm === 'dnsmasq') {
      log.info(`stopping stale dnsmasq ${pid} for ${a.bridge}`);
      process.kill(pid, 'SIGTERM');
    }
  }
  supervisor.ensure({
    id,
    cmd: 'dnsmasq',
    args: [
      '--keep-in-foreground',
      '--conf-file=/dev/null',
      '--port=0',
      '--bind-interfaces',
      `--interface=${a.bridge}`,
      '--except-interface=lo',
      `--dhcp-range=${a.address},static,${netmask(a.prefix)},12h`,
      `--dhcp-host=${a.mac},${a.address}`,
      `--dhcp-option=option:router,${a.gateway}`,
      `--dhcp-option=option:dns-server,${settings.network.dns.join(',')}`,
      `--dhcp-leasefile=${path.join(leaseDir, `${a.bridge}.leases`)}`,
      `--pid-file=${pidFile}`,
      '--dhcp-authoritative',
    ],
  });
}

export async function apply(a: NetAlloc): Promise<void> {
  if (!(await which('ip'))) throw new HttpError(503, 'iproute2 (ip) is not available');
  await ensureBridge(a);
  await fs.writeFile('/proc/sys/net/ipv4/ip_forward', '1').catch(() => log.warn('could not enable ip_forward'));
  await applyFirewall();
  await applyDhcp(a);
}

/** Re-creates bridges, firewall and DHCP after a host reboot. */
export async function reconcileAll(): Promise<void> {
  const list = await networks.list();
  if (!list.length) return;
  if (!(await which('ip'))) {
    log.warn('ip not available, skipping network reconcile');
    return;
  }
  for (const a of list) {
    try {
      await ensureBridge(a);
      await applyDhcp(a);
    } catch (err) {
      log.error(`failed to restore ${a.bridge}`, err);
    }
  }
  await fs.writeFile('/proc/sys/net/ipv4/ip_forward', '1').catch(() => undefined);
  await applyFirewall().catch((err) => log.error('failed to apply nftables', err));
  log.info(`reconciled ${list.length} networks`);
}

/** LXC config lines for a NIC */
export function lxcNetConfig(nic: NicSpec, alloc?: NetAlloc): string[] {
  if (nic.mode === 'none') return ['lxc.net.0.type = empty'];
  if (nic.mode === 'bridge') {
    return ['lxc.net.0.type = veth', `lxc.net.0.link = ${nic.bridge}`, 'lxc.net.0.flags = up', `lxc.net.0.hwaddr = ${randomMac()}`];
  }
  if (!alloc) throw new Error('allocation required');
  return [
    'lxc.net.0.type = veth',
    `lxc.net.0.link = ${alloc.bridge}`,
    'lxc.net.0.flags = up',
    `lxc.net.0.hwaddr = ${alloc.mac}`,
    `lxc.net.0.ipv4.address = ${alloc.address}/${alloc.prefix}`,
    `lxc.net.0.ipv4.gateway = ${alloc.gateway}`,
  ];
}

/** libvirt <interface> XML for a NIC */
export function libvirtInterface(nic: NicSpec, alloc?: NetAlloc): string {
  if (nic.mode === 'none') return '';
  const bridge = nic.mode === 'bridge' ? nic.bridge : alloc!.bridge;
  const mac = alloc ? `\n      <mac address='${alloc.mac}'/>` : '';
  return `    <interface type='bridge'>${mac}
      <source bridge='${bridge}'/>
      <model type='virtio'/>
    </interface>`;
}

export function validateNic(nic: any): NicSpec {
  if (!nic || nic.mode === 'none') return { mode: 'none' };
  if (nic.mode === 'bridge') {
    if (!BRIDGE_RE.test(nic.bridge ?? '')) throw new HttpError(400, 'invalid bridge name');
    return { mode: 'bridge', bridge: nic.bridge };
  }
  if (nic.mode === 'dedicated') {
    if (nic.cidr) parseCidr(nic.cidr);
    return {
      mode: 'dedicated',
      prefix: nic.prefix ? Number(nic.prefix) : undefined,
      nat: nic.nat !== false,
      dhcp: nic.dhcp,
      isolated: nic.isolated,
      cidr: nic.cidr || undefined,
    };
  }
  throw new HttpError(400, 'invalid network mode');
}

export async function hostBridges(): Promise<string[]> {
  const r = await run('ip', ['-j', 'link', 'show', 'type', 'bridge'], { allowFail: true }).catch(() => null);
  try {
    return (JSON.parse(r?.stdout || '[]') as { ifname: string }[]).map((x) => x.ifname).filter((n) => !n.startsWith('vas-') && !n.startsWith('hst-'));
  } catch {
    return [];
  }
}

export function routes(app: FastifyInstance): void {
  app.get('/api/networks', async () => {
    const list = await networks.list();
    const procs = supervisor.list();
    const links = await run('ip', ['-j', 'link', 'show'], { allowFail: true }).catch(() => null);
    let up = new Set<string>();
    try {
      up = new Set((JSON.parse(links?.stdout || '[]') as any[]).filter((l) => l.operstate !== 'DOWN').map((l) => l.ifname));
    } catch {
      /* ignore */
    }
    return {
      settings: (await getSettings()).network,
      bridges: await hostBridges(),
      allocations: list.map((a) => ({
        ...a,
        bridgeUp: up.has(a.bridge),
        dhcpState: procs.find((p) => p.id === `dnsmasq-${a.bridge}`)?.state ?? (a.dhcp ? 'stopped' : 'disabled'),
      })),
    };
  });

  app.post('/api/networks/reconcile', async () => {
    await reconcileAll();
    return { ok: true };
  });

  app.get('/api/networks/nftables', async () => ({ ruleset: renderNftables(await networks.list()) }));
}
