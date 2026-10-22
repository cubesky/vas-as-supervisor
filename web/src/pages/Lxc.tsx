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
  Modal,
  NumberInput,
  PageHeader,
  Select,
  Tabs,
  TextInput,
  Toggle,
  Unavailable,
  act,
} from '../components/ui';
import { InstanceSettings, Snapshots, restartOptions } from '../components/InstanceSettings';
import { NetSummary, NicEditor, type Nic } from '../components/NicEditor';
import { Terminal } from '../components/Terminal';

interface LxcImage {
  dist: string;
  release: string;
  arch: string;
  variant: string;
}

const uniq = (xs: string[]) => [...new Set(xs)];
// newest first: "3.24" before "3.21", named releases keep index order
const byReleaseDesc = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

interface ImageSel {
  dist: string;
  release: string;
  arch: string;
  variant: string;
}

/** First valid release/variant for a dist + arch, preferring the `default` variant. */
function pick(images: LxcImage[], sel: ImageSel): ImageSel {
  const forArch = images.filter((i) => i.arch === sel.arch);
  const dists = uniq(forArch.map((i) => i.dist));
  const dist = dists.includes(sel.dist) ? sel.dist : dists.includes('debian') ? 'debian' : dists[0] ?? sel.dist;
  const releases = uniq(forArch.filter((i) => i.dist === dist).map((i) => i.release)).sort(byReleaseDesc);
  const release = releases.includes(sel.release) ? sel.release : releases.find((r) => r !== 'edge' && r !== 'current' && r !== 'sid') ?? releases[0] ?? sel.release;
  const variants = uniq(forArch.filter((i) => i.dist === dist && i.release === release).map((i) => i.variant));
  const variant = variants.includes(sel.variant) ? sel.variant : variants.includes('default') ? 'default' : variants[0] ?? '';
  return { dist, release, arch: sel.arch, variant };
}

/** Distribution / release / variant chooser fed by the image server's index. */
function ImagePicker({ value, onChange }: { value: ImageSel; onChange: (v: ImageSel) => void }) {
  const { data, error } = useApi<{ server: string; hostArch: string; images: LxcImage[] }>('/lxc/images', []);

  // once the index arrives, snap the selection to something that exists
  useEffect(() => {
    if (data) onChange(pick(data.images, { ...value, arch: value.arch || data.hostArch }));
  }, [data]);

  if (error || !data) {
    const set = (k: keyof ImageSel) => (v: string) => onChange({ ...value, [k]: v });
    return (
      <>
        {error && <div class="alert alert-warn field-wide">{t('lxc.indexUnavailable', { error })}</div>}
        <TextInput label={t('lxc.dist')} value={value.dist} onInput={set('dist')} mono />
        <TextInput label={t('lxc.release')} value={value.release} onInput={set('release')} mono />
        <TextInput label={t('lxc.arch')} value={value.arch} onInput={set('arch')} mono />
        <TextInput label={t('lxc.variant')} value={value.variant} onInput={set('variant')} placeholder="default" mono />
      </>
    );
  }

  const forArch = data.images.filter((i) => i.arch === value.arch);
  const arches = uniq(data.images.map((i) => i.arch)).sort();
  const dists = uniq(forArch.map((i) => i.dist)).sort();
  const releases = uniq(forArch.filter((i) => i.dist === value.dist).map((i) => i.release)).sort(byReleaseDesc);
  const variants = uniq(forArch.filter((i) => i.dist === value.dist && i.release === value.release).map((i) => i.variant));
  const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));
  return (
    <>
      <Select label={t('lxc.arch')} value={value.arch} options={opts(arches)} onChange={(arch) => onChange(pick(data.images, { ...value, arch }))} />
      <Select label={t('lxc.dist')} value={value.dist} options={opts(dists)} onChange={(dist) => onChange(pick(data.images, { ...value, dist, release: '' }))} hint={t('lxc.imageServer', { server: data.server })} />
      <Select label={t('lxc.release')} value={value.release} options={opts(releases)} onChange={(release) => onChange(pick(data.images, { ...value, release }))} />
      <Select label={t('lxc.variant')} value={value.variant} options={opts(variants)} onChange={(variant) => onChange({ ...value, variant })} />
    </>
  );
}

