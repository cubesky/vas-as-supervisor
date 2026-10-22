import { useEffect, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { del, post, put, useApi } from '../api';
import { t } from '../i18n';
import {
  Badge,
  Button,
  Card,
  CodeArea,
  Empty,
  ErrorBox,
  Loading,
  LogView,
  Modal,
  PageHeader,
  Tabs,
  TextInput,
  Unavailable,
  act,
} from '../components/ui';
import { InstanceSettings, Snapshots } from '../components/InstanceSettings';
import { portsText } from './Containers';

const TEMPLATE = `services:
  app:
    image: docker.io/library/nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - ./data:/usr/share/nginx/html:Z
`;

function CreateDialog({ onClose, baseDir }: { onClose: () => void; baseDir: string }) {
  const [name, setName] = useState('');
  const [compose, setCompose] = useState(TEMPLATE);
  const [env, setEnv] = useState('');
  const { route } = useLocation();
  return (
    <Modal
      title={t('compose.create')}
      wide
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={!name}
          onClick={async () => {
            const r = await act(() => post('/compose', { name, compose, env }), t('compose.created'));
            if (r) {
              onClose();
              route(`/compose/${name}`);
            }
          }}
        >
          {t('common.create')}
        </Button>
      }
    >
      <TextInput label={t('common.name')} value={name} onInput={(v) => setName(v.toLowerCase())} placeholder="a_container" hint={`${baseDir}/${name || '<name>'}`} />
      <label class="field field-wide">
        <span class="field-label">compose.yaml</span>
        <CodeArea value={compose} onInput={setCompose} rows={16} />
      </label>
      <label class="field field-wide">
        <span class="field-label">.env</span>
        <CodeArea value={env} onInput={setEnv} rows={4} placeholder="KEY=value" />
      </label>
    </Modal>
  );
}

export function ComposeList() {
  const { data, error, loading } = useApi('/compose', ['compose', 'podman', 'instances']);
  const [creating, setCreating] = useState(false);
  if (loading) return <Loading />;
  const projects: any[] = data?.projects ?? [];
  return (
    <div>
      <PageHeader
        title={t('nav.compose')}
        sub={<span class="mono">{data?.baseDir}</span>}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            + {t('compose.create')}
          </Button>
        }
      />
      <ErrorBox error={error} />
      {data && !data.available && <Unavailable what="podman-compose" />}
      <Card>
        {projects.length === 0 ? (
          <Empty>{t('compose.none')}</Empty>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('common.state')}</th>
                <th>{t('compose.containers')}</th>
                <th>{t('inst.autostart')}</th>
                <th>{t('inst.restartPolicy')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.name}>
                  <td>
                    <a href={`/compose/${p.name}`}>
                      <strong>{p.name}</strong>
                    </a>
                    <div class="mono small muted">{p.dir}</div>
                  </td>
                  <td>
                    <Badge state={p.state} label={t(`state.${p.state}` as any)} />
                  </td>
                  <td>
                    {p.running}/{p.total}
                  </td>
                  <td>{p.meta.autostart ? '✓' : '—'}</td>
                  <td>{p.meta.restartPolicy}</td>
                  <td class="actions">
                    {p.system ? (
                      <span class="badge badge-muted" title={t('ctr.systemHint')}>
                        {t('ctr.system')}
                      </span>
                    ) : (
                      <>
                        <Button small onClick={() => act(() => post(`/compose/${p.name}/up`))}>{t('compose.up')}</Button>
                        <Button small onClick={() => act(() => post(`/compose/${p.name}/down`))}>{t('compose.down')}</Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {creating && <CreateDialog baseDir={data?.baseDir ?? ''} onClose={() => setCreating(false)} />}
    </div>
  );
}

export function ComposeDetail() {
  const { params } = useRoute();
  const name = params.name;
  const { route } = useLocation();
  const { data, error, loading } = useApi(`/compose/${name}`, ['compose', 'podman', 'instances']);
  const [tab, setTab] = useState<'overview' | 'files' | 'logs' | 'snapshots'>('overview');
  const [compose, setCompose] = useState('');
  const [env, setEnv] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) {
      setCompose(data.compose);
      setEnv(data.env);
    }
  }, [data]);

  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const run = (a: string) => act(() => post(`/compose/${name}/${a}`));

  return (
    <div>
      <PageHeader
        title={name}
        sub={<span class="mono">{data.dir}</span>}
        actions={
          <>
            <Badge state={data.status.state} label={t(`state.${data.status.state}` as any)} />
            {data.status.system ? (
              <span class="badge badge-muted" title={t('ctr.systemHint')}>
                {t('ctr.system')}
              </span>
            ) : (
              <>
                <Button variant="primary" onClick={() => run('up')}>{t('compose.up')}</Button>
                <Button onClick={() => run('restart')}>{t('act.restart')}</Button>
                <Button onClick={() => run('stop')}>{t('act.stop')}</Button>
                <Button onClick={() => run('down')}>{t('compose.down')}</Button>
                <Button onClick={() => run('pull')}>{t('ctr.pull')}</Button>
                <Button
                  variant="danger"
                  confirm={t('compose.confirmDelete', { name })}
                  onClick={async () => {
                    const deleteData = window.confirm(t('compose.confirmDeleteData'));
                    if (await act(() => del(`/compose/${name}?deleteData=${deleteData}`))) route('/compose');
                  }}
                >
                  {t('act.remove')}
                </Button>
              </>
            )}
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: t('common.overview') },
          { id: 'files', label: t('compose.files') },
          { id: 'logs', label: t('common.logs') },
          { id: 'snapshots', label: t('snap.title') },
        ]}
      />
      {tab === 'overview' && (
        <div class="grid2">
          <Card title={t('compose.containers')}>
            {data.status.containers.length === 0 ? (
              <p class="muted">{t('compose.notCreated')}</p>
            ) : (
              <table class="table compact">
                <tbody>
                  {data.status.containers.map((c: any) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.composeService ?? c.name}</strong>
                        <div class="mono small muted">{c.image}</div>
                      </td>
                      <td>
                        <Badge state={c.state} />
                      </td>
                      <td class="mono small">{portsText(c.ports)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <InstanceSettings meta={data.meta} path={`/compose/${name}/meta`} />
        </div>
      )}
      {tab === 'files' && (
        <Card
          title={data.file}
          actions={
            <Button
              variant="primary"
              disabled={!dirty}
              onClick={async () => {
                if (await act(() => put(`/compose/${name}`, { compose, env }), t('common.saved'))) setDirty(false);
              }}
            >
              {t('common.save')}
            </Button>
          }
        >
          <CodeArea
            value={compose}
            rows={22}
            onInput={(v) => {
              setCompose(v);
              setDirty(true);
            }}
          />
          <h4>.env</h4>
          <CodeArea
            value={env}
            rows={6}
            onInput={(v) => {
              setEnv(v);
              setDirty(true);
            }}
          />
          <p class="muted small">{t('compose.saveHint')}</p>
        </Card>
      )}
      {tab === 'logs' && <LogView path={`/compose/${name}/logs?tail=500`} />}
      {tab === 'snapshots' && (
        <Snapshots
          list={data.snapshots}
          available={!!data.subvolume}
          onCreate={() => act(() => post(`/compose/${name}/snapshot`), t('snap.created'))}
          onDelete={(s) => act(() => del(`/compose/${name}/snapshots/${s}`), t('common.done'))}
        />
      )}
    </div>
  );
}
