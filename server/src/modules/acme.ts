import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env } from '../core/env.js';
import { run, which } from '../core/exec.js';
import { startJob, type JobContext } from '../core/jobs.js';
import { createLogger } from '../core/logger.js';
import {
  Collection,
  HttpError,
  assertId,
  getSettings,
  readJson,
  updateSettings,
  writeFileAtomic,
  writeJson,
} from '../core/store.js';
import { bus } from '../core/events.js';
import { checkAgentRequest, getAgentToken } from './auth.js';

/**
 * Let's Encrypt certificates via acme.sh using the DNS-01 challenge, either
 * directly against the domain's zone ("dns") or through a CNAME'd alias zone
 * ("DNS alias mode": --challenge-alias / --domain-alias).
 *
 * acme.sh runs in its own container (neilpang/acme.sh in `daemon` mode keeps
 * cron renewals going); the manager drives it through `podman exec`. Issued
 * certificates are installed into <acme home>/vas-certs/<id>/ and acme.sh's
 * reload hook calls back into the manager, which bumps the OpenResty bundle.
 */

const log = createLogger('acme');

export const DNS_PROVIDERS: { type: string; label: string; env: string[] }[] = [
  { type: 'dns_cf', label: 'Cloudflare', env: ['CF_Token', 'CF_Account_ID', 'CF_Zone_ID'] },
  { type: 'dns_ali', label: 'Alibaba Cloud (Aliyun)', env: ['Ali_Key', 'Ali_Secret'] },
  { type: 'dns_dp', label: 'DNSPod.cn', env: ['DP_Id', 'DP_Key'] },
  { type: 'dns_tencent', label: 'Tencent Cloud', env: ['Tencent_SecretId', 'Tencent_SecretKey'] },
  { type: 'dns_huaweicloud', label: 'Huawei Cloud', env: ['HUAWEICLOUD_Username', 'HUAWEICLOUD_Password', 'HUAWEICLOUD_DomainName'] },
  { type: 'dns_aws', label: 'AWS Route53', env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] },
  { type: 'dns_azure', label: 'Azure DNS', env: ['AZUREDNS_SUBSCRIPTIONID', 'AZUREDNS_TENANTID', 'AZUREDNS_APPID', 'AZUREDNS_CLIENTSECRET'] },
  { type: 'dns_gcloud', label: 'Google Cloud DNS', env: ['CLOUDSDK_ACTIVE_CONFIG_NAME'] },
  { type: 'dns_gd', label: 'GoDaddy', env: ['GD_Key', 'GD_Secret'] },
  { type: 'dns_namesilo', label: 'NameSilo', env: ['Namesilo_Key'] },
  { type: 'dns_porkbun', label: 'Porkbun', env: ['PORKBUN_API_KEY', 'PORKBUN_SECRET_API_KEY'] },
  { type: 'dns_hetzner', label: 'Hetzner', env: ['HETZNER_Token'] },
  { type: 'dns_do', label: 'DigitalOcean', env: ['DO_API_KEY'] },
  { type: 'dns_linode_v4', label: 'Linode', env: ['LINODE_V4_API_KEY'] },
  { type: 'dns_vultr', label: 'Vultr', env: ['VULTR_API_KEY'] },
  { type: 'dns_ovh', label: 'OVH', env: ['OVH_AK', 'OVH_AS', 'OVH_CK', 'OVH_END_POINT'] },
  { type: 'dns_gandi_livedns', label: 'Gandi LiveDNS', env: ['GANDI_LIVEDNS_TOKEN'] },
  { type: 'dns_cloudns', label: 'ClouDNS', env: ['CLOUDNS_AUTH_ID', 'CLOUDNS_AUTH_PASSWORD'] },
  { type: 'dns_pdns', label: 'PowerDNS', env: ['PDNS_Url', 'PDNS_ServerId', 'PDNS_Token', 'PDNS_Ttl'] },
  { type: 'dns_acmedns', label: 'acme-dns', env: ['ACMEDNS_BASE_URL', 'ACMEDNS_USERNAME', 'ACMEDNS_PASSWORD', 'ACMEDNS_SUBDOMAIN'] },
  { type: 'dns_duckdns', label: 'DuckDNS', env: ['DuckDNS_Token'] },
  { type: 'dns_he', label: 'Hurricane Electric', env: ['HE_Username', 'HE_Password'] },
  { type: 'dns_nsupdate', label: 'RFC2136 nsupdate', env: ['NSUPDATE_SERVER', 'NSUPDATE_KEY', 'NSUPDATE_ZONE'] },
];

