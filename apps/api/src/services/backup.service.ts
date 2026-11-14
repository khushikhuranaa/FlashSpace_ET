import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Env } from '../config/env.js';

/**
 * Module 14: local backup and restore tooling.
 *
 * A backup is a self-describing directory:
 *
 *   <backupDir>/<timestamp>-<shortId>/manifest.json
 *   <backupDir>/<timestamp>-<shortId>/database/<sqlite file>
 *   <backupDir>/<timestamp>-<shortId>/storage/**            (local adapter only)
 *
 * The manifest records a SHA-256 for every copied file plus size and mtime, so
 * `verify()` can prove the copy is intact and `restore()` can refuse a corrupt
 * archive before touching any target directory.
 *
 * Limitations (reported, not hidden): backups are local-only unless BACKUP_DIR
 * points at mounted offsite storage; Supabase/Postgres deployments need
 * `pg_dump` and a bucket export, which this module cannot perform without those
 * services being configured. Offsite replication is therefore NOT_CONFIGURED.
 */

export interface BackupManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  id: string;
  createdAt: string;
  nodeEnv: string;
  repoMode: string;
  storageMode: string;
  database: BackupManifestEntry | null;
  storage: { files: number; bytes: number };
  entries: BackupManifestEntry[];
}

export interface BackupSummary {
  id: string;
  dir: string;
  createdAt: string;
  sizeBytes: number;
  files: number;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  failures: string[];
}

