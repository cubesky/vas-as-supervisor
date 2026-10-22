import { useEffect, useState } from 'preact/hooks';
import { del, post, put, useApi } from '../api';
import { fmtDate, t, type TKey } from '../i18n';
import { Badge, Button, Card, Empty, ErrorBox, Loading, Modal, NumberInput, PageHeader, Select, Tabs, act } from '../components/ui';
import { wafModeLabel } from '../components/WafRouteEditor';

interface WafEvent {
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

const ACTION_STATE: Record<string, string> = { block: 'error', blocklist: 'error', detect: 'pending', log: 'stopped' };
const actionBadge = (a: string) => <Badge state={ACTION_STATE[a] ?? 'stopped'} label={t(`waf.action.${a}` as TKey)} />;
const tsIso = (ts: number) => new Date(ts * 1000).toISOString();

function TopTable({ title, rows, label, onPick, extra }: { title: string; rows: { key: string; count: number; msg?: string }[]; label: (r: any) => any; onPick: (k: string) => void; extra?: (k: string) => any }) {
  return (
    <div>
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p class="muted small">—</p>
      ) : (
        <table class="table compact">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <button class="linklike" onClick={() => onPick(r.key)}>
                    {label(r)}
                  </button>
                </td>
                <td class="mono">{r.count}</td>
                {extra && <td class="actions">{extra(r.key)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

async function blockIp(ip: string) {
  await act(() => post('/waf/blocklist', { cidr: ip, note: t('waf.blockedFromEvents') }), t('waf.blockedIp'));
}

function EventDialog({ ev, onClose }: { ev: WafEvent; onClose: () => void }) {
  return (
    <Modal title={`${t('waf.eventTitle')} — ${fmtDate(tsIso(ev.ts))}`} wide onClose={onClose}>
      <dl class="kvlist">
        <dt>{t('waf.action')}</dt>
        <dd>
          {actionBadge(ev.action)} <span class="muted small">{t('waf.score')} {ev.score}</span>
        </dd>
        <dt>{t('waf.route')}</dt>
        <dd class="mono">{ev.route}</dd>
        <dt>{t('waf.client')}</dt>
        <dd class="mono">{ev.ip}</dd>
        <dt>{t('waf.request')}</dt>
        <dd class="mono">
          {ev.method} {ev.host}
          {ev.uri}
        </dd>
        <dt>User-Agent</dt>
        <dd class="mono small">{ev.ua || '—'}</dd>
        <dt>{t('waf.requestId')}</dt>
        <dd class="mono">{ev.requestId || '—'}</dd>
      </dl>
      <h4>{t('waf.matched')}</h4>
      <table class="table compact">
        <tbody>
          {ev.rules.map((r, i) => (
            <tr key={i}>
              <td class="mono">{r.id}</td>
              <td>
                {r.msg}
                {r.match && <div class="mono small muted">{r.target}: {r.match}</div>}
              </td>
              <td class="actions">
                {typeof r.id === 'number' && r.id > 0 && ev.route !== 'vas-system' && (
                  <Button small onClick={() => act(() => post('/waf/exclude', { route: ev.route, rule: r.id }), t('waf.excluded'))}>
                    {t('waf.excludeRule', { rule: String(r.id), route: ev.route })}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="row gap">
        {ev.action !== 'blocklist' && (
          <Button variant="danger" onClick={() => blockIp(ev.ip)}>
            {t('waf.blockIp')} {ev.ip}
          </Button>
        )}
      </div>
    </Modal>
  );
}

function EventsTab({ data }: { data: any }) {
  const [f, setF] = useState({ route: '', action: '', ip: '', rule: '', q: '' });
  const params = new URLSearchParams(Object.entries({ ...f, limit: '300' }).filter(([, v]) => v) as [string, string][]).toString();
  const ev = useApi<WafEvent[]>(`/waf/events?${params}`, ['waf']);
  const [open, setOpen] = useState<WafEvent | null>(null);
  const s = data.stats;
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });

  return (
    <>
      <Card
        title={t('waf.last24h')}
        actions={
          <Button small variant="danger" confirm={t('waf.confirmClear')} onClick={() => act(() => del('/waf/events'), t('common.done'))}>
            {t('waf.clearEvents')}
          </Button>
        }
      >
        <dl class="kvlist">
          <dt>{t('waf.total')}</dt>
          <dd>{s.last24h.total}</dd>
          <dt>{t('waf.blocked')}</dt>
          <dd class={s.last24h.blocked ? 'error-text' : ''}>{s.last24h.blocked}</dd>
          <dt>{t('waf.detected')}</dt>
          <dd class={s.last24h.detected ? 'warn-text' : ''}>{s.last24h.detected}</dd>
          <dt>{t('waf.logged')}</dt>
          <dd>{s.last24h.logged}</dd>
        </dl>
        <div class="grid3">
          <TopTable title={t('waf.topRules')} rows={s.topRules} label={(r) => `${r.key} · ${r.msg ?? ''}`} onPick={set('rule')} />
          <TopTable
            title={t('waf.topIps')}
            rows={s.topIps}
            label={(r) => <span class="mono">{r.key}</span>}
            onPick={set('ip')}
            extra={(ip) => (
              <Button small variant="danger" onClick={() => blockIp(ip)}>
                {t('waf.block')}
              </Button>
            )}
          />
          <TopTable title={t('waf.topRoutes')} rows={s.topRoutes} label={(r) => r.key} onPick={set('route')} />
        </div>
      </Card>

      <Card>
        <div class="row gap wrap toolbar">
          <select class="input" value={f.route} aria-label={t('waf.route')} onChange={(e) => set('route')((e.target as HTMLSelectElement).value)}>
            <option value="">{t('waf.allRoutes')}</option>
            {data.routes.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
          <select class="input" value={f.action} aria-label={t('waf.action')} onChange={(e) => set('action')((e.target as HTMLSelectElement).value)}>
            <option value="">{t('waf.allActions')}</option>
            {['block', 'detect', 'log', 'blocklist'].map((a) => (
              <option key={a} value={a}>
                {t(`waf.action.${a}` as TKey)}
              </option>
            ))}
          </select>
          <input class="input mono" placeholder={t('waf.client')} value={f.ip} onInput={(e) => set('ip')((e.target as HTMLInputElement).value.trim())} />
          <input class="input mono" placeholder={t('waf.rule')} value={f.rule} onInput={(e) => set('rule')((e.target as HTMLInputElement).value.trim())} />
          <input class="input" placeholder={t('common.filter')} value={f.q} onInput={(e) => set('q')((e.target as HTMLInputElement).value)} />
          {Object.values(f).some(Boolean) && (
            <Button small onClick={() => setF({ route: '', action: '', ip: '', rule: '', q: '' })}>
              ✕
            </Button>
          )}
        </div>
        <ErrorBox error={ev.error} />
        {!ev.data?.length ? (
          <Empty>{t('waf.noEvents')}</Empty>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>{t('waf.time')}</th>
                <th>{t('waf.action')}</th>
                <th>{t('waf.client')}</th>
                <th>{t('waf.request')}</th>
                <th>{t('waf.rules')}</th>
                <th>{t('waf.score')}</th>
              </tr>
            </thead>
            <tbody>
              {ev.data.map((e, i) => (
                <tr key={`${e.ts}-${i}`} class="clickable" onClick={() => setOpen(e)}>
                  <td class="mono small">{fmtDate(tsIso(e.ts))}</td>
                  <td>{actionBadge(e.action)}</td>
                  <td class="mono small">{e.ip}</td>
                  <td class="mono small">
                    <strong>{e.method}</strong> {e.host}
                    {e.uri.length > 80 ? `${e.uri.slice(0, 80)}…` : e.uri}
                    <div class="muted">{e.route}</div>
                  </td>
                  <td class="small">
                    {e.rules.map((r) => (
                      <div key={String(r.id)} title={r.match}>
                        <span class="mono">{r.id}</span> {r.msg}
                      </div>
                    ))}
                  </td>
                  <td class="mono">{e.score || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {open && <EventDialog ev={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function RulesTab({ data }: { data: any }) {
  const disabled = new Set<number>(data.settings.disabledRules);
  const toggle = (id: number, enabled: boolean) => {
    const next = enabled ? [...disabled].filter((x) => x !== id) : [...disabled, id];
    return act(() => put('/waf/settings', { disabledRules: next }), t('common.saved'));
  };
  return (
    <Card>
      <p class="muted small">{t('waf.rulesHint')}</p>
      <table class="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>{t('waf.ruleGroup')}</th>
            <th>{t('waf.description')}</th>
            <th>{t('waf.paranoia')}</th>
            <th>{t('waf.severity')}</th>
            <th>{t('waf.targets')}</th>
            <th>{t('common.enabled')}</th>
          </tr>
        </thead>
        <tbody>
          {data.rules.map((r: any) => (
            <tr key={r.id} class={r.enabled ? '' : 'disabled'}>
              <td class="mono">{r.id}</td>
              <td>
                <span class="badge badge-muted">{r.group}</span>
              </td>
              <td title={r.pattern}>{r.msg}</td>
              <td class="mono">{r.paranoia}</td>
              <td class="mono">{r.severity}</td>
              <td class="mono small">{r.targets.join(', ')}</td>
              <td>
                <input type="checkbox" checked={r.enabled} aria-label={`${r.id} ${t('common.enabled')}`} onChange={(e) => toggle(r.id, (e.target as HTMLInputElement).checked)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function BlocklistTab({ data }: { data: any }) {
  const [cidr, setCidr] = useState('');
  const [note, setNote] = useState('');
  const list: { cidr: string; note?: string; addedAt: string }[] = data.settings.blockedIps;
  return (
    <Card>
      <p class="muted small">{t('waf.blocklistHint')}</p>
      <div class="row gap wrap toolbar">
        <input class="input mono" placeholder="203.0.113.0/24" aria-label={t('waf.cidr')} value={cidr} onInput={(e) => setCidr((e.target as HTMLInputElement).value)} />
        <input class="input grow" placeholder={t('waf.note')} aria-label={t('waf.note')} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
        <Button
          variant="danger"
          disabled={!cidr.trim()}
          onClick={async () => {
            if (await act(() => post('/waf/blocklist', { cidr, note }), t('waf.blockedIp'))) {
              setCidr('');
              setNote('');
            }
          }}
        >
          {t('waf.block')}
        </Button>
      </div>
      {list.length === 0 ? (
        <Empty>{t('waf.noBlocked')}</Empty>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>{t('waf.cidr')}</th>
              <th>{t('waf.note')}</th>
              <th>{t('waf.addedAt')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((b) => (
              <tr key={b.cidr}>
                <td class="mono">{b.cidr}</td>
                <td>{b.note || '—'}</td>
                <td class="small">{fmtDate(b.addedAt)}</td>
                <td class="actions">
                  <Button small onClick={() => act(() => del(`/waf/blocklist?cidr=${encodeURIComponent(b.cidr)}`), t('common.done'))}>
                    {t('act.remove')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function SettingsTab({ data }: { data: any }) {
  const [s, setS] = useState(data.settings);
  useEffect(() => setS(data.settings), [JSON.stringify(data.settings)]);
  return (
    <>
      <Card title={t('waf.settingsTitle')} actions={<Button variant="primary" onClick={() => act(() => put('/waf/settings', s), t('common.saved'))}>{t('common.save')}</Button>}>
        <div class="form-grid">
          <Select
            label={t('waf.defaultMode')}
            value={s.defaultMode}
            onChange={(defaultMode) => setS({ ...s, defaultMode })}
            options={['off', 'detect', 'block'].map((m) => ({ value: m, label: wafModeLabel(m) }))}
            hint={t('waf.defaultModeHint')}
          />
          <Select label={t('waf.paranoia')} value={String(s.paranoia)} onChange={(p) => setS({ ...s, paranoia: Number(p) })} options={['1', '2', '3'].map((p) => ({ value: p, label: p }))} hint={t('waf.paranoiaHint')} />
          <NumberInput label={t('waf.threshold')} value={s.threshold} min={1} max={100} onInput={(threshold) => setS({ ...s, threshold })} hint={t('waf.thresholdHint')} />
          <NumberInput label={t('waf.bodyLimit')} value={s.bodyLimitKb} min={0} max={4096} onInput={(bodyLimitKb) => setS({ ...s, bodyLimitKb })} hint={t('waf.bodyLimitHint')} />
          <Select
            label={t('waf.blockStatus')}
            value={String(s.blockStatus)}
            onChange={(v) => setS({ ...s, blockStatus: Number(v) })}
            options={[
              { value: '403', label: '403 Forbidden' },
              { value: '406', label: '406 Not Acceptable' },
              { value: '429', label: '429 Too Many Requests' },
              { value: '451', label: '451 Unavailable For Legal Reasons' },
              { value: '444', label: t('waf.status444') },
            ]}
          />
          <NumberInput label={t('waf.maxEvents')} value={s.maxEvents} min={100} onInput={(maxEvents) => setS({ ...s, maxEvents })} />
        </div>
      </Card>
      <Card title={t('waf.routesTitle')}>
        <table class="table compact">
          <tbody>
            {data.routes.map((r: any) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.id}</strong>
                  <div class="mono small muted">{r.domains.join(', ')}</div>
                </td>
                <td>
                  <Badge state={r.mode === 'block' ? 'running' : r.mode === 'detect' ? 'pending' : 'stopped'} label={wafModeLabel(r.mode)} />
                </td>
                <td class="small muted">{r.system ? t('waf.systemRouteHint') : r.explicit === 'inherit' ? t('waf.mode.inherit', { mode: wafModeLabel(data.settings.defaultMode) }) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p class="muted small">{t('waf.routesHint')}</p>
      </Card>
    </>
  );
}

export function Waf() {
  const { data, error, loading } = useApi('/waf', ['waf', 'settings', 'openresty']);
  const [tab, setTab] = useState<'events' | 'rules' | 'blocklist' | 'settings'>('events');
  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <div>
      <PageHeader title={t('nav.waf')} sub={t('waf.sub')} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'events', label: t('waf.tabEvents') },
          { id: 'rules', label: t('waf.rules') },
          { id: 'blocklist', label: t('waf.tabBlocklist') },
          { id: 'settings', label: t('nav.settings') },
        ]}
      />
      {tab === 'events' && <EventsTab data={data} />}
      {tab === 'rules' && <RulesTab data={data} />}
      {tab === 'blocklist' && <BlocklistTab data={data} />}
      {tab === 'settings' && <SettingsTab data={data} />}
    </div>
  );
}
