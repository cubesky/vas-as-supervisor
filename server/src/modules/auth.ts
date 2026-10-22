import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { env } from '../core/env.js';
import { createLogger } from '../core/logger.js';
import { HttpError, emitConfigChange, readJson, writeJson } from '../core/store.js';
import { isAdminRequest } from '../core/admin.js';

/**
 * Passkey-only login for a single administrator. Enabled unless
 * VAS_AUTH_ENABLED=false. The very first passkey can only be registered
 * with the setup token (VAS_SETUP_TOKEN, or a random one printed to the log).
 */

const log = createLogger('auth');
const SESSION_COOKIE = 'vas_session';
const CHALLENGE_COOKIE = 'vas_challenge';

interface Passkey {
  id: string;
  name: string;
  publicKey: string; // base64url
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  deviceType?: string;
  backedUp?: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

interface Session {
  hash: string;
  createdAt: number;
  expiresAt: number;
  passkeyId: string;
  ua?: string;
}

const passkeysFile = () => path.join(env.configDir, 'auth', 'passkeys.json');
const userFile = () => path.join(env.configDir, 'auth', 'user.json');
const sessionsFile = () => path.join(env.stateDir, 'sessions.json');
const agentTokenFile = () => path.join(env.configDir, 'secrets', 'agent-token');

const challenges = new Map<string, { challenge: string; kind: 'reg' | 'auth'; expires: number; name?: string }>();
let sessions: Session[] = [];
let setupToken = env.auth.setupToken;
let agentToken = env.agentToken;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function getPasskeys(): Promise<Passkey[]> {
  return readJson<Passkey[]>(passkeysFile(), []);
}

async function savePasskeys(list: Passkey[]): Promise<void> {
  await writeJson(passkeysFile(), list);
  emitConfigChange({ collection: 'passkeys', action: 'update' });
}

async function getUser(): Promise<{ id: string; name: string }> {
  let u = await readJson<{ id: string; name: string } | null>(userFile(), null);
  if (!u) {
    u = { id: crypto.randomBytes(16).toString('base64url'), name: 'admin' };
    await writeJson(userFile(), u);
  }
  return u;
}

async function saveSessions(): Promise<void> {
  const now = Date.now();
  sessions = sessions.filter((s) => s.expiresAt > now);
  await writeJson(sessionsFile(), sessions, 0o600);
}

export async function initAuth(): Promise<void> {
  sessions = await readJson<Session[]>(sessionsFile(), []);
  if (!agentToken) {
    try {
      agentToken = fs.readFileSync(agentTokenFile(), 'utf8').trim();
    } catch {
      agentToken = crypto.randomBytes(32).toString('base64url');
      fs.mkdirSync(path.dirname(agentTokenFile()), { recursive: true });
      fs.writeFileSync(agentTokenFile(), agentToken, { mode: 0o600 });
      log.info(`generated agent token at ${agentTokenFile()}`);
    }
  }
  if (!env.auth.enabled) {
    log.warn('authentication is DISABLED (VAS_AUTH_ENABLED=false)');
    return;
  }
  if ((await getPasskeys()).length === 0) {
    if (!setupToken) setupToken = crypto.randomBytes(9).toString('base64url');
    log.warn(`no passkey registered yet. Setup token: ${setupToken}`);
  }
}

export function getAgentToken(): string {
  return agentToken;
}

export function checkAgentRequest(req: FastifyRequest): void {
  const h = req.headers.authorization ?? '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : String((req.query as any)?.token ?? '');
  if (!agentToken || !safeEqual(tok, agentToken)) throw new HttpError(401, 'invalid agent token');
}

function rpFor(req: FastifyRequest): { origin: string; rpID: string } {
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  const origin = (req.headers.origin as string) || `${proto}://${host}`;
  if (env.auth.origins.length && !env.auth.origins.includes(origin)) {
    throw new HttpError(403, `origin ${origin} is not allowed (VAS_ORIGIN)`);
  }
  return { origin, rpID: env.auth.rpId || new URL(origin).hostname };
}

function sessionFrom(req: FastifyRequest): Session | undefined {
  const tok = req.cookies?.[SESSION_COOKIE];
  if (!tok) return undefined;
  const hash = sha256(tok);
  const s = sessions.find((x) => x.hash === hash);
  return s && s.expiresAt > Date.now() ? s : undefined;
}

export function isAuthenticated(req: FastifyRequest): boolean {
  return !env.auth.enabled || !!sessionFrom(req);
}

function cookieSecure(req: FastifyRequest): boolean {
  if (env.auth.secureCookie !== undefined) return env.auth.secureCookie;
  return rpFor(req).origin.startsWith('https://');
}

const PUBLIC_PREFIXES = ['/api/auth/', '/api/agent/', '/api/health'];

/** onRequest hook: guards every /api route (including websockets) */
export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/')) return;
  // CLI over the root-only admin socket
  if (isAdminRequest(req)) return;
  if (PUBLIC_PREFIXES.some((p) => url.startsWith(p))) return;
  if (!isAuthenticated(req)) {
    reply.code(401).send({ error: 'authentication required' });
  }
}

