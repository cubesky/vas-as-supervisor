import { useState } from 'preact/hooks';
import { useApi } from '../api';
import { t, type TKey } from '../i18n';
import { Button, Toggle } from './ui';

interface PortInfo {
  port: number;
  protocol: string;
  source: 'expose' | 'ports' | 'published';
  hostPort?: number;
}

interface Target {
  kind: 'podman' | 'compose' | 'lxc' | 'vm';
  name: string;
  service?: string;
  label: string;
  running: boolean;
  address?: string;
  ports: PortInfo[];
}

export interface Resolution {
  addresses: string[];
  note?: string;
}

const GROUPS: [Target['kind'], TKey][] = [
  ['compose', 'proxy.groupCompose'],
  ['podman', 'proxy.groupPodman'],
  ['lxc', 'proxy.groupLxc'],
  ['vm', 'proxy.groupVm'],
];

const keyOf = (x: Target) => `${x.kind}:${x.name}${x.service ? `/${x.service}` : ''}`;

function portLabel(p: PortInfo): string {
  if (p.source === 'published') return t('proxy.srcPublished', { port: p.hostPort ?? '?' });
  return p.source === 'expose' ? t('proxy.srcExpose') : t('proxy.srcPorts');
}

/**
 * Picks a workload and one of its container ports (expose / ports, published
 * or not) and emits a reference such as `compose://app/web:80`. The manager
 * resolves it to the current address on every config build.
 */
export function TargetPicker({ mode, onPick }: { mode: 'http' | 'stream'; onPick: (ref: string) => void }) {
  const { data } = useApi<Target[]>('/openresty/targets', ['podman', 'compose', 'lxc', 'vm', 'networks']);
  const [key, setKey] = useState('');
  const [port, setPort] = useState<number | ''>('');
  const [https, setHttps] = useState(false);

  if (!data) return null;
  if (!data.length) return <p class="muted small">{t('proxy.noTargets')}</p>;

  const sel = data.find((x) => keyOf(x) === key);
  const ports = sel ? sel.ports.filter((p) => mode === 'stream' || p.protocol === 'tcp') : [];
  const fallbackPort = mode === 'stream' ? 22 : 80;

  const choose = (k: string) => {
    setKey(k);
    const tgt = data.find((x) => keyOf(x) === k);
    const first = tgt?.ports.find((p) => mode === 'stream' || p.protocol === 'tcp');
    setPort(first?.port ?? (k ? fallbackPort : ''));
  };

  const add = () => {
    if (!sel || !port) return;
    const prefix = mode === 'http' && https ? 'https+' : '';
    onPick(`${prefix}${sel.kind}://${sel.name}${sel.service ? `/${sel.service}` : ''}:${port}`);
    setKey('');
    setPort('');
  };

  return (
    <div class="picker">
      <select class="input" value={key} onChange={(e) => choose((e.target as HTMLSelectElement).value)} aria-label={t('proxy.pickTarget')}>
        <option value="">{t('proxy.pickTarget')}</option>
        {GROUPS.map(([kind, label]) => {
          const items = data.filter((x) => x.kind === kind);
          if (!items.length) return null;
          return (
            <optgroup key={kind} label={t(label)}>
              {items.map((x) => (
                <option key={keyOf(x)} value={keyOf(x)}>
                  {x.label}
                  {x.address ? ` (${x.address})` : ''}
                  {x.running ? '' : ` — ${t('proxy.note.notRunning')}`}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      {sel && (
        <>
          {ports.length > 0 && (
            <select
              class="input"
              value={ports.some((p) => p.port === port) ? String(port) : ''}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v) setPort(Number(v));
              }}
              aria-label={t('proxy.targetPort')}
            >
              {ports.map((p) => (
                <option key={`${p.port}/${p.protocol}`} value={p.port}>
                  {p.port}/{p.protocol} · {portLabel(p)}
                </option>
              ))}
              <option value="">{t('proxy.customPort')}</option>
            </select>
          )}
          <input
            class="input port-input"
            type="number"
            min={1}
            max={65535}
            value={port}
            placeholder={String(fallbackPort)}
            aria-label={t('proxy.targetPort')}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              setPort(v ? Number(v) : '');
            }}
          />
          {mode === 'http' && <Toggle label="HTTPS" checked={https} onChange={setHttps} />}
          <Button small variant="primary" disabled={!port} onClick={add}>
            + {t('proxy.addTarget')}
          </Button>
        </>
      )}
    </div>
  );
}

