import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Messages from module initialisation, logged by index.ts once the logger is up. */
export const startupNotes: { level: 'info' | 'warn' | 'error'; msg: string }[] = [];

// This service used to be called "Hastur". VAS_X variables fall back to the
// old HASTUR_X names so existing env files keep working; each one used is
// reported once at startup.
const legacyUsed = new Set<string>();
const e: Record<string, string | undefined> = new Proxy({} as Record<string, string | undefined>, {
  get(_t, name: string) {
    const v = process.env[name];
    if (v !== undefined || !name.startsWith('VAS_')) return v;
    const oldName = `HASTUR_${name.slice(4)}`;
    const old = process.env[oldName];
    if (old !== undefined && !legacyUsed.has(oldName)) {
      legacyUsed.add(oldName);
      startupNotes.push({ level: 'warn', msg: `${oldName} is deprecated, rename it to ${name}` });
    }
    return old;
  },
});

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number): number {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : def;
}

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(e.VAS_DATA_DIR || '/mnt/data');
const vasDir = path.resolve(e.VAS_HOME_DIR || path.join(dataDir, 'vas'));

// One-time move of the default home from <data>/hastur to <data>/vas (config,
// state, logs, acme). Only when the new one doesn't exist yet; anything else
// is left to the operator so nothing gets merged or overwritten by accident.
if (!e.VAS_HOME_DIR) {
  const legacyDir = path.join(dataDir, 'hastur');
  if (fs.existsSync(legacyDir) && !fs.existsSync(vasDir)) {
    try {
      fs.renameSync(legacyDir, vasDir);
      startupNotes.push({ level: 'info', msg: `moved ${legacyDir} to ${vasDir} (service renamed Hastur → VAS)` });
    } catch (err) {
      startupNotes.push({ level: 'error', msg: `could not move ${legacyDir} to ${vasDir}: ${(err as Error).message}; move it by hand or set VAS_HOME_DIR=${legacyDir}` });
    }
  } else if (fs.existsSync(legacyDir) && fs.existsSync(vasDir)) {
    startupNotes.push({ level: 'warn', msg: `both ${legacyDir} and ${vasDir} exist; using ${vasDir}. Move the old data by hand if it is the one you want` });
  }
}
const stateDir = path.resolve(e.VAS_STATE_DIR || path.join(vasDir, 'state'));

export interface ListenAddr {
  host: string;
  port: number;
}

/**
 * VAS_LISTEN: comma list of addresses the web UI/API listens on directly
 * (the fallback when OpenResty is broken), e.g. "127.0.0.1:8080,192.168.1.10:8080",
 * "[::1]:8080" or a bare address using VAS_PORT. Defaults to VAS_HOST:VAS_PORT.
 */
function parseListen(v: string | undefined, host: string, port: number): ListenAddr[] {
  if (!v?.trim()) return [{ host, port }];
  return list(v).map((item) => {
    const m = item.match(/^\[([0-9a-fA-F:.]+)\]:(\d+)$/) ?? item.match(/^([^:]+):(\d+)$/);
    if (m) return { host: m[1], port: Number(m[2]) };
    if (/^\d+$/.test(item)) return { host: '0.0.0.0', port: Number(item) };
    return { host: item.replace(/^\[|\]$/g, ''), port };
  });
}

const listen = parseListen(e.VAS_LISTEN, e.VAS_HOST || '0.0.0.0', int(e.VAS_PORT, 8080));