function newChallengeCookie(reply: FastifyReply, req: FastifyRequest, entry: Parameters<typeof challenges.set>[1]): void {
  const id = crypto.randomBytes(16).toString('base64url');
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  challenges.set(id, entry);
  reply.setCookie(CHALLENGE_COOKIE, id, {
    path: '/api/auth',
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(req),
    maxAge: 300,
  });
}

function takeChallenge(req: FastifyRequest, kind: 'reg' | 'auth') {
  const id = req.cookies?.[CHALLENGE_COOKIE];
  const c = id ? challenges.get(id) : undefined;
  if (id) challenges.delete(id);
  if (!c || c.kind !== kind || c.expires < Date.now()) throw new HttpError(400, 'challenge expired, please retry');
  return c;
}

export function routes(app: FastifyInstance): void {
  app.get('/api/auth/status', async (req) => {
    const passkeys = env.auth.enabled ? await getPasskeys() : [];
    return {
      enabled: env.auth.enabled,
      authenticated: isAuthenticated(req),
      needsSetup: env.auth.enabled && passkeys.length === 0,
    };
  });

  app.post('/api/auth/register/options', async (req, reply) => {
    if (!env.auth.enabled) throw new HttpError(400, 'authentication is disabled');
    const body = (req.body ?? {}) as { setupToken?: string; name?: string };
    const passkeys = await getPasskeys();
    const authed = !!sessionFrom(req);
    if (!authed) {
      if (passkeys.length > 0) throw new HttpError(401, 'login first to add another passkey');
      if (!body.setupToken || !safeEqual(body.setupToken, setupToken)) throw new HttpError(403, 'invalid setup token');
    }
    const { rpID } = rpFor(req);
    const user = await getUser();
    const options = await generateRegistrationOptions({
      rpName: env.auth.rpName,
      rpID,
      userName: user.name,
      userID: Buffer.from(user.id, 'base64url'),
      attestationType: 'none',
      excludeCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    newChallengeCookie(reply, req, {
      challenge: options.challenge,
      kind: 'reg',
      expires: Date.now() + 300_000,
      name: (body.name || '').slice(0, 64) || `Passkey ${passkeys.length + 1}`,
    });
    return options;
  });

  app.post('/api/auth/register/verify', async (req, reply) => {
    const c = takeChallenge(req, 'reg');
    const { origin, rpID } = rpFor(req);
    const body = req.body as { response: any };
    const result = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: c.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
    if (!result.verified || !result.registrationInfo) throw new HttpError(400, 'passkey verification failed');
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    const passkeys = await getPasskeys();
    const pk: Passkey = {
      id: credential.id,
      name: c.name ?? 'Passkey',
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      createdAt: new Date().toISOString(),
    };
    passkeys.push(pk);
    await savePasskeys(passkeys);
    log.info(`passkey registered: ${pk.name}`);
    if (!sessionFrom(req)) await createSession(req, reply, pk.id);
    return { ok: true };
  });

  app.post('/api/auth/login/options', async (req, reply) => {
    if (!env.auth.enabled) throw new HttpError(400, 'authentication is disabled');
    const { rpID } = rpFor(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred', allowCredentials: [] });
    newChallengeCookie(reply, req, { challenge: options.challenge, kind: 'auth', expires: Date.now() + 300_000 });
    return options;
  });

  app.post('/api/auth/login/verify', async (req, reply) => {
    const c = takeChallenge(req, 'auth');
    const { origin, rpID } = rpFor(req);
    const body = req.body as { response: any };
    const passkeys = await getPasskeys();
    const pk = passkeys.find((p) => p.id === body.response?.id);
    if (!pk) throw new HttpError(401, 'unknown passkey');
    const result = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: c.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: pk.id,
        publicKey: new Uint8Array(Buffer.from(pk.publicKey, 'base64url')),
        counter: pk.counter,
        transports: pk.transports,
      },
    });
    if (!result.verified) throw new HttpError(401, 'passkey verification failed');
    pk.counter = result.authenticationInfo.newCounter;
    pk.lastUsedAt = new Date().toISOString();
    await savePasskeys(passkeys);
    await createSession(req, reply, pk.id);
    log.info(`login with passkey ${pk.name}`, { ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const tok = req.cookies?.[SESSION_COOKIE];
    if (tok) {
      const hash = sha256(tok);
      sessions = sessions.filter((s) => s.hash !== hash);
      await saveSessions();
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth-admin/passkeys', async () => {
    return (await getPasskeys()).map(({ publicKey: _pk, ...rest }) => rest);
  });

  app.delete('/api/auth-admin/passkeys/:id', async (req) => {
    const { id } = req.params as { id: string };
    const passkeys = await getPasskeys();
    await savePasskeys(passkeys.filter((p) => p.id !== id));
    sessions = sessions.filter((s) => s.passkeyId !== id);
    await saveSessions();
    return { ok: true };
  });

  app.get('/api/auth-admin/agent-token', async () => ({ token: agentToken, fromEnv: !!env.agentToken }));

  // One-time login links (CLI only): the way back in when passkeys can't be
  // used, e.g. on the direct fallback port, where the passkey's domain doesn't match.
  app.post('/api/admin/login-link', async (req) => {
    if (!isAdminRequest(req)) throw new HttpError(403, 'only available through the admin socket (CLI)');
    if (!env.auth.enabled) return { disabled: true };
    const tok = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    for (const [k, exp] of loginLinks) if (exp < now) loginLinks.delete(k);
    loginLinks.set(sha256(tok), now + LOGIN_LINK_TTL_MS);
    log.warn('one-time login link created via CLI');
    return { path: `/api/auth/link?token=${tok}`, expiresInSec: LOGIN_LINK_TTL_MS / 1000 };
  });

  app.get('/api/auth/link', async (req, reply) => {
    const tok = String((req.query as any).token ?? '');
    const key = sha256(tok);
    const exp = loginLinks.get(key);
    loginLinks.delete(key);
    if (!exp || exp < Date.now()) {
      reply.code(401).type('text/html; charset=utf-8');
      return '<!doctype html><title>VAS</title><p>This login link has expired or was already used. Create a new one with <code>vas auth login-link</code>.</p>';
    }
    await createSession(req, reply, 'login-link');
    log.warn('login via one-time link', { ip: req.ip });
    return reply.redirect('/');
  });
}

const LOGIN_LINK_TTL_MS = 10 * 60_000;
const loginLinks = new Map<string, number>();

async function createSession(req: FastifyRequest, reply: FastifyReply, passkeyId: string): Promise<void> {
  const tok = crypto.randomBytes(32).toString('base64url');
  const ttl = env.auth.sessionTtlHours * 3600_000;
  sessions.push({
    hash: sha256(tok),
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    passkeyId,
    ua: String(req.headers['user-agent'] ?? '').slice(0, 200),
  });
  await saveSessions();
  reply.setCookie(SESSION_COOKIE, tok, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(req),
    maxAge: Math.floor(ttl / 1000),
  });
}
