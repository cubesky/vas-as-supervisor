import { Collection } from './store.js';
import { createLogger } from './logger.js';
import { isSafeMode } from './boot.js';
import { getSettings } from './store.js';
import { bus } from './events.js';
import type { NicSpec } from '../modules/network.js';

export type InstanceKind = 'compose' | 'lxc' | 'vm';

export interface InstanceMeta {
  id: string;
  kind: InstanceKind;
  autostart: boolean;
  autostartDelaySec: number;
  restartPolicy: 'no' | 'on-failure' | 'always';
  desired: 'running' | 'stopped';
  nic?: NicSpec;
  serialPort?: number;
  notes?: string;
  createdAt: string;
}

export const instanceMeta: Record<InstanceKind, Collection<InstanceMeta>> = {
  compose: new Collection<InstanceMeta>('instances.compose', 'instances/compose'),
  lxc: new Collection<InstanceMeta>('instances.lxc', 'instances/lxc'),
  vm: new Collection<InstanceMeta>('instances.vm', 'instances/vm'),
};

export function defaultMeta(kind: InstanceKind, id: string, over: Partial<InstanceMeta> = {}): InstanceMeta {
  return {
    id,
    kind,
    autostart: false,
    autostartDelaySec: 0,
    restartPolicy: 'no',
    desired: 'stopped',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

export async function getMeta(kind: InstanceKind, id: string): Promise<InstanceMeta> {
  return (await instanceMeta[kind].get(id)) ?? defaultMeta(kind, id);
}

export async function setDesired(kind: InstanceKind, id: string, desired: 'running' | 'stopped'): Promise<void> {
  const m = await getMeta(kind, id);
  if (m.desired !== desired) await instanceMeta[kind].put({ ...m, desired });
  watchdogState.delete(`${kind}/${id}`);
}

// ---------------------------------------------------------------------------
// Watchdog: keeps instances with a restart policy running, with backoff and
// crash-loop detection. Also performs ordered autostart on manager startup.

export interface Driver {
  kind: InstanceKind;
  status(id: string): Promise<{ running: boolean; failed?: boolean; exists: boolean }>;
  start(id: string): Promise<void>;
}

const log = createLogger('watchdog');
const drivers = new Map<InstanceKind, Driver>();
const MAX_RESTARTS = 5;
const WINDOW_MS = 10 * 60_000;

interface WdState {
  attempts: number[];
  crashloop: boolean;
  lastError?: string;
  lastRestart?: string;
}
const watchdogState = new Map<string, WdState>();

export function registerDriver(d: Driver): void {
  drivers.set(d.kind, d);
}

export function watchdogStatus() {
  return Object.fromEntries(watchdogState);
}

export function clearCrashloop(kind: InstanceKind, id: string): void {
  watchdogState.delete(`${kind}/${id}`);
}

async function tick(): Promise<void> {
  for (const [kind, coll] of Object.entries(instanceMeta) as [InstanceKind, Collection<InstanceMeta>][]) {
    const driver = drivers.get(kind);
    if (!driver) continue;
    for (const m of await coll.list()) {
      if (m.restartPolicy === 'no' || m.desired !== 'running') continue;
      const key = `${kind}/${m.id}`;
      const st = watchdogState.get(key) ?? { attempts: [] as number[], crashloop: false };
      if (st.crashloop) continue;
      try {
        const s = await driver.status(m.id);
        if (!s.exists || s.running) continue;
        if (m.restartPolicy === 'on-failure' && s.failed === false) continue;
        const now = Date.now();
        st.attempts = st.attempts.filter((t) => now - t < WINDOW_MS);
        if (st.attempts.length >= MAX_RESTARTS) {
          st.crashloop = true;
          log.error(`${key} is crash looping (${MAX_RESTARTS} restarts in ${WINDOW_MS / 60000} min); giving up until started manually`);
        } else {
          // exponential backoff between attempts
          const last = st.attempts.at(-1) ?? 0;
          const wait = Math.min(300_000, 5000 * 2 ** st.attempts.length);
          if (now - last >= wait) {
            st.attempts.push(now);
            st.lastRestart = new Date().toISOString();
            log.warn(`${key} is not running, restarting (attempt ${st.attempts.length})`);
            await driver.start(m.id);
          }
        }
      } catch (err) {
        st.lastError = (err as Error).message;
        log.error(`${key} restart failed`, { error: st.lastError });
      }
      watchdogState.set(key, st);
      bus.changed(kind, m.id);
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export async function startWatchdog(): Promise<void> {
  const s = await getSettings();
  if (timer) clearInterval(timer);
  if (!s.watchdog.enabled || isSafeMode()) {
    log.info(isSafeMode() ? 'watchdog disabled (safe mode)' : 'watchdog disabled');
    return;
  }
  let busy = false;
  timer = setInterval(async () => {
    if (busy || isSafeMode()) return;
    busy = true;
    await tick().catch((err) => log.error('watchdog tick failed', err));
    busy = false;
  }, Math.max(10, s.watchdog.intervalSec) * 1000);
}

export function stopWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Starts every instance with autostart=true, ordered by delay. Skipped in safe mode. */
export async function runAutostart(): Promise<void> {
  if (isSafeMode()) {
    log.warn('safe mode: autostart skipped');
    return;
  }
  const all: InstanceMeta[] = [];
  for (const coll of Object.values(instanceMeta)) all.push(...(await coll.list()).filter((m) => m.autostart));
  all.sort((a, b) => a.autostartDelaySec - b.autostartDelaySec);
  const t0 = Date.now();
  for (const m of all) {
    const driver = drivers.get(m.kind);
    if (!driver) continue;
    const wait = t0 + m.autostartDelaySec * 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const s = await driver.status(m.id);
      if (!s.exists) {
        log.warn(`autostart: ${m.kind}/${m.id} no longer exists`);
        continue;
      }
      if (!s.running) {
        log.info(`autostart: starting ${m.kind}/${m.id}`);
        await driver.start(m.id);
      }
      await instanceMeta[m.kind].put({ ...m, desired: 'running' });
    } catch (err) {
      log.error(`autostart: ${m.kind}/${m.id} failed`, { error: (err as Error).message });
    }
  }
}