/** URL other local services (OpenResty, acme.sh hook) use to reach the manager: loopback if bound, else a wildcard via 127.0.0.1, else the first address. */
function localUrl(addrs: ListenAddr[]): string {
  const loop = addrs.find((a) => ['127.0.0.1', '::1', 'localhost'].includes(a.host));
  const wild = addrs.find((a) => a.host === '0.0.0.0' || a.host === '::');
  const a = loop ?? wild ?? addrs[0];
  const h = loop ? a.host : wild ? '127.0.0.1' : a.host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${a.port}`;
}

const managerUrl = e.VAS_MANAGER_URL || localUrl(listen);

/**
 * All runtime configuration comes from environment variables. Paths that are
 * shared with the host (compose projects, LXC, VM disks) MUST be bind-mounted
 * at the same absolute path inside the manager container, because podman,
 * LXC and libvirt run on the host and resolve paths there.
 */
export const env = {
  production: e.NODE_ENV === 'production',
  host: listen[0].host,
  port: listen[0].port,
  listen,
  /** how OpenResty / acme.sh reach this manager (VAS_MANAGER_URL overrides) */
  managerUrl,
  /** root-only socket for the CLI; requests over it bypass passkey login */
  adminSocket: process.platform === 'win32' ? '\\\\.\\pipe\\vas-admin' : path.resolve(e.VAS_ADMIN_SOCKET || path.join(stateDir, 'admin.sock')),
  logLevel: (e.VAS_LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',

  dataDir,
  composeDir: path.resolve(e.VAS_COMPOSE_DIR || path.join(dataDir, 'container')),
  lxcDir: path.resolve(e.VAS_LXC_DIR || path.join(dataDir, 'lxc')),
  vmDir: path.resolve(e.VAS_VM_DIR || path.join(dataDir, 'vm')),
  isoDir: path.resolve(e.VAS_ISO_DIR || path.join(dataDir, 'iso')),
  snapshotDir: path.resolve(e.VAS_SNAPSHOT_DIR || path.join(dataDir, '.snapshots')),
  configDir: path.resolve(e.VAS_CONFIG_DIR || path.join(vasDir, 'config')),
  stateDir,
  logDir: path.resolve(e.VAS_LOG_DIR || path.join(vasDir, 'logs')),
  webDir: path.resolve(e.VAS_WEB_DIR || path.join(here, '../../../web/dist')),

  /**
   * The filesystem is always detected: subvolumes are created only on btrfs,
   * plain folders everywhere else. `off` forces plain folders even on btrfs.
   */
  btrfs: (e.VAS_BTRFS === 'off' ? 'off' : 'auto') as 'auto' | 'off',

  auth: {
    enabled: bool(e.VAS_AUTH_ENABLED, true),
    rpId: e.VAS_RP_ID || '',
    rpName: e.VAS_RP_NAME || 'VAS',
    origins: list(e.VAS_ORIGIN),
    setupToken: e.VAS_SETUP_TOKEN || '',
    sessionTtlHours: int(e.VAS_SESSION_TTL_HOURS, 24 * 7),
    secureCookie: e.VAS_SECURE_COOKIE ? bool(e.VAS_SECURE_COOKIE, true) : undefined,
  },

  /** Shared secret used by the OpenResty Lua agent and acme.sh reload hook. */
  agentToken: e.VAS_AGENT_TOKEN || '',

  podman: {
    bin: e.VAS_PODMAN_BIN || 'podman',
    composeBin: e.VAS_PODMAN_COMPOSE_BIN || 'podman-compose',
  },
  libvirtUri: e.VAS_LIBVIRT_URI || 'qemu:///system',
  /**
   * Where lxc-* commands run. auto: on the host (via nsenter into PID 1's
   * namespaces) when the manager runs in a container sharing the host PID
   * namespace, else locally. host / local force either.
   */
  lxcExec: (['host', 'local'].includes(e.VAS_LXC_EXEC ?? '') ? e.VAS_LXC_EXEC : 'auto') as 'auto' | 'host' | 'local',
  /** image server used by the LXC `download` template (hostname, e.g. a mirror) */
  lxcImageServer: (e.VAS_LXC_IMAGE_SERVER || 'images.linuxcontainers.org').replace(/^https?:\/\//, '').replace(/\/+$/, ''),

  acme: {
    /** podman: run acme.sh via `podman exec` in a dedicated container; local: run acme.sh directly */
    mode: (e.VAS_ACME_MODE || 'podman') as 'podman' | 'local',
    container: e.VAS_ACME_CONTAINER || 'vas-acme',
    bin: e.VAS_ACME_BIN || 'acme.sh',
    /** acme.sh home as seen by this process */
    home: path.resolve(e.VAS_ACME_HOME || path.join(vasDir, 'acme')),
    /** acme.sh home as seen inside the acme container */
    homeInContainer: e.VAS_ACME_HOME_IN_CONTAINER || '/acme.sh',
    /** URL the acme container uses to notify the manager after renewals */
    callbackUrl: e.VAS_ACME_CALLBACK_URL || managerUrl,
    /** ACME account e-mail; filled into the settings when they have none */
    email: e.VAS_ACME_EMAIL || '',
  },

  openresty: {
    container: e.VAS_OPENRESTY_CONTAINER || 'vas-openresty',
  },

  /**
   * Serve the VAS UI itself on a domain through OpenResty. The route is
   * generated from these variables, shown read-only in the UI, and can't be
   * edited there. With VAS_PUBLIC_DNS_PROVIDER a Let's Encrypt certificate
   * is requested automatically.
   */
  public: {
    domains: list(e.VAS_PUBLIC_DOMAIN).map((d) => d.toLowerCase()),
    tls: (['off', 'on', 'redirect'].includes(e.VAS_PUBLIC_TLS ?? '') ? e.VAS_PUBLIC_TLS : 'redirect') as 'off' | 'on' | 'redirect',
    certId: e.VAS_PUBLIC_CERT || 'auto',
    hsts: bool(e.VAS_PUBLIC_HSTS, false),
    allow: list(e.VAS_PUBLIC_ALLOW),
    /** acme.sh dnsapi (e.g. dns_cf); enables automatic issuing */
    dnsProvider: e.VAS_PUBLIC_DNS_PROVIDER || '',
    /** names of environment variables holding that provider's credentials, e.g. CF_Token,CF_Zone_ID */
    dnsEnv: list(e.VAS_PUBLIC_DNS_ENV),
    /** DNS alias mode: challenge alias domain */
    dnsAlias: (e.VAS_PUBLIC_DNS_ALIAS || '').toLowerCase(),
    acmeServer: e.VAS_PUBLIC_ACME_SERVER || 'letsencrypt',
    /** WAF on the VAS UI route; off by default because the UI legitimately submits code (Lua, compose files, shell) */
    waf: (['detect', 'block'].includes(e.VAS_PUBLIC_WAF ?? '') ? e.VAS_PUBLIC_WAF : 'off') as 'off' | 'detect' | 'block',
  },

  /**
   * Containers the UI must never start/stop/remove: the manager itself, its
   * compose project, OpenResty and acme.sh, plus anything labelled
   * io.vas.system=true. VAS_SYSTEM_CONTAINERS adds names.
   */
  systemContainers: [
    ...new Set(['vas', e.VAS_OPENRESTY_CONTAINER || 'vas-openresty', e.VAS_ACME_CONTAINER || 'vas-acme', ...list(e.VAS_SYSTEM_CONTAINERS)]),
  ],

  /** auto: enter safe mode after repeated crash loops; on: force; off: never */
  safeMode: (e.VAS_SAFE_MODE || 'auto') as 'auto' | 'on' | 'off',
  crashLoopThreshold: int(e.VAS_CRASH_LOOP_THRESHOLD, 3),
  crashLoopWindowSec: int(e.VAS_CRASH_LOOP_WINDOW_SEC, 900),
};

export type Env = typeof env;
