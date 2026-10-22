import { useState } from 'preact/hooks';
import { del, post, put, useApi } from '../api';
import { fmtDate, t } from '../i18n';
import {
  Badge,
  Button,
  Card,
  CodeArea,
  Empty,
  ErrorBox,
  Field,
  KeyValueEditor,
  Loading,
  Modal,
  NumberInput,
  PageHeader,
  Select,
  Tabs,
  TextInput,
  Unavailable,
  act,
} from '../components/ui';

const SERVERS = [
  { value: 'letsencrypt', label: "Let's Encrypt" },
  { value: 'letsencrypt_test', label: "Let's Encrypt (staging)" },
  { value: 'zerossl', label: 'ZeroSSL' },
  { value: 'google', label: 'Google Trust Services' },
  { value: 'buypass', label: 'Buypass' },
];

function daysLeft(iso?: string): number | null {
  return iso ? Math.floor((Date.parse(iso) - Date.now()) / 86400_000) : null;
}

function CertEditor({ initial, providers, onClose }: { initial: any; providers: any[]; onClose: () => void }) {
  const [c, setC] = useState(initial);
  const [pem, setPem] = useState({ fullchain: '', key: '' });
  const isNew = !initial.createdAt;
  const save = async () => {
    const r = await act(() => put(`/acme/certs/${c.id}`, c), t('common.saved'));
    if (!r) return;
    if (c.source === 'manual' && pem.fullchain && pem.key) {
      if (!(await act(() => put(`/acme/certs/${c.id}/pem`, pem), t('cert.uploaded')))) return;
    }
    onClose();
  };
  return (
    <Modal
      title={isNew ? t('cert.new') : `${t('cert.edit')}: ${c.id}`}
      wide
      onClose={onClose}
      footer={
        <Button variant="primary" disabled={!c.id || !c.domains.length} onClick={save}>
          {t('common.save')}
        </Button>
      }
    >
      <div class="form-grid">
        <TextInput label="ID" value={c.id} onInput={(id) => setC({ ...c, id: id.toLowerCase() })} disabled={!isNew} placeholder="example-com" mono />
        <Select
          label={t('cert.source')}
          value={c.source}
          onChange={(source) => setC({ ...c, source })}
          options={[
            { value: 'acme', label: 'ACME (acme.sh)' },
            { value: 'manual', label: t('cert.manual') },
          ]}
        />
        <Field label={t('cert.domains')} wide hint={t('cert.domainsHint')}>
          <CodeArea value={c.domains.join('\n')} rows={3} onInput={(v) => setC({ ...c, domains: v.split(/[\s,]+/).filter(Boolean) })} placeholder={'example.com\n*.example.com'} />
        </Field>
        {c.source === 'acme' && (
          <>
            <Select label={t('cert.server')} value={c.server} onChange={(server) => setC({ ...c, server })} options={SERVERS} />
            <Select
              label={t('cert.keyType')}
              value={c.keyType}
              onChange={(keyType) => setC({ ...c, keyType })}
              options={['ec-256', 'ec-384', '2048', '3072', '4096'].map((k) => ({ value: k, label: k.startsWith('ec') ? `ECDSA ${k}` : `RSA ${k}` }))}
            />
            <Select
              label={t('cert.dnsProvider')}
              value={c.dnsProviderId ?? ''}
              onChange={(dnsProviderId) => setC({ ...c, dnsProviderId })}
              options={[{ value: '', label: '—' }, ...providers.map((p) => ({ value: p.id, label: `${p.name} (${p.type})` }))]}
            />
            <Select
              label={t('cert.mode')}
              value={c.aliasMode}
              onChange={(aliasMode) => setC({ ...c, aliasMode })}
              options={[
                { value: 'none', label: t('cert.modeDns') },
                { value: 'challenge', label: t('cert.modeChallengeAlias') },
                { value: 'domain', label: t('cert.modeDomainAlias') },
              ]}
            />
            {c.aliasMode !== 'none' && (
              <TextInput
                label={t('cert.aliasDomain')}
                value={c.aliasDomain ?? ''}
                onInput={(aliasDomain) => setC({ ...c, aliasDomain })}
                placeholder="acme-validation.net"
                mono
                hint={t('cert.aliasHint', { domain: c.domains[0]?.replace(/^\*\./, '') ?? 'example.com', alias: c.aliasDomain || 'acme-validation.net' })}
                wide
              />
            )}
            <NumberInput label={t('cert.dnsSleep')} value={c.dnsSleep} min={0} onInput={(dnsSleep) => setC({ ...c, dnsSleep })} hint={t('cert.dnsSleepHint')} />
          </>
        )}
      </div>
      {c.source === 'manual' && (
        <>
          <Field label="fullchain.pem" wide>
            <CodeArea value={pem.fullchain} rows={6} onInput={(fullchain) => setPem({ ...pem, fullchain })} placeholder="-----BEGIN CERTIFICATE-----" />
          </Field>
          <Field label="key.pem" wide hint={t('cert.keyHint')}>
            <CodeArea value={pem.key} rows={6} onInput={(key) => setPem({ ...pem, key })} placeholder="-----BEGIN PRIVATE KEY-----" />
          </Field>
        </>
      )}
    </Modal>
  );
}

