import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env } from '../core/env.js';
import { bus } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import { HttpError, getSettings, updateSettings, type Settings } from '../core/store.js';
import { checkAgentRequest } from './auth.js';
import { WAF_LUA } from './waf-lua.js';
import { WAF_RULES, type WafTarget } from './waf-rules.js';
// openresty.ts imports this module too; only functions are used across the cycle, never at load time
import { loadRoutes, routesColl, systemRoute, SYSTEM_ROUTE_ID, type ProxyRoute } from './openresty.js';

/**
 * Web application firewall for OpenResty routes. The rule engine runs in
 * OpenResty (waf-lua.ts) and is configured from here through the config
 * bundle; blocked/detected requests come back as events posted by the
 * OpenResty agent process.
 */

const log = createLogger('waf');

export type WafMode = 'off' | 'detect' | 'block';

export interface WafCustomRule {
  id: string;
  name: string;
  enabled: boolean;
  /** a built-in target, "ip", or "header:<Name>" */
  target: string;
  match: 'regex' | 'contains' | 'equals';
  value: string;
  action: 'block' | 'log' | 'allow';
}

/** Per-route WAF settings; `inherit` uses the global default mode. */
export interface RouteWaf {
  mode: 'inherit' | WafMode;
  paranoia?: 1 | 2 | 3;
  threshold?: number;
  excludeRules: number[];
  excludePaths: string[];
  customRules: WafCustomRule[];
}

const TARGETS: (WafTarget | 'ip')[] = ['uri', 'raw_uri', 'args', 'body', 'cookies', 'ua', 'referer', 'headers', 'method', 'ip'];
const RULE_IDS = new Set(WAF_RULES.map((r) => r.id));

