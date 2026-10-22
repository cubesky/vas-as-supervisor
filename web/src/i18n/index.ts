import { signal } from '@preact/signals';
import en from './locales/en';
import ja from './locales/ja';
import ko from './locales/ko';
import zhTW from './locales/zh-TW';
import zhCN from './locales/zh-CN';

export type TKey = keyof typeof en;
export type Dict = Record<TKey, string>;
export type Lang = 'en' | 'ja' | 'ko' | 'zh-TW' | 'zh-CN';

export const LANGS: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'zh-CN', label: '简体中文' },
];

const dicts: Record<Lang, Dict> = { en, ja, ko, 'zh-TW': zhTW, 'zh-CN': zhCN };

function detect(): Lang {
  try {
    const saved = localStorage.getItem('vas.lang') as Lang | null;
    if (saved && saved in dicts) return saved;
  } catch {
    /* storage unavailable */
  }
  for (const l of navigator.languages ?? [navigator.language]) {
    const low = l.toLowerCase();
    if (low.startsWith('ja')) return 'ja';
    if (low.startsWith('ko')) return 'ko';
    if (low === 'zh-tw' || low === 'zh-hk' || low.startsWith('zh-hant')) return 'zh-TW';
    if (low.startsWith('zh')) return 'zh-CN';
    if (low.startsWith('en')) return 'en';
  }
  return 'en';
}

export const lang = signal<Lang>(detect());

export function setLang(l: Lang): void {
  lang.value = l;
  document.documentElement.lang = l;
  try {
    localStorage.setItem('vas.lang', l);
  } catch {
    /* ignore */
  }
}

/** Translates `key`, replacing `{name}` placeholders. Reading `lang` subscribes the component. */
export function t(key: TKey, vars?: Record<string, string | number>): string {
  let s = dicts[lang.value][key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(lang.value);
}

export function fmtBytes(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
