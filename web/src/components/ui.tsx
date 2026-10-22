import { signal } from '@preact/signals';
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t, type TKey } from '../i18n';
import { api, type JobSummary } from '../api';
import { openJob } from './JobLog';

// ---------------------------------------------------------------------------
// toasts

interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}
export const toasts = signal<Toast[]>([]);
let toastId = 0;

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, kind, text }];
  setTimeout(() => (toasts.value = toasts.value.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3500);
}

export function Toasts() {
  return (
    <div class="toasts">
      {toasts.value.map((x) => (
        <div key={x.id} class={`toast toast-${x.kind}`} onClick={() => (toasts.value = toasts.value.filter((y) => y.id !== x.id))}>
          {x.text}
        </div>
      ))}
    </div>
  );
}

/**
 * Runs an API action with busy state and error toasts. When the server
 * answers with a job summary, the job log dialog opens automatically.
 */
export async function act<T>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    const job = r as unknown as JobSummary;
    if (job && typeof job === 'object' && 'id' in job && 'state' in job && 'topic' in job) openJob(job.id, job.title);
    else if (okText) toast(okText, 'ok');
    return r;
  } catch (e) {
    toast((e as Error).message, 'error');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// building blocks

type BtnProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'danger' | 'ghost' | 'default';
  small?: boolean;
  confirm?: string;
  onClick?: () => unknown;
  disabled?: boolean;
  type?: 'button' | 'submit';
};

export function Button({ variant = 'default', small, confirm: confirmText, onClick, children, disabled, type = 'button', ...rest }: BtnProps) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      {...rest}
      type={type}
      class={`btn btn-${variant}${small ? ' btn-sm' : ''} ${rest.class ?? ''}`}
      disabled={disabled || busy}
      onClick={async (e) => {
        e.stopPropagation();
        if (!onClick) return;
        if (confirmText && !window.confirm(confirmText)) return;
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <span class="spinner" /> : null}
      {children}
    </button>
  );
}

const STATE_CLASS: Record<string, string> = {
  running: 'ok',
  issued: 'ok',
  success: 'ok',
  online: 'ok',
  up: 'ok',
  partial: 'warn',
  paused: 'warn',
  frozen: 'warn',
  issuing: 'warn',
  pending: 'muted',
  backoff: 'warn',
  stopped: 'muted',
  down: 'muted',
  exited: 'muted',
  created: 'muted',
  'shut off': 'muted',
  disabled: 'muted',
  offline: 'error',
  error: 'error',
  crashed: 'error',
  crashloop: 'error',
};

export function Badge({ state, label }: { state: string; label?: string }) {
  const cls = STATE_CLASS[state?.toLowerCase()] ?? 'muted';
  return <span class={`badge badge-${cls}`}>{label ?? state}</span>;
}

export function Card({ title, actions, children, class: cls }: { title?: ComponentChildren; actions?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`card ${cls ?? ''}`}>
      {(title || actions) && (
        <header class="card-head">
          <h3>{title}</h3>
          <div class="row gap">{actions}</div>
        </header>
      )}
      <div class="card-body">{children}</div>
    </section>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <div class="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p class="muted">{sub}</p>}
      </div>
      <div class="row gap wrap">{actions}</div>
    </div>
  );
}

export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean; footer?: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header class="modal-head">
          <h3>{title}</h3>
          <button class="btn btn-ghost btn-sm" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </header>
        <div class="modal-body">{children}</div>
        {footer && <footer class="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div class="tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={tab.id === value} class={`tab${tab.id === value ? ' active' : ''}`} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class="empty">{children}</div>;
}

