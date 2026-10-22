import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env } from '../core/env.js';
import { run, which } from '../core/exec.js';
import { createLogger } from '../core/logger.js';
import { HttpError, getSecrets, getSettings, onConfigChange, type ChangeInfo } from '../core/store.js';
import { findComposeFile, listProjectNames, projectDir } from './compose.js';
import { instanceMeta } from '../core/instances.js';

/**
 * Auto-commits VAS_CONFIG_DIR into a git repository after every change
 * (debounced) and optionally pushes to a remote. Before each commit the
 * compose files, LXC configs and libvirt domain XML are copied into
 * `snapshots/` so the repository describes the complete system.
 */

const log = createLogger('git');

let timer: NodeJS.Timeout | null = null;
let busy = false;
const pending = new Set<string>();
const status = { lastCommit: '', lastPush: '', lastError: '' };

const git = (args: string[], opts: { allowFail?: boolean; extra?: string[] } = {}) =>
  run('git', [...(opts.extra ?? []), '-C', env.configDir, ...args], { allowFail: opts.allowFail, timeoutMs: 120_000, quiet: !!opts.extra });

/** Copies files that live outside the config dir into config/snapshots. */
export async function syncSnapshots(includeSecrets: boolean): Promise<void> {
  const root = path.join(env.configDir, 'snapshots');
  await fs.rm(root, { recursive: true, force: true });
  for (const name of await listProjectNames()) {
    const file = await findComposeFile(name);
    if (!file) continue;
    const dst = path.join(root, 'compose', name);
    await fs.mkdir(dst, { recursive: true });
    await fs.copyFile(file, path.join(dst, path.basename(file)));
    if (includeSecrets) await fs.copyFile(path.join(projectDir(name), '.env'), path.join(dst, '.env')).catch(() => undefined);
  }
  for (const m of await instanceMeta.lxc.list()) {
    const src = path.join(env.lxcDir, m.id, 'config');
    const dst = path.join(root, 'lxc', m.id);
    await fs.mkdir(dst, { recursive: true });
    await fs.copyFile(src, path.join(dst, 'config')).catch(() => undefined);
  }
  if (await which('virsh')) {
    for (const m of await instanceMeta.vm.list()) {
      const r = await run('virsh', ['-c', env.libvirtUri, 'dumpxml', '--inactive', m.id], { allowFail: true });
      if (r.code === 0) {
        await fs.mkdir(path.join(root, 'vm'), { recursive: true });
        await fs.writeFile(path.join(root, 'vm', `${m.id}.xml`), r.stdout);
      }
    }
  }
}

async function authArgs(): Promise<string[]> {
  const s = await getSettings();
  const { gitToken } = await getSecrets();
  if (!gitToken || !/^https?:/.test(s.git.remote)) return [];
  const basic = Buffer.from(`${s.git.tokenUser || 'x-access-token'}:${gitToken}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

async function ensureRepo(): Promise<void> {
  const s = await getSettings();
  await fs.mkdir(env.configDir, { recursive: true });
  try {
    await fs.access(path.join(env.configDir, '.git'));
  } catch {
    await git(['init', '-b', s.git.branch || 'main']);
    log.info(`initialized git repository in ${env.configDir}`);
  }
  const ignore = ['*.tmp', ...(s.git.includeSecrets ? [] : ['secrets/'])].join('\n') + '\n';
  await fs.writeFile(path.join(env.configDir, '.gitignore'), ignore);
  if (s.git.remote) {
    const cur = await git(['remote', 'get-url', 'origin'], { allowFail: true });
    if (cur.code !== 0) await git(['remote', 'add', 'origin', s.git.remote]);
    else if (cur.stdout.trim() !== s.git.remote) await git(['remote', 'set-url', 'origin', s.git.remote]);
  }
}

export async function commitNow(message?: string): Promise<{ committed: boolean; hash?: string }> {
  const s = await getSettings();
  if (!(await which('git'))) throw new HttpError(503, 'git is not installed');
  busy = true;
  try {
    await ensureRepo();
    await syncSnapshots(s.git.includeSecrets);
    await git(['add', '-A']);
    const diff = await git(['diff', '--cached', '--quiet'], { allowFail: true });
    if (diff.code === 0) return { committed: false };
    const topics = [...pending];
    pending.clear();
    const msg = message || `vas: update ${topics.length ? topics.join(', ') : 'configuration'}`;
    await git(['-c', `user.name=${s.git.authorName}`, '-c', `user.email=${s.git.authorEmail}`, 'commit', '-q', '-m', msg]);
    const hash = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
    status.lastCommit = new Date().toISOString();
    status.lastError = '';
    log.info(`committed ${hash}: ${msg}`);
    if (s.git.push && s.git.remote) await pushNow();
    return { committed: true, hash };
  } catch (err) {
    status.lastError = (err as Error).message;
    log.error('git commit failed', { error: status.lastError });
    throw err;
  } finally {
    busy = false;
  }
}

export async function pushNow(): Promise<void> {
  const s = await getSettings();
  if (!s.git.remote) throw new HttpError(400, 'no remote configured');
  await ensureRepo();
  await run('git', [...(await authArgs()), '-C', env.configDir, 'push', '-q', 'origin', `HEAD:${s.git.branch || 'main'}`], {
    timeoutMs: 120_000,
    quiet: true,
  });
  status.lastPush = new Date().toISOString();
  log.info(`pushed to ${s.git.remote}`);
}

function schedule(c: ChangeInfo): void {
  pending.add(c.collection);
  void getSettings().then((s) => {
    if (!s.git.enabled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      function fire() {
        if (busy) {
          timer = setTimeout(fire, 2000);
          return;
        }
        commitNow().catch(() => undefined);
      },
      Math.max(1, s.git.debounceSec) * 1000,
    );
  });
}

export function initGit(): void {
  onConfigChange(schedule);
}

export function routes(app: FastifyInstance): void {
  app.get('/api/git', async () => {
    const s = await getSettings();
    const available = await which('git');
    let commits: { hash: string; date: string; message: string }[] = [];
    let initialized = false;
    if (available) {
      const r = await git(['log', '-n', '30', '--pretty=format:%h%x09%cI%x09%s'], { allowFail: true });
      initialized = r.code === 0;
      commits = r.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [hash, date, ...m] = l.split('\t');
          return { hash, date, message: m.join('\t') };
        });
    }
    return { available, initialized, settings: s.git, status, commits, tokenSet: !!(await getSecrets()).gitToken };
  });

  app.post('/api/git/commit', async (req) => commitNow((req.body as any)?.message));
  app.post('/api/git/push', async () => {
    await pushNow();
    return { ok: true };
  });
  app.post('/api/git/test', async () => {
    const s = await getSettings();
    if (!s.git.remote) throw new HttpError(400, 'no remote configured');
    const r = await run('git', [...(await authArgs()), 'ls-remote', '--heads', s.git.remote], {
      allowFail: true,
      timeoutMs: 30_000,
      quiet: true,
    });
    return { ok: r.code === 0, output: (r.stdout + r.stderr).slice(0, 4000) };
  });
}
