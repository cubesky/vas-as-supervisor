import { useState } from 'preact/hooks';
import { api, del, post, put, useApi } from '../api';
import { fmtDate, t } from '../i18n';
import {
  Badge,
  Button,
  Card,
  CodeArea,
  Empty,
  ErrorBox,
  Field,
  KeyValueEditor,
  Loading,
  Modal,
  NumberInput,
  PageHeader,
  Select,
  Tabs,
  TextArea,
  TextInput,
  Toggle,
  act,
} from '../components/ui';
import { UpstreamEditor, UpstreamList, type Upstream } from '../components/UpstreamEditor';
import { WafRouteEditor, emptyRouteWaf, wafModeLabel, type RouteWaf } from '../components/WafRouteEditor';
import { LuaPackageEditor, PkgBadge, pkgState, routeHasLua, type LuaPackage, type LuaPackageStatus, type WantedLuaPackage } from '../components/LuaPackageEditor';

interface Loc {
  path: string;
  upstreams: Upstream[];
  lb: string;
  websocket: boolean;
  preserveHost: boolean;
  stripPrefix: boolean;
  timeoutSec: number;
  headers: Record<string, string>;
  luaAccess?: string;
  luaContent?: string;
  extra?: string;
  offlinePage?: boolean;
}

const newLoc = (): Loc => ({ path: '/', upstreams: [], lb: 'round_robin', websocket: true, preserveHost: true, stripPrefix: false, timeoutSec: 60, headers: {}, offlinePage: true });

const isWorkloadRef = (target: string) => /^(?:https?\+)?(?:podman|compose|lxc|vm):\/\//.test(target);

const newRoute = () => ({
  id: '',
  enabled: true,
  domains: [] as string[],
  tls: { mode: 'redirect', certId: 'auto' },
  http2: true,
  hsts: false,
  allow: [] as string[],
  deny: [] as string[],
  rateLimit: undefined as undefined | { rps: number; burst: number },
  locations: [newLoc()],
  lua: {} as { access?: string; headerFilter?: string; bodyFilter?: string; log?: string },
  extra: '',
  notes: '',
  waf: emptyRouteWaf() as RouteWaf,
  luaPackages: [] as LuaPackage[],
});

type LuaStatusMap = Record<string, LuaPackageStatus>;

const lines = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

function LocationEditor({ loc, onChange, onRemove }: { loc: Loc; onChange: (l: Loc) => void; onRemove?: () => void }) {
  const [adv, setAdv] = useState(!!(loc.luaAccess || loc.luaContent || loc.extra || Object.keys(loc.headers).length));
  return (
    <fieldset class="fieldset">
      <legend>
        {t('proxy.location')} <code>{loc.path}</code>
      </legend>
      <div class="form-grid">
        <TextInput label={t('proxy.path')} value={loc.path} onInput={(path) => onChange({ ...loc, path })} mono hint={t('proxy.pathHint')} />
        <Select
          label={t('proxy.lb')}
          value={loc.lb}
          onChange={(lb) => onChange({ ...loc, lb })}
          options={[
            { value: 'round_robin', label: 'round robin' },
            { value: 'least_conn', label: 'least_conn' },
            { value: 'ip_hash', label: 'ip_hash' },
          ]}
        />
        <div class="field field-wide">
          <span class="field-label">{t('proxy.upstreams')}</span>
          <UpstreamEditor mode="http" value={loc.upstreams} onChange={(upstreams) => onChange({ ...loc, upstreams })} />
          <span class="field-hint">{t('proxy.upstreamsHint')}</span>
        </div>
        <NumberInput label={t('proxy.timeout')} value={loc.timeoutSec} min={1} onInput={(timeoutSec) => onChange({ ...loc, timeoutSec })} />
        <div class="toggles">
          <Toggle label="WebSocket" checked={loc.websocket} onChange={(websocket) => onChange({ ...loc, websocket })} />
          <Toggle label={t('proxy.preserveHost')} checked={loc.preserveHost} onChange={(preserveHost) => onChange({ ...loc, preserveHost })} />
          <Toggle label={t('proxy.stripPrefix')} checked={loc.stripPrefix} onChange={(stripPrefix) => onChange({ ...loc, stripPrefix })} />
          {loc.upstreams.some((u) => isWorkloadRef(u.target)) && (
            <Toggle label={t('proxy.offlinePage')} checked={loc.offlinePage !== false} hint={t('proxy.offlinePageHint')} onChange={(offlinePage) => onChange({ ...loc, offlinePage })} />
          )}
          <Toggle label={t('proxy.advanced')} checked={adv} onChange={setAdv} />
        </div>
      </div>
      {adv && (
        <>
          <KeyValueEditor label={t('proxy.headers')} value={loc.headers} onChange={(headers) => onChange({ ...loc, headers })} keyPlaceholder="X-Header" />
          <TextArea label="access_by_lua_block" value={loc.luaAccess} onInput={(luaAccess) => onChange({ ...loc, luaAccess })} rows={4} placeholder={'if ngx.var.http_x_token ~= "secret" then\n  return ngx.exit(403)\nend'} hint={t('proxy.luaAccessHint')} />
          <TextArea label="content_by_lua_block" value={loc.luaContent} onInput={(luaContent) => onChange({ ...loc, luaContent })} rows={4} placeholder={'ngx.say("hello from OpenResty")'} hint={t('proxy.luaContentHint')} />
          <TextArea label={t('proxy.extra')} value={loc.extra} onInput={(extra) => onChange({ ...loc, extra })} rows={3} placeholder="proxy_buffering off;" />
        </>
      )}
      {onRemove && (
        <Button small variant="danger" onClick={onRemove}>
          {t('proxy.removeLocation')}
        </Button>
      )}
    </fieldset>
  );
}

