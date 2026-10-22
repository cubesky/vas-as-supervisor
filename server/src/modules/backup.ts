import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as tar from 'tar';
import { env } from '../core/env.js';
import { startJob, type JobContext } from '../core/jobs.js';
import { createLogger } from '../core/logger.js';
import { HttpError, getSecrets, getSettings, readJson, writeJson } from '../core/store.js';
import { findComposeFile, listProjectNames, projectDir } from './compose.js';
import { syncSnapshots } from './git.js';

/**
 * Scheduled tar.gz backups of the configuration (and optionally compose files
 * and extra paths) uploaded to any S3-compatible endpoint, with retention.
 */

const log = createLogger('backup');
const stateFile = () => path.join(env.stateDir, 'backup.json');

interface BackupState {
  lastRun?: string;
  lastOk?: string;
  lastError?: string;
  lastKey?: string;
  lastSize?: number;
  running?: boolean;
}

let running = false;

async function client(): Promise<{ s3: S3Client; bucket: string; prefix: string }> {
  const s = (await getSettings()).backup;
  const sec = await getSecrets();
  if (!s.bucket) throw new HttpError(400, 'S3 bucket is not configured');
  if (!sec.s3AccessKeyId || !sec.s3SecretAccessKey) throw new HttpError(400, 'S3 credentials are not configured');
  const s3 = new S3Client({
    endpoint: s.endpoint || undefined,
    region: s.region || 'us-east-1',
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: sec.s3AccessKeyId, secretAccessKey: sec.s3SecretAccessKey },
  });
  const host = os.hostname().replace(/[^\w.-]/g, '_');
  return { s3, bucket: s.bucket, prefix: `${s.prefix.replace(/^\/+/, '')}${host}/` };
}

async function collectPaths(): Promise<string[]> {
  const s = (await getSettings()).backup;
  const paths = [env.configDir];
  if (s.includeComposeFiles) {
    for (const name of await listProjectNames()) {
      const f = await findComposeFile(name);
      if (f) paths.push(f);
      if (s.includeSecrets && fs.existsSync(path.join(projectDir(name), '.env'))) paths.push(path.join(projectDir(name), '.env'));
    }
  }
  for (const p of s.extraPaths) if (path.isAbsolute(p) && fs.existsSync(p)) paths.push(path.resolve(p));
  return paths;
}

export async function runBackup(job: JobContext): Promise<void> {
  if (running) throw new Error('a backup is already running');
  running = true;
  const settings = (await getSettings()).backup;
  const state = await readJson<BackupState>(stateFile(), {});
  state.lastRun = new Date().toISOString();
  await writeJson(stateFile(), state);
  const tmpDir = path.join(env.stateDir, 'tmp');
  await fsp.mkdir(tmpDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(tmpDir, `vas-${ts}.tar.gz`);
  try {
    const { s3, bucket, prefix } = await client();
    await syncSnapshots(settings.includeSecrets);
    const paths = await collectPaths();
    job.log(`archiving ${paths.length} paths`);
    const secretsDir = path.join(env.configDir, 'secrets');
    await tar.c(
      {
        gzip: true,
        file: tmp,
        cwd: '/',
        portable: true,
        filter: (p) => {
          const abs = path.resolve('/', p);
          if (abs.startsWith(path.join(env.configDir, '.git'))) return false;
          if (!settings.includeSecrets && (abs === secretsDir || abs.startsWith(secretsDir + path.sep))) return false;
          return !abs.endsWith('.tmp');
        },
      },
      paths.map((p) => path.relative('/', p)),
    );
    const size = (await fsp.stat(tmp)).size;
    const key = `${prefix}vas-${ts}.tar.gz`;
    job.log(`uploading ${(size / 1024).toFixed(1)} KiB to s3://${bucket}/${key}`);
    const up = new Upload({
      client: s3,
      params: { Bucket: bucket, Key: key, Body: fs.createReadStream(tmp), ContentType: 'application/gzip' },
    });
    up.on('httpUploadProgress', (p) => p.loaded && job.log(`uploaded ${(p.loaded / 1024).toFixed(0)} KiB`));
    await up.done();

    // retention
    const list = await listBackups();
    const old = list.slice(settings.retention);
    if (old.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: old.map((o) => ({ Key: o.key })) } }));
      job.log(`retention: deleted ${old.length} old backups`);
    }
    Object.assign(state, { lastOk: new Date().toISOString(), lastError: undefined, lastKey: key, lastSize: size });
    log.info(`backup uploaded: ${key}`);
  } catch (err) {
    state.lastError = (err as Error).message;
    log.error('backup failed', { error: state.lastError });
    throw err;
  } finally {
    running = false;
    await fsp.rm(tmp, { force: true });
    await writeJson(stateFile(), state);
  }
}

export async function listBackups(): Promise<{ key: string; size: number; lastModified?: string }[]> {
  const { s3, bucket, prefix } = await client();
  const out: { key: string; size: number; lastModified?: string }[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) {
      // hastur-*: archives written before the rename to VAS still count for retention
      if (!/\/(vas|hastur)-[^/]+\.tar\.gz$/.test(`/${o.Key}`)) continue;
      out.push({ key: o.Key!, size: o.Size ?? 0, lastModified: o.LastModified?.toISOString() });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? '') || b.key.localeCompare(a.key));
}

export function startBackupScheduler(): void {
  setInterval(async () => {
    try {
      const s = (await getSettings()).backup;
      if (!s.enabled || running) return;
      const st = await readJson<BackupState>(stateFile(), {});
      const last = st.lastRun ? Date.parse(st.lastRun) : 0;
      if (Date.now() - last >= s.intervalHours * 3600_000) startJob('scheduled S3 backup', 'backup', runBackup);
    } catch (err) {
      log.error('backup scheduler error', err);
    }
  }, 5 * 60_000);
}

export function routes(app: FastifyInstance): void {
  app.get('/api/backup', async () => {
    const s = await getSettings();
    const sec = await getSecrets();
    return {
      settings: s.backup,
      credentialsSet: !!(sec.s3AccessKeyId && sec.s3SecretAccessKey),
      state: { ...(await readJson<BackupState>(stateFile(), {})), running },
    };
  });

  app.get('/api/backup/list', async () => listBackups());

  app.post('/api/backup/run', async () => startJob('S3 backup', 'backup', runBackup));

  app.get('/api/backup/download', async (req, reply) => {
    const { key } = req.query as { key: string };
    const { s3, bucket, prefix } = await client();
    if (!key?.startsWith(prefix) || key.includes('..')) throw new HttpError(400, 'invalid key');
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename="${path.basename(key)}"`);
    return reply.send(obj.Body as any);
  });
}
