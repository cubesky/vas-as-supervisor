import { useEffect, useState } from 'preact/hooks';
import { put } from '../api';
import { t } from '../i18n';
import { Button, Card, NumberInput, Select, Toggle, act } from './ui';

export interface Meta {
  autostart: boolean;
  autostartDelaySec: number;
  restartPolicy: 'no' | 'on-failure' | 'always';
  desired?: string;
}

export const restartOptions = () => [
  { value: 'no' as const, label: t('inst.restartNo') },
  { value: 'on-failure' as const, label: t('inst.restartOnFailure') },
  { value: 'always' as const, label: t('inst.restartAlways') },
];

/** Autostart + watchdog restart policy editor shared by compose / LXC / VM. */
export function InstanceSettings({ meta, path }: { meta: Meta; path: string }) {
  const [m, setM] = useState(meta);
  useEffect(() => setM(meta), [JSON.stringify(meta)]);
  return (
    <Card title={t('inst.lifecycle')}>
      <div class="form-grid">
        <Toggle label={t('inst.autostart')} checked={m.autostart} onChange={(v) => setM({ ...m, autostart: v })} hint={t('inst.autostartHint')} />
        <NumberInput label={t('inst.autostartDelay')} value={m.autostartDelaySec} min={0} onInput={(v) => setM({ ...m, autostartDelaySec: v })} />
        <Select label={t('inst.restartPolicy')} value={m.restartPolicy} options={restartOptions()} onChange={(v) => setM({ ...m, restartPolicy: v })} hint={t('inst.restartHint')} />
      </div>
      <Button variant="primary" onClick={() => act(() => put(path, m), t('common.saved'))}>
        {t('common.save')}
      </Button>
    </Card>
  );
}

export interface Snapshot {
  name: string;
  path: string;
}

/** Snapshots only exist for folders that are btrfs subvolumes; plain folders just get a notice. */
export function Snapshots({ list, available, onCreate, onDelete }: { list: Snapshot[]; available: boolean; onCreate: () => unknown; onDelete: (name: string) => unknown }) {
  if (!available && list.length === 0) {
    return (
      <Card title={t('snap.title')}>
        <p class="muted">{t('snap.unavailable')}</p>
      </Card>
    );
  }
  return (
    <Card title={t('snap.title')} actions={available && <Button small onClick={onCreate}>+ {t('snap.create')}</Button>}>
      <p class="muted small">{t('snap.hint')}</p>
      {list.length === 0 ? (
        <p class="muted">{t('snap.none')}</p>
      ) : (
        <table class="table compact">
          <tbody>
            {list.map((s) => (
              <tr key={s.name}>
                <td class="mono small">{s.name}</td>
                <td class="mono small muted">{s.path}</td>
                <td class="actions">
                  <Button small variant="danger" confirm={t('common.confirmDelete')} onClick={() => onDelete(s.name)}>
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
