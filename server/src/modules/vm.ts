import fs from 'node:fs/promises';
import fss from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { env } from '../core/env.js';
import { run, which } from '../core/exec.js';
import { startJob } from '../core/jobs.js';
import { createLogger } from '../core/logger.js';
import { HttpError, assertId } from '../core/store.js';
import { clearCrashloop, defaultMeta, getMeta, instanceMeta, registerDriver, setDesired } from '../core/instances.js';
import { createSnapshot, deleteSnapshot, ensureDir, isSubvolume, listSnapshots, removeDir } from './btrfs.js';
import { allocate, apply as applyNetwork, libvirtInterface, networks, release, validateNic, type NicSpec } from './network.js';
import { bus } from '../core/events.js';

/**
 * Virtual machines via libvirt (virsh). Disks live in VAS_VM_DIR/<name>
 * (btrfs subvolume with nodatacow). Graphics are VNC bound to 127.0.0.1 and
 * proxied to noVNC over WebSocket; the serial console is a libvirt TCP serial
 * port, also bound to 127.0.0.1 and proxied to xterm.js.
 */

const log = createLogger('vm');
const SERIAL_BASE = 47000;
const virsh = (...args: string[]) => ['-c', env.libvirtUri, ...args];

export async function vmAvailable(): Promise<boolean> {
  return which('virsh');
}

export interface VmInfo {
  name: string;
  state: string;
  id?: number;
}

export function parseVirshList(out: string): VmInfo[] {
  return out
    .split('\n')
    .slice(2)
    .map((l) => l.match(/^\s*(\S+)\s+(\S+)\s+(.+?)\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ id: m[1] === '-' ? undefined : Number(m[1]), name: m[2], state: m[3] }));
}

async function listDomains(): Promise<VmInfo[]> {
  if (!(await vmAvailable())) return [];
  const r = await run('virsh', virsh('list', '--all'), { allowFail: true, timeoutMs: 30_000 });
  return parseVirshList(r.stdout);
}

function parseKv(out: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const l of out.split('\n')) {
    const i = l.indexOf(':');
    if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return o;
}

async function domState(name: string): Promise<{ state: string; reason: string }> {
  const r = await run('virsh', virsh('domstate', '--reason', name), { allowFail: true, timeoutMs: 10_000 });
  if (r.code !== 0) return { state: 'missing', reason: '' };
  const m = r.stdout.trim().match(/^(.+?)\s*\((.+)\)$/);
  return m ? { state: m[1], reason: m[2] } : { state: r.stdout.trim(), reason: '' };
}

export async function vncPort(name: string): Promise<number | null> {
  const r = await run('virsh', virsh('vncdisplay', name), { allowFail: true, timeoutMs: 10_000 });
  const m = r.stdout.trim().match(/:(\d+)$/);
  return m ? 5900 + Number(m[1]) : null;
}

async function nextSerialPort(): Promise<number> {
  const used = new Set((await instanceMeta.vm.list()).map((m) => m.serialPort).filter(Boolean));
  for (let p = SERIAL_BASE; p < SERIAL_BASE + 1000; p++) if (!used.has(p)) return p;
  throw new HttpError(507, 'no free serial ports');
}

const vmDir = (name: string) => path.join(env.vmDir, assertId(name, 'vm name'));

function isoPath(file: string): string {
  const p = path.resolve(env.isoDir, file);
  if (!p.startsWith(env.isoDir + path.sep)) throw new HttpError(400, 'invalid image path');
  return p;
}

export interface VmCreate {
  name: string;
  vcpus: number;
  memoryMiB: number;
  diskGiB: number;
  iso?: string;
  importImage?: string;
  firmware?: 'bios' | 'uefi';
  machine?: string;
  nic?: NicSpec;
  autostart?: boolean;
  restartPolicy?: 'no' | 'on-failure' | 'always';
}