function RouteEditor({
  initial,
  certs,
  wafDefault,
  luaStatus,
  onClose,
}: {
  initial: ReturnType<typeof newRoute>;
  certs: any[];
  wafDefault?: string;
  luaStatus: LuaStatusMap;
  onClose: () => void;
}) {
  const [r, setR] = useState(initial);
  const isNew = !initial.id;
  const set = <K extends keyof typeof r>(k: K, v: (typeof r)[K]) => setR({ ...r, [k]: v });
  return (
    <Modal
      title={isNew ? t('proxy.newRoute') : `${t('proxy.editRoute')}: ${r.id}`}
      wide
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={!r.id || !r.domains.length}
          onClick={async () => {
            if (await act(() => put(`/openresty/routes/${r.id}`, r), t('common.saved'))) onClose();
          }}
        >
          {t('common.save')}
        </Button>
      }
    >
      <div class="form-grid">
        <TextInput label="ID" value={r.id} onInput={(v) => set('id', v.toLowerCase())} disabled={!isNew} placeholder="my-site" mono />
        <Toggle label={t('common.enabled')} checked={r.enabled} onChange={(v) => set('enabled', v)} />
        <Field label={t('proxy.domains')} wide hint={t('proxy.domainsHint')}>
          <CodeArea value={r.domains.join('\n')} rows={2} onInput={(v) => set('domains', lines(v))} placeholder={'example.com\nwww.example.com'} />
        </Field>
        <Select
          label="TLS"
          value={r.tls.mode}
          onChange={(mode) => set('tls', { ...r.tls, mode })}
          options={[
            { value: 'off', label: t('proxy.tlsOff') },
            { value: 'on', label: t('proxy.tlsOn') },
            { value: 'redirect', label: t('proxy.tlsRedirect') },
          ]}
        />
        {r.tls.mode !== 'off' && (
          <Select
            label={t('nav.certificates')}
            value={r.tls.certId ?? 'auto'}
            onChange={(certId) => set('tls', { ...r.tls, certId })}
            options={[{ value: 'auto', label: t('proxy.certAuto') }, ...certs.map((c) => ({ value: c.id, label: `${c.id} (${c.domains.join(', ')})` }))]}
          />
        )}
        <div class="toggles">
          <Toggle label="HTTP/2" checked={r.http2} onChange={(v) => set('http2', v)} />
          <Toggle label="HSTS" checked={r.hsts} onChange={(v) => set('hsts', v)} />
          <Toggle
            label={t('proxy.rateLimit')}
            checked={!!r.rateLimit}
            onChange={(v) => set('rateLimit', v ? { rps: 10, burst: 20 } : undefined)}
          />
        </div>
        {r.rateLimit && (
          <>
            <NumberInput label={t('proxy.rps')} value={r.rateLimit.rps} min={1} onInput={(rps) => set('rateLimit', { ...r.rateLimit!, rps })} />
            <NumberInput label={t('proxy.burst')} value={r.rateLimit.burst} min={0} onInput={(burst) => set('rateLimit', { ...r.rateLimit!, burst })} />
          </>
        )}
        <TextInput label={t('proxy.allow')} value={r.allow.join(', ')} onInput={(v) => set('allow', lines(v))} placeholder="10.0.0.0/8, 192.168.1.5" mono />
        <TextInput label={t('proxy.deny')} value={r.deny.join(', ')} onInput={(v) => set('deny', lines(v))} placeholder="1.2.3.4" mono />
      </div>

      {r.locations.map((l, i) => (
        <LocationEditor
          key={i}
          loc={l}
          onChange={(nl) => set('locations', r.locations.map((x, j) => (j === i ? nl : x)))}
          onRemove={r.locations.length > 1 ? () => set('locations', r.locations.filter((_, j) => j !== i)) : undefined}
        />
      ))}
      <Button small onClick={() => set('locations', [...r.locations, { ...newLoc(), path: '/api/' }])}>
        + {t('proxy.addLocation')}
      </Button>

      <WafRouteEditor value={r.waf} defaultMode={wafDefault} onChange={(w) => set('waf', w)} />

      <details class="details">
        <summary>{t('proxy.serverLua')}</summary>
        <p class="muted small">{t('proxy.serverLuaHint')}</p>
        <TextArea label="access_by_lua_block" value={r.lua.access} onInput={(access) => set('lua', { ...r.lua, access })} rows={4} />
        <TextArea label="header_filter_by_lua_block" value={r.lua.headerFilter} onInput={(headerFilter) => set('lua', { ...r.lua, headerFilter })} rows={3} placeholder={'ngx.header["X-Served-By"] = "vas"'} />
        <TextArea label="body_filter_by_lua_block" value={r.lua.bodyFilter} onInput={(bodyFilter) => set('lua', { ...r.lua, bodyFilter })} rows={3} />
        <TextArea label="log_by_lua_block" value={r.lua.log} onInput={(log) => set('lua', { ...r.lua, log })} rows={3} />
        <TextArea label={t('proxy.extraServer')} value={r.extra} onInput={(v) => set('extra', v)} rows={3} placeholder="client_max_body_size 1g;" />
      </details>
      {/* shown once the route has Lua code anywhere (or already lists packages) */}
      {(routeHasLua(r) || r.luaPackages?.length > 0) && (
        <fieldset class="fieldset">
          <legend>{t('lua.packages')}</legend>
          <LuaPackageEditor label="" value={r.luaPackages ?? []} onChange={(v) => set('luaPackages', v)} status={luaStatus} hint={t('lua.routeHint')} />
        </fieldset>
      )}
      <TextArea label={t('common.notes')} value={r.notes} onInput={(v) => set('notes', v)} rows={2} />
    </Modal>
  );
}