const MANIFEST = 'manifest.json';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function walk(root: string, prefix = ''): Promise<BackupManifestEntry[]> {
  const out: BackupManifestEntry[] = [];
  let entries;
  try {
    entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walk(root, relative)));
    } else if (entry.isFile()) {
      const full = path.join(root, relative);
      const stat = await fs.stat(full);
      out.push({ path: relative, size: stat.size, sha256: await sha256File(full) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export class BackupService {
  constructor(private readonly env: Env) {}

  get rootDir(): string {
    return this.env.backupDir;
  }

  async create(label?: string): Promise<BackupSummary> {
    const id = `${label ? `${label.replace(/[^A-Za-z0-9_-]/g, '')}-` : ''}${randomUUID().slice(0, 8)}`;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(this.rootDir, `${stamp}-${id}`);
    await fs.mkdir(path.join(dir, 'database'), { recursive: true });
    await fs.mkdir(path.join(dir, 'storage'), { recursive: true });

    let database: BackupManifestEntry | null = null;
    const dbSource = this.env.repoMode === 'sqlite' ? this.env.sqliteFile : null;
    if (dbSource) {
      try {
        const stat = await fs.stat(dbSource);
        if (stat.isFile()) {
          const target = path.join(dir, 'database', path.basename(dbSource));
          // Copying the main file plus its WAL/SHM sidecars keeps the snapshot
          // consistent without requiring a lock on the live database.
          for (const suffix of ['', '-wal', '-shm']) {
            await fs.copyFile(`${dbSource}${suffix}`, `${target}${suffix}`).catch(() => undefined);
          }
          database = {
            path: `database/${path.basename(dbSource)}`,
            size: stat.size,
            sha256: await sha256File(target),
          };
        }
      } catch {
        database = null;
      }
    }

    let storageFiles = 0;
    let storageBytes = 0;
    if (this.env.storageMode === 'local') {
      const sourceRoot = this.env.localStorageDir;
      const files = await walk(sourceRoot);
      for (const file of files) {
        const target = path.join(dir, 'storage', file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(sourceRoot, file.path), target);
        storageFiles += 1;
        storageBytes += file.size;
      }
    }

    const entries = await walk(dir);
    const manifest: BackupManifest = {
      version: 1,
      id,
      createdAt: new Date().toISOString(),
      nodeEnv: this.env.nodeEnv,
      repoMode: this.env.repoMode,
      storageMode: this.env.storageMode,
      database,
      storage: { files: storageFiles, bytes: storageBytes },
      entries,
    };
    await fs.writeFile(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    await this.prune();
    return {
      id,
      dir,
      createdAt: manifest.createdAt,
      sizeBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      files: entries.length,
    };
  }

  async list(): Promise<BackupSummary[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.rootDir);
    } catch {
      return [];
    }
    const out: BackupSummary[] = [];
    for (const name of names) {
      const dir = path.join(this.rootDir, name);
      try {
        const manifest = await this.readManifest(dir);
        out.push({
          id: manifest.id,
          dir,
          createdAt: manifest.createdAt,
          sizeBytes: manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
          files: manifest.entries.length,
        });
      } catch {
        // A directory without a valid manifest is not a backup; skip it.
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async verify(id: string): Promise<VerifyResult> {
    const dir = await this.findBackupDir(id);
    const manifest = await this.readManifest(dir);
    const failures: string[] = [];
    let checked = 0;
    for (const entry of manifest.entries) {
      checked += 1;
      const full = path.join(dir, entry.path);
      try {
        const stat = await fs.stat(full);
        if (stat.size !== entry.size) {
          failures.push(`${entry.path}: size ${stat.size} != ${entry.size}`);
          continue;
        }
        if ((await sha256File(full)) !== entry.sha256) failures.push(`${entry.path}: checksum mismatch`);
      } catch {
        failures.push(`${entry.path}: missing`);
      }
    }
    return { ok: failures.length === 0, checked, failures };
  }

  /**
   * Restore a backup into an isolated directory. Never writes to the live
   * database or storage unless the caller explicitly points `targetDir` there.
   */
  async restore(id: string, targetDir: string): Promise<{ databasePath: string | null; storageDir: string; files: number }> {
    const dir = await this.findBackupDir(id);
    const verification = await this.verify(id);
    if (!verification.ok) {
      throw new Error(`Backup ${id} failed integrity verification: ${verification.failures.slice(0, 3).join('; ')}`);
    }
    const manifest = await this.readManifest(dir);
    const databaseTargetDir = path.join(targetDir, 'database');
    const storageTargetDir = path.join(targetDir, 'storage');
    await fs.mkdir(databaseTargetDir, { recursive: true });
    await fs.mkdir(storageTargetDir, { recursive: true });

    let databasePath: string | null = null;
    if (manifest.database) {
      databasePath = path.join(databaseTargetDir, path.basename(manifest.database.path));
      await fs.copyFile(path.join(dir, manifest.database.path), databasePath);
    }

    let files = 0;
    for (const entry of manifest.entries) {
      if (!entry.path.startsWith('storage/')) continue;
      const relative = entry.path.slice('storage/'.length);
      const target = path.join(storageTargetDir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(dir, entry.path), target);
      files += 1;
    }
    return { databasePath, storageDir: storageTargetDir, files };
  }

  /** Keep the newest `backupRetention` backups, delete older ones. */
  async prune(): Promise<number> {
    const backups = await this.list();
    const doomed = backups.slice(Math.max(0, this.env.backupRetention));
    for (const backup of doomed) await fs.rm(backup.dir, { recursive: true, force: true });
    return doomed.length;
  }

  private async readManifest(dir: string): Promise<BackupManifest> {
    const raw = await fs.readFile(path.join(dir, MANIFEST), 'utf8');
    const parsed = JSON.parse(raw) as BackupManifest;
    if (parsed?.version !== 1 || typeof parsed.id !== 'string' || !Array.isArray(parsed.entries)) {
      throw new Error('Unsupported or corrupt backup manifest');
    }
    return parsed;
  }

  /** Resolve a backup by id, rejecting traversal attempts. */
  private async findBackupDir(id: string): Promise<string> {
    if (!ID_PATTERN.test(id)) throw new Error('Invalid backup id');
    const backups = await this.list();
    const match = backups.find((backup) => backup.id === id || path.basename(backup.dir).endsWith(`-${id}`));
    if (!match) throw new Error(`Backup not found: ${id}`);
    return match.dir;
  }
}
