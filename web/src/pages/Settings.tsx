import { useEffect, useState } from 'preact/hooks';
import { startRegistration } from '@simplewebauthn/browser';
import { api, authState, del, post, put, useApi } from '../api';
import { LANGS, fmtBytes, fmtDate, lang, setLang, t, type Lang } from '../i18n';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  NumberInput,
  PageHeader,
  Select,
  Tabs,
  TextArea,
  TextInput,
  Toggle,
  act,
  toast,
} from '../components/ui';
import { SafeModeBanner } from './Dashboard';

function useSettings() {
  return useApi('/settings', ['settings', 'secrets']);
}

function GeneralTab() {
  const { data, loading } = useSettings();
  const sys = useApi('/system', []);
  const [net, setNet] = useState<any>(null);
  const [wd, setWd] = useState<any>(null);
  useEffect(() => {
    if (data) {
      setNet(data.settings.network);
      setWd(data.settings.watchdog);
    }
  }, [data]);
  if (loading || !net) return <Loading />;
  return (
    <>
      {sys.data && <SafeModeBanner boot={sys.data.boot} />}
      <Card title={t('settings.language')}>
        <Select
          label={t('settings.language')}
          value={lang.value}
          onChange={async (l: Lang) => {
            setLang(l);
            await put('/settings', { general: { language: l } }).catch(() => undefined);
          }}
          options={LANGS.map((l) => ({ value: l.code, label: l.label }))}
        />
      </Card>
      <Card title={t('settings.network')} actions={<Button variant="primary" onClick={() => act(() => put('/settings', { network: net }), t('common.saved'))}>{t('common.save')}</Button>}>
        <div class="form-grid">
          <TextInput label={t('settings.pool')} value={net.pool} onInput={(pool) => setNet({ ...net, pool })} mono hint={t('settings.poolHint')} />
          <NumberInput label={t('settings.defaultPrefix')} value={net.defaultPrefix} min={16} max={30} onInput={(defaultPrefix) => setNet({ ...net, defaultPrefix })} />
          <TextInput label="DNS" value={net.dns.join(', ')} onInput={(v) => setNet({ ...net, dns: v.split(/[\s,]+/).filter(Boolean) })} mono />
          <Toggle label={t('settings.isolateDefault')} checked={net.isolate} onChange={(isolate) => setNet({ ...net, isolate })} />
        </div>
      </Card>
      <Card title={t('settings.watchdog')} actions={<Button variant="primary" onClick={() => act(() => put('/settings', { watchdog: wd }), t('common.saved'))}>{t('common.save')}</Button>}>
        <div class="form-grid">
          <Toggle label={t('common.enabled')} checked={wd.enabled} onChange={(enabled) => setWd({ ...wd, enabled })} hint={t('settings.watchdogHint')} />
          <NumberInput label={t('settings.interval')} value={wd.intervalSec} min={10} onInput={(intervalSec) => setWd({ ...wd, intervalSec })} />
        </div>
      </Card>
    </>
  );
}

