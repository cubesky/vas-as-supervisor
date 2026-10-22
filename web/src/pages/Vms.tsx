import { useEffect, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { del, post, put, useApi } from '../api';
import { fmtBytes, t } from '../i18n';
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
import { VncViewer } from '../components/VncViewer';

function CreateDialog({ onClose, baseDir, images }: { onClose: () => void; baseDir: string; images: { name: string }[] }) {
  const isos = images.filter((i) => i.name.toLowerCase().endsWith('.iso'));
  const disks = images.filter((i) => !i.name.toLowerCase().endsWith('.iso'));
  const [f, setF] = useState({
    name: '',
    vcpus: 2,
    memoryMiB: 2048,
    diskGiB: 20,
    iso: isos[0]?.name ?? '',
    importImage: '',
    firmware: 'uefi' as 'bios' | 'uefi',
    machine: 'q35',
    autostart: false,
    restartPolicy: 'no' as 'no' | 'on-failure' | 'always',
  });
  const [nic, setNic] = useState<Nic>({ mode: 'dedicated', prefix: 30, nat: true, dhcp: true, isolated: true });
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF({ ...f, [k]: v });
  return (
    <Modal
      title={t('vm.create')}
      wide
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={!f.name}
          onClick={async () => {
            if (await act(() => post('/vms', { ...f, iso: f.iso || undefined, importImage: f.importImage || undefined, nic }))) onClose();
          }}
        >
          {t('common.create')}
        </Button>
      }
    >
      <div class="form-grid">
        <TextInput label={t('common.name')} value={f.name} onInput={(v) => set('name')(v.toLowerCase())} placeholder="vm1" hint={`${baseDir}/${f.name || '<name>'}`} />
        <NumberInput label={t('vm.vcpus')} value={f.vcpus} min={1} onInput={set('vcpus')} />
        <NumberInput label={t('vm.memory')} value={f.memoryMiB} min={128} onInput={set('memoryMiB')} />
        <NumberInput label={t('vm.disk')} value={f.diskGiB} min={1} onInput={set('diskGiB')} />
        <Select label={t('vm.iso')} value={f.iso} onChange={set('iso')} options={[{ value: '', label: '—' }, ...isos.map((i) => ({ value: i.name, label: i.name }))]} />
        <Select label={t('vm.importImage')} value={f.importImage} onChange={set('importImage')} options={[{ value: '', label: '—' }, ...disks.map((i) => ({ value: i.name, label: i.name }))]} hint={t('vm.importHint')} />
        <Select label={t('vm.firmware')} value={f.firmware} onChange={set('firmware')} options={[{ value: 'uefi', label: 'UEFI' }, { value: 'bios', label: 'BIOS' }]} />
        <Select label={t('vm.machine')} value={f.machine} onChange={set('machine')} options={[{ value: 'q35', label: 'q35' }, { value: 'pc', label: 'i440fx (pc)' }]} />
        <Toggle label={t('inst.autostart')} checked={f.autostart} onChange={set('autostart')} />
        <Select label={t('inst.restartPolicy')} value={f.restartPolicy} options={restartOptions()} onChange={set('restartPolicy')} />
      </div>
      <NicEditor value={nic} onChange={setNic} kind="vm" />
    </Modal>
  );
}