function CreateDialog({ onClose, baseDir }: { onClose: () => void; baseDir: string }) {
  const [f, setF] = useState({ name: '', memoryMiB: 0, cpus: '', autostart: false, restartPolicy: 'no' as const });
  const [image, setImage] = useState<ImageSel>({ dist: 'debian', release: '', arch: '', variant: 'default' });
  const [nic, setNic] = useState<Nic>({ mode: 'dedicated', prefix: 30, nat: true, dhcp: false, isolated: true });
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF({ ...f, [k]: v });
  return (
    <Modal
      title={t('lxc.create')}
      wide
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={!f.name || !image.dist || !image.release}
          onClick={async () => {
            const body = { ...f, ...image, arch: image.arch || undefined, variant: image.variant || undefined, memoryMiB: f.memoryMiB || undefined, nic };
            if (await act(() => post('/lxc', body))) onClose();
          }}
        >
          {t('common.create')}
        </Button>
      }
    >
      <div class="form-grid">
        <TextInput label={t('common.name')} value={f.name} onInput={(v) => set('name')(v.toLowerCase())} placeholder="web1" hint={`${baseDir}/${f.name || '<name>'}`} />
        <ImagePicker value={image} onChange={setImage} />
        <NumberInput label={t('lxc.memory')} value={f.memoryMiB || undefined} onInput={set('memoryMiB')} min={0} hint={t('lxc.memoryHint')} />
        <TextInput label={t('lxc.cpus')} value={f.cpus} onInput={set('cpus')} placeholder="0-1" hint={t('lxc.cpusHint')} />
        <Toggle label={t('inst.autostart')} checked={f.autostart} onChange={set('autostart')} />
        <Select label={t('inst.restartPolicy')} value={f.restartPolicy} options={restartOptions()} onChange={set('restartPolicy') as any} />
      </div>
      <NicEditor value={nic} onChange={setNic} kind="lxc" />
    </Modal>
  );
}

