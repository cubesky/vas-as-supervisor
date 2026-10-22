import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env } from '../core/env.js';
import { createLogger } from '../core/logger.js';
import { Collection, HttpError, assertId, getSettings, readJson, updateSettings, writeJson, type Settings } from '../core/store.js';
import { bus } from '../core/events.js';
import { checkAgentRequest } from './auth.js';
import { certificates, matchCertificate, readCertFiles } from './acme.js';
import { formatRef, listTargets, parseRef, resolveRefs, type Resolution, type TargetRef } from './targets.js';
import { OFFLINE_LUA } from './offline-page.js';
import { effectiveMode, validateRouteWaf, wafAccessLua, wafBundle, type RouteWaf } from './waf.js';

/**
 * OpenResty integration. The manager renders a complete config bundle (server
 * blocks, stream proxies, certificates, Lua hooks) from the route files. The
 * OpenResty container runs a Lua agent in its privileged agent process that
 * *pulls* the bundle from /api/agent/openresty/bundle, writes it, tests it
 * with `openresty -t`, rolls back on failure, and HUPs the master on success.
 */

const log = createLogger('openresty');

/**
 * One upstream target with its options. Server attributes (weight, backup,
 * failure handling, connection cap) go on the nginx `server` line and may
 * differ per upstream. Host header and TLS options are location directives in
 * nginx, so all upstreams of one location must agree on them.
 */
export interface Upstream {
  /** http(s) URL, host:port (streams) or workload reference (compose://, podman://, lxc://, vm://) */
  target: string;
  weight?: number;
  backup?: boolean;
  maxFails?: number;
  failTimeoutSec?: number;
  maxConns?: number;
  /** Host header sent upstream; overrides the location's "preserve Host" */
  host?: string;
  tls?: {
    /** verify the upstream certificate (proxy_ssl_verify) */
    verify?: boolean;
    /** name for SNI and verification (proxy_ssl_name) */
    serverName?: string;
    /** send SNI (proxy_ssl_server_name), default on */
    sni?: boolean;
    /** PEM CA bundle to verify against; default: system CA store */
    trustedCa?: string;
  };
}

export interface ProxyLocation {
  path: string;
  upstreams: Upstream[];
  lb: 'round_robin' | 'least_conn' | 'ip_hash';
  websocket: boolean;
  preserveHost: boolean;
  stripPrefix: boolean;
  timeoutSec: number;
  headers: Record<string, string>;
  luaAccess?: string;
  luaContent?: string;
  extra?: string;
  /** serve the "service not running" page when workload upstreams are unreachable (default on) */
  offlinePage?: boolean;
}

export interface ProxyRoute {
  id: string;
  enabled: boolean;
  domains: string[];
  tls: { mode: 'off' | 'on' | 'redirect'; certId?: string };
  http2: boolean;
  hsts: boolean;
  allow: string[];
  deny: string[];
  rateLimit?: { rps: number; burst: number };
  locations: ProxyLocation[];
  lua: { access?: string; headerFilter?: string; bodyFilter?: string; log?: string };
  extra?: string;
  notes?: string;
  waf?: RouteWaf;
  /** LuaRocks packages this route's Lua code requires */
  luaPackages?: LuaPackage[];
}

/** A LuaRocks package installed into the OpenResty container by its agent. */
export interface LuaPackage {
  name: string;
  /** LuaRocks version, e.g. 0.17.1-0; empty = latest */
  version?: string;
}

export interface StreamRoute {
  id: string;
  enabled: boolean;
  listen: number;
  protocol: 'tcp' | 'udp';
  /** server attributes only; Host/TLS don't apply to streams */
  upstreams: Upstream[];
  proxyProtocol: boolean;
  timeoutSec: number;
  allow: string[];
  notes?: string;
}

export const routesColl = new Collection<ProxyRoute>('openresty.routes', 'openresty/http');
export const streamsColl = new Collection<StreamRoute>('openresty.streams', 'openresty/stream');

// route files written before per-upstream options store plain strings
const asUpstream = (u: string | Upstream): Upstream => (typeof u === 'string' ? { target: u } : u);

export async function loadRoutes(): Promise<ProxyRoute[]> {
  return (await routesColl.list()).map((r) => ({
    ...r,
    locations: r.locations.map((l) => ({ ...l, upstreams: (l.upstreams as (string | Upstream)[]).map(asUpstream) })),
  }));
}

export async function loadStreams(): Promise<StreamRoute[]> {
  return (await streamsColl.list()).map((s) => ({ ...s, upstreams: (s.upstreams as (string | Upstream)[]).map(asUpstream) }));
}

// ---------------------------------------------------------------------------
// The VAS UI itself (VAS_PUBLIC_DOMAIN). Generated, never stored, so it
// can't be edited or deleted in the UI; the direct VAS_LISTEN ports remain
// as the fallback when OpenResty is broken.

export const SYSTEM_ROUTE_ID = 'vas-system';
const isReservedId = (id: string) => id.startsWith('vas-');
let warnedDomains = false;