function ProviderEditor({ initial, types, onClose }: { initial: any; types: { type: string; label: string; env: string[] }[]; onClose: () => void }) {
  const isNew = !initial.type;
  const [p, setP] = useState({ id: initial.id ?? '', name: initial.name ?? '', type: initial.type ?? types[0]?.type ?? 'dns_cf' });
  // values are write-only: existing keys show blank, blank = keep
  const keysFor = (type: string) => types.find((x) => x.type === type)?.env ?? [];
  const [envs, setEnvs] = useState<Record<string, string>>(
    Object.fromEntries([...new Set([...(initial.keys ?? []), ...(isNew ? keysFor(p.type) : [])])].map((k) => [k, ''])),
  );
  return (
    <Modal
      title={isNew ? t('cert.newProvider') : `${t('cert.editProvider')}: ${p.id}`}
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={!p.id}
          onClick={async () => {
            const env = { ...envs };
            for (const k of initial.keys ?? []) if (!(k in env)) env[k] = '-';
            if (await act(() => put(`/acme/providers/${p.id}`, { ...p, env }), t('common.saved'))) onClose();
          }}
        >
          {t('common.save')}
        </Button>
      }
    >
      <div class="form-grid">
        <TextInput label="ID" value={p.id} onInput={(id) => setP({ ...p, id: id.toLowerCase() })} disabled={!isNew} placeholder="cloudflare" mono />
        <TextInput label={t('common.name')} value={p.name} onInput={(name) => setP({ ...p, name })} />
        <Select
          label={t('cert.providerType')}
          value={types.some((x) => x.type === p.type) ? p.type : '__custom'}
          onChange={(type) => {
            if (type === '__custom') return setP({ ...p, type: 'dns_' });
            setP({ ...p, type });
            setEnvs(Object.fromEntries(keysFor(type).map((k) => [k, envs[k] ?? ''])));
          }}
          options={[...types.map((x) => ({ value: x.type, label: `${x.label} (${x.type})` })), { value: '__custom', label: t('cert.customProvider') }]}
        />
        {!types.some((x) => x.type === p.type) && <TextInput label="dnsapi" value={p.type} onInput={(type) => setP({ ...p, type })} mono hint={t('cert.customHint')} />}
      </div>
      <KeyValueEditor label={t('cert.credentials')} value={envs} onChange={setEnvs} secret hint={t('cert.credentialsHint')} />
    </Modal>
  );
}