export interface DnsProvider {
  id: string;
  name: string;
  type: string;
}

export interface Certificate {
  id: string;
  source: 'acme' | 'manual';
  domains: string[];
  keyType: 'ec-256' | 'ec-384' | '2048' | '3072' | '4096';
  server: string;
  dnsProviderId?: string;
  aliasMode: 'none' | 'challenge' | 'domain';
  aliasDomain?: string;
  dnsSleep?: number;
  createdAt: string;
}

export interface CertStatus {
  state: 'pending' | 'issuing' | 'issued' | 'error';
  notBefore?: string;
  notAfter?: string;
  issuer?: string;
  sans?: string[];
  fingerprint?: string;
  lastError?: string;
  updatedAt?: string;
}

export const dnsProviders = new Collection<DnsProvider>('acme.dns', 'acme/dns');
export const certificates = new Collection<Certificate>('acme.certs', 'acme/certs');
const dnsSecrets = new Collection<{ id: string; env: Record<string, string> }>('acme.dns.secrets', 'secrets/dns', true);

const statusFile = () => path.join(env.stateDir, 'cert-status.json');
const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function certDir(id: string): string {
  return path.join(env.acme.home, 'vas-certs', assertId(id));
}

function certDirInAcme(id: string): string {
  const base = env.acme.mode === 'podman' ? env.acme.homeInContainer : env.acme.home;
  return path.posix.join(base, 'vas-certs', id);
}

/**
 * Certificates installed before the rename to VAS live in hastur-certs/, and
 * acme.sh keeps renewing them there (the install paths are stored in its own
 * config) until they're issued again from VAS.
 */
const legacyCertDir = (id: string) => path.join(env.acme.home, 'hastur-certs', assertId(id));

export async function readCertFiles(id: string): Promise<{ fullchain: string; key: string } | null> {
  for (const dir of [certDir(id), legacyCertDir(id)]) {
    try {
      const [fullchain, key] = await Promise.all([
        fs.readFile(path.join(dir, 'fullchain.pem'), 'utf8'),
        fs.readFile(path.join(dir, 'key.pem'), 'utf8'),
      ]);
      return { fullchain, key };
    } catch {
      /* try the next location */
    }
  }
  return null;
}

async function getStatuses(): Promise<Record<string, CertStatus>> {
  return readJson(statusFile(), {});
}

async function setStatus(id: string, patch: Partial<CertStatus>): Promise<void> {
  const all = await getStatuses();
  all[id] = { ...(all[id] ?? { state: 'pending' }), ...patch, updatedAt: new Date().toISOString() };
  await writeJson(statusFile(), all);
  bus.changed('certs', id);
}

/** Reads the installed certificate and records validity information. */
export async function refreshStatus(id: string): Promise<CertStatus | undefined> {
  const files = await readCertFiles(id);
  if (!files) return (await getStatuses())[id];
  try {
    const x = new crypto.X509Certificate(files.fullchain);
    await setStatus(id, {
      state: 'issued',
      notBefore: new Date(x.validFrom).toISOString(),
      notAfter: new Date(x.validTo).toISOString(),
      issuer: x.issuer.split('\n').find((l) => l.startsWith('CN='))?.slice(3) ?? x.issuer,
      sans: (x.subjectAltName ?? '').split(/,\s*/).map((s) => s.replace(/^DNS:/, '')).filter(Boolean),
      fingerprint: x.fingerprint256,
      lastError: undefined,
    });
  } catch (err) {
    await setStatus(id, { state: 'error', lastError: `cannot parse certificate: ${(err as Error).message}` });
  }
  return (await getStatuses())[id];
}

