import { useState } from 'preact/hooks';
import { api, post, useApi } from '../api';
import { fmtDate, t } from '../i18n';
import { Badge, Button, Card, Empty, ErrorBox, Loading, Modal, PageHeader, act } from '../components/ui';

export function Networks() {
  const { data, error, loading } = useApi('/networks', ['networks', 'supervisor', 'settings']);
  const [nft, setNft] = useState<string | null>(null);
  if (loading) return <Loading />;
  const list: any[] = data?.allocations ?? [];
  return (
    <div>
      <PageHeader
        title={t('nav.networks')}
        sub={t('net.sub', { pool: data?.settings?.pool ?? '', prefix: data?.settings?.defaultPrefix ?? 30 })}
        actions={
          <>
            <Button onClick={async () => setNft((await api('/networks/nftables')).ruleset)}>{t('net.showNft')}</Button>
            <Button variant="primary" onClick={() => act(() => post('/networks/reconcile'), t('common.done'))}>
              {t('net.reconcile')}
            </Button>
          </>
        }
      />
      <ErrorBox error={error} />
      <Card>
        {list.length === 0 ? (
          <Empty>{t('net.none')}</Empty>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>{t('net.owner')}</th>
                <th>CIDR</th>
                <th>{t('net.gateway')}</th>
                <th>{t('net.address')}</th>
                <th>{t('net.bridge')}</th>
                <th>MAC</th>
                <th>{t('net.flags')}</th>
                <th>{t('common.state')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td>
                    <a href={`/${a.owner.kind === 'vm' ? 'vms' : 'lxc'}/${a.owner.name}`}>
                      {a.owner.kind}/{a.owner.name}
                    </a>
                    <div class="small muted">{fmtDate(a.createdAt)}</div>
                  </td>
                  <td class="mono">{a.cidr}</td>
                  <td class="mono">{a.gateway}</td>
                  <td class="mono">{a.address}</td>
                  <td class="mono">{a.bridge}</td>
                  <td class="mono small">{a.mac}</td>
                  <td class="small">
                    {a.nat && <span class="badge badge-muted">NAT</span>} {a.dhcp && <span class="badge badge-muted">DHCP</span>}{' '}
                    {a.isolated && <span class="badge badge-muted">{t('net.isolated')}</span>}
                  </td>
                  <td>
                    <Badge state={a.bridgeUp ? 'up' : 'down'} label={a.bridgeUp ? t('net.up') : t('net.down')} />{' '}
                    {a.dhcp && <Badge state={a.dhcpState} label={`DHCP: ${a.dhcpState}`} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title={t('net.hostBridges')}>
        <div class="caps">
          {(data?.bridges ?? []).map((b: string) => (
            <span key={b} class="cap cap-ok mono">
              {b}
            </span>
          ))}
          {(data?.bridges ?? []).length === 0 && <span class="muted">—</span>}
        </div>
      </Card>
      {nft !== null && (
        <Modal title="nftables: inet vas" wide onClose={() => setNft(null)}>
          <pre class="logbox tall">{nft}</pre>
        </Modal>
      )}
    </div>
  );
}
