import { useApi } from '../api';
import { t } from '../i18n';
import { NumberInput, Select, TextInput, Toggle } from './ui';

export type Nic =
  | { mode: 'dedicated'; prefix?: number; cidr?: string; nat?: boolean; dhcp?: boolean; isolated?: boolean }
  | { mode: 'bridge'; bridge: string }
  | { mode: 'none' };

/** Network interface chooser: dedicated bridge + own subnet (e.g. /30), existing host bridge, or none. */
export function NicEditor({ value, onChange, kind }: { value: Nic; onChange: (n: Nic) => void; kind: 'lxc' | 'vm' }) {
  const { data } = useApi('/networks', ['networks']);
  const pool = data?.settings?.pool;
  return (
    <fieldset class="fieldset">
      <legend>{t('net.nic')}</legend>
      <div class="form-grid">
        <Select
          label={t('net.mode')}
          value={value.mode}
          onChange={(mode) =>
            onChange(
              mode === 'dedicated'
                ? { mode, prefix: data?.settings?.defaultPrefix ?? 30, nat: true, dhcp: kind === 'vm', isolated: true }
                : mode === 'bridge'
                  ? { mode, bridge: data?.bridges?.[0] ?? 'br0' }
                  : { mode },
            )
          }
          options={[
            { value: 'dedicated', label: t('net.modeDedicated') },
            { value: 'bridge', label: t('net.modeBridge') },
            { value: 'none', label: t('net.modeNone') },
          ]}
          hint={value.mode === 'dedicated' ? t('net.dedicatedHint', { pool: pool ?? '…' }) : undefined}
        />
        {value.mode === 'dedicated' && (
          <>
            <NumberInput label={t('net.prefix')} value={value.prefix} min={16} max={30} onInput={(prefix) => onChange({ ...value, prefix })} hint={t('net.prefixHint')} />
            <TextInput label={t('net.cidr')} value={value.cidr ?? ''} onInput={(cidr) => onChange({ ...value, cidr: cidr || undefined })} placeholder={t('net.cidrAuto')} mono />
            <Toggle label={t('net.nat')} checked={value.nat !== false} onChange={(nat) => onChange({ ...value, nat })} />
            <Toggle label={t('net.dhcp')} checked={!!value.dhcp} onChange={(dhcp) => onChange({ ...value, dhcp })} hint={kind === 'lxc' ? t('net.dhcpLxcHint') : undefined} />
            <Toggle label={t('net.isolated')} checked={value.isolated !== false} onChange={(isolated) => onChange({ ...value, isolated })} />
          </>
        )}
        {value.mode === 'bridge' && (
          <>
            {data?.bridges?.length ? (
              <Select
                label={t('net.bridge')}
                value={value.bridge}
                onChange={(bridge) => onChange({ mode: 'bridge', bridge })}
                options={data.bridges.map((b: string) => ({ value: b, label: b }))}
              />
            ) : (
              <TextInput label={t('net.bridge')} value={value.bridge} onInput={(bridge) => onChange({ mode: 'bridge', bridge })} mono />
            )}
          </>
        )}
      </div>
    </fieldset>
  );
}

export function NetSummary({ n }: { n?: any }) {
  if (!n) return <span class="muted">—</span>;
  return (
    <span class="mono small">
      {n.address}/{n.prefix} via {n.gateway}
      <span class="muted"> · {n.bridge}</span>
    </span>
  );
}