export async function acmeAvailable(): Promise<{ ok: boolean; detail: string }> {
  if (env.acme.mode === 'local') {
    return (await which(env.acme.bin)) ? { ok: true, detail: 'local acme.sh' } : { ok: false, detail: 'acme.sh not on PATH' };
  }
  if (!(await which(env.podman.bin))) return { ok: false, detail: 'podman not available' };
  const r = await run(env.podman.bin, ['container', 'inspect', '-f', '{{.State.Running}}', env.acme.container], {
    allowFail: true,
    timeoutMs: 10_000,
  });
  return r.stdout.trim() === 'true'
    ? { ok: true, detail: `container ${env.acme.container}` }
    : { ok: false, detail: `container ${env.acme.container} is not running` };
}

async function acme(args: string[], vars: Record<string, string>, job?: JobContext) {
  const configHome = env.acme.mode === 'podman' ? env.acme.homeInContainer : env.acme.home;
  const full = ['--config-home', configHome, ...args];
  if (env.acme.mode === 'podman') {
    // `--env NAME` (without value) makes podman copy the value from our environment,
    // so credentials never appear on the command line.
    const envFlags = Object.keys(vars).flatMap((k) => ['--env', k]);
    return run(env.podman.bin, ['exec', ...envFlags, env.acme.container, env.acme.bin, ...full], {
      env: vars,
      onLine: job?.log,
      allowFail: true,
      timeoutMs: 30 * 60_000,
    });
  }
  return run(env.acme.bin, full, { env: vars, onLine: job?.log, allowFail: true, timeoutMs: 30 * 60_000 });
}

function isEcc(c: Certificate): boolean {
  return c.keyType.startsWith('ec-');
}

async function providerEnv(c: Certificate): Promise<{ type: string; vars: Record<string, string> }> {
  if (!c.dnsProviderId) throw new HttpError(400, 'certificate has no DNS provider');
  const p = await dnsProviders.require(c.dnsProviderId);
  const s = await dnsSecrets.get(p.id);
  return { type: p.type, vars: s?.env ?? {} };
}

function reloadCmd(id: string): string {
  const url = `${env.acme.callbackUrl.replace(/\/$/, '')}/api/agent/acme/renewed/${id}`;
  return `curl -fsS -X POST -H 'Authorization: Bearer ${getAgentToken()}' '${url}' || true`;
}

async function issue(c: Certificate, job: JobContext, force = false): Promise<void> {
  const settings = await getSettings();
  const { type, vars } = await providerEnv(c);
  await setStatus(c.id, { state: 'issuing', lastError: undefined });
  if (settings.acme.email) {
    job.log(`registering ACME account ${settings.acme.email} on ${c.server}`);
    await acme(['--register-account', '-m', settings.acme.email, '--server', c.server], {}, job);
  }
  const args = ['--issue', '--server', c.server, '--keylength', c.keyType, '--dns', type];
  if (c.dnsSleep) args.push('--dnssleep', String(c.dnsSleep));
  for (const d of c.domains) {
    args.push('-d', d);
    if (c.aliasMode === 'challenge' && c.aliasDomain) args.push('--challenge-alias', c.aliasDomain);
    if (c.aliasMode === 'domain' && c.aliasDomain) args.push('--domain-alias', c.aliasDomain);
  }
  if (force) args.push('--force');
  job.log(`acme.sh ${args.join(' ')}`);
  const r = await acme(args, vars, job);
  // exit code 2 = "Skipped, not due for renewal"
  if (r.code !== 0 && r.code !== 2) throw new Error(`acme.sh --issue failed (exit ${r.code})`);
  await install(c, job);
}

