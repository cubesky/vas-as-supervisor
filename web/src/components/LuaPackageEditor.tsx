import { useState } from 'preact/hooks';
import { t } from '../i18n';
import { Badge, Button } from './ui';

export interface LuaPackage {
  name: string;
  version?: string;
}

/** Install result reported by the OpenResty agent */
export interface LuaPackageStatus {
  name: string;
  version?: string;
  installed?: string;
  ok: boolean;
  message?: string;
  at?: string;
}

/** Entry of GET /api/openresty → luaPackages */
export interface WantedLuaPackage extends LuaPackage {
  sources: string[];
  conflict?: boolean;
  status: LuaPackageStatus | null;
}

const NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
const VER_RE = /^[\w.-]{1,32}$/;

// already part of OpenResty; installing them from LuaRocks would shadow the bundled copy
const BUNDLED = new Set([
  'lua-cjson',
  'lua-resty-core',
  'lua-resty-lrucache',
  'lua-resty-redis',
  'lua-resty-mysql',
  'lua-resty-memcached',
  'lua-resty-string',
  'lua-resty-lock',
  'lua-resty-dns',
  'lua-resty-upload',
  'lua-resty-websocket',
  'lua-resty-limit-traffic',
  'lua-resty-shell',
  'lua-resty-signal',
  'lua-resty-upstream-healthcheck',
]);

const SUGGESTIONS = [
  'lua-resty-http',
  'lua-resty-jwt',
  'lua-resty-openidc',
  'lua-resty-session',
  'lua-resty-openssl',
  'lua-resty-template',
  'lua-resty-cookie',
  'lua-resty-mlcache',
  'lua-resty-ipmatcher',
  'lua-resty-jit-uuid',
  'lua-resty-redis-connector',
  'lua-resty-iputils',
  'lua-resty-hmac-ffi',
  'lua-resty-requests',
  'lua-resty-radixtree',
  'luasocket',
  'lpeg',
  'penlight',
];

export type PkgState = 'installed' | 'pending' | 'failed';

/** installed = the agent has exactly the wanted version (or any, when none is pinned) */
export function pkgState(want: LuaPackage, st: LuaPackageStatus | null | undefined): PkgState {
  if (!st || (st.version ?? '') !== (want.version ?? '')) return 'pending';
  return st.ok ? 'installed' : 'failed';
}

export function PkgBadge({ state, installed }: { state: PkgState; installed?: string }) {
  if (state === 'installed') return <Badge state="success" label={installed ? `${t('lua.installed')} ${installed}` : t('lua.installed')} />;
  if (state === 'failed') return <Badge state="error" label={t('lua.failed')} />;
  return <Badge state="pending" label={t('lua.pending')} />;
}

/**
 * List editor for LuaRocks packages: one row per package with an optional
 * pinned version, plus a free-form "add" row (accepts "name", "name 1.0-1",
 * "name@1.0-1" or several separated by commas / spaces between pairs).
 */
export function LuaPackageEditor({
  value,
  onChange,
  status,
  label,
  hint,
}: {
  value: LuaPackage[];
  onChange: (v: LuaPackage[]) => void;
  status?: Record<string, LuaPackageStatus>;
  label?: string;
  hint?: string;
}) {
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [err, setErr] = useState('');
  const list = value ?? [];

  const add = () => {
    const n = name.trim();
    const v = version.trim();
    if (!NAME_RE.test(n)) return setErr(t('lua.badName'));
    if (v && !VER_RE.test(v)) return setErr(t('lua.badVersion'));
    if (list.some((p) => p.name === n)) return setErr(t('lua.duplicate', { name: n }));
    onChange([...list, v ? { name: n, version: v } : { name: n }]);
    setName('');
    setVersion('');
    setErr('');
  };
  const update = (i: number, p: LuaPackage) => onChange(list.map((x, j) => (j === i ? p : x)));

  return (
    // a div, not <Field> (a <label>): clicks on badges or the log toggle must not focus the first input
    <div class="field field-wide">
      {label !== '' && <span class="field-label">{label ?? t('lua.packages')}</span>}
      <datalist id="vas-luarocks-suggestions">
        {SUGGESTIONS.filter((s) => !list.some((p) => p.name === s)).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {list.map((p, i) => {
        const st = status?.[p.name];
        const state = pkgState(p, st);
        return (
          <div class="custom-rule lua-pkg" key={p.name}>
            <code class="lua-pkg-name">{p.name}</code>
            <input
              class="input mono"
              value={p.version ?? ''}
              placeholder={t('lua.latest')}
              aria-label={t('lua.version')}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value.trim();
                update(i, v ? { name: p.name, version: v } : { name: p.name });
              }}
            />
            {status && <PkgBadge state={state} installed={st?.installed} />}
            {BUNDLED.has(p.name) && <span class="badge badge-warn" title={t('lua.bundledHint')}>{t('lua.bundled')}</span>}
            <span class="grow" />
            <Button small variant="danger" onClick={() => onChange(list.filter((_, j) => j !== i))}>
              {t('act.remove')}
            </Button>
            {state === 'failed' && st?.message && (
              <details class="lua-pkg-log">
                <summary class="small">{t('lua.showLog')}</summary>
                <pre class="logbox">{st.message}</pre>
              </details>
            )}
          </div>
        );
      })}
      <div class="custom-rule lua-pkg">
        <input
          class="input mono grow"
          list="vas-luarocks-suggestions"
          value={name}
          placeholder="lua-resty-http"
          aria-label={t('lua.name')}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
        />
        <input
          class="input mono"
          value={version}
          placeholder={t('lua.latest')}
          aria-label={t('lua.version')}
          onInput={(e) => setVersion((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
        />
        <Button small onClick={add} disabled={!name.trim()}>
          + {t('lua.add')}
        </Button>
      </div>
      {err && <span class="warn-text small">{err}</span>}
      <span class="field-hint">{hint ?? t('lua.packagesHint')}</span>
    </div>
  );
}

/** True when a route contains any Lua code (server or location level, or *_by_lua in raw config). */
export function routeHasLua(r: any): boolean {
  const lua = r?.lua ?? {};
  if (Object.values(lua).some((v) => typeof v === 'string' && v.trim())) return true;
  if (/_by_lua/.test(r?.extra ?? '')) return true;
  return (r?.locations ?? []).some((l: any) => (l.luaAccess ?? '').trim() || (l.luaContent ?? '').trim() || /_by_lua/.test(l.extra ?? ''));
}
