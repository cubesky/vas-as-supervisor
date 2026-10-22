import { useState } from 'preact/hooks';
import { del, post, useApi } from '../api';
import { fmtBytes, fmtDate, t } from '../i18n';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  KeyValueEditor,
  Loading,
  LogView,
  Modal,
  PageHeader,
  Select,
  Tabs,
  TextArea,
  TextInput,
  Unavailable,
  act,
} from '../components/ui';

export function portsText(ports: { hostIp: string; hostPort: number; containerPort: number; protocol: string }[]): string {
  return ports.map((p) => `${p.hostPort}→${p.containerPort}/${p.protocol}`).join(', ');
}

function RunDialog({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', image: '', ports: '', volumes: '', restart: 'unless-stopped', network: '', command: '' });
  const [envs, setEnvs] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });

  const submit = async () => {
    const ports = f.ports
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [spec, protocol = 'tcp'] = l.split('/');
        const parts = spec.split(':');
        const container = Number(parts.pop());
        const host = Number(parts.pop());
        return { host, container, protocol, hostIp: parts.pop() };
      });
    const volumes = f.volumes
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [host, container, mode] = l.split(':');
        return { host, container, ro: mode === 'ro' };
      });
    const r = await act(() =>
      post('/podman/containers', {
        name: f.name,
        image: f.image,
        ports,
        volumes,
        env: Object.fromEntries(Object.entries(envs).filter(([k]) => k)),
        restart: f.restart,
        network: f.network || undefined,
        command: f.command ? f.command.split(' ').filter(Boolean) : undefined,
      }),
    );
    if (r) onClose();
  };

  return (
    <Modal
      title={t('ctr.run')}
      wide
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={submit} disabled={!f.name || !f.image}>
          {t('ctr.run')}
        </Button>
      }
    >
      <div class="form-grid">
        <TextInput label={t('common.name')} value={f.name} onInput={set('name')} placeholder="my-app" hint={t('ctr.nameHint')} />
        <TextInput label={t('ctr.image')} value={f.image} onInput={set('image')} placeholder="docker.io/library/nginx:latest" mono />
        <Select
          label={t('ctr.restart')}
          value={f.restart}
          onChange={set('restart')}
          options={['no', 'always', 'on-failure', 'unless-stopped'].map((v) => ({ value: v, label: v }))}
        />
        <TextInput label={t('ctr.network')} value={f.network} onInput={set('network')} placeholder="bridge / host / my-net" />
        <TextArea label={t('ctr.ports')} value={f.ports} onInput={set('ports')} rows={3} placeholder={'8080:80\n127.0.0.1:5432:5432/tcp'} />
        <TextArea label={t('ctr.volumes')} value={f.volumes} onInput={set('volumes')} rows={3} placeholder={'data:/var/lib/app\n/srv/shared:/shared:ro'} hint={t('ctr.volumesHint')} />
        <KeyValueEditor label={t('ctr.env')} value={envs} onChange={setEnvs} />
        <TextInput label={t('ctr.command')} value={f.command} onInput={set('command')} wide mono />
      </div>
    </Modal>
  );
}