export function Certificates() {
  const { data, error, loading } = useApi('/acme', ['acme', 'certs']);
  const [tab, setTab] = useState<'certs' | 'providers' | 'account'>('certs');
  const [editCert, setEditCert] = useState<any>(null);
  const [editProv, setEditProv] = useState<any>(null);
  const [email, setEmail] = useState<string | null>(null);
  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader title={t('nav.certificates')} sub={t('cert.sub')} />
      {!data.available.ok && <Unavailable what="acme.sh" detail={data.available.detail} />}
      {!data.email && <div class="alert alert-warn">{t('cert.noEmail')}</div>}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'certs', label: t('nav.certificates') },
          { id: 'providers', label: t('cert.providers') },
          { id: 'account', label: t('cert.account') },
        ]}
      />
      {tab === 'certs' && (
        <Card
          actions={
            <Button
              variant="primary"
              onClick={() => setEditCert({ id: '', source: 'acme', domains: [], keyType: 'ec-256', server: 'letsencrypt', dnsProviderId: data.providers[0]?.id, aliasMode: 'none' })}
            >
              + {t('cert.new')}
            </Button>
          }
        >
          {data.certificates.length === 0 ? (
            <Empty>{t('cert.none')}</Empty>
          ) : (
            <table class="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t('cert.domains')}</th>
                  <th>{t('common.state')}</th>
                  <th>{t('cert.expires')}</th>
                  <th>{t('cert.mode')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.certificates.map((c: any) => {
                  const d = daysLeft(c.status.notAfter);
                  return (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.id}</strong>
                        <div class="small muted">{c.source === 'manual' ? t('cert.manual') : c.server}</div>
                      </td>
                      <td class="mono small">{c.domains.join(', ')}</td>
                      <td>
                        <Badge state={c.status.state} label={t(`cert.state.${c.status.state}` as any)} />
                        {c.status.lastError && <div class="small error-text">{c.status.lastError}</div>}
                      </td>
                      <td class="small">
                        {c.status.notAfter ? (
                          <>
                            {fmtDate(c.status.notAfter)}
                            <div class={d !== null && d < 14 ? 'warn-text' : 'muted'}>{t('cert.daysLeft', { n: d ?? 0 })}</div>
                            <div class="muted">{c.status.issuer}</div>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td class="small">
                        {c.source === 'acme' ? (c.aliasMode === 'none' ? 'DNS' : `DNS alias → ${c.aliasDomain}`) : '—'}
                        <div class="muted">{data.providers.find((p: any) => p.id === c.dnsProviderId)?.name}</div>
                      </td>
                      <td class="actions">
                        {c.source === 'acme' && (
                          <>
                            <Button small variant="primary" onClick={() => act(() => post(`/acme/certs/${c.id}/issue`))}>
                              {t('cert.issue')}
                            </Button>
                            {c.status.state === 'issued' && <Button small onClick={() => act(() => post(`/acme/certs/${c.id}/renew`))}>{t('cert.renew')}</Button>}
                          </>
                        )}
                        <Button small onClick={() => setEditCert(c)}>{t('common.edit')}</Button>
                        <Button small variant="danger" confirm={t('cert.confirmDelete', { id: c.id })} onClick={() => act(() => del(`/acme/certs/${c.id}`), t('common.done'))}>
                          {t('act.remove')}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p class="muted small">{t('cert.renewHint')}</p>
        </Card>
      )}
      {tab === 'providers' && (
        <Card actions={<Button variant="primary" onClick={() => setEditProv({})}>+ {t('cert.newProvider')}</Button>}>
          {data.providers.length === 0 ? (
            <Empty>{t('cert.noProviders')}</Empty>
          ) : (
            <table class="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t('common.name')}</th>
                  <th>dnsapi</th>
                  <th>{t('cert.credentials')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.providers.map((p: any) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.id}</strong>
                    </td>
                    <td>{p.name}</td>
                    <td class="mono">{p.type}</td>
                    <td class="mono small">{p.keys.join(', ') || '—'}</td>
                    <td class="actions">
                      <Button small onClick={() => setEditProv(p)}>{t('common.edit')}</Button>
                      <Button small variant="danger" confirm={t('common.confirmDelete')} onClick={() => act(() => del(`/acme/providers/${p.id}`), t('common.done'))}>
                        {t('act.remove')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {tab === 'account' && (
        <Card title={t('cert.account')}>
          <div class="form-grid">
            <TextInput label={t('cert.email')} value={email ?? data.email} onInput={setEmail} type="email" placeholder="admin@example.com" hint={t('cert.emailHint')} />
          </div>
          <Button variant="primary" onClick={() => act(() => put('/acme/settings', { email: email ?? data.email }), t('common.saved'))}>
            {t('common.save')}
          </Button>
          <dl class="kvlist">
            <dt>{t('cert.execMode')}</dt>
            <dd>{data.mode}</dd>
            <dt>{t('common.state')}</dt>
            <dd>{data.available.detail}</dd>
          </dl>
        </Card>
      )}
      {editCert && <CertEditor initial={editCert} providers={data.providers} onClose={() => setEditCert(null)} />}
      {editProv && <ProviderEditor initial={editProv} types={data.providerTypes} onClose={() => setEditProv(null)} />}
    </div>
  );
}