export function systemRoute(): ProxyRoute | null {
  const domains = env.public.domains.filter((d) => {
    const ok = DOMAIN_RE.test(d) && !d.startsWith('*');
    if (!ok && !warnedDomains) log.error(`VAS_PUBLIC_DOMAIN: invalid domain ${d}, ignored`);
    return ok;
  });
  warnedDomains = true;
  if (!domains.length) return null;
  return {
    id: SYSTEM_ROUTE_ID,
    enabled: true,
    domains,
    tls: { mode: env.public.tls, certId: env.public.tls === 'off' ? undefined : env.public.certId },
    http2: true,
    hsts: env.public.hsts,
    allow: env.public.allow,
    deny: [],
    locations: [
      {
        path: '/',
        upstreams: [{ target: env.managerUrl }],
        lb: 'round_robin',
        websocket: true, // terminals, noVNC
        preserveHost: true, // passkeys are bound to this hostname
        stripPrefix: false,
        timeoutSec: 3600, // long-lived consoles and the event stream
        headers: {},
        // live updates are server-sent events; uploads go straight through
        extra: 'proxy_buffering off;\nproxy_request_buffering off;\nclient_max_body_size 0;',
        offlinePage: false,
      },
    ],
    lua: {},
    waf: { mode: env.public.waf, excludeRules: [], excludePaths: [], customRules: [] },
    notes: 'VAS UI (VAS_PUBLIC_DOMAIN)',
  };
}

