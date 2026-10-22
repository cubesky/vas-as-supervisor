import { useState } from 'preact/hooks';
import { t, type TKey } from '../i18n';
import { Button, CodeArea, Field, TextInput, Toggle } from './ui';
import { TargetPicker, type Resolution } from './TargetPicker';

export interface UpstreamTls {
  verify?: boolean;
  serverName?: string;
  sni?: boolean;
  trustedCa?: string;
}

export interface Upstream {
  target: string;
  weight?: number;
  backup?: boolean;
  maxFails?: number;
  failTimeoutSec?: number;
  maxConns?: number;
  host?: string;
  tls?: UpstreamTls;
}

export const isHttpsTarget = (target: string) => /^https(\+|:\/\/)/.test(target.trim());

/** Number field whose empty value means "use the default" (undefined), unlike NumberInput's 0. */
function OptNumber(p: { label: string; value: number | undefined; placeholder: string; min?: number; max?: number; hint?: string; onChange: (v: number | undefined) => void }) {
  return (
    <Field label={p.label} hint={p.hint}>
      <input
        class="input"
        type="number"
        min={p.min}
        max={p.max}
        value={p.value ?? ''}
        placeholder={p.placeholder}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          p.onChange(v === '' ? undefined : Number(v));
        }}
      />
    </Field>
  );
}

/** Short summary of the non-default options of an upstream. */
export function UpstreamBadges({ u }: { u: Upstream }) {
  const b: string[] = [];
  if (u.weight && u.weight !== 1) b.push(`${t('proxy.up.weight')} ${u.weight}`);
  if (u.backup) b.push(t('proxy.up.backup'));
  if (u.maxConns) b.push(`≤${u.maxConns} conn`);
  if (u.host) b.push(`Host: ${u.host}`);
  if (isHttpsTarget(u.target)) {
    b.push(u.tls?.verify ? t('proxy.up.verifyOn') : t('proxy.up.verifyOff'));
    if (u.tls?.serverName) b.push(`SNI: ${u.tls.serverName}`);
    if (u.tls?.sni === false) b.push(t('proxy.up.noSni'));
  }
  return (
    <>
      {b.map((x) => (
        <span key={x} class="badge badge-muted">
          {x}
        </span>
      ))}
    </>
  );
}

function Options({ u, mode, onChange, onConn }: { u: Upstream; mode: 'http' | 'stream'; onChange: (u: Upstream) => void; onConn: (c: Pick<Upstream, 'host' | 'tls'>) => void }) {
  const tls = u.tls ?? {};
  const setTls = (patch: Partial<UpstreamTls>) => {
    const next: UpstreamTls = { ...tls, ...patch };
    for (const k of Object.keys(next) as (keyof UpstreamTls)[]) if (next[k] === undefined || next[k] === '') delete next[k];
    onConn({ host: u.host, tls: Object.keys(next).length ? next : undefined });
  };
  return (
    <div class="upstream-options">
      <div class="form-grid">
        <OptNumber label={t('proxy.up.weight')} value={u.weight} placeholder="1" min={1} max={1000} onChange={(weight) => onChange({ ...u, weight })} />
        <OptNumber label={t('proxy.up.maxFails')} value={u.maxFails} placeholder="3" min={0} max={100} hint={t('proxy.up.maxFailsHint')} onChange={(maxFails) => onChange({ ...u, maxFails })} />
        <OptNumber label={t('proxy.up.failTimeout')} value={u.failTimeoutSec} placeholder="10" min={1} max={3600} onChange={(failTimeoutSec) => onChange({ ...u, failTimeoutSec })} />
        <OptNumber label={t('proxy.up.maxConns')} value={u.maxConns} placeholder="0" min={0} hint={t('proxy.up.maxConnsHint')} onChange={(maxConns) => onChange({ ...u, maxConns })} />
        <Toggle label={t('proxy.up.backup')} checked={u.backup} hint={t('proxy.up.backupHint')} onChange={(backup) => onChange({ ...u, backup: backup || undefined })} />
      </div>
      {mode === 'http' && (
        <fieldset class="fieldset">
          <legend>{t('proxy.up.shared')}</legend>
          <p class="muted small">{t('proxy.up.sharedHint')}</p>
          <div class="form-grid">
            <TextInput label={t('proxy.up.host')} value={u.host ?? ''} placeholder={t('proxy.up.hostPlaceholder')} hint={t('proxy.up.hostHint')} mono onInput={(host) => onConn({ host: host.trim() || undefined, tls: u.tls })} />
          </div>
          {isHttpsTarget(u.target) ? (
            <>
              <div class="form-grid">
                <Toggle label={t('proxy.up.verify')} checked={tls.verify} hint={t('proxy.up.verifyHint')} onChange={(verify) => setTls({ verify: verify || undefined })} />
                <Toggle label={t('proxy.up.sni')} checked={tls.sni !== false} hint={t('proxy.up.sniHint')} onChange={(sni) => setTls({ sni: sni ? undefined : false })} />
                <TextInput label={t('proxy.up.serverName')} value={tls.serverName ?? ''} placeholder={u.host?.replace(/:\d+$/, '') || t('proxy.up.serverNamePlaceholder')} hint={t('proxy.up.serverNameHint')} mono onInput={(serverName) => setTls({ serverName: serverName.trim() || undefined })} />
              </div>
              {tls.verify && (
                <Field label={t('proxy.up.trustedCa')} wide hint={t('proxy.up.trustedCaHint')}>
                  <CodeArea value={tls.trustedCa ?? ''} rows={4} placeholder="-----BEGIN CERTIFICATE-----" onInput={(trustedCa) => setTls({ trustedCa: trustedCa.trim() ? trustedCa : undefined })} />
                </Field>
              )}
            </>
          ) : (
            <p class="muted small">{t('proxy.up.tlsOnlyHttps')}</p>
          )}
        </fieldset>
      )}
    </div>
  );
}