export function validateRouteWaf(raw: any): RouteWaf | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const mode = ['inherit', 'off', 'detect', 'block'].includes(raw.mode) ? raw.mode : 'inherit';
  const paranoia = [1, 2, 3].includes(Number(raw.paranoia)) ? (Number(raw.paranoia) as 1 | 2 | 3) : undefined;
  const threshold = raw.threshold === undefined || raw.threshold === null || raw.threshold === '' ? undefined : Number(raw.threshold);
  if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 1 || threshold > 100)) throw new HttpError(400, 'WAF threshold must be 1..100');
  const ids: number[] = (Array.isArray(raw.excludeRules) ? raw.excludeRules : []).map(Number);
  const excludeRules = [...new Set(ids)].filter((n) => RULE_IDS.has(n));
  const excludePaths = (Array.isArray(raw.excludePaths) ? raw.excludePaths : [])
    .map((p: unknown) => String(p).trim())
    .filter(Boolean);
  for (const p of excludePaths) if (!/^\/[^\s"'\\]*$/.test(p)) throw new HttpError(400, `WAF exclusion path must start with / : ${p}`);
  const customRules: WafCustomRule[] = (Array.isArray(raw.customRules) ? raw.customRules : []).map((c: any, i: number) => {
    const target = String(c.target ?? '');
    if (!TARGETS.includes(target as any) && !/^header:[A-Za-z0-9-]{1,64}$/.test(target)) throw new HttpError(400, `WAF custom rule ${i + 1}: invalid target ${target}`);
    const match = ['regex', 'contains', 'equals'].includes(c.match) ? c.match : 'contains';
    const value = String(c.value ?? '');
    if (!value || value.length > 500) throw new HttpError(400, `WAF custom rule ${i + 1}: value must be 1..500 characters`);
    if (match === 'regex') {
      try {
        new RegExp(value);
      } catch (err) {
        throw new HttpError(400, `WAF custom rule ${i + 1}: ${(err as Error).message}`);
      }
    }
    return {
      id: /^[\w-]{1,40}$/.test(c.id ?? '') ? c.id : `custom-${i + 1}`,
      name: String(c.name || `custom rule ${i + 1}`).slice(0, 100),
      enabled: c.enabled !== false,
      target,
      match,
      value,
      action: ['block', 'log', 'allow'].includes(c.action) ? c.action : 'block',
    };
  });
  return { mode, paranoia, threshold, excludeRules, excludePaths, customRules };
}

export function effectiveMode(r: ProxyRoute, s: Settings['waf']): WafMode {
  const m = r.waf?.mode;
  return !m || m === 'inherit' ? s.defaultMode : m;
}

/** access_by_lua snippet for a WAF-enabled server block (engine errors never block traffic) */
export function wafAccessLua(routeId: string): string {
  return `-- vas WAF
do
  local waf = require "vas_waf"
  local ok, verdict = pcall(waf.check, "${routeId}")
  if not ok then
    ngx.log(ngx.ERR, "vas waf: ", verdict)
  elseif verdict then
    return waf.deny(verdict)
  end
end`;
}

/** Files and http-level directives the WAF adds to the OpenResty bundle. */
export function wafBundle(routes: ProxyRoute[], s: Settings['waf']): { files: Record<string, string>; httpConf: string } {
  const routeCfg: Record<string, unknown> = {};
  for (const r of routes) {
    const mode = effectiveMode(r, s);
    if (mode === 'off') continue;
    const w = r.waf;
    routeCfg[r.id] = {
      mode,
      paranoia: w?.paranoia ?? s.paranoia,
      threshold: w?.threshold ?? s.threshold,
      excludeRules: w?.excludeRules ?? [],
      excludePaths: w?.excludePaths ?? [],
      custom: (w?.customRules ?? [])
        .filter((c) => c.enabled)
        .map((c) => ({ id: c.id, name: c.name, target: c.target, kind: c.match, value: c.value, lvalue: c.value.toLowerCase(), action: c.action })),
    };
  }
  const config = {
    rules: WAF_RULES.map((r) => ({
      id: r.id,
      paranoia: r.paranoia,
      severity: r.severity,
      targets: r.targets,
      pattern: r.pattern,
      flags: r.caseless === false ? 'jo' : 'ijo',
      msg: r.msg,
    })),
    disabled: s.disabledRules,
    bodyLimit: s.bodyLimitKb * 1024,
    blockStatus: s.blockStatus,
    routes: routeCfg,
  };
  const httpConf = [
    '# WAF — generated by vas',
    'lua_shared_dict vas_waf 10m;',
    'geo $vas_waf_blocked {',
    '    default 0;',
    ...s.blockedIps.map((b) => `    ${b.cidr} 1;`),
    '}',
    '',
  ].join('\n');
  return { files: { 'lua/vas_waf.lua': WAF_LUA, 'waf/config.json': JSON.stringify(config) + '\n' }, httpConf };
}

// ---------------------------------------------------------------------------
// events

export interface WafEvent {
  ts: number;
  route: string;
  host?: string;
  ip: string;
  method: string;
  uri: string;
  ua?: string;
  action: string;
  mode?: string;
  score: number;
  rules: { id: number | string; msg: string; target?: string; match?: string }[];
  requestId?: string;
}

const eventsFile = () => path.join(env.stateDir, 'waf-events.jsonl');
const MAX_FILE = 20 * 1024 * 1024;
let events: WafEvent[] = [];
let maxEvents = 10000;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);

function sanitize(e: any): WafEvent | null {
  if (!e || typeof e !== 'object' || typeof e.ts !== 'number') return null;
  return {
    ts: e.ts,
    route: str(e.route, 64) ?? '?',
    host: str(e.host, 255),
    ip: str(e.ip, 64) ?? '?',
    method: str(e.method, 16) ?? '?',
    uri: str(e.uri, 512) ?? '',
    ua: str(e.ua, 256),
    action: str(e.action, 16) ?? 'detect',
    mode: str(e.mode, 16),
    score: Number(e.score) || 0,
    rules: (Array.isArray(e.rules) ? e.rules : []).slice(0, 20).map((r: any) => ({
      id: typeof r?.id === 'number' ? r.id : String(r?.id ?? '').slice(0, 40),
      msg: str(r?.msg, 200) ?? '',
      target: str(r?.target, 40),
      match: str(r?.match, 200),
    })),
    requestId: str(e.requestId, 64),
  };
}