function ContainersTab() {
  const { data, error, loading } = useApi('/podman/containers', ['podman', 'compose']);
  const [logs, setLogs] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState('');

  if (loading) return <Loading />;
  const list: any[] = (data?.containers ?? []).filter((c: any) => !filter || `${c.name} ${c.image} ${c.composeProject ?? ''}`.includes(filter));
  const action = (ref: string, a: string) => act(() => post(`/podman/containers/${encodeURIComponent(ref)}/${a}`), t('common.done'));

  return (
    <>
      <ErrorBox error={error} />
      {data && !data.available && <Unavailable what="Podman" />}
      <div class="row gap toolbar">
        <input class="input" placeholder={t('common.filter')} value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <div class="spacer" />
        <Button variant="primary" onClick={() => setRunning(true)}>
          + {t('ctr.run')}
        </Button>
      </div>
      {list.length === 0 ? (
        <Empty>{t('ctr.none')}</Empty>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('ctr.image')}</th>
              <th>{t('common.state')}</th>
              <th>{t('ctr.ports')}</th>
              <th>{t('nav.compose')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td>
                  <strong>{c.name}</strong>
                  {c.system && (
                    <span class="badge badge-muted" title={t('ctr.systemHint')}>
                      {t('ctr.system')}
                    </span>
                  )}
                  <div class="mono small muted">{c.id.slice(0, 12)}</div>
                </td>
                <td class="mono small">{c.image}</td>
                <td>
                  <Badge state={c.state} />
                  <div class="small muted">{c.status}</div>
                </td>
                <td class="mono small">{portsText(c.ports)}</td>
                <td>
                  {!c.composeProject ? (
                    '—'
                  ) : c.composeManaged ? (
                    <a href={`/compose/${c.composeProject}`}>{c.composeProject}</a>
                  ) : (
                    // started outside VAS_COMPOSE_DIR (e.g. VAS's own stack in deploy/): no project page to open
                    <span title={t('ctr.externalProjectHint', { dir: c.composeWorkingDir ?? '?' })}>
                      {c.composeProject} <span class="small muted">({c.system ? t('ctr.system') : t('ctr.externalProject')})</span>
                    </span>
                  )}
                </td>
                <td class="actions">
                  {/* VAS's own containers are read-only here (managed on the host / with the CLI) */}
                  {!c.system &&
                    (c.state === 'running' ? (
                      <>
                        <Button small onClick={() => action(c.id, 'restart')}>{t('act.restart')}</Button>
                        <Button small onClick={() => action(c.id, 'stop')}>{t('act.stop')}</Button>
                      </>
                    ) : (
                      <Button small onClick={() => action(c.id, 'start')}>{t('act.start')}</Button>
                    ))}
                  <Button small onClick={() => setLogs(c.id)}>{t('common.logs')}</Button>
                  {!c.system && (
                    <Button small variant="danger" confirm={t('ctr.confirmRemove', { name: c.name })} onClick={() => action(c.id, 'rm')}>
                      {t('act.remove')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {logs && (
        <Modal title={t('common.logs')} wide onClose={() => setLogs(null)}>
          <LogView path={`/podman/containers/${encodeURIComponent(logs)}/logs?tail=500`} />
        </Modal>
      )}
      {running && <RunDialog onClose={() => setRunning(false)} />}
    </>
  );
}

function ImagesTab() {
  const { data, loading } = useApi<any[]>('/podman/images', ['podman']);
  const [image, setImage] = useState('');
  if (loading) return <Loading />;
  return (
    <>
      <div class="row gap toolbar">
        <input class="input mono grow" placeholder="docker.io/library/alpine:latest" value={image} onInput={(e) => setImage((e.target as HTMLInputElement).value)} />
        <Button variant="primary" disabled={!image} onClick={() => act(() => post('/podman/images/pull', { image }))}>
          {t('ctr.pull')}
        </Button>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>{t('ctr.image')}</th>
            <th>{t('common.size')}</th>
            <th>{t('common.created')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((i) => (
            <tr key={i.id}>
              <td class="mono small">{i.names.join(', ') || i.id.slice(0, 12)}</td>
              <td>{fmtBytes(i.size)}</td>
              <td>{fmtDate(typeof i.created === 'number' ? new Date(i.created * 1000).toISOString() : i.created)}</td>
              <td class="actions">
                <Button small variant="danger" confirm={t('common.confirmDelete')} onClick={() => act(() => del(`/podman/images/${i.id.slice(0, 12)}`), t('common.done'))}>
                  {t('act.remove')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function Containers() {
  const [tab, setTab] = useState<'containers' | 'images'>('containers');
  return (
    <div>
      <PageHeader title={t('nav.containers')} sub={t('ctr.sub')} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'containers', label: t('nav.containers') },
          { id: 'images', label: t('ctr.images') },
        ]}
      />
      <Card>{tab === 'containers' ? <ContainersTab /> : <ImagesTab />}</Card>
    </div>
  );
}
