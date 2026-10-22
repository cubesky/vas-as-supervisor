import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../core/env.js';
import { run } from '../core/exec.js';
import { createLogger } from '../core/logger.js';
import { HttpError } from '../core/store.js';

/**
 * BtrFS helpers. Each compose project / LXC container / VM folder is created as
 * its own subvolume so it can be snapshotted and deleted atomically.
 *
 * Mount pitfalls handled here:
 *  - The filesystem type is checked on the *parent* directory, so a different
 *    filesystem mounted inside the data dir is detected correctly.
 *  - A path that is itself a mount point is never deleted recursively; doing
 *    so would wipe whatever disk the operator mounted there.
 *  - Snapshots are only taken when source and snapshot dir live on the same
 *    btrfs filesystem (subvolumes report distinct st_dev values, so the mount
 *    source from findmnt is compared instead).
 *  - The manager container needs the data dir bind-mounted at the same path
 *    with rshared propagation, plus CAP_SYS_ADMIN for subvolume ioctls.
 */

const log = createLogger('btrfs');

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function fsType(p: string): Promise<string> {
  try {
    const r = await run('stat', ['-f', '-c', '%T', p], { timeoutMs: 5000 });
    return r.stdout.trim();
  } catch {
    return 'unknown';
  }
}

export async function isSubvolume(p: string): Promise<boolean> {
  if ((await fsType(p)) !== 'btrfs') return false;
  try {
    // the root directory of every btrfs subvolume has inode number 256
    const r = await run('stat', ['-c', '%i', p], { timeoutMs: 5000 });
    return r.stdout.trim() === '256';
  } catch {
    return false;
  }
}

export async function mountInfo(p: string): Promise<{ target: string; source: string; fstype: string } | null> {
  try {
    const r = await run('findmnt', ['-n', '-o', 'TARGET,SOURCE,FSTYPE', '-T', p], { timeoutMs: 5000 });
    const [target, source, fstype] = r.stdout.trim().split(/\s+/);
    return { target, source: source.replace(/\[.*\]$/, ''), fstype };
  } catch {
    return null;
  }
}

export async function isMountPoint(p: string): Promise<boolean> {
  const m = await mountInfo(p);
  return !!m && path.resolve(m.target) === path.resolve(p);
}

export interface EnsureResult {
  path: string;
  created: boolean;
  subvolume: boolean;
}

/**
 * Creates `dir` as a btrfs subvolume only when the filesystem it lands on is
 * btrfs; on every other filesystem (ext4, xfs, zfs, tmpfs, ...) or when the
 * type cannot be detected, it is a plain directory.
 */
export async function ensureDir(dir: string, opts: { nocow?: boolean } = {}): Promise<EnsureResult> {
  dir = path.resolve(dir);
  if (await exists(dir)) return { path: dir, created: false, subvolume: await isSubvolume(dir) };
  const parent = path.dirname(dir);
  await fs.mkdir(parent, { recursive: true });
  const parentFs = await fsType(parent);
  if (parentFs !== 'btrfs' || env.btrfs === 'off') {
    await fs.mkdir(dir, { recursive: true });
    log.debug(`created folder ${dir} (${parentFs})`);
    return { path: dir, created: true, subvolume: false };
  }
  await run('btrfs', ['subvolume', 'create', dir]);
  log.info(`created subvolume ${dir}`);
  if (opts.nocow) {
    // disable copy-on-write for VM images; must be set while the dir is empty
    await run('chattr', ['+C', dir], { allowFail: true });
  }
  return { path: dir, created: true, subvolume: true };
}

/** Removes a directory or subvolume (with nested subvolumes). Refuses mount points and paths outside the data dir. */
export async function removeDir(dir: string): Promise<void> {
  dir = path.resolve(dir);
  const roots = [env.dataDir, env.composeDir, env.lxcDir, env.vmDir].map((r) => path.resolve(r));
  if (roots.includes(dir) || !roots.some((r) => dir.startsWith(r + path.sep))) {
    throw new HttpError(400, `refusing to delete ${dir}`);
  }
  if (!(await exists(dir))) return;
  if (await isMountPoint(dir)) {
    throw new HttpError(409, `${dir} is a mount point; unmount it first (refusing to delete mounted data)`);
  }
  const mounts = await run('findmnt', ['-rn', '-o', 'TARGET'], { allowFail: true });
  const nestedMount = mounts.stdout.split('\n').find((t) => t.startsWith(dir + path.sep));
  if (nestedMount) throw new HttpError(409, `${nestedMount} is mounted inside ${dir}; unmount it first`);

  if (await isSubvolume(dir)) {
    // nested subvolumes (created by podman, lxc, users...) must go first, deepest first.
    // No -xdev: every subvolume has its own st_dev, so -xdev would skip exactly what we look for.
    const nested = await run('find', [dir, '-mindepth', '1', '-type', 'd', '-inum', '256'], { allowFail: true });
    const children = nested.stdout.split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
    for (const child of children) {
      if (await isSubvolume(child)) await run('btrfs', ['subvolume', 'delete', child], { allowFail: true });
    }
    await run('btrfs', ['subvolume', 'delete', dir]);
    log.info(`deleted subvolume ${dir}`);
  } else {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export interface Snapshot {
  name: string;
  path: string;
  createdAt: string;
}

function snapshotRoot(kind: string, name: string): string {
  return path.join(env.snapshotDir, kind, name);
}

export async function createSnapshot(kind: string, name: string, src: string): Promise<Snapshot> {
  if (!(await isSubvolume(src))) throw new HttpError(400, `${src} is not a btrfs subvolume`);
  const root = snapshotRoot(kind, name);
  await fs.mkdir(root, { recursive: true });
  const [a, b] = await Promise.all([mountInfo(src), mountInfo(root)]);
  if (!a || !b || a.source !== b.source) {
    throw new HttpError(400, `snapshot dir ${root} is not on the same btrfs filesystem as ${src}`);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(root, ts);
  await run('btrfs', ['subvolume', 'snapshot', '-r', src, dst]);
  log.info(`snapshot ${src} -> ${dst}`);
  return { name: ts, path: dst, createdAt: new Date().toISOString() };
}

export async function listSnapshots(kind: string, name: string): Promise<Snapshot[]> {
  const root = snapshotRoot(kind, name);
  try {
    const names = await fs.readdir(root);
    return names.sort().reverse().map((n) => ({ name: n, path: path.join(root, n), createdAt: n }));
  } catch {
    return [];
  }
}

export async function deleteSnapshot(kind: string, name: string, snap: string): Promise<void> {
  if (!/^[\w-]+$/.test(snap)) throw new HttpError(400, 'invalid snapshot name');
  await run('btrfs', ['subvolume', 'delete', path.join(snapshotRoot(kind, name), snap)]);
}

export async function storageInfo() {
  const dirs = { data: env.dataDir, compose: env.composeDir, lxc: env.lxcDir, vm: env.vmDir };
  const out: Record<string, { path: string; fstype: string; subvolume: boolean; mount?: string }> = {};
  for (const [k, p] of Object.entries(dirs)) {
    const m = await mountInfo(p);
    out[k] = { path: p, fstype: await fsType(p), subvolume: await isSubvolume(p), mount: m?.target };
  }
  return { mode: env.btrfs, dirs: out };
}