const CONF_ROOT = '/etc/openresty/vas';
/** CA store in the OpenResty (Alpine) image, used when verifying without a custom CA */
const SYSTEM_CA = '/etc/ssl/certs/ca-certificates.crt';
const HOST_HEADER_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})(:\d{1,5})?$/;
const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const CIDR_RE = /^(all|[0-9.]+(\/\d{1,2})?|[0-9a-fA-F:]+(\/\d{1,3})?)$/;
const HOSTPORT_RE = /^([\w.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/;
const LOCATION_RE = /^(=\s*|\^~\s*|~\*?\s*)?\/[^\s;{}'"]*$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;

// ---------------------------------------------------------------------------
// validation

function strList(v: unknown): string[] {
  return (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
}

function parseUpstreamUrl(u: string): { scheme: string; hostport: string; path: string } {
  const m = u.match(/^(https?):\/\/([\w.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?(\/[\w./%~-]*)?$/);
  if (!m) throw new HttpError(400, `invalid upstream URL ${u} (expected http(s)://host:port[/path])`);
  const port = m[3] ?? (m[1] === 'https' ? '443' : '80');
  return { scheme: m[1], hostport: `${m[2]}:${port}`, path: m[4] ?? '' };
}

/** A route upstream is either an http(s) URL or a workload reference (compose://, podman://, lxc://, vm://). */
function upstreamTarget(u: string): { scheme: string; path: string; ref?: TargetRef } {
  const ref = parseRef(u);
  if (ref) return { scheme: ref.scheme ?? 'http', path: '', ref };
  const p = parseUpstreamUrl(u);
  return { scheme: p.scheme, path: p.path };
}

function normalizeHttpUpstream(u: string): string {
  const ref = parseRef(u);
  if (ref) return formatRef(ref);
  parseUpstreamUrl(u);
  return u;
}

function normalizeStreamUpstream(u: string): string {
  const ref = parseRef(u);
  if (ref) {
    if (ref.scheme) throw new HttpError(400, `stream upstream ${u}: http/https prefixes only apply to HTTP routes`);
    return formatRef(ref);
  }
  if (!HOSTPORT_RE.test(u)) throw new HttpError(400, `invalid upstream ${u}`);
  return u;
}

const LUA_PKG_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
const LUA_VER_RE = /^[\w.-]{1,32}$/;

/** Accepts [{name, version}] or "name", "name version", "name@version" strings. */
export function validateLuaPackages(raw: unknown): LuaPackage[] {
  const list: unknown[] = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,]+/);
  const out: LuaPackage[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    let name = '';
    let version: string | undefined;
    if (item && typeof item === 'object') {
      name = String((item as any).name ?? '').trim();
      version = (item as any).version ? String((item as any).version).trim() : undefined;
    } else {
      const [n, v] = String(item ?? '').trim().split(/[\s@]+/);
      name = n ?? '';
      version = v || undefined;
    }
    if (!name) continue;
    if (!LUA_PKG_RE.test(name)) throw new HttpError(400, `invalid Lua package name "${name}"`);
    if (version && !LUA_VER_RE.test(version)) throw new HttpError(400, `invalid version "${version}" for ${name}`);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(version ? { name, version } : { name });
  }
  return out;
}

/** LuaRocks --server value: an http(s) URL, or empty for luarocks.org. */
export function validateLuarocksServer(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\/[^\s'"`$\\;|&<>]+$/.test(s)) throw new HttpError(400, 'LuaRocks server must be an http(s) URL');
  return s;
}

/** Packages to install: global ones plus every enabled route's, de-duplicated (first version given wins). */
export function wantedLuaPackages(routes: ProxyRoute[], s: Settings['openresty']) {
  const m = new Map<string, LuaPackage & { sources: string[]; conflict?: boolean }>();
  const add = (p: LuaPackage, source: string) => {
    const cur = m.get(p.name);
    if (!cur) {
      m.set(p.name, { ...p, sources: [source] });
      return;
    }
    cur.sources.push(source);
    if (!cur.version && p.version) cur.version = p.version;
    else if (p.version && cur.version !== p.version) cur.conflict = true;
  };
  for (const p of s.luaPackages ?? []) add(p, 'global');
  for (const r of routes) for (const p of r.luaPackages ?? []) add(p, r.id);
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function optInt(v: unknown, min: number, max: number, what: string, target: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${target}: ${what} must be ${min}..${max}`);
  return n;
}

/** Validates one upstream; accepts the legacy plain-string form. */
function validateUpstream(raw: unknown, kind: 'http' | 'stream'): Upstream {
  const o: any = typeof raw === 'string' ? { target: raw } : raw ?? {};
  const target = kind === 'http' ? normalizeHttpUpstream(String(o.target ?? '').trim()) : normalizeStreamUpstream(String(o.target ?? '').trim());
  const u: Upstream = {
    target,
    weight: optInt(o.weight, 1, 1000, 'weight', target),
    backup: o.backup ? true : undefined,
    maxFails: optInt(o.maxFails, 0, 100, 'max fails', target),
    failTimeoutSec: optInt(o.failTimeoutSec, 1, 3600, 'fail timeout', target),
    maxConns: optInt(o.maxConns, 0, 100_000, 'max connections', target),
  };
  if (kind === 'http') {
    if (o.host) {
      const host = String(o.host).trim();
      if (!HOST_HEADER_RE.test(host)) throw new HttpError(400, `${target}: invalid Host header ${host}`);
      u.host = host;
    }
    // TLS options only mean something for https upstreams
    if (o.tls && upstreamTarget(target).scheme === 'https') {
      const t: NonNullable<Upstream['tls']> = {};
      if (o.tls.verify) t.verify = true;
      if (o.tls.sni === false) t.sni = false;
      if (o.tls.serverName) {
        const sn = String(o.tls.serverName).trim().toLowerCase();
        if (!DOMAIN_RE.test(sn) || sn.startsWith('*')) throw new HttpError(400, `${target}: invalid TLS server name ${sn}`);
        t.serverName = sn;
      }
      if (typeof o.tls.trustedCa === 'string' && o.tls.trustedCa.trim()) {
        const pem = o.tls.trustedCa.trim();
        try {
          new crypto.X509Certificate(pem);
        } catch (err) {
          throw new HttpError(400, `${target}: trusted CA is not a valid PEM certificate (${(err as Error).message})`);
        }
        t.trustedCa = pem;
      }
      if (Object.keys(t).length) u.tls = t;
    }
  }
  for (const k of Object.keys(u) as (keyof Upstream)[]) if (u[k] === undefined) delete u[k];
  return u;
}

function validateUpstreams(raw: unknown, kind: 'http' | 'stream', where: string, lb?: string): Upstream[] {
  const list = (Array.isArray(raw) ? raw : strList(raw)).filter((x: any) => (typeof x === 'string' ? x.trim() : String(x?.target ?? '').trim()));
  const ups = list.map((x) => validateUpstream(x, kind));
  if (ups.length && ups.every((u) => u.backup)) throw new HttpError(400, `${where}: at least one upstream must not be a backup`);
  if (lb === 'ip_hash' && ups.some((u) => u.backup)) throw new HttpError(400, `${where}: backup upstreams cannot be combined with ip_hash`);
  if (kind === 'http') {
    const schemes = new Set(ups.map((u) => upstreamTarget(u.target).scheme));
    if (schemes.size > 1) throw new HttpError(400, `${where}: upstreams must share one scheme`);
    const conn = new Set(ups.map((u) => JSON.stringify({ host: u.host ?? null, tls: u.tls ?? null })));
    if (conn.size > 1) {
      throw new HttpError(400, `${where}: all upstreams must use the same Host header and TLS options (nginx applies them per location; use a separate location for different settings)`);
    }
  }
  return ups;
}

function validateRoute(b: any, id: string): ProxyRoute {
  const domains = strList(b.domains).map((d) => d.toLowerCase());
  if (!domains.length) throw new HttpError(400, 'at least one domain is required');
  for (const d of domains) if (!DOMAIN_RE.test(d)) throw new HttpError(400, `invalid domain ${d}`);
  const locations: ProxyLocation[] = (Array.isArray(b.locations) && b.locations.length ? b.locations : [{ path: '/' }]).map(
    (l: any) => {
      const p = String(l.path || '/').trim();
      if (!LOCATION_RE.test(p)) throw new HttpError(400, `invalid location ${p}`);
      const lb = ['round_robin', 'least_conn', 'ip_hash'].includes(l.lb) ? l.lb : 'round_robin';
      const upstreams = validateUpstreams(l.upstreams, 'http', `location ${p}`, lb);
      if (!upstreams.length && !l.luaContent) throw new HttpError(400, `location ${p} needs an upstream or Lua content`);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries<string>(l.headers ?? {})) {
        if (!HEADER_RE.test(k) || /["\n\r;]/.test(String(v))) throw new HttpError(400, `invalid header ${k}`);
        headers[k] = String(v);
      }
      return {
        path: p,
        upstreams,
        lb,
        websocket: l.websocket !== false,
        preserveHost: l.preserveHost !== false,
        stripPrefix: !!l.stripPrefix,
        timeoutSec: Math.max(1, Math.min(86400, Number(l.timeoutSec) || 60)),
        headers,
        luaAccess: l.luaAccess || undefined,
        luaContent: l.luaContent || undefined,
        extra: l.extra || undefined,
        offlinePage: l.offlinePage !== false,
      };
    },
  );
  const allow = strList(b.allow);
  const deny = strList(b.deny);
  for (const a of [...allow, ...deny]) if (!CIDR_RE.test(a)) throw new HttpError(400, `invalid address ${a}`);
  const mode = ['off', 'on', 'redirect'].includes(b.tls?.mode) ? b.tls.mode : 'off';
  const certId = b.tls?.certId ? String(b.tls.certId) : undefined;
  if (certId && certId !== 'auto') assertId(certId, 'certificate id');
  const rps = Number(b.rateLimit?.rps);
  return {
    id,
    enabled: b.enabled !== false,
    domains,
    tls: { mode, certId: mode === 'off' ? undefined : certId ?? 'auto' },
    http2: b.http2 !== false,
    hsts: !!b.hsts,
    allow,
    deny,
    rateLimit: rps > 0 ? { rps, burst: Math.max(0, Number(b.rateLimit?.burst) || 0) } : undefined,
    locations,
    lua: {
      access: b.lua?.access || undefined,
      headerFilter: b.lua?.headerFilter || undefined,
      bodyFilter: b.lua?.bodyFilter || undefined,
      log: b.lua?.log || undefined,
    },
    extra: b.extra || undefined,
    notes: typeof b.notes === 'string' ? b.notes.slice(0, 2000) : undefined,
    waf: validateRouteWaf(b.waf),
    luaPackages: validateLuaPackages(b.luaPackages),
  };
}

function validateStream(b: any, id: string): StreamRoute {
  const listen = Number(b.listen);
  if (!Number.isInteger(listen) || listen < 1 || listen > 65535) throw new HttpError(400, 'invalid listen port');
  const upstreams = validateUpstreams(b.upstreams, 'stream', `stream ${id}`);
  if (!upstreams.length) throw new HttpError(400, 'at least one upstream host:port is required');
  const allow = strList(b.allow);
  for (const a of allow) if (!CIDR_RE.test(a)) throw new HttpError(400, `invalid address ${a}`);
  return {
    id,
    enabled: b.enabled !== false,
    listen,
    protocol: b.protocol === 'udp' ? 'udp' : 'tcp',
    upstreams,
    proxyProtocol: !!b.proxyProtocol,
    timeoutSec: Math.max(1, Math.min(86400, Number(b.timeoutSec) || 600)),
    allow,
    notes: typeof b.notes === 'string' ? b.notes.slice(0, 2000) : undefined,
  };
}

// ---------------------------------------------------------------------------
// rendering

const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
const indent = (code: string, n: number) =>
  code
    .split('\n')
    .map((l) => (l.trim() ? ' '.repeat(n) + l : ''))
    .join('\n');

function luaBlock(directive: string, code: string | undefined, n: number): string[] {
  if (!code?.trim()) return [];
  return [`${' '.repeat(n)}${directive} {`, indent(code.trim(), n + 2), `${' '.repeat(n)}}`];
}

function rateLimitLua(r: ProxyRoute): string {
  if (!r.rateLimit) return '';
  return `-- vas rate limit: ${r.rateLimit.rps} r/s, burst ${r.rateLimit.burst}
local limit_req = require "resty.limit.req"
local lim, lerr = limit_req.new("vas_limit", ${r.rateLimit.rps}, ${r.rateLimit.burst})
if lim then
  local delay, err = lim:incoming("${r.id}:" .. ngx.var.binary_remote_addr, true)
  if not delay then
    if err == "rejected" then return ngx.exit(429) end
    ngx.log(ngx.ERR, "rate limit: ", err)
  elseif delay >= 0.001 then
    ngx.sleep(delay)
  end
else
  ngx.log(ngx.ERR, "rate limit init: ", lerr)
end`;
}

interface RenderCtx {
  settings: Settings['openresty'];
  waf: Settings['waf'];
  certFor: (r: ProxyRoute) => string | undefined;
  /** current host:port list for an upstream (static, or resolved from a workload reference) */
  servers: (u: string) => { hostports: string[]; note?: string };
  /** extra bundle files (e.g. upstream CA bundles) */
  files: Record<string, string>;
}

function serverParams(u: Upstream): string {
  return [
    u.weight && u.weight !== 1 ? `weight=${u.weight}` : '',
    `max_fails=${u.maxFails ?? 3}`,
    `fail_timeout=${u.failTimeoutSec ?? 10}s`,
    u.maxConns ? `max_conns=${u.maxConns}` : '',
    u.backup ? 'backup' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Upstream `server` lines. A target that is down/unresolved still needs a
 * syntactically valid upstream, so a `down` placeholder makes nginx answer 502
 * (or use the backups) until the workload is back.
 */
function serverLines(upstreams: Upstream[], ctx: RenderCtx): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let primaries = 0;
  for (const u of upstreams) {
    const { hostports, note } = ctx.servers(u.target);
    const isRef = !!parseRef(u.target);
    if (note || hostports.length === 0) out.push(`    # ${u.target}: ${note ?? 'unresolved'}`);
    for (const hp of hostports) {
      if (seen.has(hp)) continue;
      seen.add(hp);
      if (!u.backup) primaries++;
      out.push(`    server ${hp} ${serverParams(u)};${isRef ? `  # ${u.target}` : ''}`);
    }
  }
  if (!primaries) out.push('    server 127.0.0.1:9 down;  # no live primary target: backups or 502 until it is back');
  return out;
}

/** SNI / verification name: explicit, else the Host override, else the URL's hostname, else the client's Host. */
function sslName(u: Upstream): string {
  if (u.tls?.serverName) return u.tls.serverName;
  if (u.host) return u.host.replace(/:\d+$/, '');
  if (!parseRef(u.target)) {
    const host = parseUpstreamUrl(u.target).hostport.replace(/:\d+$/, '');
    if (!/^[\d.]+$/.test(host) && !host.startsWith('[')) return host;
  }
  return '$host';
}

const OFFLINE_LOCATION = '@vas_offline';

/**
 * Locations proxying to workload references (compose/podman/lxc/vm) get the
 * offline page. Only nginx's own 502 (can't connect / no live upstream) is
 * caught: proxy_intercept_errors stays off, so an app's own 502 responses pass
 * through, and timeouts (504) of a running but slow app are not mislabeled.
 */
function usesOfflinePage(l: ProxyLocation): boolean {
  return !l.luaContent && l.offlinePage !== false && l.upstreams.some((u) => !!parseRef(u.target));
}

function renderLocation(r: ProxyRoute, l: ProxyLocation, idx: number, serverAccess: string, ctx: RenderCtx): string[] {
  const out = [`    location ${l.path} {`];
  if (l.luaAccess) out.push(...luaBlock('access_by_lua_block', [serverAccess, l.luaAccess].filter(Boolean).join('\n\n'), 6));
  if (l.luaContent) {
    out.push(...luaBlock('content_by_lua_block', l.luaContent, 6));
  } else {
    // Host/TLS options are identical for all upstreams of a location (validated), take the first
    const conn = l.upstreams[0];
    const up = upstreamTarget(conn.target);
    const name = `vas_${ident(r.id)}_${idx}`;
    // nginx forbids a URI part in proxy_pass inside regex locations
    const isRegex = l.path.startsWith('~');
    const uri = isRegex ? '' : l.stripPrefix && !l.path.startsWith('=') ? up.path || '/' : up.path;
    out.push(
      `      proxy_pass ${up.scheme}://${name}${uri};`,
      '      proxy_http_version 1.1;',
      `      proxy_set_header Host ${conn.host ? `"${conn.host}"` : l.preserveHost ? '$host' : '$proxy_host'};`,
      '      proxy_set_header X-Real-IP $remote_addr;',
      '      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '      proxy_set_header X-Forwarded-Proto $scheme;',
      '      proxy_set_header X-Forwarded-Host $host;',
      `      proxy_set_header Connection ${l.websocket ? '$connection_upgrade' : '""'};`,
    );
    if (l.websocket) out.push('      proxy_set_header Upgrade $http_upgrade;');
    if (up.scheme === 'https') {
      const t = conn.tls ?? {};
      out.push(`      proxy_ssl_server_name ${t.sni === false ? 'off' : 'on'};`, `      proxy_ssl_name ${sslName(conn)};`);
      if (t.verify) {
        let ca = SYSTEM_CA;
        if (t.trustedCa) {
          const file = `upstream-ca/${ident(r.id)}_${idx}.pem`;
          ctx.files[file] = t.trustedCa + '\n';
          ca = `${CONF_ROOT}/${file}`;
        }
        out.push('      proxy_ssl_verify on;', '      proxy_ssl_verify_depth 3;', `      proxy_ssl_trusted_certificate ${ca};`);
      } else {
        out.push('      proxy_ssl_verify off;');
      }
    }
    for (const [k, v] of Object.entries(l.headers)) out.push(`      proxy_set_header ${k} "${v}";`);
    out.push(
      `      proxy_connect_timeout ${Math.min(l.timeoutSec, 75)}s;`,
      `      proxy_read_timeout ${l.timeoutSec}s;`,
      `      proxy_send_timeout ${l.timeoutSec}s;`,
    );
    if (usesOfflinePage(l)) out.push(`      error_page 502 = ${OFFLINE_LOCATION};`);
  }
  if (l.extra) out.push(indent(l.extra.trim(), 6));
  out.push('    }');
  return out;
}

function renderRoute(r: ProxyRoute, ctx: RenderCtx): string {
  const { httpPort, httpsPort } = ctx.settings;
  const lines: string[] = [`# route ${r.id} — generated by vas, do not edit`];

  // upstream blocks
  r.locations.forEach((l, i) => {
    if (l.luaContent || !l.upstreams.length) return;
    lines.push(`upstream vas_${ident(r.id)}_${i} {`);
    if (l.lb === 'least_conn') lines.push('    least_conn;');
    if (l.lb === 'ip_hash') lines.push('    ip_hash;');
    lines.push(...serverLines(l.upstreams, ctx));
    lines.push('    keepalive 16;', '}');
  });

  const certId = r.tls.mode !== 'off' ? ctx.certFor(r) : undefined;
  const tls = r.tls.mode !== 'off' && !!certId;
  if (r.tls.mode !== 'off' && !certId) lines.push(`# WARNING: no issued certificate for ${r.domains.join(' ')}, TLS disabled`);
  const names = r.domains.join(' ');
  // WAF first, so blocked requests don't consume rate-limit budget or reach custom Lua
  const waf = effectiveMode(r, ctx.waf) !== 'off';
  const serverAccess = [waf ? wafAccessLua(r.id) : '', rateLimitLua(r), r.lua.access ?? ''].filter(Boolean).join('\n\n');

  const body: string[] = [];
  if (r.hsts && tls) body.push('    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;');
  for (const a of r.allow) body.push(`    allow ${a};`);
  for (const d of r.deny) body.push(`    deny ${d};`);
  if (r.allow.length && !r.deny.includes('all')) body.push('    deny all;');
  body.push(...luaBlock('access_by_lua_block', serverAccess, 4));
  body.push(...luaBlock('header_filter_by_lua_block', r.lua.headerFilter, 4));
  body.push(...luaBlock('body_filter_by_lua_block', r.lua.bodyFilter, 4));
  body.push(...luaBlock('log_by_lua_block', r.lua.log, 4));
  // the WAF only inspects bodies nginx keeps in memory
  if (waf && ctx.waf.bodyLimitKb > 0) body.push(`    client_body_buffer_size ${Math.max(16, ctx.waf.bodyLimitKb)}k;`);
  if (r.extra) body.push(indent(r.extra.trim(), 4));
  r.locations.forEach((l, i) => body.push(...renderLocation(r, l, i, serverAccess, ctx)));
  if (r.locations.some(usesOfflinePage)) {
    body.push(
      `    location ${OFFLINE_LOCATION} {`,
      '      content_by_lua_block {',
      '        require("vas_offline").serve()',
      '      }',
      '    }',
    );
  }

  const tlsLines = tls
    ? [
        `    listen ${httpsPort} ssl;`,
        `    listen [::]:${httpsPort} ssl;`,
        ...(r.http2 ? ['    http2 on;'] : []),
        `    ssl_certificate ${CONF_ROOT}/certs/${certId}/fullchain.pem;`,
        `    ssl_certificate_key ${CONF_ROOT}/certs/${certId}/key.pem;`,
      ]
    : [];

  if (tls && r.tls.mode === 'redirect') {
    lines.push(
      'server {',
      `    listen ${httpPort};`,
      `    listen [::]:${httpPort};`,
      `    server_name ${names};`,
      '    location / { return 301 https://$host$request_uri; }',
      '}',
      'server {',
      ...tlsLines,
      `    server_name ${names};`,
      ...body,
      '}',
    );
  } else {
    lines.push(
      'server {',
      `    listen ${httpPort};`,
      `    listen [::]:${httpPort};`,
      ...tlsLines,
      `    server_name ${names};`,
      ...body,
      '}',
    );
  }
  return lines.join('\n') + '\n';
}

function renderStream(s: StreamRoute, ctx: RenderCtx): string {
  const name = `vas_s_${ident(s.id)}`;
  const udp = s.protocol === 'udp' ? ' udp' : '';
  const lines = [
    `# stream ${s.id} — generated by vas, do not edit`,
    `upstream ${name} {`,
    ...serverLines(s.upstreams, ctx),
    '}',
    'server {',
    `    listen ${s.listen}${udp};`,
    `    listen [::]:${s.listen}${udp};`,
    `    proxy_pass ${name};`,
    `    proxy_timeout ${s.timeoutSec}s;`,
  ];
  if (s.proxyProtocol) lines.push('    proxy_protocol on;');
  for (const a of s.allow) lines.push(`    allow ${a};`);
  if (s.allow.length) lines.push('    deny all;');
  lines.push('}');
  return lines.join('\n') + '\n';
}

function renderGlobal(s: Settings['openresty']): string {
  const lines = [
    '# global http settings — generated by vas',
    `client_max_body_size ${/^\d+[kmg]?$/i.test(s.clientMaxBodySize) ? s.clientMaxBodySize : '100m'};`,
  ];
  if (s.resolver && /^[\w.: \[\]-]+$/.test(s.resolver)) lines.push(`resolver ${s.resolver} valid=60s ipv6=off;`);
  if (s.globalHttpConfig.trim()) lines.push(s.globalHttpConfig.trim());
  return lines.join('\n') + '\n';
}

function renderDefaultServer(s: Settings['openresty']): string {
  const manager =
    s.defaultServer === 'manager'
      ? `    location / {
        proxy_pass ${env.managerUrl};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
    }`
      : '    return 444;';
  return `# default server — generated by vas
server {
    listen ${s.httpPort} default_server;
    listen [::]:${s.httpPort} default_server;
    server_name _;
${manager}
}
server {
    listen ${s.httpsPort} ssl default_server;
    listen [::]:${s.httpsPort} ssl default_server;
    server_name _;
    ssl_reject_handshake on;
}
`;
}

export interface Bundle {
  revision: string;
  generatedAt: string;
  files: Record<string, string>;
  /** resolution of workload references (manager-side only, not sent to the agent) */
  targets?: Record<string, Resolution>;
}

const stateFile = () => path.join(env.stateDir, 'openresty-agent.json');
interface AgentState {
  nonce: string;
  lastSeen?: string;
  appliedRevision?: string;
  lastReport?: { ok: boolean; message: string; revision: string; ts: string; hostname?: string; version?: string };
  /** LuaRocks install results reported by the agent */
  luaPackages?: { name: string; version?: string; installed?: string; ok: boolean; message?: string; at?: string }[];
  luaPackagesAt?: string;
}
let agentState: AgentState | null = null;

async function getAgentState(): Promise<AgentState> {
  if (!agentState) agentState = await readJson<AgentState>(stateFile(), { nonce: '' });
  return agentState;
}

export async function buildBundle(): Promise<Bundle> {
  const allSettings = await getSettings();
  const settings = allSettings.openresty;
  const sys = systemRoute();
  const routes = [...(sys ? [sys] : []), ...(await loadRoutes()).filter((r) => r.enabled && !isReservedId(r.id))];
  const streams = (await loadStreams()).filter((s) => s.enabled);
  const files: Record<string, string> = {};

  // resolve certificates, include the PEMs that are actually referenced
  const certIds = new Set((await certificates.list()).map((c) => c.id));
  const resolved = new Map<string, string | undefined>();
  for (const r of routes) {
    if (r.tls.mode === 'off') continue;
    const want = r.tls.certId && r.tls.certId !== 'auto' ? r.tls.certId : await matchCertificate(r.domains);
    const files0 = want && certIds.has(want) ? await readCertFiles(want) : null;
    resolved.set(r.id, files0 ? want : undefined);
    if (files0 && want) {
      files[`certs/${want}/fullchain.pem`] = files0.fullchain;
      files[`certs/${want}/key.pem`] = files0.key;
    }
  }
  // resolve workload references (compose://, podman://, lxc://, vm://) to their current addresses
  const upstreams = [...routes.flatMap((r) => r.locations.flatMap((l) => l.upstreams)), ...streams.flatMap((s) => s.upstreams)];
  const targets = await resolveRefs(upstreams.map((u) => u.target));
  const ctx: RenderCtx = {
    settings,
    waf: allSettings.waf,
    files,
    certFor: (r) => resolved.get(r.id),
    servers: (u) => {
      const ref = parseRef(u);
      if (!ref) return { hostports: [u.includes('://') ? parseUpstreamUrl(u).hostport : u] };
      const res = targets[formatRef(ref, false)];
      return { hostports: res?.addresses ?? [], note: res?.note };
    },
  };

  // WAF: engine + config, shared memory for events and the IP blocklist (http level)
  const waf = wafBundle(routes, allSettings.waf);
  Object.assign(files, waf.files);
  files['http/00-global.conf'] = renderGlobal(settings) + waf.httpConf;
  files['http/01-default.conf'] = renderDefaultServer(settings);
  for (const r of routes) files[`http/route-${r.id}.conf`] = renderRoute(r, ctx);
  for (const s of streams) files[`stream/stream-${s.id}.conf`] = renderStream(s, ctx);
  files['lua/vas_user/init_worker.lua'] = [
    '-- generated by vas: runs in every worker after the agent',
    '-- WAF event shipping (privileged agent only)',
    'pcall(function() require("vas_waf").init_worker() end)',
    settings.initWorkerLua || '',
    '',
  ].join('\n');
  files['lua/vas_offline.lua'] = OFFLINE_LUA;
  // installed by the agent with LuaRocks before the config is applied
  files['luarocks/packages.json'] =
    JSON.stringify({
      server: settings.luarocksServer || undefined,
      packages: wantedLuaPackages(routes, settings).map(({ name, version }) => (version ? { name, version } : { name })),
    }) + '\n';
  if (settings.offlineHtml?.trim()) files['offline.html'] = settings.offlineHtml;
  if (settings.ipv6 === false) {
    for (const k of Object.keys(files)) {
      if (k.endsWith('.conf')) files[k] = files[k].replace(/^[ \t]*listen \[::\]:.*\n/gm, '');
    }
  }

  const st = await getAgentState();
  const h = crypto.createHash('sha256');
  h.update(st.nonce);
  for (const k of Object.keys(files).sort()) h.update(k).update('\0').update(files[k]).update('\0');
  const revision = h.digest('hex').slice(0, 16);
  return { revision, generatedAt: new Date().toISOString(), files, targets };
}

/**
 * Rebuilds the bundle periodically so address changes of referenced
 * workloads (container re-created, VM got a new lease...) are logged and the
 * UI refreshes. The agent picks the new revision up on its own next poll.
 */
export function startUpstreamWatcher(): void {
  let last: Record<string, Resolution> | null = null;
  let lastRevision = '';
  setInterval(async () => {
    try {
      const b = await buildBundle();
      const now = b.targets ?? {};
      if (last) {
        for (const [k, v] of Object.entries(now)) {
          const before = last[k]?.addresses.join(', ') || last[k]?.note || 'none';
          const after = v.addresses.join(', ') || v.note || 'none';
          if (before !== after) log.info(`upstream ${k}: ${before} → ${after}`);
        }
      }
      if (lastRevision && b.revision !== lastRevision) bus.changed('openresty');
      last = now;
      lastRevision = b.revision;
    } catch (err) {
      log.warn('upstream watcher failed', { error: (err as Error).message });
    }
  }, 10_000);
}

/** Ports OpenResty will listen on, for the port map and conflict checks. */
export async function openrestyReservations(): Promise<{ port: number; protocol: string; owner: string; detail: string }[]> {
  const s = (await getSettings()).openresty;
  const out = [
    { port: s.httpPort, protocol: 'tcp', owner: 'openresty', detail: 'http' },
    { port: s.httpsPort, protocol: 'tcp', owner: 'openresty', detail: 'https' },
  ];
  for (const st of await loadStreams()) {
    if (st.enabled) out.push({ port: st.listen, protocol: st.protocol, owner: 'openresty', detail: `stream ${st.id} → ${st.upstreams.map((u) => u.target).join(', ')}` });
  }
  return out;
}

export function routes(app: FastifyInstance): void {
  app.get('/api/openresty', async () => {
    const st = await getAgentState();
    const bundle = await buildBundle();
    const online = st.lastSeen ? Date.now() - Date.parse(st.lastSeen) < 30_000 : false;
    const routes = (await loadRoutes()).filter((r) => !isReservedId(r.id));
    const status = new Map((st.luaPackages ?? []).map((p) => [p.name, p]));
    return {
      routes,
      /** route for the VAS UI itself, generated from VAS_PUBLIC_* (read-only) */
      system: systemRoute(),
      streams: await loadStreams(),
      settings: (await getSettings()).openresty,
      revision: bundle.revision,
      /** current addresses of workload references, keyed by ref without http(s)+ prefix */
      targets: bundle.targets ?? {},
      agent: { ...st, online, inSync: st.appliedRevision === bundle.revision },
      /** LuaRocks packages wanted by the global settings and enabled routes, with the agent's install result */
      luaPackages: wantedLuaPackages(
        routes.filter((r) => r.enabled),
        (await getSettings()).openresty,
      ).map((p) => ({ ...p, status: status.get(p.name) ?? null })),
    };
  });

  app.get('/api/openresty/targets', async () => listTargets());

  app.get('/api/openresty/preview', async () => {
    const b = await buildBundle();
    for (const k of Object.keys(b.files)) if (k.endsWith('key.pem')) b.files[k] = '# private key hidden';
    return b;
  });

  app.put('/api/openresty/routes/:id', async (req) => {
    const id = assertId((req.params as any).id, 'route id');
    if (isReservedId(id)) throw new HttpError(400, `route ids starting with "vas-" are reserved`);
    const r = validateRoute(req.body, id);
    const taken = (r.domains ?? []).filter((d) => env.public.domains.includes(d));
    if (taken.length) throw new HttpError(409, `${taken.join(', ')} is served by the VAS UI route (VAS_PUBLIC_DOMAIN)`);
    await routesColl.put(r);
    bus.publish({ type: 'ports' });
    return r;
  });

  app.delete('/api/openresty/routes/:id', async (req) => {
    const id = assertId((req.params as any).id);
    if (isReservedId(id)) throw new HttpError(400, 'the VAS UI route is configured with VAS_PUBLIC_* variables');
    await routesColl.remove(id);
    return { ok: true };
  });

  app.put('/api/openresty/streams/:id', async (req) => {
    const id = assertId((req.params as any).id, 'stream id');
    const s = validateStream(req.body, id);
    const settings = (await getSettings()).openresty;
    const clash = (await streamsColl.list()).find((x) => x.id !== id && x.listen === s.listen && x.protocol === s.protocol);
    if (clash) throw new HttpError(409, `port ${s.listen}/${s.protocol} is already used by stream ${clash.id}`);
    if (s.protocol === 'tcp' && [settings.httpPort, settings.httpsPort, ...env.listen.map((l) => l.port)].includes(s.listen)) {
      throw new HttpError(409, `port ${s.listen} is reserved`);
    }
    await streamsColl.put(s);
    bus.publish({ type: 'ports' });
    return s;
  });

  app.delete('/api/openresty/streams/:id', async (req) => {
    await streamsColl.remove(assertId((req.params as any).id));
    bus.publish({ type: 'ports' });
    return { ok: true };
  });

  app.put('/api/openresty/settings', async (req) => {
    const b = req.body as Partial<Settings['openresty']>;
    const cur = (await getSettings()).openresty;
    const port = (v: unknown, d: number) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536 ? Number(v) : d);
    await updateSettings({
      openresty: {
        ...cur,
        ...b,
        httpPort: port(b.httpPort, cur.httpPort),
        httpsPort: port(b.httpsPort, cur.httpsPort),
        defaultServer: b.defaultServer === 'manager' ? 'manager' : 'drop',
        ipv6: b.ipv6 ?? cur.ipv6,
        offlineHtml: typeof b.offlineHtml === 'string' ? b.offlineHtml.slice(0, 200_000) : cur.offlineHtml,
        luaPackages: b.luaPackages === undefined ? cur.luaPackages : validateLuaPackages(b.luaPackages),
        luarocksServer: b.luarocksServer === undefined ? cur.luarocksServer : validateLuarocksServer(b.luarocksServer),
      },
    });
    bus.publish({ type: 'ports' });
    return { ok: true };
  });

  app.post('/api/openresty/reapply', async () => {
    const st = await getAgentState();
    st.nonce = crypto.randomBytes(4).toString('hex');
    await writeJson(stateFile(), st);
    bus.changed('openresty');
    return { ok: true };
  });

  // ---- agent API (pulled by the Lua agent inside the OpenResty container)
  app.get('/api/agent/openresty/bundle', async (req, reply) => {
    checkAgentRequest(req);
    const st = await getAgentState();
    st.lastSeen = new Date().toISOString();
    const bundle = await buildBundle();
    // `failed` = revision the agent already rejected; don't resend it until something changes
    const { have, failed } = req.query as { have?: string; failed?: string };
    if ((have && have === bundle.revision) || (failed && failed === bundle.revision)) {
      reply.code(204);
      return null;
    }
    return { revision: bundle.revision, generatedAt: bundle.generatedAt, files: bundle.files };
  });

  app.post('/api/agent/openresty/report', async (req) => {
    checkAgentRequest(req);
    const b = req.body as { revision: string; ok: boolean; message?: string; hostname?: string; version?: string };
    const st = await getAgentState();
    st.lastSeen = new Date().toISOString();
    st.lastReport = {
      ok: !!b.ok,
      message: String(b.message ?? '').slice(0, 8000),
      revision: String(b.revision ?? ''),
      ts: new Date().toISOString(),
      hostname: b.hostname,
      version: b.version,
    };
    if (b.ok) st.appliedRevision = String(b.revision);
    await writeJson(stateFile(), st);
    if (b.ok) log.info(`agent applied revision ${b.revision}`);
    else {
      // put the decisive line (nginx [emerg], "not found", ...) into the headline
      const lines = st.lastReport.message.split('\n').map((l) => l.trim()).filter(Boolean);
      const reason = lines.find((l) => /\[emerg\]|\[crit\]|not found|failed/i.test(l)) ?? lines.at(-1) ?? 'no output';
      log.error(`agent failed to apply revision ${b.revision}: ${reason}`, { message: st.lastReport.message });
    }
    bus.changed('openresty');
    bus.publish({ type: 'ports' });
    return { ok: true };
  });

  // LuaRocks results: sent by the agent after every package sync
  app.post('/api/agent/openresty/lua-packages', async (req) => {
    checkAgentRequest(req);
    const b = req.body as { packages?: any[] };
    const st = await getAgentState();
    const now = new Date().toISOString();
    st.lastSeen = now;
    st.luaPackagesAt = now;
    st.luaPackages = (Array.isArray(b?.packages) ? b.packages : []).slice(0, 500).map((p) => ({
      name: String(p?.name ?? '').slice(0, 64),
      version: p?.version ? String(p.version).slice(0, 32) : undefined,
      installed: p?.installed ? String(p.installed).slice(0, 32) : undefined,
      ok: !!p?.ok,
      message: p?.message ? String(p.message).slice(-4000) : undefined,
      at: p?.at ? String(p.at) : now,
    }));
    await writeJson(stateFile(), st);
    for (const p of st.luaPackages) {
      if (!p.ok) log.error(`LuaRocks: ${p.name} could not be installed`, { message: p.message });
    }
    bus.changed('openresty');
    return { ok: true };
  });
}
