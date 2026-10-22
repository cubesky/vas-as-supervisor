import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { env } from './env.js';
import { bus } from './events.js';

/**
 * File-based configuration store. Every entity is a pretty-printed JSON file
 * under VAS_CONFIG_DIR so the whole directory can be diffed, committed to
 * git and backed up. Secrets live under `secrets/` which is git-ignored by default.
 */

export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function assertId(id: unknown, what = 'id'): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new HttpError(400, `invalid ${what}: must match ${ID_RE}`);
  }
  return id;
}

export interface ChangeInfo {
  collection: string;
  id?: string;
  action: 'put' | 'remove' | 'update';
}

const changes = new EventEmitter();
export function onConfigChange(cb: (c: ChangeInfo) => void): void {
  changes.on('change', cb);
}
export function emitConfigChange(c: ChangeInfo): void {
  changes.emit('change', c);
  bus.changed(c.collection, c.id);
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fss.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, { mode });
  await fs.rename(tmp, file);
}

export async function writeJson(file: string, data: unknown, mode?: number): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', mode);
}

export class Collection<T extends { id: string }> {
  readonly dir: string;
  constructor(
    public readonly name: string,
    relDir: string,
    private readonly secret = false,
  ) {
    this.dir = path.join(env.configDir, relDir);
  }

  private file(id: string): string {
    return path.join(this.dir, `${assertId(id)}.json`);
  }

  async list(): Promise<T[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const items: (T | null)[] = await Promise.all(
      names.filter((n) => n.endsWith('.json')).map((n) => readJson<T | null>(path.join(this.dir, n), null)),
    );
    return items.filter((x): x is T => !!x).sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<T | undefined> {
    return (await readJson<T | null>(this.file(id), null)) ?? undefined;
  }

  async require(id: string): Promise<T> {
    const item = await this.get(id);
    if (!item) throw new HttpError(404, `${this.name} ${id} not found`);
    return item;
  }

  async put(item: T): Promise<T> {
    await writeJson(this.file(item.id), item, this.secret ? 0o600 : undefined);
    emitConfigChange({ collection: this.name, id: item.id, action: 'put' });
    return item;
  }

  async patch(id: string, patch: Partial<T>): Promise<T> {
    const cur = await this.require(id);
    return this.put({ ...cur, ...patch, id });
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
    emitConfigChange({ collection: this.name, id, action: 'remove' });
  }
}

// ---------------------------------------------------------------------------
// Settings

export interface Settings {
  general: { language: string };
  network: { pool: string; defaultPrefix: number; dns: string[]; isolate: boolean };
  openresty: {
    httpPort: number;
    httpsPort: number;
    /** also listen on [::] — disable on hosts without IPv6 or nginx refuses to start */
    ipv6: boolean;
    defaultServer: 'drop' | 'manager';
    clientMaxBodySize: string;
    resolver: string;
    globalHttpConfig: string;
    initWorkerLua: string;
    /** custom "service not running" page; {{host}}, {{title}}, {{message}}, {{lang}} are replaced. Empty = built-in page */
    offlineHtml: string;
    /** LuaRocks packages for global Lua (init_worker, global http config); routes add their own */
    luaPackages: { name: string; version?: string }[];
    /** LuaRocks mirror (--server); empty = luarocks.org */
    luarocksServer: string;
  };
  acme: { email: string; defaultServer: string };
  git: {
    enabled: boolean;
    remote: string;
    branch: string;
    authorName: string;
    authorEmail: string;
    push: boolean;
    debounceSec: number;
    includeSecrets: boolean;
    tokenUser: string;
  };
  backup: {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    forcePathStyle: boolean;
    intervalHours: number;
    retention: number;
    includeSecrets: boolean;
    includeComposeFiles: boolean;
    extraPaths: string[];
  };
  watchdog: { enabled: boolean; intervalSec: number };
  waf: {
    /** mode for routes that don't set their own */
    defaultMode: 'off' | 'detect' | 'block';
    paranoia: 1 | 2 | 3;
    /** anomaly score at which a request is blocked/logged */
    threshold: number;
    bodyLimitKb: number;
    /** 403, 406, 429, 451 or 444 (close the connection) */
    blockStatus: number;
    disabledRules: number[];
    blockedIps: { cidr: string; note?: string; addedAt: string }[];
    /** events kept by the manager */
    maxEvents: number;
  };
}

export interface Secrets {
  gitToken?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  general: { language: 'en' },
  network: { pool: '10.250.0.0/16', defaultPrefix: 30, dns: ['1.1.1.1', '8.8.8.8'], isolate: true },
  openresty: {
    httpPort: 80,
    httpsPort: 443,
    ipv6: true,
    defaultServer: 'drop',
    clientMaxBodySize: '100m',
    resolver: '1.1.1.1 8.8.8.8',
    globalHttpConfig: '',
    initWorkerLua: '',
    offlineHtml: '',
    luaPackages: [],
    luarocksServer: '',
  },
  acme: { email: '', defaultServer: 'letsencrypt' },
  git: {
    enabled: false,
    remote: '',
    branch: 'main',
    authorName: 'VAS',
    authorEmail: 'vas@localhost',
    push: false,
    debounceSec: 10,
    includeSecrets: false,
    tokenUser: 'x-access-token',
  },
  backup: {
    enabled: false,
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    prefix: 'vas/',
    forcePathStyle: true,
    intervalHours: 24,
    retention: 14,
    includeSecrets: false,
    includeComposeFiles: true,
    extraPaths: [],
  },
  watchdog: { enabled: true, intervalSec: 30 },
  // detect = log only, so enabling the WAF never breaks a site before the events were reviewed
  waf: { defaultMode: 'detect', paranoia: 1, threshold: 5, bodyLimitKb: 64, blockStatus: 403, disabledRules: [], blockedIps: [], maxEvents: 10000 },
};

function deepMerge<T>(base: T, over: any): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as any)?.[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, v) : v;
  }
  return out;
}

const settingsFile = () => path.join(env.configDir, 'settings.json');
const secretsFile = () => path.join(env.configDir, 'secrets', 'settings.json');

let settingsCache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (!settingsCache) settingsCache = deepMerge(DEFAULT_SETTINGS, await readJson(settingsFile(), {}));
  return settingsCache;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = deepMerge(await getSettings(), patch);
  await writeJson(settingsFile(), next);
  settingsCache = next;
  emitConfigChange({ collection: 'settings', action: 'update' });
  return next;
}

export async function getSecrets(): Promise<Secrets> {
  return readJson<Secrets>(secretsFile(), {});
}

export async function updateSecrets(patch: Secrets): Promise<void> {
  const cur = await getSecrets();
  for (const [k, v] of Object.entries(patch)) {
    // empty string clears, undefined keeps
    if (v === undefined) continue;
    if (v === '') delete (cur as any)[k];
    else (cur as any)[k] = v;
  }
  await writeJson(secretsFile(), cur, 0o600);
  emitConfigChange({ collection: 'secrets', action: 'update' });
}

/** Masks secrets for API responses: only reveals whether a value is set. */
export function maskSecrets(s: Secrets): Record<string, boolean> {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, !!v]));
}