export async function initWaf(): Promise<void> {
  maxEvents = (await getSettings()).waf.maxEvents;
  try {
    const text = await fsp.readFile(eventsFile(), 'utf8');
    events = text
      .split('\n')
      .slice(-maxEvents - 1)
      .map((l) => {
        try {
          return sanitize(JSON.parse(l));
        } catch {
          return null;
        }
      })
      .filter((e): e is WafEvent => !!e);
  } catch {
    events = [];
  }
}

let notify: NodeJS.Timeout | null = null;

async function addEvents(list: WafEvent[]): Promise<void> {
  if (!list.length) return;
  events.push(...list);
  if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
  try {
    const st = await fsp.stat(eventsFile()).catch(() => null);
    if (st && st.size > MAX_FILE) await fsp.rename(eventsFile(), `${eventsFile()}.1`);
    await fsp.appendFile(eventsFile(), list.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } catch (err) {
    log.warn(`cannot persist WAF events: ${(err as Error).message}`);
  }
  const blocked = list.filter((e) => e.action === 'block' || e.action === 'blocklist').length;
  if (blocked) log.info(`${blocked} request(s) blocked`, { lastIp: list.at(-1)?.ip });
  // live UI refresh, at most once a second
  notify ??= setTimeout(() => {
    notify = null;
    bus.changed('waf');
  }, 1000);
}

function top<T>(list: T[], key: (e: T) => string | undefined, n = 10): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const e of list) {
    const k = key(e);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
}

function stats() {
  const since = Date.now() / 1000 - 86400;
  const recent = events.filter((e) => e.ts >= since);
  const ruleMsg = new Map<string, string>();
  for (const e of recent) for (const r of e.rules) ruleMsg.set(String(r.id), r.msg);
  return {
    last24h: {
      total: recent.length,
      blocked: recent.filter((e) => e.action === 'block' || e.action === 'blocklist').length,
      detected: recent.filter((e) => e.action === 'detect').length,
      logged: recent.filter((e) => e.action === 'log').length,
    },
    topRules: top(recent.flatMap((e) => e.rules), (r) => String(r.id)).map((t) => ({ ...t, msg: ruleMsg.get(t.key) })),
    topIps: top(recent, (e) => e.ip),
    topRoutes: top(recent, (e) => e.route),
  };
}

// ---------------------------------------------------------------------------
// blocklist

function normalizeCidr(raw: string): string {
  const v = raw.trim();
  const [addr, prefix] = v.split('/');
  const kind = net.isIP(addr);
  if (!kind) throw new HttpError(400, `not an IP address or CIDR: ${raw}`);
  if (prefix !== undefined) {
    const p = Number(prefix);
    if (!/^\d{1,3}$/.test(prefix) || p > (kind === 4 ? 32 : 128)) throw new HttpError(400, `invalid prefix in ${raw}`);
  }
  return prefix === undefined ? addr : `${addr}/${prefix}`;
}