function StreamEditor({ initial, onClose }: { initial: any; onClose: () => void }) {
  const [s, setS] = useState(initial);
  const [check, setCheck] = useState<any>(null);
  const isNew = !initial.id;
  const verify = async (port: number, protocol: string) => {
    if (!port) return setCheck(null);
    setCheck(await api(`/ports/check?port=${port}&protocol=${protocol}`).catch(() => null));
  };
  return (
    <Modal
      title={isNew ? t('proxy.newStream') : `${t('proxy.editStream')}: ${s.id}`}
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={!s.id || !s.listen}
          onClick={async () => {
            if (await act(() => put(`/openresty/streams/${s.id}`, s), t('common.saved'))) onClose();
          }}
        >
          {t('common.save')}
        </Button>
      }
    >
      <div class="form-grid">
        <TextInput label="ID" value={s.id} onInput={(v) => setS({ ...s, id: v.toLowerCase() })} disabled={!isNew} placeholder="ssh-vm1" mono />
        <Toggle label={t('common.enabled')} checked={s.enabled} onChange={(enabled) => setS({ ...s, enabled })} />
        <NumberInput
          label={t('proxy.listenPort')}
          value={s.listen}
          min={1}
          max={65535}
          onInput={(listen) => {
            setS({ ...s, listen });
            void verify(listen, s.protocol);
          }}
          hint={
            check &&
            (check.free ? (
              <span class="ok-text">{t('ports.free')}</span>
            ) : (
              <span class="warn-text">
                {t('ports.inUse')}: {check.row?.process ?? check.row?.owners?.map((o: any) => o.owner).join(', ')}
              </span>
            ))
          }
        />
        <Select label={t('proxy.protocol')} value={s.protocol} onChange={(protocol) => setS({ ...s, protocol })} options={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }]} />
        <div class="field field-wide">
          <span class="field-label">{t('proxy.upstreams')}</span>
          <UpstreamEditor mode="stream" value={s.upstreams} onChange={(upstreams) => setS({ ...s, upstreams })} />
          <span class="field-hint">{t('proxy.streamUpstreamsHint')}</span>
        </div>
        <NumberInput label={t('proxy.timeout')} value={s.timeoutSec} min={1} onInput={(timeoutSec) => setS({ ...s, timeoutSec })} />
        <Toggle label="PROXY protocol" checked={s.proxyProtocol} onChange={(proxyProtocol) => setS({ ...s, proxyProtocol })} />
        <TextInput label={t('proxy.allow')} value={s.allow.join(', ')} onInput={(v) => setS({ ...s, allow: lines(v) })} mono />
      </div>
    </Modal>
  );
}