async function install(c: Certificate, job: JobContext): Promise<void> {
  await fs.mkdir(certDir(c.id), { recursive: true });
  const dir = certDirInAcme(c.id);
  const args = [
    '--install-cert',
    '-d',
    c.domains[0],
    ...(isEcc(c) ? ['--ecc'] : []),
    '--key-file',
    `${dir}/key.pem`,
    '--fullchain-file',
    `${dir}/fullchain.pem`,
    '--reloadcmd',
    reloadCmd(c.id),
  ];
  const r = await acme(args, {}, job);
  if (r.code !== 0) throw new Error(`acme.sh --install-cert failed (exit ${r.code})`);
  const st = await refreshStatus(c.id);
  job.log(`installed certificate, valid until ${st?.notAfter ?? '?'}`);
  bus.changed('openresty');
}

function validateCert(b: any, existing?: Certificate): Certificate {
  const id = assertId(b.id, 'certificate id');
  const domains: string[] = (Array.isArray(b.domains) ? b.domains : String(b.domains ?? '').split(/[\s,]+/))
    .map((d: string) => d.trim().toLowerCase())
    .filter(Boolean);
  if (!domains.length) throw new HttpError(400, 'at least one domain is required');
  for (const d of domains) if (!DOMAIN_RE.test(d)) throw new HttpError(400, `invalid domain ${d}`);
  const source = b.source === 'manual' ? 'manual' : 'acme';
  const keyType = ['ec-256', 'ec-384', '2048', '3072', '4096'].includes(b.keyType) ? b.keyType : 'ec-256';
  const server = String(b.server || 'letsencrypt');
  if (!/^[\w.:/-]+$/.test(server)) throw new HttpError(400, 'invalid ACME server');
  const aliasMode = ['none', 'challenge', 'domain'].includes(b.aliasMode) ? b.aliasMode : 'none';
  const aliasDomain = b.aliasDomain ? String(b.aliasDomain).trim().toLowerCase() : undefined;
  if (aliasMode !== 'none' && (!aliasDomain || !DOMAIN_RE.test(aliasDomain))) {
    throw new HttpError(400, 'DNS alias mode requires a valid alias domain');
  }
  if (source === 'acme' && !b.dnsProviderId) throw new HttpError(400, 'DNS provider is required');
  return {
    id,
    source,
    domains,
    keyType,
    server,
    dnsProviderId: b.dnsProviderId || undefined,
    aliasMode,
    aliasDomain,
    dnsSleep: b.dnsSleep ? Math.max(0, Math.min(3600, Number(b.dnsSleep))) : undefined,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
}

/** Picks the best certificate for a set of hostnames (exact or wildcard match). */
export async function matchCertificate(hosts: string[]): Promise<string | undefined> {
  const statuses = await getStatuses();
  const covers = (sans: string[], h: string) =>
    sans.some((s) => s === h || (s.startsWith('*.') && h.split('.').slice(1).join('.') === s.slice(2)));
  for (const c of await certificates.list()) {
    const st = statuses[c.id];
    if (st?.state !== 'issued') continue;
    if (hosts.every((h) => covers(st.sans ?? c.domains, h))) return c.id;
  }
  return undefined;
}

export function routes(app: FastifyInstance): void {
  app.get('/api/acme', async () => {
    const statuses = await getStatuses();
    const settings = await getSettings();
    return {
      available: await acmeAvailable(),
      mode: env.acme.mode,
      email: settings.acme.email,
      providerTypes: DNS_PROVIDERS,
      providers: await Promise.all(
        (await dnsProviders.list()).map(async (p) => ({
          ...p,
          keys: Object.keys((await dnsSecrets.get(p.id))?.env ?? {}),
        })),
      ),
      certificates: (await certificates.list()).map((c) => ({ ...c, status: statuses[c.id] ?? { state: 'pending' } })),
    };
  });

  app.put('/api/acme/providers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { name: string; type: string; env?: Record<string, string> };
    assertId(id, 'provider id');
    if (!/^dns_\w+$/.test(b.type)) throw new HttpError(400, 'provider type must look like dns_xxx');
    await dnsProviders.put({ id, name: String(b.name || id).slice(0, 80), type: b.type });
    if (b.env) {
      const cur = (await dnsSecrets.get(id))?.env ?? {};
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.env)) {
        if (!ENV_KEY_RE.test(k)) throw new HttpError(400, `invalid variable ${k}`);
        // empty value keeps the stored secret, "-" removes it
        if (v === '-') continue;
        next[k] = v === '' ? cur[k] ?? '' : v;
      }
      await dnsSecrets.put({ id, env: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== '')) });
    }
    return { ok: true };
  });

  app.delete('/api/acme/providers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const used = (await certificates.list()).filter((c) => c.dnsProviderId === id);
    if (used.length) throw new HttpError(409, `provider is used by: ${used.map((c) => c.id).join(', ')}`);
    await dnsProviders.remove(id);
    await dnsSecrets.remove(id);
    return { ok: true };
  });

  app.put('/api/acme/certs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const existing = await certificates.get(id);
    const c = validateCert({ ...(req.body as object), id }, existing);
    await certificates.put(c);
    return c;
  });

  /** Manual certificates: upload PEMs */
  app.put('/api/acme/certs/:id/pem', async (req) => {
    const { id } = req.params as { id: string };
    const c = await certificates.require(id);
    if (c.source !== 'manual') throw new HttpError(400, 'only manual certificates accept uploads');
    const { fullchain, key } = req.body as { fullchain: string; key: string };
    try {
      new crypto.X509Certificate(fullchain);
      crypto.createPrivateKey(key);
    } catch (err) {
      throw new HttpError(400, `invalid PEM: ${(err as Error).message}`);
    }
    await writeFileAtomic(path.join(certDir(id), 'fullchain.pem'), fullchain);
    await writeFileAtomic(path.join(certDir(id), 'key.pem'), key, 0o600);
    await refreshStatus(id);
    bus.changed('openresty');
    return { ok: true };
  });

  app.post('/api/acme/certs/:id/issue', async (req) => {
    const { id } = req.params as { id: string };
    const force = (req.query as any).force === 'true';
    const c = await certificates.require(id);
    if (c.source !== 'acme') throw new HttpError(400, 'manual certificate');
    return startJob(`acme issue ${id}`, 'certs', async (job) => {
      try {
        await issue(c, job, force);
      } catch (err) {
        await setStatus(id, { state: 'error', lastError: (err as Error).message });
        throw err;
      }
    });
  });

  app.post('/api/acme/certs/:id/renew', async (req) => {
    const { id } = req.params as { id: string };
    const c = await certificates.require(id);
    return startJob(`acme renew ${id}`, 'certs', async (job) => {
      const { vars } = await providerEnv(c);
      const r = await acme(['--renew', '-d', c.domains[0], '--force', ...(isEcc(c) ? ['--ecc'] : [])], vars, job);
      if (r.code !== 0 && r.code !== 2) {
        await setStatus(id, { state: 'error', lastError: `renew failed (exit ${r.code})` });
        throw new Error(`acme.sh --renew failed (exit ${r.code})`);
      }
      await refreshStatus(id);
      bus.changed('openresty');
    });
  });

  app.delete('/api/acme/certs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const c = await certificates.require(id);
    if (c.source === 'acme') {
      await acme(['--remove', '-d', c.domains[0], ...(isEcc(c) ? ['--ecc'] : [])], {}).catch(() => undefined);
    }
    await fs.rm(certDir(id), { recursive: true, force: true });
    await fs.rm(legacyCertDir(id), { recursive: true, force: true });
    await certificates.remove(id);
    const all = await getStatuses();
    delete all[id];
    await writeJson(statusFile(), all);
    bus.changed('openresty');
    return { ok: true };
  });

  app.put('/api/acme/settings', async (req) => {
    const { email } = req.body as { email: string };
    await updateSettings({ acme: { ...(await getSettings()).acme, email } });
    return { ok: true };
  });

  // Called by acme.sh's --reloadcmd after every successful renewal
  app.post('/api/agent/acme/renewed/:id', async (req) => {
    checkAgentRequest(req);
    const { id } = req.params as { id: string };
    log.info(`acme.sh reported renewal of ${id}`);
    await refreshStatus(assertId(id));
    bus.changed('openresty');
    return { ok: true };
  });
}

