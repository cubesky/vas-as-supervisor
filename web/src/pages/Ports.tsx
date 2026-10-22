import { useEffect, useState } from 'preact/hooks';
import { useApi } from '../api';
import { fmtDate, t } from '../i18n';
import { Badge, Button, Card, ErrorBox, Loading, PageHeader, Toggle } from '../components/ui';

export function Ports() {
  // refetches automatically on `ports` events (OpenResty / podman / VM changes)
  const { data, error, loading, reload } = useApi('/ports', ['ports', 'openresty']);
  const [filter, setFilter] = useState('');
  const [onlyManaged, setOnlyManaged] = useState(false);
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => void reload(), 15_000);
    return () => clearInterval(id);
  }, [auto, reload]);

  if (loading) return <Loading />;
  const rows: any[] = (data?.ports ?? []).filter((r: any) => {
    if (onlyManaged && !r.owners.length) return false;
    if (onlyConflicts && !r.conflict) return false;
    if (!filter) return true;
    const hay = `${r.port} ${r.protocol} ${r.process ?? ''} ${r.owners.map((o: any) => `${o.owner} ${o.detail}`).join(' ')}`.toLowerCase();
    return hay.includes(filter.toLowerCase());
  });
  const conflicts = (data?.ports ?? []).filter((r: any) => r.conflict).length;

  return (
    <div>
      <PageHeader title={t('nav.ports')} sub={t('ports.sub')} actions={<Button onClick={reload}>{t('common.refresh')}</Button>} />
      <ErrorBox error={error} />
      {conflicts > 0 && <div class="alert alert-error">{t('ports.conflicts', { n: conflicts })}</div>}
      <Card>
        <div class="row gap wrap toolbar">
          <input class="input" placeholder={t('common.filter')} value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          <Toggle label={t('ports.onlyManaged')} checked={onlyManaged} onChange={setOnlyManaged} />
          <Toggle label={t('ports.onlyConflicts')} checked={onlyConflicts} onChange={setOnlyConflicts} />
          <Toggle label={t('ports.autoRefresh')} checked={auto} onChange={setAuto} />
          <div class="spacer" />
          <span class="muted small">{fmtDate(data?.generatedAt)}</span>
        </div>
        <table class="table">
          <thead>
            <tr>
              <th>{t('ports.port')}</th>
              <th>{t('proxy.protocol')}</th>
              <th>{t('common.state')}</th>
              <th>{t('ports.address')}</th>
              <th>{t('ports.process')}</th>
              <th>{t('ports.owner')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.protocol}/${r.port}`} class={r.conflict ? 'row-conflict' : ''}>
                <td class="mono">
                  <strong>{r.port}</strong>
                </td>
                <td class="mono">{r.protocol}</td>
                <td>
                  <Badge state={r.listening ? 'running' : 'pending'} label={r.listening ? t('ports.listening') : t('ports.reserved')} />
                  {r.conflict && <Badge state="error" label={t('ports.conflict')} />}
                </td>
                <td class="mono small">{r.addresses.join(', ') || '—'}</td>
                <td class="mono small">{r.process ? `${r.process}${r.pid ? ` (${r.pid})` : ''}` : '—'}</td>
                <td class="small">
                  {r.owners.length
                    ? r.owners.map((o: any, i: number) => (
                        <div key={i}>
                          <strong>{o.owner}</strong> <span class="muted">{o.detail}</span>
                        </div>
                      ))
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