function ImagesCard() {
  const { data } = useApi('/vms/images', ['vm-images']);
  const [url, setUrl] = useState('');
  return (
    <Card title={t('vm.images')}>
      <p class="muted small mono">{data?.dir}</p>
      <div class="row gap toolbar">
        <input class="input grow mono" placeholder="https://…/debian-12-netinst.iso" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
        <Button disabled={!url} onClick={() => act(() => post('/vms/images/download', { url }))}>
          {t('vm.download')}
        </Button>
      </div>
      <table class="table compact">
        <tbody>
          {(data?.files ?? []).map((f: any) => (
            <tr key={f.name}>
              <td class="mono small">{f.name}</td>
              <td>{fmtBytes(f.size)}</td>
              <td class="actions">
                <Button small variant="danger" confirm={t('common.confirmDelete')} onClick={() => act(() => del(`/vms/images/${encodeURIComponent(f.name)}`), t('common.done'))}>
                  {t('act.remove')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function VmList() {
  const { data, error, loading } = useApi('/vms', ['vm', 'networks', 'instances']);
  const images = useApi('/vms/images', ['vm-images']);
  const [creating, setCreating] = useState(false);
  if (loading) return <Loading />;
  const vms: any[] = data?.vms ?? [];
  const action = (n: string, a: string) => act(() => post(`/vms/${n}/${a}`), t('common.done'));
  return (
    <div>
      <PageHeader
        title={t('nav.vms')}
        sub={<span class="mono">{data?.baseDir}</span>}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            + {t('vm.create')}
          </Button>
        }
      />
      <ErrorBox error={error} />
      {data && !data.available && <Unavailable what="libvirt (virsh)" />}
      <Card>
        {vms.length === 0 ? (
          <Empty>{t('vm.none')}</Empty>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('common.state')}</th>
                <th>{t('vm.resources')}</th>
                <th>{t('net.network')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vms.map((v) => (
                <tr key={v.name}>
                  <td>
                    <a href={`/vms/${v.name}`}>
                      <strong>{v.name}</strong>
                    </a>
                    {!v.managed && <span class="badge badge-muted">{t('vm.unmanaged')}</span>}
                  </td>
                  <td>
                    <Badge state={v.state} />
                  </td>
                  <td class="small">
                    {v.vcpus ?? '?'} vCPU · {fmtBytes((v.memoryKiB ?? 0) * 1024)}
                  </td>
                  <td>
                    <NetSummary n={v.network} />
                  </td>
                  <td class="actions">
                    {v.state === 'running' ? (
                      <Button small onClick={() => action(v.name, 'shutdown')}>{t('vm.shutdown')}</Button>
                    ) : (
                      <Button small onClick={() => action(v.name, 'start')}>{t('act.start')}</Button>
                    )}
                    <a class="btn btn-sm" href={`/vms/${v.name}`}>
                      {t('vm.console')}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <ImagesCard />
      {creating && <CreateDialog baseDir={data?.baseDir ?? ''} images={images.data?.files ?? []} onClose={() => setCreating(false)} />}
    </div>
  );
}

export function VmDetail() {
  const { params } = useRoute();
  const name = params.name;
  const { route } = useLocation();
  const { data, error, loading } = useApi(`/vms/${name}`, ['vm', 'networks', 'instances']);
  const images = useApi('/vms/images', ['vm-images']);
  const [tab, setTab] = useState<'vnc' | 'serial' | 'settings' | 'xml' | 'snapshots' | 'log'>('vnc');
  const [xml, setXml] = useState('');
  const [iso, setIso] = useState('');

  useEffect(() => {
    if (data) setXml(data.xml);
  }, [data?.xml]);

  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const state: string = data.state.state;
  const running = state === 'running' || state === 'paused';
  const action = (a: string) => act(() => post(`/vms/${name}/${a}`), t('common.done'));

  return (
    <div>
      <PageHeader
        title={name}
        sub={<NetSummary n={data.network} />}
        actions={
          <>
            <Badge state={state} label={data.state.reason ? `${state} (${data.state.reason})` : state} />
            {!running && <Button variant="primary" onClick={() => action('start')}>{t('act.start')}</Button>}
            {running && <Button onClick={() => action('shutdown')}>{t('vm.shutdown')}</Button>}
            {running && <Button onClick={() => action('reboot')}>{t('vm.reboot')}</Button>}
            {state === 'running' && <Button onClick={() => action('suspend')}>{t('vm.suspend')}</Button>}
            {state === 'paused' && <Button onClick={() => action('resume')}>{t('vm.resume')}</Button>}
            {running && (
              <Button variant="danger" confirm={t('vm.confirmForceOff')} onClick={() => action('destroy')}>
                {t('vm.forceOff')}
              </Button>
            )}
            <Button
              variant="danger"
              confirm={t('vm.confirmDelete', { name })}
              onClick={async () => {
                const deleteDisk = window.confirm(t('vm.confirmDeleteDisk'));
                if (await act(() => del(`/vms/${name}?deleteDisk=${deleteDisk}`))) route('/vms');
              }}
            >
              {t('act.remove')}
            </Button>
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'vnc', label: 'noVNC' },
          { id: 'serial', label: t('vm.serial') },
          { id: 'settings', label: t('nav.settings') },
          { id: 'xml', label: 'XML' },
          { id: 'snapshots', label: t('snap.title') },
          { id: 'log', label: t('vm.serialLog') },
        ]}
      />
      {tab === 'vnc' && (running ? <VncViewer vm={name} /> : <Empty>{t('vm.notRunning')}</Empty>)}
      {tab === 'serial' && (
        <>
          <p class="muted small">{t('vm.serialHint')}</p>
          {running ? <Terminal path={`/vms/${name}/serial`} /> : <Empty>{t('vm.notRunning')}</Empty>}
        </>
      )}
      {tab === 'settings' && (
        <div class="grid2">
          <InstanceSettings meta={data.meta} path={`/vms/${name}/settings`} />
          <Card title={t('vm.media')}>
            <div class="row gap">
              <select class="input grow" value={iso} onChange={(e) => setIso((e.target as HTMLSelectElement).value)}>
                <option value="">—</option>
                {(images.data?.files ?? [])
                  .filter((f: any) => f.name.endsWith('.iso'))
                  .map((f: any) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                    </option>
                  ))}
              </select>
              <Button disabled={!iso} onClick={() => act(() => post(`/vms/${name}/media`, { iso }), t('common.done'))}>
                {t('vm.insert')}
              </Button>
              <Button onClick={() => act(() => post(`/vms/${name}/media`, {}), t('common.done'))}>{t('vm.eject')}</Button>
            </div>
            <h4>{t('net.network')}</h4>
            <NetSummary n={data.network} />
            {data.guestAddresses && <pre class="logbox">{data.guestAddresses}</pre>}
            <dl class="kvlist">
              <dt>VNC</dt>
              <dd class="mono">{data.vncPort ? `127.0.0.1:${data.vncPort}` : '—'}</dd>
              <dt>{t('vm.serial')}</dt>
              <dd class="mono">{data.meta.serialPort ? `127.0.0.1:${data.meta.serialPort}` : '—'}</dd>
            </dl>
          </Card>
        </div>
      )}
      {tab === 'xml' && (
        <Card title={t('vm.domainXml')} actions={<Button variant="primary" onClick={() => act(() => put(`/vms/${name}/xml`, { xml }), t('common.saved'))}>{t('common.save')}</Button>}>
          <CodeArea value={xml} onInput={setXml} rows={28} />
          <p class="muted small">{t('vm.xmlHint')}</p>
        </Card>
      )}
      {tab === 'snapshots' && (
        <Snapshots
          list={data.snapshots}
          available={!!data.subvolume}
          onCreate={() => act(() => post(`/vms/${name}/snapshot`), t('snap.created'))}
          onDelete={(s) => act(() => del(`/vms/${name}/snapshots/${s}`), t('common.done'))}
        />
      )}
      {tab === 'log' && (
        <Card title={t('vm.serialLog')}>
          <pre class="logbox tall">{data.serialLog || t('common.empty')}</pre>
        </Card>
      )}
    </div>
  );
}