function LuaPackagesCard({ settings, wanted, agentAt }: { settings: any; wanted: WantedLuaPackage[]; agentAt?: string }) {
  const [pk, setPk] = useState<LuaPackage[]>(settings.luaPackages ?? []);
  const [server, setServer] = useState<string>(settings.luarocksServer ?? '');
  const status: LuaStatusMap = Object.fromEntries(wanted.filter((w) => w.status).map((w) => [w.name, w.status!]));
  const failed = wanted.filter((w) => pkgState(w, w.status) === 'failed').length;
  return (
    <Card
      title={t('lua.packages')}
      actions={
        <>
          <Button onClick={() => act(() => post('/openresty/reapply'), t('lua.retrying'))} title={t('lua.retryHint')} disabled={!wanted.length}>
            {failed ? t('lua.retryFailed', { n: failed }) : t('lua.recheck')}
          </Button>
          <Button variant="primary" onClick={() => act(() => put('/openresty/settings', { luaPackages: pk, luarocksServer: server }), t('common.saved'))}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <p class="muted small">{t('lua.intro')}</p>
      <LuaPackageEditor label={t('lua.global')} value={pk} onChange={setPk} status={status} hint={t('lua.globalHint')} />
      <div class="form-grid">
        <TextInput label={t('lua.server')} value={server} onInput={setServer} placeholder="https://luarocks.org" mono hint={t('lua.serverHint')} />
      </div>
      <h4>{t('lua.all')}</h4>
      {wanted.length === 0 ? (
        <Empty>{t('lua.none')}</Empty>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>{t('lua.name')}</th>
              <th>{t('lua.version')}</th>
              <th>{t('lua.usedBy')}</th>
              <th>{t('common.state')}</th>
            </tr>
          </thead>
          <tbody>
            {wanted.map((w) => {
              const state = pkgState(w, w.status);
              return (
                <tr key={w.name}>
                  <td class="mono">{w.name}</td>
                  <td class="mono small">
                    {w.version || <span class="muted">{t('lua.latest')}</span>}{' '}
                    {w.conflict && (
                      <span class="badge badge-warn" title={t('lua.conflictHint')}>
                        {t('lua.conflict')}
                      </span>
                    )}
                  </td>
                  <td class="small">{w.sources.map((s) => (s === 'global' ? t('lua.globalSource') : s)).join(', ')}</td>
                  <td>
                    <PkgBadge state={state} installed={w.status?.installed} />
                    {w.status?.at && <span class="small muted"> {fmtDate(w.status.at)}</span>}
                    {state === 'failed' && w.status?.message && (
                      <details>
                        <summary class="small">{t('lua.showLog')}</summary>
                        <pre class="logbox">{w.status.message}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p class="small muted">
        {t('lua.treeHint')} {agentAt && <>· {t('lua.lastSync')}: {fmtDate(agentAt)}</>}
      </p>
    </Card>
  );
}

function SettingsTab({ settings }: { settings: any }) {
  const [s, setS] = useState(settings);
  // Lua packages have their own card and save button: never send this card's (possibly stale) copy
  const { luaPackages: _p, luarocksServer: _s, ...rest } = s;
  return (
    <Card title={t('proxy.globalSettings')} actions={<Button variant="primary" onClick={() => act(() => put('/openresty/settings', rest), t('common.saved'))}>{t('common.save')}</Button>}>
      <div class="form-grid">
        <NumberInput label={t('proxy.httpPort')} value={s.httpPort} onInput={(httpPort) => setS({ ...s, httpPort })} />
        <NumberInput label={t('proxy.httpsPort')} value={s.httpsPort} onInput={(httpsPort) => setS({ ...s, httpsPort })} />
        <Select
          label={t('proxy.defaultServer')}
          value={s.defaultServer}
          onChange={(defaultServer) => setS({ ...s, defaultServer })}
          options={[
            { value: 'drop', label: t('proxy.defaultDrop') },
            { value: 'manager', label: t('proxy.defaultManager') },
          ]}
        />
        <TextInput label="client_max_body_size" value={s.clientMaxBodySize} onInput={(clientMaxBodySize) => setS({ ...s, clientMaxBodySize })} mono />
        <TextInput label="resolver" value={s.resolver} onInput={(resolver) => setS({ ...s, resolver })} mono />
        <Toggle label={t('proxy.ipv6')} checked={s.ipv6 !== false} onChange={(ipv6) => setS({ ...s, ipv6 })} hint={t('proxy.ipv6Hint')} />
      </div>
      <TextArea label={t('proxy.globalHttp')} value={s.globalHttpConfig} onInput={(globalHttpConfig) => setS({ ...s, globalHttpConfig })} rows={5} placeholder="gzip on;" />
      <TextArea label="init_worker_by_lua (vas_user.init_worker)" value={s.initWorkerLua} onInput={(initWorkerLua) => setS({ ...s, initWorkerLua })} rows={6} hint={t('proxy.initWorkerHint')} />
      <TextArea label={t('proxy.offlineHtml')} value={s.offlineHtml} onInput={(offlineHtml) => setS({ ...s, offlineHtml })} rows={6} placeholder={'<!doctype html>\n<title>{{title}}</title>\n<h1>{{title}}</h1>\n<p>{{message}}</p>'} hint={t('proxy.offlineHtmlHint')} />
    </Card>
  );
}

function PreviewTab() {
  const { data, loading, reload } = useApi('/openresty/preview', ['openresty']);
  const [file, setFile] = useState<string>('');
  if (loading) return <Loading />;
  const files = Object.keys(data?.files ?? {}).sort();
  const cur = file || files.find((f) => f.startsWith('http/route-')) || files[0];
  return (
    <Card title={`${t('proxy.revision')} ${data?.revision}`} actions={<Button small onClick={reload}>{t('common.refresh')}</Button>}>
      <div class="split">
        <ul class="filelist">
          {files.map((f) => (
            <li key={f}>
              <button class={`linklike${f === cur ? ' active' : ''}`} onClick={() => setFile(f)}>
                {f}
              </button>
            </li>
          ))}
        </ul>
        <pre class="logbox tall grow">{cur ? data.files[cur] : ''}</pre>
      </div>
    </Card>
  );
}

export function Proxy() {
  const { data, error, loading } = useApi('/openresty', ['openresty', 'acme', 'settings']);
  const certs = useApi('/acme', ['acme']);
  const waf = useApi('/waf', ['settings']);
  const wafDefault: string | undefined = waf.data?.settings?.defaultMode;
  const [tab, setTab] = useState<'http' | 'stream' | 'settings' | 'preview'>('http');
  const [editRoute, setEditRoute] = useState<any>(null);
  const [editStream, setEditStream] = useState<any>(null);
  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const agent = data.agent;
  const certList: any[] = certs.data?.certificates ?? [];
  const wantedLua: WantedLuaPackage[] = data.luaPackages ?? [];
  const luaStatus: LuaStatusMap = Object.fromEntries((agent.luaPackages ?? []).map((p: LuaPackageStatus) => [p.name, p]));
  const luaFailed = wantedLua.filter((w) => pkgState(w, w.status) === 'failed');

  return (
    <div>
      <PageHeader
        title={t('nav.proxy')}
        sub={t('proxy.sub')}
        actions={
          <Button onClick={() => act(() => post('/openresty/reapply'), t('proxy.reapplied'))} title={t('proxy.reapplyHint')}>
            {t('proxy.reapply')}
          </Button>
        }
      />
      <Card>
        <div class="row gap wrap">
          <Badge state={agent.online ? 'online' : 'offline'} label={agent.online ? t('proxy.online') : t('proxy.offline')} />
          <Badge state={agent.inSync ? 'success' : 'pending'} label={agent.inSync ? t('proxy.inSync') : t('proxy.outOfSync')} />
          <span class="small muted">
            {t('proxy.revision')}: <code>{data.revision}</code> · {t('proxy.applied')}: <code>{agent.appliedRevision ?? '—'}</code> · {t('proxy.lastSeen')}: {fmtDate(agent.lastSeen)}
          </span>
          {agent.lastReport?.version && <span class="small muted">{agent.lastReport.version}</span>}
        </div>
        {agent.lastReport && !agent.lastReport.ok && (
          <div class="alert alert-error">
            <strong>{t('proxy.applyFailed', { rev: agent.lastReport.revision })}</strong>
            <pre class="logbox">{agent.lastReport.message}</pre>
          </div>
        )}
        {!agent.lastSeen && <div class="alert alert-warn">{t('proxy.agentHint')}</div>}
        {luaFailed.length > 0 && (
          <div class="alert alert-warn">
            {t('lua.failedAlert', { names: luaFailed.map((w) => w.name).join(', ') })}{' '}
            <button class="linklike" onClick={() => setTab('settings')}>
              {t('lua.details')}
            </button>
          </div>
        )}
      </Card>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'http', label: t('proxy.httpRoutes') },
          { id: 'stream', label: t('proxy.streamRoutes') },
          { id: 'settings', label: t('nav.settings') },
          { id: 'preview', label: t('proxy.preview') },
        ]}
      />
      {tab === 'http' && (
        <Card actions={<Button variant="primary" onClick={() => setEditRoute(newRoute())}>+ {t('proxy.newRoute')}</Button>}>
          {data.system && (
            <div class="alert alert-info">
              <strong>{t('proxy.systemRoute')}</strong> <span class="mono">{data.system.domains.join(', ')}</span> → <span class="mono">{data.system.locations[0].upstreams[0].target}</span>
              {' · TLS '}
              {data.system.tls.mode}
              <div class="small muted">{t('proxy.systemRouteHint')}</div>
            </div>
          )}
          {data.routes.length === 0 ? (
            <Empty>{t('proxy.noRoutes')}</Empty>
          ) : (
            <table class="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t('proxy.domains')}</th>
                  <th>{t('proxy.upstreams')}</th>
                  <th>TLS</th>
                  <th>{t('proxy.features')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.routes.map((r: any) => (
                  <tr key={r.id} class={r.enabled ? '' : 'disabled'}>
                    <td>
                      <strong>{r.id}</strong>
                      {!r.enabled && <span class="badge badge-muted">{t('common.disabled')}</span>}
                    </td>
                    <td class="mono small">{r.domains.join(', ')}</td>
                    <td class="mono small">
                      {r.locations.map((l: any) => (
                        <div key={l.path}>
                          <strong>{l.path}</strong> {l.luaContent ? '→ Lua' : <UpstreamList upstreams={l.upstreams} targets={data.targets ?? {}} />}
                        </div>
                      ))}
                    </td>
                    <td>{r.tls.mode === 'off' ? '—' : `${r.tls.mode} (${r.tls.certId})`}</td>
                    <td class="small">
                      {r.rateLimit && <span class="badge badge-muted">{r.rateLimit.rps} r/s</span>}{' '}
                      {routeHasLua(r) && <span class="badge badge-muted">Lua</span>}{' '}
                      {r.luaPackages?.length > 0 && (
                        <span
                          class={`badge ${r.luaPackages.some((p: LuaPackage) => pkgState(p, luaStatus[p.name]) === 'failed') ? 'badge-error' : 'badge-muted'}`}
                          title={r.luaPackages.map((p: LuaPackage) => (p.version ? `${p.name} ${p.version}` : p.name)).join('\n')}
                        >
                          {t('lua.count', { n: r.luaPackages.length })}
                        </span>
                      )}{' '}
                      {r.allow.length > 0 && <span class="badge badge-muted">ACL</span>}{' '}
                      {(() => {
                        const m = !r.waf?.mode || r.waf.mode === 'inherit' ? wafDefault : r.waf.mode;
                        return m && m !== 'off' ? <span class={`badge ${m === 'block' ? 'badge-ok' : 'badge-warn'}`}>WAF {wafModeLabel(m)}</span> : null;
                      })()}
                    </td>
                    <td class="actions">
                      <Button small onClick={() => setEditRoute(r)}>{t('common.edit')}</Button>
                      <Button small variant="danger" confirm={t('common.confirmDelete')} onClick={() => act(() => del(`/openresty/routes/${r.id}`), t('common.done'))}>
                        {t('act.remove')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {tab === 'stream' && (
        <Card
          actions={
            <Button variant="primary" onClick={() => setEditStream({ id: '', enabled: true, listen: 0, protocol: 'tcp', upstreams: [], proxyProtocol: false, timeoutSec: 600, allow: [] })}>
              + {t('proxy.newStream')}
            </Button>
          }
        >
          {data.streams.length === 0 ? (
            <Empty>{t('proxy.noStreams')}</Empty>
          ) : (
            <table class="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t('proxy.listenPort')}</th>
                  <th>{t('proxy.upstreams')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.streams.map((s: any) => (
                  <tr key={s.id} class={s.enabled ? '' : 'disabled'}>
                    <td>
                      <strong>{s.id}</strong>
                    </td>
                    <td class="mono">
                      {s.listen}/{s.protocol}
                    </td>
                    <td class="mono small">
                      <UpstreamList upstreams={s.upstreams} targets={data.targets ?? {}} />
                    </td>
                    <td class="actions">
                      <Button small onClick={() => setEditStream(s)}>{t('common.edit')}</Button>
                      <Button small variant="danger" confirm={t('common.confirmDelete')} onClick={() => act(() => del(`/openresty/streams/${s.id}`), t('common.done'))}>
                        {t('act.remove')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {tab === 'settings' && (
        <>
          <SettingsTab settings={data.settings} />
          <LuaPackagesCard settings={data.settings} wanted={wantedLua} agentAt={agent.luaPackagesAt} />
        </>
      )}
      {tab === 'preview' && <PreviewTab />}
      {editRoute && <RouteEditor initial={{ ...newRoute(), ...editRoute }} certs={certList} wafDefault={wafDefault} luaStatus={luaStatus} onClose={() => setEditRoute(null)} />}
      {editStream && <StreamEditor initial={editStream} onClose={() => setEditStream(null)} />}
    </div>
  );
}