const NOTE_KEYS: Record<string, TKey> = {
  'not running': 'proxy.note.notRunning',
  'container not found': 'proxy.note.notFound',
  'service not created': 'proxy.note.notCreated',
  'no routable address': 'proxy.note.noRoute',
  'no address': 'proxy.note.noAddress',
};

const REF_RE = /^(?:https?\+)?(?:podman|compose|lxc|vm):\/\//;

/** Read-only upstream list: target, current address of workload references, and option badges. */
export function UpstreamList({ upstreams, targets }: { upstreams: (string | Upstream)[]; targets: Record<string, Resolution> }) {
  return (
    <>
      {upstreams.map((raw, i) => {
        const u: Upstream = typeof raw === 'string' ? { target: raw } : raw;
        const r = REF_RE.test(u.target) ? targets[u.target.replace(/^https?\+/, '')] : undefined;
        const note = r?.note ? (NOTE_KEYS[r.note] ? t(NOTE_KEYS[r.note]) : r.note) : undefined;
        return (
          <div key={`${u.target}-${i}`}>
            {u.target}
            {r && r.addresses.length > 0 && <span class="muted"> → {r.addresses.join(', ')}</span>}
            {r && (r.addresses.length === 0 || note) && <span class="warn-text"> ({note ?? t('proxy.note.noAddress')})</span>} <UpstreamBadges u={u} />
          </div>
        );
      })}
    </>
  );
}

/**
 * Edits the upstreams of a location (mode "http") or a stream forward.
 * Server attributes are per upstream; Host and TLS are kept identical across
 * all upstreams of a location because nginx applies them per location.
 */
export function UpstreamEditor({ value, onChange, mode }: { value: Upstream[]; onChange: (v: Upstream[]) => void; mode: 'http' | 'stream' }) {
  const [open, setOpen] = useState<number | null>(null);
  const [manual, setManual] = useState('');

  const update = (i: number, u: Upstream) => onChange(value.map((x, j) => (j === i ? u : x)));
  const setConn = (c: Pick<Upstream, 'host' | 'tls'>) => onChange(value.map((x) => ({ ...x, host: c.host, tls: c.tls })));
  // new upstreams inherit the location's shared Host/TLS options
  const add = (target: string) => {
    if (!target.trim()) return;
    const shared = mode === 'http' && value[0] ? { host: value[0].host, tls: value[0].tls } : {};
    onChange([...value, { target: target.trim(), ...shared }]);
  };

  return (
    <div class="upstreams">
      {value.length === 0 && <p class="muted small">{t('proxy.up.none')}</p>}
      {value.map((u, i) => (
        <div class="upstream" key={i}>
          <div class="upstream-row">
            <input class="input mono grow" value={u.target} aria-label={t('proxy.upstreams')} onInput={(e) => update(i, { ...u, target: (e.target as HTMLInputElement).value })} />
            <span class="upstream-badges">
              <UpstreamBadges u={u} />
            </span>
            <Button small onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
              {open === i ? '▲' : '▼'} {t('proxy.up.options')}
            </Button>
            <Button small variant="danger" aria-label={t('act.remove')} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              ✕
            </Button>
          </div>
          {open === i && <Options u={u} mode={mode} onChange={(nu) => update(i, nu)} onConn={setConn} />}
        </div>
      ))}
      <div class="row gap">
        <input
          class="input mono grow"
          value={manual}
          placeholder={mode === 'http' ? 'http://127.0.0.1:8080' : '10.250.0.2:22'}
          aria-label={t('proxy.up.manual')}
          onInput={(e) => setManual((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(manual);
              setManual('');
            }
          }}
        />
        <Button
          small
          disabled={!manual.trim()}
          onClick={() => {
            add(manual);
            setManual('');
          }}
        >
          + {t('common.add')}
        </Button>
      </div>
      <TargetPicker mode={mode} onPick={add} />
    </div>
  );
}
