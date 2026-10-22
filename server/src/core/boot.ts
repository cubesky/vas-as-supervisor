import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { createLogger, flushLogs, recentLogs } from './logger.js';
import { readJsonSync } from './store.js';

const log = createLogger('boot');

interface BootRecord {
  ts: string;
  pid: number;
  /** null while this boot is still running */
  clean: boolean | null;
}

const historyFile = () => path.join(env.stateDir, 'boot-history.json');
const runningFlag = () => path.join(env.stateDir, 'running.flag');
const crashDir = () => path.join(env.logDir, 'crashes');

let history: BootRecord[] = [];
let safeMode = false;
let safeModeReason = '';

function saveHistory(): void {
  fs.mkdirSync(env.stateDir, { recursive: true });
  fs.writeFileSync(historyFile(), JSON.stringify({ boots: history.slice(-50) }, null, 2));
}

/**
 * Startup crash management. A flag file exists while the manager runs; if it
 * is still present at the next start, the previous run crashed (or was killed).
 * Too many unclean starts inside the window put the manager into safe mode,
 * which disables autostart and the watchdog so a bad instance cannot keep
 * crashing the host on every boot.
 */
export function initBoot(): void {
  fs.mkdirSync(env.stateDir, { recursive: true });
  history = readJsonSync<{ boots: BootRecord[] }>(historyFile(), { boots: [] }).boots;
  const last = history.at(-1);
  if (fs.existsSync(runningFlag()) && last && last.clean === null) {
    last.clean = false;
    log.warn('previous run did not shut down cleanly', { since: last.ts, pid: last.pid });
  } else if (last && last.clean === null) {
    last.clean = true;
  }
  history.push({ ts: new Date().toISOString(), pid: process.pid, clean: null });

  const cutoff = Date.now() - env.crashLoopWindowSec * 1000;
  const unclean = history.filter((b) => b.clean === false && Date.parse(b.ts) >= cutoff).length;
  if (env.safeMode === 'on') {
    safeMode = true;
    safeModeReason = 'forced by VAS_SAFE_MODE=on';
  } else if (env.safeMode === 'auto' && unclean >= env.crashLoopThreshold) {
    safeMode = true;
    safeModeReason = `${unclean} unclean starts within ${env.crashLoopWindowSec}s`;
  }
  if (safeMode) log.warn(`SAFE MODE enabled: ${safeModeReason}. Autostart and watchdog are disabled.`);

  fs.writeFileSync(runningFlag(), String(process.pid));
  saveHistory();
}

export function markCleanShutdown(): void {
  const cur = history.at(-1);
  if (cur) cur.clean = true;
  try {
    saveHistory();
    fs.rmSync(runningFlag(), { force: true });
  } catch {
    /* state dir may be gone */
  }
}

export function bootStatus() {
  return { safeMode, safeModeReason, boots: history.slice(-20).reverse() };
}

export function isSafeMode(): boolean {
  return safeMode;
}

export function exitSafeMode(): void {
  safeMode = false;
  safeModeReason = '';
  log.info('safe mode cleared by operator');
}

export function writeCrashReport(kind: string, err: unknown, extra?: unknown): string {
  const ts = new Date().toISOString();
  const name = `${ts.replace(/[:.]/g, '-')}-${kind.replace(/[^\w-]/g, '_')}.json`;
  const e = err instanceof Error ? err : new Error(String(err));
  try {
    fs.mkdirSync(crashDir(), { recursive: true });
    fs.writeFileSync(
      path.join(crashDir(), name),
      JSON.stringify(
        { ts, kind, message: e.message, stack: e.stack, extra, recentLogs: recentLogs({ limit: 200 }) },
        null,
        2,
      ),
    );
  } catch {
    /* best effort */
  }
  return name;
}

export function listCrashReports(): { name: string; ts: string; kind: string; message: string }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(crashDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .slice(0, 100)
    .map((name) => {
      const r = readJsonSync<any>(path.join(crashDir(), name), {});
      return { name, ts: r.ts, kind: r.kind, message: r.message };
    });
}

export function readCrashReport(name: string): unknown {
  if (!/^[\w.-]+\.json$/.test(name)) return null;
  return readJsonSync(path.join(crashDir(), name), null);
}

export function installCrashHandlers(onFatal: () => Promise<void>): void {
  const fatal = (kind: string) => (err: unknown) => {
    const report = writeCrashReport(kind, err);
    log.error(`fatal ${kind}, crash report ${report}`, err);
    // keep the running flag so the next start counts this as unclean
    void Promise.race([onFatal(), new Promise((r) => setTimeout(r, 3000))])
      .then(() => flushLogs())
      .finally(() => process.exit(1));
  };
  process.on('uncaughtException', fatal('uncaughtException'));
  process.on('unhandledRejection', fatal('unhandledRejection'));
}