function AccountTab() {
  const keys = useApi<any[]>(authState.value?.enabled ? '/auth-admin/passkeys' : null, ['passkeys']);
  const token = useApi('/auth-admin/agent-token', []);
  const [name, setName] = useState('');
  const [show, setShow] = useState(false);
  const addPasskey = async () => {
    try {
      const optionsJSON = await post('/auth/register/options', { name });
      const response = await startRegistration({ optionsJSON });
      await post('/auth/register/verify', { response });
      toast(t('settings.passkeyAdded'), 'ok');
      setName('');
      void keys.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <>
      <Card title={t('settings.passkeys')}>
        {!authState.value?.enabled ? (
          <div class="alert alert-warn">{t('settings.authDisabled')}</div>
        ) : (
          <>
            <table class="table">
              <tbody>
                {(keys.data ?? []).map((k) => (
                  <tr key={k.id}>
                    <td>
                      <strong>{k.name}</strong>
                      <div class="mono small muted">{k.id.slice(0, 24)}…</div>
                    </td>
                    <td class="small">
                      {k.deviceType} {k.backedUp ? '☁' : ''}
                    </td>
                    <td class="small">
                      {t('common.created')}: {fmtDate(k.createdAt)}
                      <div class="muted">
                        {t('settings.lastUsed')}: {fmtDate(k.lastUsedAt)}
                      </div>
                    </td>
                    <td class="actions">
                      <Button
                        small
                        variant="danger"
                        confirm={(keys.data?.length ?? 0) <= 1 ? t('settings.confirmLastPasskey') : t('common.confirmDelete')}
                        onClick={() => act(() => del(`/auth-admin/passkeys/${encodeURIComponent(k.id)}`), t('common.done'))}
                      >
                        {t('act.remove')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div class="row gap">
              <input class="input" placeholder={t('login.passkeyName')} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
              <Button variant="primary" onClick={addPasskey}>
                + {t('settings.addPasskey')}
              </Button>
            </div>
          </>
        )}
      </Card>
      <Card title={t('settings.agentToken')}>
        <p class="muted small">{t('settings.agentTokenHint')}</p>
        <div class="row gap">
          <input class="input mono grow" readOnly type={show ? 'text' : 'password'} value={token.data?.token ?? ''} />
          <Button small onClick={() => setShow(!show)}>{show ? t('settings.hide') : t('settings.show')}</Button>
          <Button small onClick={() => navigator.clipboard.writeText(token.data?.token ?? '').then(() => toast(t('settings.copied'), 'ok'))}>{t('settings.copy')}</Button>
        </div>
        {token.data && !token.data.fromEnv && <p class="small warn-text">{t('settings.agentTokenGenerated')}</p>}
      </Card>
    </>
  );
}

function GitTab() {
  const { data, loading, reload } = useApi('/git', ['settings', 'secrets']);
  const [g, setG] = useState<any>(null);
  const [tokenVal, setTokenVal] = useState('');
  useEffect(() => data && setG(data.settings), [data]);
  if (loading || !g) return <Loading />;
  return (
    <>
      {!data.available && <div class="alert alert-warn">{t('common.unavailable', { what: 'git' })}</div>}
      <Card
        title={t('settings.git')}
        actions={
          <Button
            variant="primary"
            onClick={async () => {
              await act(() => put('/settings', { git: g }), t('common.saved'));
              if (tokenVal) await act(() => put('/settings/secrets', { gitToken: tokenVal }));
              setTokenVal('');
            }}
          >
            {t('common.save')}
          </Button>
        }
      >
        <div class="form-grid">
          <Toggle label={t('settings.gitEnabled')} checked={g.enabled} onChange={(enabled) => setG({ ...g, enabled })} hint={t('settings.gitHint')} />
          <TextInput label={t('settings.gitRemote')} value={g.remote} onInput={(remote) => setG({ ...g, remote })} placeholder="https://github.com/me/vas-config.git" mono wide />
          <TextInput label={t('settings.gitBranch')} value={g.branch} onInput={(branch) => setG({ ...g, branch })} mono />
          <Toggle label={t('settings.gitPush')} checked={g.push} onChange={(push) => setG({ ...g, push })} />
          <TextInput label={t('settings.gitAuthorName')} value={g.authorName} onInput={(authorName) => setG({ ...g, authorName })} />
          <TextInput label={t('settings.gitAuthorEmail')} value={g.authorEmail} onInput={(authorEmail) => setG({ ...g, authorEmail })} />
          <NumberInput label={t('settings.gitDebounce')} value={g.debounceSec} min={1} onInput={(debounceSec) => setG({ ...g, debounceSec })} />
          <Toggle label={t('settings.includeSecrets')} checked={g.includeSecrets} onChange={(includeSecrets) => setG({ ...g, includeSecrets })} hint={t('settings.includeSecretsGitHint')} />
          <TextInput label={t('settings.gitTokenUser')} value={g.tokenUser} onInput={(tokenUser) => setG({ ...g, tokenUser })} mono />
          <TextInput label={t('settings.gitToken')} value={tokenVal} onInput={setTokenVal} type="password" placeholder={data.tokenSet ? t('settings.secretSet') : ''} hint={t('settings.gitTokenHint')} />
        </div>
        <div class="row gap">
          <Button onClick={() => act(async () => { const r = await post('/git/commit'); toast(r.committed ? `${t('settings.committed')} ${r.hash}` : t('settings.nothingToCommit'), 'ok'); void reload(); })}>
            {t('settings.commitNow')}
          </Button>
          <Button onClick={() => act(() => post('/git/push'), t('settings.pushed'))}>{t('settings.pushNow')}</Button>
          <Button onClick={() => act(async () => { const r = await post('/git/test'); toast(r.ok ? t('settings.remoteOk') : r.output, r.ok ? 'ok' : 'error'); })}>{t('settings.testRemote')}</Button>
        </div>
        {data.status.lastError && <ErrorBox error={data.status.lastError} />}
      </Card>
      <Card title={t('settings.history')}>
        {data.commits.length === 0 ? (
          <Empty>{t('settings.noCommits')}</Empty>
        ) : (
          <table class="table compact">
            <tbody>
              {data.commits.map((c: any) => (
                <tr key={c.hash}>
                  <td class="mono">{c.hash}</td>
                  <td class="small">{fmtDate(c.date)}</td>
                  <td>{c.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function BackupTab() {
  const { data, loading } = useApi('/backup', ['settings', 'secrets', 'backup']);
  const [b, setB] = useState<any>(null);
  const [keys, setKeys] = useState({ s3AccessKeyId: '', s3SecretAccessKey: '' });
  const [list, setList] = useState<any[] | null>(null);
  useEffect(() => data && setB(data.settings), [data]);
  if (loading || !b) return <Loading />;
  const st = data.state;
  return (
    <>
      <Card
        title={t('settings.backup')}
        actions={
          <Button
            variant="primary"
            onClick={async () => {
              await act(() => put('/settings', { backup: b }), t('common.saved'));
              if (keys.s3AccessKeyId || keys.s3SecretAccessKey) {
                await act(() => put('/settings/secrets', keys));
                setKeys({ s3AccessKeyId: '', s3SecretAccessKey: '' });
              }
            }}
          >
            {t('common.save')}
          </Button>
        }
      >
        <div class="form-grid">
          <Toggle label={t('settings.backupEnabled')} checked={b.enabled} onChange={(enabled) => setB({ ...b, enabled })} />
          <TextInput label={t('settings.s3Endpoint')} value={b.endpoint} onInput={(endpoint) => setB({ ...b, endpoint })} placeholder="https://s3.example.com" mono hint={t('settings.s3EndpointHint')} />
          <TextInput label={t('settings.s3Region')} value={b.region} onInput={(region) => setB({ ...b, region })} mono />
          <TextInput label={t('settings.s3Bucket')} value={b.bucket} onInput={(bucket) => setB({ ...b, bucket })} mono />
          <TextInput label={t('settings.s3Prefix')} value={b.prefix} onInput={(prefix) => setB({ ...b, prefix })} mono />
          <Toggle label={t('settings.pathStyle')} checked={b.forcePathStyle} onChange={(forcePathStyle) => setB({ ...b, forcePathStyle })} />
          <NumberInput label={t('settings.intervalHours')} value={b.intervalHours} min={1} onInput={(intervalHours) => setB({ ...b, intervalHours })} />
          <NumberInput label={t('settings.retention')} value={b.retention} min={1} onInput={(retention) => setB({ ...b, retention })} />
          <Toggle label={t('settings.includeSecrets')} checked={b.includeSecrets} onChange={(includeSecrets) => setB({ ...b, includeSecrets })} />
          <Toggle label={t('settings.includeCompose')} checked={b.includeComposeFiles} onChange={(includeComposeFiles) => setB({ ...b, includeComposeFiles })} />
          <TextInput label={t('settings.accessKey')} value={keys.s3AccessKeyId} onInput={(s3AccessKeyId) => setKeys({ ...keys, s3AccessKeyId })} placeholder={data.credentialsSet ? t('settings.secretSet') : ''} mono />
          <TextInput label={t('settings.secretKey')} value={keys.s3SecretAccessKey} onInput={(s3SecretAccessKey) => setKeys({ ...keys, s3SecretAccessKey })} type="password" placeholder={data.credentialsSet ? t('settings.secretSet') : ''} />
        </div>
        <TextArea label={t('settings.extraPaths')} value={b.extraPaths.join('\n')} onInput={(v) => setB({ ...b, extraPaths: v.split('\n').map((s) => s.trim()).filter(Boolean) })} rows={3} placeholder="/etc/vas" />
        <div class="row gap">
          <Button onClick={() => act(() => post('/backup/run'))}>{t('settings.backupNow')}</Button>
          <Button onClick={async () => setList(await act(() => api('/backup/list')) ?? null)}>{t('settings.listBackups')}</Button>
        </div>
        <dl class="kvlist">
          <dt>{t('settings.lastRun')}</dt>
          <dd>{fmtDate(st.lastRun)}</dd>
          <dt>{t('settings.lastOk')}</dt>
          <dd>
            {fmtDate(st.lastOk)} {st.lastSize ? `(${fmtBytes(st.lastSize)})` : ''}
          </dd>
          {st.lastError && (
            <>
              <dt>{t('common.error')}</dt>
              <dd class="error-text">{st.lastError}</dd>
            </>
          )}
        </dl>
      </Card>
      {list && (
        <Card title={t('settings.backups')}>
          <table class="table compact">
            <tbody>
              {list.map((o) => (
                <tr key={o.key}>
                  <td class="mono small">{o.key}</td>
                  <td>{fmtBytes(o.size)}</td>
                  <td class="small">{fmtDate(o.lastModified)}</td>
                  <td class="actions">
                    <a class="btn btn-sm" href={`/api/backup/download?key=${encodeURIComponent(o.key)}`}>
                      {t('settings.download')}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function StorageTab() {
  const { data, loading } = useApi('/system/storage', []);
  const sys = useApi('/system', []);
  if (loading) return <Loading />;
  return (
    <>
      <Card title={t('settings.storage')}>
        <p class="muted small">{t('settings.btrfsMode')}</p>
        <table class="table">
          <thead>
            <tr>
              <th />
              <th>{t('settings.path')}</th>
              <th>{t('settings.fs')}</th>
              <th>{t('settings.subvolume')}</th>
              <th>{t('settings.mount')}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries<any>(data?.dirs ?? {}).map(([k, d]) => (
              <tr key={k}>
                <td>
                  <strong>{k}</strong>
                </td>
                <td class="mono small">{d.path}</td>
                <td>
                  <Badge state={d.fstype === 'btrfs' ? 'success' : 'pending'} label={d.fstype} />
                </td>
                <td>{d.subvolume ? '✓' : '—'}</td>
                <td class="mono small">{d.mount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title={t('settings.paths')}>
        <dl class="kvlist">
          {Object.entries<string>(sys.data?.paths ?? {}).map(([k, v]) => (
            <>
              <dt key={`${k}-k`}>{k}</dt>
              <dd key={`${k}-v`} class="mono">
                {v}
              </dd>
            </>
          ))}
        </dl>
        <p class="muted small">{t('settings.pathsHint')}</p>
      </Card>
    </>
  );
}

export function SettingsPage() {
  const [tab, setTab] = useState<'general' | 'account' | 'git' | 'backup' | 'storage'>('general');
  return (
    <div>
      <PageHeader title={t('nav.settings')} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'general', label: t('settings.general') },
          { id: 'account', label: t('settings.account') },
          { id: 'git', label: 'Git' },
          { id: 'backup', label: t('settings.backupTab') },
          { id: 'storage', label: t('settings.storage') },
        ]}
      />
      {tab === 'general' && <GeneralTab />}
      {tab === 'account' && <AccountTab />}
      {tab === 'git' && <GitTab />}
      {tab === 'backup' && <BackupTab />}
      {tab === 'storage' && <StorageTab />}
    </div>
  );
}