export function Loading() {
  return (
    <div class="empty">
      <span class="spinner" /> {t('common.loading')}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div class="alert alert-error">{error}</div> : null;
}

export function Unavailable({ what, detail }: { what: string; detail?: string }) {
  return (
    <div class="alert alert-warn">
      {t('common.unavailable', { what })}
      {detail ? ` (${detail})` : ''}
    </div>
  );
}

// ---------------------------------------------------------------------------
// form fields

interface FieldProps {
  label: string;
  hint?: ComponentChildren;
  children: ComponentChildren;
  wide?: boolean;
}

export function Field({ label, hint, children, wide }: FieldProps) {
  return (
    <label class={`field${wide ? ' field-wide' : ''}`}>
      <span class="field-label">{label}</span>
      {children}
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  );
}

export function TextInput(p: { label: string; value: string | number | undefined; onInput: (v: string) => void; placeholder?: string; hint?: ComponentChildren; type?: string; wide?: boolean; disabled?: boolean; mono?: boolean }) {
  return (
    <Field label={p.label} hint={p.hint} wide={p.wide}>
      <input
        class={`input${p.mono ? ' mono' : ''}`}
        type={p.type ?? 'text'}
        value={p.value ?? ''}
        placeholder={p.placeholder}
        disabled={p.disabled}
        onInput={(e) => p.onInput((e.target as HTMLInputElement).value)}
      />
    </Field>
  );
}

export function NumberInput(p: { label: string; value: number | undefined; onInput: (v: number) => void; min?: number; max?: number; hint?: ComponentChildren }) {
  return (
    <Field label={p.label} hint={p.hint}>
      <input
        class="input"
        type="number"
        value={p.value ?? ''}
        min={p.min}
        max={p.max}
        onInput={(e) => p.onInput(Number((e.target as HTMLInputElement).value))}
      />
    </Field>
  );
}

export function Select<T extends string>(p: { label: string; value: T | undefined; options: { value: T; label: string }[]; onChange: (v: T) => void; hint?: ComponentChildren; wide?: boolean }) {
  return (
    <Field label={p.label} hint={p.hint} wide={p.wide}>
      <select class="input" value={p.value} onChange={(e) => p.onChange((e.target as HTMLSelectElement).value as T)}>
        {p.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Toggle(p: { label: string; checked: boolean | undefined; onChange: (v: boolean) => void; hint?: ComponentChildren }) {
  return (
    <label class="toggle">
      <input type="checkbox" checked={!!p.checked} onChange={(e) => p.onChange((e.target as HTMLInputElement).checked)} />
      <span>{p.label}</span>
      {p.hint && <span class="field-hint">{p.hint}</span>}
    </label>
  );
}

export function TextArea(p: { label: string; value: string | undefined; onInput: (v: string) => void; rows?: number; mono?: boolean; placeholder?: string; hint?: ComponentChildren }) {
  return (
    <Field label={p.label} hint={p.hint} wide>
      <CodeArea value={p.value ?? ''} onInput={p.onInput} rows={p.rows} mono={p.mono} placeholder={p.placeholder} />
    </Field>
  );
}

/** Textarea with Tab-key indentation, used as a lightweight code editor. */
export function CodeArea(p: { value: string; onInput: (v: string) => void; rows?: number; mono?: boolean; placeholder?: string; readOnly?: boolean }) {
  return (
    <textarea
      class={`input${p.mono !== false ? ' mono' : ''}`}
      rows={p.rows ?? 6}
      value={p.value}
      spellcheck={false}
      readOnly={p.readOnly}
      placeholder={p.placeholder}
      onInput={(e) => p.onInput((e.target as HTMLTextAreaElement).value)}
      onKeyDown={(e) => {
        if (e.key !== 'Tab' || p.readOnly) return;
        e.preventDefault();
        const el = e.target as HTMLTextAreaElement;
        const s = el.selectionStart;
        const v = el.value.slice(0, s) + '  ' + el.value.slice(el.selectionEnd);
        p.onInput(v);
        requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
      }}
    />
  );
}

/** Edits a string→string map as rows. Secret mode shows values as password inputs. */
export function KeyValueEditor(p: { label: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void; secret?: boolean; keyPlaceholder?: string; valuePlaceholder?: string; hint?: ComponentChildren }) {
  const rows = Object.entries(p.value);
  const update = (i: number, k: string, v: string) => {
    const next = [...rows];
    next[i] = [k, v];
    p.onChange(Object.fromEntries(next));
  };
  return (
    <Field label={p.label} hint={p.hint} wide>
      <div class="kv">
        {rows.map(([k, v], i) => (
          <div class="kv-row" key={i}>
            <input class="input mono" value={k} placeholder={p.keyPlaceholder ?? 'KEY'} onInput={(e) => update(i, (e.target as HTMLInputElement).value, v)} />
            <input
              class="input mono"
              type={p.secret ? 'password' : 'text'}
              value={v}
              placeholder={p.valuePlaceholder ?? 'value'}
              onInput={(e) => update(i, k, (e.target as HTMLInputElement).value)}
            />
            <button type="button" class="btn btn-ghost btn-sm" onClick={() => p.onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" class="btn btn-sm" onClick={() => p.onChange({ ...p.value, '': '' })}>
          + {t('common.add')}
        </button>
      </div>
    </Field>
  );
}

export function StateText({ k }: { k: TKey }) {
  return <>{t(k)}</>;
}

/** Shows the last lines of a log endpoint in a <pre>. */
export function LogView({ path, title }: { path: string; title?: string }) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const r = await api<{ logs: string }>(path);
      setText(r.logs);
    } catch (e) {
      setText((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => void load(), [path]);
  return (
    <Card title={title ?? t('common.logs')} actions={<Button small onClick={load}>{loading ? <span class="spinner" /> : null}{t('common.refresh')}</Button>}>
      <pre class="logbox">{text || t('common.empty')}</pre>
    </Card>
  );
}
