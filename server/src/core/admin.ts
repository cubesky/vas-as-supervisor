import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env, type ListenAddr } from './env.js';
import { createLogger } from './logger.js';

/**
 * Extra listeners besides Fastify's primary one:
 *  - additional VAS_LISTEN addresses (same app, same auth);
 *  - the admin socket used by the CLI. Requests arriving there are marked
 *    with a symbol on the raw request; a symbol cannot be set by a remote
 *    client, so it is a safe "trusted local root" flag. The socket file is
 *    mode 0600, i.e. only root can talk to it.
 */

const log = createLogger('listen');
const ADMIN = Symbol.for('vas.admin');

export function isAdminRequest(req: FastifyRequest): boolean {
  return !!(req.raw as any)[ADMIN];
}

function forwardServer(app: FastifyInstance, admin: boolean): http.Server {
  const srv = http.createServer((req, res) => {
    if (admin) (req as any)[ADMIN] = true;
    app.routing(req, res);
  });
  // websockets (terminals, noVNC) are handled by Fastify's own server
  srv.on('upgrade', (req, socket, head) => {
    if (admin) (req as any)[ADMIN] = true;
    app.server.emit('upgrade', req, socket, head);
  });
  return srv;
}

export async function listenExtra(app: FastifyInstance, addr: ListenAddr): Promise<http.Server> {
  const srv = forwardServer(app, false);
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(addr.port, addr.host, () => resolve());
  });
  return srv;
}

export async function listenAdminSocket(app: FastifyInstance): Promise<http.Server> {
  const sock = env.adminSocket;
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    fs.rmSync(sock, { force: true });
  }
  const srv = forwardServer(app, true);
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(sock, () => resolve());
  });
  if (process.platform !== 'win32') fs.chmodSync(sock, 0o600);
  log.info(`admin socket ${sock} (CLI: vas)`);
  return srv;
}
