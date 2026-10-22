import { signal } from '@preact/signals';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
  needsSetup: boolean;
}

export const authState = signal<AuthStatus | null>(null);

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    authState.value = authState.value ? { ...authState.value, authenticated: false } : authState.value;
  }
  if (res.status === 204) return null as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

export const put = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });
export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

export function wsUrl(path: string): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api${path}`;
}

// ---------------------------------------------------------------------------
// server-sent events

export type ServerEvent =
  | { type: 'log'; entry: LogEntry }
  | { type: 'job'; job: JobSummary }
  | { type: 'job-line'; id: string; line: string }
  | { type: 'changed'; topic: string; id?: string }
  | { type: 'ports' };

export interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  msg: string;
  data?: unknown;
}

export interface JobSummary {
  id: string;
  title: string;
  topic: string;
  state: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

type Listener = (ev: ServerEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
export const connected = signal(false);

export function startEvents(): void {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => (connected.value = true);
  source.onerror = () => (connected.value = false);
  source.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data) as ServerEvent;
      for (const l of listeners) l(ev);
    } catch {
      /* ignore */
    }
  };
}

export function stopEvents(): void {
  source?.close();
  source = null;
  connected.value = false;
}

export function onEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useEvent(l: Listener, deps: unknown[] = []): void {
  useEffect(() => onEvent(l), deps);
}

/**
 * Fetches `path` and refetches whenever a `changed` event for one of
 * `topics` arrives (debounced), or a `ports` event when topics include 'ports'.
 */
export function useApi<T = any>(path: string | null, topics: string[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  useEvent(
    (ev) => {
      const hit =
        (ev.type === 'changed' && topics.some((t) => ev.topic === t || ev.topic.startsWith(`${t}.`))) ||
        (ev.type === 'ports' && topics.includes('ports')) ||
        (ev.type === 'job' && ev.job.state !== 'running' && topics.includes(ev.job.topic));
      if (!hit) return;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void reload(), 300);
    },
    [reload, topics.join(',')],
  );

  return { data, error, loading, reload, setData };
}
