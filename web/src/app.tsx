import { useEffect } from 'preact/hooks';
import { LocationProvider, Route, Router, useLocation } from 'preact-iso';
import { api, authState, connected, post, startEvents, stopEvents, type AuthStatus } from './api';
import { LANGS, lang, setLang, t, type Lang, type TKey } from './i18n';
import { JobDialog, runningJobs } from './components/JobLog';
import { Loading, Toasts } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Containers } from './pages/Containers';
import { ComposeList, ComposeDetail } from './pages/Compose';
import { LxcList, LxcDetail } from './pages/Lxc';
import { VmList, VmDetail } from './pages/Vms';
import { Networks } from './pages/Networks';
import { Proxy } from './pages/Proxy';
import { Waf } from './pages/Waf';
import { Certificates } from './pages/Certificates';
import { Ports } from './pages/Ports';
import { Logs } from './pages/Logs';
import { SettingsPage } from './pages/Settings';

const NAV: { href: string; key: TKey; icon: string }[] = [
  { href: '/', key: 'nav.dashboard', icon: '◈' },
  { href: '/containers', key: 'nav.containers', icon: '▣' },
  { href: '/compose', key: 'nav.compose', icon: '❖' },
  { href: '/lxc', key: 'nav.lxc', icon: '▤' },
  { href: '/vms', key: 'nav.vms', icon: '▥' },
  { href: '/networks', key: 'nav.networks', icon: '⇄' },
  { href: '/proxy', key: 'nav.proxy', icon: '⇉' },
  { href: '/waf', key: 'nav.waf', icon: '⛨' },
  { href: '/certificates', key: 'nav.certificates', icon: '⚿' },
  { href: '/ports', key: 'nav.ports', icon: '⌁' },
  { href: '/logs', key: 'nav.logs', icon: '☰' },
  { href: '/settings', key: 'nav.settings', icon: '⚙' },
];

function Sidebar() {
  const { path } = useLocation();
  return (
    <nav class="sidebar">
      <div class="brand">
        <span class="brand-mark">V</span>
        <span>VAS</span>
      </div>
      {NAV.map((n) => {
        const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
        return (
          <a key={n.href} href={n.href} class={`nav-link${active ? ' active' : ''}`}>
            <span class="nav-icon" aria-hidden="true">
              {n.icon}
            </span>
            {t(n.key)}
          </a>
        );
      })}
    </nav>
  );
}

function TopBar() {
  const jobs = runningJobs.value;
  return (
    <header class="topbar">
      <div class="row gap">
        <span class={`dot ${connected.value ? 'dot-ok' : 'dot-error'}`} title={connected.value ? t('top.live') : t('top.offline')} />
        <span class="muted small">{connected.value ? t('top.live') : t('top.offline')}</span>
        {jobs.length > 0 && (
          <span class="badge badge-warn">
            <span class="spinner" /> {t('top.jobs', { n: jobs.length })}
          </span>
        )}
      </div>
      <div class="row gap">
        <select class="input input-sm" value={lang.value} onChange={(e) => setLang((e.target as HTMLSelectElement).value as Lang)} aria-label={t('settings.language')}>
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        {authState.value?.enabled && (
          <button
            class="btn btn-ghost btn-sm"
            onClick={async () => {
              await post('/auth/logout');
              stopEvents();
              authState.value = { ...authState.value!, authenticated: false };
            }}
          >
            {t('top.logout')}
          </button>
        )}
      </div>
    </header>
  );
}

function Shell() {
  useEffect(() => {
    startEvents();
    return () => stopEvents();
  }, []);
  return (
    <div class="layout">
      <Sidebar />
      <div class="main">
        <TopBar />
        <main class="content">
          <Router>
            <Route path="/" component={Dashboard} />
            <Route path="/containers" component={Containers} />
            <Route path="/compose" component={ComposeList} />
            <Route path="/compose/:name" component={ComposeDetail} />
            <Route path="/lxc" component={LxcList} />
            <Route path="/lxc/:name" component={LxcDetail} />
            <Route path="/vms" component={VmList} />
            <Route path="/vms/:name" component={VmDetail} />
            <Route path="/networks" component={Networks} />
            <Route path="/proxy" component={Proxy} />
            <Route path="/waf" component={Waf} />
            <Route path="/certificates" component={Certificates} />
            <Route path="/ports" component={Ports} />
            <Route path="/logs" component={Logs} />
            <Route path="/settings" component={SettingsPage} />
            <Route default component={Dashboard} />
          </Router>
        </main>
      </div>
      <JobDialog />
    </div>
  );
}

export function App() {
  useEffect(() => {
    document.documentElement.lang = lang.value;
    api<AuthStatus>('/auth/status')
      .then((s) => (authState.value = s))
      .catch(() => (authState.value = { enabled: false, authenticated: true, needsSetup: false }));
  }, []);

  const auth = authState.value;
  return (
    <LocationProvider>
      {!auth ? <Loading /> : auth.enabled && !auth.authenticated ? <Login status={auth} /> : <Shell />}
      <Toasts />
    </LocationProvider>
  );
}