export function domainXml(o: {
  name: string;
  vcpus: number;
  memoryMiB: number;
  disk: string;
  iso?: string;
  firmware: 'bios' | 'uefi';
  machine: string;
  iface: string;
  serialPort: number;
  serialLog: string;
}): string {
  return `<domain type='kvm'>
  <name>${o.name}</name>
  <metadata><vas:managed xmlns:vas='https://vas.local/xmlns'>true</vas:managed></metadata>
  <memory unit='MiB'>${o.memoryMiB}</memory>
  <vcpu>${o.vcpus}</vcpu>
  <os${o.firmware === 'uefi' ? " firmware='efi'" : ''}>
    <type arch='x86_64' machine='${o.machine}'>hvm</type>
    <boot dev='cdrom'/>
    <boot dev='hd'/>
  </os>
  <features><acpi/><apic/></features>
  <cpu mode='host-passthrough'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>restart</on_crash>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' discard='unmap'/>
      <source file='${o.disk}'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      ${o.iso ? `<source file='${o.iso}'/>` : ''}
      <target dev='sda' bus='sata'/>
      <readonly/>
    </disk>
${o.iface}
    <serial type='tcp'>
      <source mode='bind' host='127.0.0.1' service='${o.serialPort}'/>
      <protocol type='raw'/>
      <log file='${o.serialLog}' append='on'/>
      <target port='0'/>
    </serial>
    <channel type='unix'>
      <target type='virtio' name='org.qemu.guest_agent.0'/>
    </channel>
    <graphics type='vnc' autoport='yes' listen='127.0.0.1'>
      <listen type='address' address='127.0.0.1'/>
    </graphics>
    <video><model type='virtio'/></video>
    <input type='tablet' bus='usb'/>
    <rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>
  </devices>
</domain>
`;
}

async function startVm(name: string): Promise<void> {
  const alloc = await networks.get(`vm-${name}`);
  // bridges disappear after a host reboot; make sure ours exists before start
  if (alloc) await applyNetwork(alloc);
  await run('virsh', virsh('start', name), { timeoutMs: 120_000 });
}

registerDriver({
  kind: 'vm',
  async status(id) {
    const s = await domState(id);
    return {
      exists: s.state !== 'missing',
      running: s.state === 'running' || s.state === 'paused',
      failed: s.state === 'crashed' || /crash|failed/.test(s.reason),
    };
  },
  start: startVm,
});

async function defineXml(xml: string): Promise<void> {
  const tmp = path.join(os.tmpdir(), `vas-domain-${Date.now()}.xml`);
  await fs.writeFile(tmp, xml);
  try {
    await run('virsh', virsh('define', tmp));
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

function proxyTcp(socket: any, port: number, binary: boolean, label: string): void {
  const tcp = net.connect({ host: '127.0.0.1', port });
  tcp.on('connect', () => log.debug(`${label} connected to 127.0.0.1:${port}`));
  tcp.on('data', (d) => socket.readyState === 1 && socket.send(d, { binary: true }));
  tcp.on('error', (err) => {
    log.warn(`${label} tcp error: ${err.message}`);
    socket.close(1011, err.message.slice(0, 100));
  });
  tcp.on('close', () => socket.readyState === 1 && socket.close());
  socket.on('message', (raw: Buffer, isBinary: boolean) => {
    if (binary || isBinary) {
      tcp.write(raw);
      return;
    }
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'i') tcp.write(msg.d);
    } catch {
      tcp.write(raw);
    }
  });
  socket.on('close', () => tcp.destroy());
}