/** Periodically re-read installed certificates (renewals done by acme.sh cron). */
/**
 * VAS_PUBLIC_DNS_PROVIDER: keeps a DNS provider and certificate named
 * "vas-system" in line with the environment and issues the certificate
 * for VAS_PUBLIC_DOMAIN when it isn't valid yet. The system proxy route
 * (certId "auto") picks it up as soon as it exists.
 */
export async function ensurePublicCertificate(): Promise<void> {
  const pub = env.public;
  if (!pub.domains.length || !pub.dnsProvider) return;
  const id = 'vas-system';
  if (!/^dns_\w+$/.test(pub.dnsProvider)) {
    log.error(`VAS_PUBLIC_DNS_PROVIDER must look like dns_xxx, got ${pub.dnsProvider}`);
    return;
  }
  if (env.acme.email && !(await getSettings()).acme.email) {
    await updateSettings({ acme: { ...(await getSettings()).acme, email: env.acme.email } });
  }

  // write only on change, so restarts don't produce git commits
  const provider: DnsProvider = { id, name: 'VAS UI (from environment)', type: pub.dnsProvider };
  const curProvider = await dnsProviders.get(id);
  if (JSON.stringify(curProvider) !== JSON.stringify(provider)) await dnsProviders.put(provider);
  const vars = Object.fromEntries(pub.dnsEnv.map((k) => [k, process.env[k] ?? '']).filter(([, v]) => v));
  const missing = pub.dnsEnv.filter((k) => !process.env[k]);
  if (missing.length) log.warn(`VAS_PUBLIC_DNS_ENV: ${missing.join(', ')} not set`);
  if (Object.keys(vars).length && JSON.stringify((await dnsSecrets.get(id))?.env) !== JSON.stringify(vars)) {
    await dnsSecrets.put({ id, env: vars });
  }

  const existing = await certificates.get(id);
  let wanted: Certificate;
  try {
    wanted = validateCert(
      {
        id,
        source: 'acme',
        domains: pub.domains,
        keyType: existing?.keyType ?? 'ec-256',
        server: pub.acmeServer,
        dnsProviderId: id,
        aliasMode: pub.dnsAlias ? 'challenge' : 'none',
        aliasDomain: pub.dnsAlias || undefined,
      },
      existing,
    );
  } catch (err) {
    log.error(`public certificate: ${(err as Error).message}`);
    return;
  }
  if (JSON.stringify(existing) !== JSON.stringify(wanted)) await certificates.put(wanted);

  const st = (await getStatuses())[id];
  const covers = st?.state === 'issued' && pub.domains.every((d) => (st.sans ?? []).includes(d));
  if (covers) return;
  if (st?.state === 'error' && st.updatedAt && Date.now() - Date.parse(st.updatedAt) < 3600_000) {
    log.warn(`public certificate failed less than an hour ago (${st.lastError}); not retrying yet`);
    return;
  }

  // the acme container may still be starting next to us
  for (let attempt = 1; attempt <= 10; attempt++) {
    if ((await acmeAvailable()).ok) {
      startJob(`acme issue ${id} (VAS_PUBLIC_DOMAIN)`, 'certs', async (job) => {
        try {
          await issue(wanted, job);
        } catch (err) {
          await setStatus(id, { state: 'error', lastError: (err as Error).message });
          throw err;
        }
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
  log.error('public certificate: acme.sh never became available');
}

export function startCertWatcher(): void {
  const scan = async () => {
    for (const c of await certificates.list()) {
      const before = (await getStatuses())[c.id]?.fingerprint;
      const st = await refreshStatus(c.id);
      if (st?.fingerprint && st.fingerprint !== before) {
        log.info(`certificate ${c.id} changed on disk`);
        bus.changed('openresty');
      }
      if (st?.notAfter && Date.parse(st.notAfter) - Date.now() < 14 * 86400_000) {
        log.warn(`certificate ${c.id} expires at ${st.notAfter}`);
      }
    }
  };
  setTimeout(() => void scan().catch(() => undefined), 5000);
  setInterval(() => void scan().catch((e) => log.error('cert scan failed', e)), 30 * 60_000);
}
