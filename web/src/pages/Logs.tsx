import { useEffect, useRef, useState } from 'preact/hooks';
import { api, useApi, useEvent, type JobSummary, type LogEntry } from '../api';
import { fmtDate, t } from '../i18n';
import { Badge, Button, Card, Empty, Loading, Modal, PageHeader, Select, Tabs, Toggle } from '../components/ui';
import { openJob } from '../components/JobLog';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function LiveLogs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('info');
  const [q, setQ] = useState('');
  const [paused, setPaused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    api<LogEntry[]>(`/logs?limit=1000&level=${level}`).then(setEntries).catch(() => undefined);
  }, [level]);

  useEvent(
    (ev) => {
      if (ev.type !== 'log' || pausedRef.current) return;
      if (LEVELS.indexOf(ev.entry.level) < LEVELS.indexOf(level)) return;
      setEntries((list) => [...list.slice(-1999), ev.entry]);
    },
    [level],
  );

  useEffect(() => {
    if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [entries.length, paused]);

  const shown = q ? entries.filter((e) => `${e.module} ${e.msg}`.toLowerCase().includes(q.toLowerCase())) : entries;
  return (
    <Card>
      <div class="row gap wrap toolbar">
        <Select label={t('logs.level')} value={level} onChange={setLevel} options={LEVELS.map((l) => ({ value: l, label: l }))} />
        <input class="input" placeholder={t('common.filter')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <Toggle label={t('logs.pause')} checked={paused} onChange={setPaused} />
        <div class="spacer" />
        <Button small onClick={() => setEntries([])}>{t('logs.clear')}</Button>
        <a class="btn btn-sm" href="/api/logs/file?lines=5000" target="_blank" rel="noreferrer">
          {t('logs.file')}
        </a>
      </div>
      <div ref={box} class="logbox tall live">
        {shown.map((e, i) => (
          <div key={i} class={`logline lvl-${e.level}`}>
            <span class="muted">{e.ts.slice(11, 23)}</span> <span class={`lvl lvl-${e.level}`}>{e.level.toUpperCase()}</span> <strong>[{e.module}]</strong> {e.msg}
            {e.data !== undefined && <span class="muted"> {JSON.stringify(e.data)}</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Crashes() {
  const { data, loading } = useApi<any[]>('/crashes', []);
  const [open, setOpen] = useState<any>(null);
  if (loading) return <Loading />;
  return (
    <Card>
      <p class="muted small">{t('logs.crashHint')}</p>
      {!data?.length ? (
        <Empty>{t('logs.noCrashes')}</Empty>
      ) : (
        <table class="table">
          <tbody>
            {data.map((c) => (
              <tr key={c.name}>
                <td class="mono small">{fmtDate(c.ts)}</td>
                <td>
                  <Badge state="error" label={c.kind} />
                </td>
                <td>{c.message}</td>
                <td class="actions">
                  <Button small onClick={async () => setOpen(await api(`/crashes/${c.name}`))}>{t('common.view')}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <Modal title={`${open.kind} — ${fmtDate(open.ts)}`} wide onClose={() => setOpen(null)}>
          <pre class="logbox">{open.stack}</pre>
          {open.extra && <pre class="logbox">{JSON.stringify(open.extra, null, 2)}</pre>}
          <h4>{t('logs.recent')}</h4>
          <pre class="logbox tall">{(open.recentLogs ?? []).map((l: LogEntry) => `${l.ts} ${l.level} [${l.module}] ${l.msg}`).join('\n')}</pre>
        </Modal>
      )}
    </Card>
  );
}

function Processes() {
  const { data, loading } = useApi('/system/processes', ['supervisor', 'lxc', 'vm', 'compose']);
  if (loading) return <Loading />;
  const wd = Object.entries<any>(data?.watchdog ?? {});
  return (
    <>
      <Card title={t('logs.supervised')}>
        {!data?.processes?.length ? (
          <Empty>{t('logs.noProcesses')}</Empty>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>{t('common.state')}</th>
                <th>PID</th>
                <th>{t('logs.restarts')}</th>
                <th>{t('logs.lastExit')}</th>
              </tr>
            </thead>
            <tbody>
              {data.processes.map((p: any) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.id}</strong>
                    <div class="mono small muted">{p.cmd}</div>
                  </td>
                  <td>
                    <Badge state={p.state} />
                  </td>
                  <td class="mono">{p.pid ?? '—'}</td>
                  <td>{p.restarts}</td>
                  <td class="small">{p.lastExit ? `${fmtDate(p.lastExit.ts)} code=${p.lastExit.code} ${p.lastExit.signal ?? ''}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title={t('logs.watchdog')}>
        {wd.length === 0 ? (
          <Empty>{t('logs.watchdogIdle')}</Empty>
        ) : (
          <table class="table">
            <tbody>
              {wd.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <strong>{k}</strong>
                  </td>
                  <td>{v.crashloop ? <Badge state="crashloop" label={t('logs.crashloop')} /> : <Badge state="running" label={t('logs.watching')} />}</td>
                  <td class="small">
                    {t('logs.restarts')}: {v.attempts.length} · {fmtDate(v.lastRestart)}
                  </td>
                  <td class="small error-text">{v.lastError}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function Jobs() {
  const { data, loading } = useApi<JobSummary[]>('/jobs', []);
  const [list, setList] = useState<JobSummary[]>([]);
  useEffect(() => setList(data ?? []), [data]);
  useEvent((ev) => {
    if (ev.type === 'job') setList((l) => [ev.job, ...l.filter((j) => j.id !== ev.job.id)]);
  });
  if (loading) return <Loading />;
  return (
    <Card>
      {list.length === 0 ? (
        <Empty>{t('logs.noJobs')}</Empty>
      ) : (
        <table class="table">
          <tbody>
            {list.map((j) => (
              <tr key={j.id}>
                <td class="mono small">{fmtDate(j.startedAt)}</td>
                <td>
                  <strong>{j.title}</strong>
                  {j.error && <div class="small error-text">{j.error}</div>}
                </td>
                <td>
                  <Badge state={j.state} label={t(`job.${j.state}`)} />
                </td>
                <td class="actions">
                  <Button small onClick={() => openJob(j.id, j.title)}>{t('common.view')}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function Logs() {
  const [tab, setTab] = useState<'live' | 'jobs' | 'processes' | 'crashes'>('live');
  return (
    <div>
      <PageHeader title={t('nav.logs')} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'live', label: t('logs.live') },
          { id: 'jobs', label: t('logs.jobs') },
          { id: 'processes', label: t('logs.processes') },
          { id: 'crashes', label: t('logs.crashes') },
        ]}
      />
      {tab === 'live' && <LiveLogs />}
      {tab === 'jobs' && <Jobs />}
      {tab === 'processes' && <Processes />}
      {tab === 'crashes' && <Crashes />}
    </div>
  );
}