export function LxcList() {
  const { data, error, loading } = useApi('/lxc', ['lxc', 'networks', 'instances']);
  const [creating, setCreating] = useState(false);
  if (loading) return <Loading />;
  const list: any[] = data?.containers ?? [];
  const action = (n: string, a: string) => act(() => post(`/lxc/${n}/${a}`), t('common.done'));
  return (
    <div>
      <PageHeader
        title={t('nav.lxc')}
        sub={<span class="mono">{data?.baseDir}</span>}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            + {t('lxc.create')}
          </Button>
        }
      />
      <ErrorBox error={error} />
      {data && !data.available && <Unavailable what="LXC" />}
      <Card>
        {list.length === 0 ? (
          <Empty>{t('lxc.none')}</Empty>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('common.state')}</th>
                <th>IPv4</th>
                <th>{t('net.network')}</th>
                <th>{t('inst.autostart')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.name}>
                  <td>
                    <a href={`/lxc/${c.name}`}>
                      <strong>{c.name}</strong>
                    </a>
                  </td>
                  <td>
                    <Badge state={c.state} />
                  </td>
                  <td class="mono small">{c.ipv4.join(', ') || '—'}</td>
                  <td>
                    <NetSummary n={c.network} />
                  </td>
                  <td>{c.meta.autostart ? '✓' : '—'}</td>
                  <td class="actions">
                    {c.state === 'running' ? (
                      <Button small onClick={() => action(c.name, 'stop')}>{t('act.stop')}</Button>
                    ) : (
                      <Button small onClick={() => action(c.name, 'start')}>{t('act.start')}</Button>
                    )}
                    <a class="btn btn-sm" href={`/lxc/${c.name}`}>
                      {t('lxc.terminal')}
                    </a>
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

export function LxcDetail() {
  const { params } = useRoute();
  const name = params.name;
  const { route } = useLocation();
  const { data, error, loading } = useApi(`/lxc/${name}`, ['lxc', 'networks', 'instances']);
  const list = useApi('/lxc', ['lxc']);
  const [tab, setTab] = useState<'terminal' | 'console' | 'settings' | 'config' | 'snapshots' | 'log'>('terminal');
  const [config, setConfig] = useState('');
  const [nic, setNic] = useState<Nic | null>(null);

  useEffect(() => {
    if (data) {
      setConfig(data.config);
      setNic(data.meta.nic ?? { mode: 'none' });
    }
  }, [data?.config, JSON.stringify(data?.meta?.nic)]);

  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const state = list.data?.containers?.find((c: any) => c.name === name)?.state ?? 'unknown';
  const action = (a: string) => act(() => post(`/lxc/${name}/${a}`), t('common.done'));

  return (
    <div>
      <PageHeader
        title={name}
        sub={<NetSummary n={data.network} />}
        actions={
          <>
            <Badge state={state} />
            <Button variant="primary" onClick={() => action('start')}>{t('act.start')}</Button>
            <Button onClick={() => action('restart')}>{t('act.restart')}</Button>
            <Button onClick={() => action('stop')}>{t('act.stop')}</Button>
            <Button onClick={() => action(state === 'frozen' ? 'unfreeze' : 'freeze')}>{state === 'frozen' ? t('lxc.unfreeze') : t('lxc.freeze')}</Button>
            <Button
              variant="danger"
              confirm={t('lxc.confirmDestroy', { name })}
              onClick={async () => {
                if (await act(() => del(`/lxc/${name}`))) route('/lxc');
              }}
            >
              {t('lxc.destroy')}
            </Button>
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'terminal', label: t('lxc.terminal') },
          { id: 'console', label: t('lxc.console') },
          { id: 'settings', label: t('nav.settings') },
          { id: 'config', label: t('lxc.config') },
          { id: 'snapshots', label: t('snap.title') },
          { id: 'log', label: t('lxc.consoleLog') },
        ]}
      />
      {tab === 'terminal' && <Terminal path={`/lxc/${name}/terminal?mode=attach`} />}
      {tab === 'console' && (
        <>
          <p class="muted small">{t('lxc.consoleHint')}</p>
          <Terminal path={`/lxc/${name}/terminal?mode=console`} />
        </>
      )}
      {tab === 'settings' && (
        <div class="grid2">
          <InstanceSettings meta={data.meta} path={`/lxc/${name}/settings`} />
          <Card title={t('net.network')}>
            {nic && <NicEditor value={nic} onChange={setNic} kind="lxc" />}
            <p class="muted small">{t('lxc.nicRestartHint')}</p>
            <Button variant="primary" onClick={() => act(() => put(`/lxc/${name}/settings`, { nic }), t('common.saved'))}>
              {t('common.save')}
            </Button>
          </Card>
        </div>
      )}
      {tab === 'config' && (
        <Card title={`${name}/config`} actions={<Button variant="primary" onClick={() => act(() => put(`/lxc/${name}/config`, { config }), t('common.saved'))}>{t('common.save')}</Button>}>
          <CodeArea value={config} onInput={setConfig} rows={24} />
          <pre class="logbox">{data.info}</pre>
        </Card>
      )}
      {tab === 'snapshots' && (
        <Snapshots
          list={data.snapshots}
          available={!!data.subvolume}
          onCreate={() => act(() => post(`/lxc/${name}/snapshot`), t('snap.created'))}
          onDelete={(s) => act(() => del(`/lxc/${name}/snapshots/${s}`), t('common.done'))}
        />
      )}
      {tab === 'log' && (
        <>
          <Card title={t('lxc.startLog')}>
            <p class="muted small">{t('lxc.startLogHint')}</p>
            <pre class="logbox">{data.startLog || t('common.empty')}</pre>
          </Card>
          <Card title={t('lxc.consoleLog')}>
            <pre class="logbox tall">{data.consoleLog || t('common.empty')}</pre>
          </Card>
        </>
      )}
    </div>
  );
}
