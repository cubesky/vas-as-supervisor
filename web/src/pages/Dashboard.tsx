import { useApi, post, type LogEntry } from '../api';
import { fmtBytes, fmtDate, fmtDuration, t } from '../i18n';
import { Badge, Button, Card, ErrorBox, Loading, PageHeader, act } from '../components/ui';

function Stat({ label, value, sub, href }: { label: string; value: string | number; sub?: string; href?: string }) {
  const body = (
    <>
      <div class="stat-value">{value}</div>
      <div class="stat-label">{label}</div>
      {sub && <div class="muted small">{sub}</div>}
    </>
  );
  return href ? (
    <a class="stat" href={href}>
      {body}
    </a>
  ) : (
    <div class="stat">{body}</div>
  );
}

export function SafeModeBanner({ boot }: { boot: { safeMode: boolean; safeModeReason: string } }) {
  if (!boot.safeMode) return null;
  return (
    <div class="alert alert-error row between">
      <span>
        <strong>{t('dash.safeMode')}</strong> — {boot.safeModeReason}. {t('dash.safeModeHint')}
      </span>
      <Button small variant="danger" onClick={() => act(() => post('/system/safe-mode/exit'), t('dash.safeModeCleared'))}>
        {t('dash.exitSafeMode')}
      </Button>
    </div>
  );
}

export function Dashboard() {
  const sys = useApi('/system', ['settings']);
  const podman = useApi('/podman/containers', ['podman', 'compose']);
  const compose = useApi('/compose', ['compose', 'instances']);
  const lxc = useApi('/lxc', ['lxc']);
  const vms = useApi('/vms', ['vm']);
  const or = useApi('/openresty', ['openresty', 'certs', 'acme']);
  const logs = useApi<LogEntry[]>('/logs?level=warn&limit=15', ['__never']);

  if (sys.loading) return <Loading />;
  const s = sys.data;
  const caps = s?.capabilities?.bins ?? {};
  const containers: any[] = podman.data?.containers ?? [];
  const projects: any[] = compose.data?.projects ?? [];
  const lx: any[] = lxc.data?.containers ?? [];
  const vm: any[] = vms.data?.vms ?? [];
  const agent = or.data?.agent;

  return (
    <div>
      <PageHeader title={t('nav.dashboard')} sub={s ? `${s.hostname} · ${s.platform} · ${s.arch}` : undefined} />
      <ErrorBox error={sys.error} />
      {s && <SafeModeBanner boot={s.boot} />}

      <div class="stats">
        <Stat label={t('nav.containers')} value={`${containers.filter((c) => c.state === 'running').length}/${containers.length}`} sub={t('dash.running')} href="/containers" />
        <Stat label={t('nav.compose')} value={`${projects.filter((p) => p.state === 'running').length}/${projects.length}`} sub={t('dash.running')} href="/compose" />
        <Stat label={t('nav.lxc')} value={`${lx.filter((c) => c.state === 'running').length}/${lx.length}`} sub={t('dash.running')} href="/lxc" />
        <Stat label={t('nav.vms')} value={`${vm.filter((v) => v.state === 'running').length}/${vm.length}`} sub={t('dash.running')} href="/vms" />
        <Stat label={t('nav.proxy')} value={or.data ? or.data.routes.length + or.data.streams.length : '—'} sub={t('dash.routes')} href="/proxy" />
      </div>

      <div class="grid2">
        <Card title={t('dash.host')}>
          {s && (
            <dl class="kvlist">
              <dt>{t('dash.uptime')}</dt>
              <dd>{fmtDuration(s.uptime)}</dd>
              <dt>{t('dash.load')}</dt>
              <dd>{s.load.map((x: number) => x.toFixed(2)).join(' / ')}</dd>
              <dt>{t('dash.memory')}</dt>
              <dd>
                {fmtBytes(s.memory.total - s.memory.free)} / {fmtBytes(s.memory.total)}
                <div class="meter">
                  <div style={{ width: `${((s.memory.total - s.memory.free) / s.memory.total) * 100}%` }} />
                </div>
              </dd>
              <dt>CPU</dt>
              <dd>{s.cpus}</dd>
              <dt>Podman</dt>
              <dd>{s.versions.podman ?? '—'}</dd>
              <dt>LXC</dt>
              <dd>{s.versions.lxc ?? '—'}</dd>
              <dt>libvirt</dt>
              <dd>{s.versions.libvirt ?? '—'}</dd>
              <dt>{t('dash.dataDir')}</dt>
              <dd class="mono">{s.paths.data}</dd>
              <dt>{t('dash.auth')}</dt>
              <dd>{s.auth ? t('dash.authPasskey') : t('dash.authDisabled')}</dd>
            </dl>
          )}
        </Card>

        <Card title={t('dash.capabilities')}>
          <div class="caps">
            {Object.entries(caps).map(([k, v]) => (
              <span key={k} class={`cap ${v ? 'cap-ok' : 'cap-missing'}`}>
                {v ? '✓' : '✕'} {k}
              </span>
            ))}
            {s && (
              <span class={`cap ${s.capabilities.acme.ok ? 'cap-ok' : 'cap-missing'}`} title={s.capabilities.acme.detail}>
                {s.capabilities.acme.ok ? '✓' : '✕'} acme.sh
              </span>
            )}
          </div>
          <h4>{t('dash.openrestyAgent')}</h4>
          {agent ? (
            <div class="row gap wrap">
              <Badge state={agent.online ? 'online' : 'offline'} label={agent.online ? t('proxy.online') : t('proxy.offline')} />
              <Badge state={agent.inSync ? 'success' : 'pending'} label={agent.inSync ? t('proxy.inSync') : t('proxy.outOfSync')} />
              <span class="muted small">
                {t('proxy.lastSeen')}: {fmtDate(agent.lastSeen)}
              </span>
            </div>
          ) : (
            <span class="muted">—</span>
          )}
        </Card>
      </div>

      <div class="grid2">
        <Card title={t('dash.recentProblems')} actions={<a href="/logs">{t('dash.allLogs')} →</a>}>
          {(logs.data ?? []).length === 0 ? (
            <p class="muted">{t('dash.noProblems')}</p>
          ) : (
            <ul class="loglist">
              {[...(logs.data ?? [])].reverse().map((l, i) => (
                <li key={i} class={`lvl-${l.level}`}>
                  <span class="mono small muted">{fmtDate(l.ts)}</span> <strong>[{l.module}]</strong> {l.msg}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t('dash.boots')}>
          <table class="table compact">
            <tbody>
              {(s?.boot.boots ?? []).slice(0, 8).map((b: any, i: number) => (
                <tr key={i}>
                  <td class="mono small">{fmtDate(b.ts)}</td>
                  <td>
                    <Badge state={b.clean === null ? 'running' : b.clean ? 'success' : 'error'} label={b.clean === null ? t('dash.bootCurrent') : b.clean ? t('dash.bootClean') : t('dash.bootCrash')} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