export function routes(app: FastifyInstance): void {
  app.get('/api/vms', async () => {
    const domains = await listDomains();
    const allocs = await networks.list();
    return {
      available: await vmAvailable(),
      baseDir: env.vmDir,
      vms: await Promise.all(
        domains.map(async (d) => {
          const meta = await instanceMeta.vm.get(d.name);
          const info = parseKv((await run('virsh', virsh('dominfo', d.name), { allowFail: true })).stdout);
          return {
            ...d,
            managed: !!meta,
            meta: meta ?? defaultMeta('vm', d.name),
            vcpus: Number(info['CPU(s)']) || undefined,
            memoryKiB: Number.parseInt(info['Max memory'] ?? '', 10) || undefined,
            autostartLibvirt: info.Autostart === 'enable',
            network: allocs.find((a) => a.id === `vm-${d.name}`),
          };
        }),
      ),
    };
  });

  app.get('/api/vms/images', async () => {
    await fs.mkdir(env.isoDir, { recursive: true }).catch(() => undefined);
    const names = await fs.readdir(env.isoDir).catch(() => [] as string[]);
    const files = await Promise.all(
      names
        .filter((n) => /\.(iso|img|qcow2|raw)$/i.test(n))
        .map(async (n) => ({ name: n, size: (await fs.stat(path.join(env.isoDir, n))).size })),
    );
    return { dir: env.isoDir, files };
  });

  app.post('/api/vms/images/download', async (req) => {
    const { url, filename } = req.body as { url: string; filename?: string };
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'only http(s) URLs');
    const name = filename || path.basename(u.pathname);
    if (!/^[\w.+-]+\.(iso|img|qcow2|raw)$/i.test(name)) throw new HttpError(400, 'filename must end in .iso/.img/.qcow2/.raw');
    return startJob(`download ${name}`, 'vm-images', async (job) => {
      await fs.mkdir(env.isoDir, { recursive: true });
      const res = await fetch(u);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let done = 0;
      let lastPct = -1;
      const tmp = isoPath(`${name}.part`);
      const body = Readable.fromWeb(res.body as any);
      body.on('data', (c: Buffer) => {
        done += c.length;
        const pct = total ? Math.floor((done / total) * 100) : -1;
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          job.log(`${pct}% (${(done / 1048576).toFixed(0)} MiB)`);
        }
      });
      await pipeline(body, fss.createWriteStream(tmp));
      await fs.rename(tmp, isoPath(name));
      job.log(`saved ${isoPath(name)}`);
    });
  });

  app.delete('/api/vms/images/:file', async (req) => {
    const { file } = req.params as { file: string };
    await fs.rm(isoPath(file));
    return { ok: true };
  });

  app.post('/api/vms', async (req) => {
    const b = req.body as VmCreate;
    const name = assertId(b.name, 'vm name');
    const vcpus = Math.max(1, Math.min(256, Math.floor(Number(b.vcpus) || 1)));
    const memoryMiB = Math.max(128, Math.floor(Number(b.memoryMiB) || 1024));
    const diskGiB = Math.max(1, Math.floor(Number(b.diskGiB) || 20));
    const machine = /^[\w.-]+$/.test(b.machine ?? '') ? b.machine! : 'q35';
    const nic = validateNic(b.nic ?? { mode: 'dedicated' });
    const iso = b.iso ? isoPath(b.iso) : undefined;
    const importImage = b.importImage ? isoPath(b.importImage) : undefined;
    if (!(await vmAvailable())) throw new HttpError(503, 'libvirt (virsh) is not available');
    if ((await domState(name)).state !== 'missing') throw new HttpError(409, 'domain already exists');

    return startJob(`vm create ${name}`, 'vm', async (job) => {
      const dir = await ensureDir(vmDir(name), { nocow: true });
      job.log(`vm dir ${dir.path}${dir.subvolume ? ' (btrfs subvolume, nodatacow)' : ''}`);
      const disk = path.join(dir.path, 'disk.qcow2');
      let serialPort = 0;
      try {
        if (importImage) {
          await run('qemu-img', ['convert', '-p', '-O', 'qcow2', importImage, disk], { onLine: job.log, timeoutMs: 3600_000 });
          await run('qemu-img', ['resize', disk, `${diskGiB}G`], { onLine: job.log });
        } else {
          await run('qemu-img', ['create', '-f', 'qcow2', disk, `${diskGiB}G`], { onLine: job.log });
        }
        const alloc = nic.mode === 'dedicated' ? await allocate({ kind: 'vm', name }, nic) : undefined;
        if (alloc) job.log(`network ${alloc.cidr} on ${alloc.bridge}: guest ${alloc.address}, gateway ${alloc.gateway}`);
        serialPort = await nextSerialPort();
        const xml = domainXml({
          name,
          vcpus,
          memoryMiB,
          disk,
          iso,
          firmware: b.firmware === 'uefi' ? 'uefi' : 'bios',
          machine,
          iface: libvirtInterface(nic, alloc),
          serialPort,
          serialLog: path.join(dir.path, 'serial.log'),
        });
        await fs.writeFile(path.join(dir.path, 'domain.xml'), xml);
        await defineXml(xml);
        await instanceMeta.vm.put(
          defaultMeta('vm', name, { nic, serialPort, autostart: !!b.autostart, restartPolicy: b.restartPolicy ?? 'no' }),
        );
      } catch (err) {
        // undo what this attempt created; a pre-existing folder (maybe holding a disk) is kept
        job.log('creation failed, cleaning up');
        await release(`vm-${name}`).catch(() => undefined);
        if (dir.created) await removeDir(dir.path).catch((e) => job.log(`could not remove ${dir.path}: ${(e as Error).message}`));
        throw err;
      }
      job.log(`defined domain ${name} (serial on 127.0.0.1:${serialPort})`);
      bus.publish({ type: 'ports' });
    });
  });

  app.get('/api/vms/:name', async (req) => {
    const { name } = req.params as { name: string };
    assertId(name);
    const [xml, st, ifaddr] = await Promise.all([
      run('virsh', virsh('dumpxml', '--inactive', name), { allowFail: true }),
      domState(name),
      run('virsh', virsh('domifaddr', name, '--source', 'agent'), { allowFail: true }),
    ]);
    return {
      name,
      state: st,
      xml: xml.stdout,
      meta: await getMeta('vm', name),
      network: await networks.get(`vm-${name}`),
      vncPort: await vncPort(name),
      guestAddresses: ifaddr.code === 0 ? ifaddr.stdout : '',
      snapshots: await listSnapshots('vm', name),
      subvolume: await isSubvolume(vmDir(name)),
      serialLog: await fs
        .readFile(path.join(vmDir(name), 'serial.log'), 'utf8')
        .then((s) => s.slice(-20000))
        .catch(() => ''),
    };
  });

  app.put('/api/vms/:name/xml', async (req) => {
    const { name } = req.params as { name: string };
    const { xml } = req.body as { xml: string };
    assertId(name);
    if (!xml.includes(`<name>${name}</name>`)) throw new HttpError(400, 'XML must keep the domain name');
    await defineXml(xml);
    return { ok: true };
  });

  app.put('/api/vms/:name/settings', async (req) => {
    const { name } = req.params as { name: string };
    const b = req.body as any;
    const cur = await getMeta('vm', assertId(name));
    await instanceMeta.vm.put({
      ...cur,
      autostart: b.autostart ?? cur.autostart,
      autostartDelaySec: b.autostartDelaySec ?? cur.autostartDelaySec,
      restartPolicy: b.restartPolicy ?? cur.restartPolicy,
    });
    return { ok: true };
  });

  app.post('/api/vms/:name/media', async (req) => {
    const { name } = req.params as { name: string };
    const { iso } = req.body as { iso?: string };
    assertId(name);
    const st = await domState(name);
    const live = st.state === 'running' ? ['--live', '--config'] : ['--config'];
    if (iso) await run('virsh', virsh('change-media', name, 'sda', isoPath(iso), '--insert', '--force', ...live));
    else await run('virsh', virsh('change-media', name, 'sda', '--eject', '--force', ...live));
    return { ok: true };
  });

  app.post('/api/vms/:name/:action', async (req) => {
    const { name, action } = req.params as { name: string; action: string };
    assertId(name);
    switch (action) {
      case 'start':
        await setDesired('vm', name, 'running');
        clearCrashloop('vm', name);
        await startVm(name);
        break;
      case 'shutdown':
        await setDesired('vm', name, 'stopped');
        await run('virsh', virsh('shutdown', name));
        break;
      case 'destroy':
        await setDesired('vm', name, 'stopped');
        await run('virsh', virsh('destroy', name));
        break;
      case 'reboot':
        await run('virsh', virsh('reboot', name));
        break;
      case 'reset':
        await run('virsh', virsh('reset', name));
        break;
      case 'suspend':
        await run('virsh', virsh('suspend', name));
        break;
      case 'resume':
        await run('virsh', virsh('resume', name));
        break;
      case 'snapshot':
        return createSnapshot('vm', name, vmDir(name));
      default:
        throw new HttpError(400, 'unknown action');
    }
    bus.changed('vm', name);
    bus.publish({ type: 'ports' });
    return { ok: true };
  });

  app.delete('/api/vms/:name/snapshots/:snap', async (req) => {
    const { name, snap } = req.params as { name: string; snap: string };
    await deleteSnapshot('vm', assertId(name), snap);
    return { ok: true };
  });

  app.delete('/api/vms/:name', async (req) => {
    const { name } = req.params as { name: string };
    const deleteDisk = (req.query as any).deleteDisk === 'true';
    assertId(name);
    return startJob(`vm delete ${name}`, 'vm', async (job) => {
      await run('virsh', virsh('destroy', name), { allowFail: true });
      await run('virsh', virsh('undefine', name, '--nvram'), { allowFail: true, onLine: job.log }).then((r) =>
        r.code === 0 ? r : run('virsh', virsh('undefine', name), { onLine: job.log }),
      );
      await release(`vm-${name}`);
      await instanceMeta.vm.remove(name);
      if (deleteDisk) {
        await removeDir(vmDir(name));
        job.log(`deleted ${vmDir(name)}`);
      }
      bus.publish({ type: 'ports' });
    });
  });

  // noVNC: raw RFB over binary WebSocket frames
  app.get('/api/vms/:name/vnc', { websocket: true }, async (socket, req) => {
    const { name } = req.params as { name: string };
    const port = /^[a-z0-9][a-z0-9._-]{0,62}$/.test(name) ? await vncPort(name) : null;
    if (!port) {
      socket.close(1011, 'VNC not available (is the VM running?)');
      return;
    }
    log.info(`VNC session for ${name} (port ${port})`);
    proxyTcp(socket, port, true, `vnc:${name}`);
  });

  // Web serial console
  app.get('/api/vms/:name/serial', { websocket: true }, async (socket, req) => {
    const { name } = req.params as { name: string };
    const meta = /^[a-z0-9][a-z0-9._-]{0,62}$/.test(name) ? await instanceMeta.vm.get(name) : undefined;
    if (!meta?.serialPort) {
      socket.close(1011, 'no serial console configured for this VM');
      return;
    }
    log.info(`serial session for ${name} (port ${meta.serialPort})`);
    proxyTcp(socket, meta.serialPort, false, `serial:${name}`);
  });
}
