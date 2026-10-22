import { t, type TKey } from '../i18n';
import { Button, CodeArea, Field, Select, TextInput, Toggle } from './ui';

export interface WafCustomRule {
  id: string;
  name: string;
  enabled: boolean;
  target: string;
  match: 'regex' | 'contains' | 'equals';
  value: string;
  action: 'block' | 'log' | 'allow';
}

export interface RouteWaf {
  mode: 'inherit' | 'off' | 'detect' | 'block';
  paranoia?: 1 | 2 | 3;
  threshold?: number;
  excludeRules: number[];
  excludePaths: string[];
  customRules: WafCustomRule[];
}

export const emptyRouteWaf = (): RouteWaf => ({ mode: 'inherit', excludeRules: [], excludePaths: [], customRules: [] });

const TARGETS = ['uri', 'raw_uri', 'args', 'body', 'cookies', 'ua', 'referer', 'headers', 'method', 'ip'];

export const wafModeLabel = (m: string) => t(`waf.mode.${m}` as TKey);

function CustomRuleRow({ r, onChange, onRemove }: { r: WafCustomRule; onChange: (r: WafCustomRule) => void; onRemove: () => void }) {
  const isHeader = r.target.startsWith('header:');
  return (
    <div class="custom-rule">
      <input class="input" value={r.name} placeholder={t('waf.crName')} aria-label={t('waf.crName')} onInput={(e) => onChange({ ...r, name: (e.target as HTMLInputElement).value })} />
      <select class="input" value={isHeader ? 'header' : r.target} aria-label={t('waf.crTarget')} onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        onChange({ ...r, target: v === 'header' ? 'header:X-Forwarded-For' : v });
      }}>
        {TARGETS.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
        <option value="header">{t('waf.target.header')}</option>
      </select>
      {isHeader && (
        <input class="input mono" value={r.target.slice(7)} aria-label={t('waf.headerName')} placeholder="X-Header" onInput={(e) => onChange({ ...r, target: `header:${(e.target as HTMLInputElement).value}` })} />
      )}
      <select class="input" value={r.match} aria-label={t('waf.crMatch')} onChange={(e) => onChange({ ...r, match: (e.target as HTMLSelectElement).value as WafCustomRule['match'] })}>
        {(['contains', 'equals', 'regex'] as const).map((m) => (
          <option key={m} value={m}>
            {t(`waf.match.${m}`)}
          </option>
        ))}
      </select>
      <input class="input mono grow" value={r.value} placeholder={t('waf.crValue')} aria-label={t('waf.crValue')} onInput={(e) => onChange({ ...r, value: (e.target as HTMLInputElement).value })} />
      <select class="input" value={r.action} aria-label={t('waf.crAction')} onChange={(e) => onChange({ ...r, action: (e.target as HTMLSelectElement).value as WafCustomRule['action'] })}>
        {(['block', 'log', 'allow'] as const).map((a) => (
          <option key={a} value={a}>
            {t(`waf.act.${a}`)}
          </option>
        ))}
      </select>
      <Toggle label={t('common.enabled')} checked={r.enabled} onChange={(enabled) => onChange({ ...r, enabled })} />
      <Button small variant="danger" aria-label={t('act.remove')} onClick={onRemove}>
        ✕
      </Button>
    </div>
  );
}

/** WAF settings of one route (inside the route editor). */
export function WafRouteEditor({ value, onChange, defaultMode }: { value?: RouteWaf; onChange: (w: RouteWaf) => void; defaultMode?: string }) {
  const w = value ?? emptyRouteWaf();
  const set = <K extends keyof RouteWaf>(k: K, v: RouteWaf[K]) => onChange({ ...w, [k]: v });
  return (
    <details class="details" open={w.mode !== 'inherit' || w.customRules.length > 0}>
      <summary>
        {t('waf.routeSection')} <span class="badge badge-muted">{w.mode === 'inherit' ? t('waf.mode.inherit', { mode: defaultMode ? wafModeLabel(defaultMode) : '…' }) : wafModeLabel(w.mode)}</span>
      </summary>
      <div class="form-grid">
        <Select
          label={t('waf.routeMode')}
          value={w.mode}
          onChange={(mode) => set('mode', mode)}
          options={[
            { value: 'inherit', label: t('waf.mode.inherit', { mode: defaultMode ? wafModeLabel(defaultMode) : '…' }) },
            { value: 'off', label: wafModeLabel('off') },
            { value: 'detect', label: wafModeLabel('detect') },
            { value: 'block', label: wafModeLabel('block') },
          ]}
        />
        <Select
          label={t('waf.paranoia')}
          value={String(w.paranoia ?? '')}
          onChange={(p) => set('paranoia', p ? (Number(p) as 1 | 2 | 3) : undefined)}
          options={[{ value: '', label: t('waf.inheritValue') }, { value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]}
          hint={t('waf.paranoiaHint')}
        />
        <Field label={t('waf.threshold')} hint={t('waf.thresholdHint')}>
          <input
            class="input"
            type="number"
            min={1}
            max={100}
            value={w.threshold ?? ''}
            placeholder={t('waf.inheritValue')}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              set('threshold', v ? Number(v) : undefined);
            }}
          />
        </Field>
        <TextInput
          label={t('waf.excludeRules')}
          value={w.excludeRules.join(', ')}
          onInput={(v) => set('excludeRules', v.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n)))}
          placeholder="941100, 942110"
          mono
          hint={t('waf.excludeRulesHint')}
        />
      </div>
      <Field label={t('waf.excludePaths')} wide hint={t('waf.excludePathsHint')}>
        <CodeArea value={w.excludePaths.join('\n')} rows={2} placeholder={'/admin/\n/api/upload'} onInput={(v) => set('excludePaths', v.split('\n').map((s) => s.trim()).filter(Boolean))} />
      </Field>
      <div class="field field-wide">
        <span class="field-label">{t('waf.customRules')}</span>
        <span class="field-hint">{t('waf.customHint')}</span>
        {w.customRules.map((r, i) => (
          <CustomRuleRow
            key={i}
            r={r}
            onChange={(nr) => set('customRules', w.customRules.map((x, j) => (j === i ? nr : x)))}
            onRemove={() => set('customRules', w.customRules.filter((_, j) => j !== i))}
          />
        ))}
        <div>
          <Button
            small
            onClick={() =>
              set('customRules', [...w.customRules, { id: `custom-${Date.now().toString(36)}`, name: '', enabled: true, target: 'uri', match: 'contains', value: '', action: 'block' }])
            }
          >
            + {t('waf.addCustom')}
          </Button>
        </div>
      </div>
    </details>
  );
}