export function routes(app: FastifyInstance): void {
  app.get('/api/waf', async () => {
    const s = (await getSettings()).waf;
    const sys = systemRoute();
    const list = [...(sys ? [sys] : []), ...(await loadRoutes())];
    return {
      settings: s,
      rules: WAF_RULES.map((r) => ({ ...r, enabled: !s.disabledRules.includes(r.id) })),
      routes: list.map((r) => ({ id: r.id, domains: r.domains, mode: effectiveMode(r, s), explicit: r.waf?.mode ?? 'inherit', system: r.id === SYSTEM_ROUTE_ID })),
      stats: stats(),
    };
  });

  app.get('/api/waf/events', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(1000, Number(q.limit) || 200);
    const needle = q.q?.toLowerCase();
    const out: WafEvent[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = events[i];
      if (q.before && e.ts >= Number(q.before)) continue;
      if (q.route && e.route !== q.route) continue;
      if (q.ip && e.ip !== q.ip) continue;
      if (q.action && e.action !== q.action) continue;
      if (q.rule && !e.rules.some((r) => String(r.id) === q.rule)) continue;
      if (needle && !`${e.host} ${e.uri} ${e.ua}`.toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    return out;
  });

  app.delete('/api/waf/events', async () => {
    events = [];
    await fsp.rm(eventsFile(), { force: true });
    bus.changed('waf');
    return { ok: true };
  });

  app.put('/api/waf/settings', async (req) => {
    const b = req.body as Partial<Settings['waf']>;
    const cur = (await getSettings()).waf;
    const int = (v: unknown, min: number, max: number, def: number) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : def);
    const next: Settings['waf'] = {
      ...cur,
      defaultMode: ['off', 'detect', 'block'].includes(b.defaultMode as string) ? (b.defaultMode as WafMode) : cur.defaultMode,
      paranoia: int(b.paranoia, 1, 3, cur.paranoia) as 1 | 2 | 3,
      threshold: int(b.threshold, 1, 100, cur.threshold),
      bodyLimitKb: int(b.bodyLimitKb, 0, 4096, cur.bodyLimitKb),
      blockStatus: [403, 406, 429, 451, 444].includes(Number(b.blockStatus)) ? Number(b.blockStatus) : cur.blockStatus,
      maxEvents: int(b.maxEvents, 100, 1_000_000, cur.maxEvents),
      disabledRules: Array.isArray(b.disabledRules) ? [...new Set(b.disabledRules.map(Number))].filter((n) => RULE_IDS.has(n)) : cur.disabledRules,
    };
    await updateSettings({ waf: next });
    maxEvents = next.maxEvents;
    return next;
  });

  app.post('/api/waf/blocklist', async (req) => {
    const b = req.body as { cidr: string; note?: string };
    const cidr = normalizeCidr(String(b.cidr ?? ''));
    const cur = (await getSettings()).waf;
    if (cur.blockedIps.some((x) => x.cidr === cidr)) return { ok: true, cidr };
    await updateSettings({
      waf: { ...cur, blockedIps: [...cur.blockedIps, { cidr, note: b.note ? String(b.note).slice(0, 200) : undefined, addedAt: new Date().toISOString() }] },
    });
    log.info(`blocklisted ${cidr}`);
    return { ok: true, cidr };
  });

  app.delete('/api/waf/blocklist', async (req) => {
    const cidr = String((req.query as any).cidr ?? '');
    const cur = (await getSettings()).waf;
    await updateSettings({ waf: { ...cur, blockedIps: cur.blockedIps.filter((x) => x.cidr !== cidr) } });
    return { ok: true };
  });

  // one-click false-positive handling from an event
  app.post('/api/waf/exclude', async (req) => {
    const b = req.body as { route: string; rule: number };
    if (b.route === SYSTEM_ROUTE_ID) throw new HttpError(400, 'the VAS UI route is configured with VAS_PUBLIC_* variables');
    if (!RULE_IDS.has(Number(b.rule))) throw new HttpError(400, `unknown rule ${b.rule}`);
    const r = await routesColl.require(b.route);
    const w: RouteWaf = r.waf ?? { mode: 'inherit', excludeRules: [], excludePaths: [], customRules: [] };
    if (!w.excludeRules.includes(Number(b.rule))) w.excludeRules = [...w.excludeRules, Number(b.rule)];
    await routesColl.put({ ...r, waf: w });
    return { ok: true };
  });

  // events from the OpenResty agent process
  app.post('/api/agent/openresty/waf-events', async (req) => {
    checkAgentRequest(req);
    const list = ((req.body as any)?.events ?? []).map(sanitize).filter((e: WafEvent | null): e is WafEvent => !!e);
    await addEvents(list.slice(0, 1000));
    return { ok: true, accepted: list.length };
  });
}
