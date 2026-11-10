import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { AppError } from '@flashspace/shared';
import type { SignedUrl, StorageAdapter, StoredObjectInfo } from './storage.interface.js';
import { signStorageToken } from './signed-tokens.js';

/**
 * Filesystem storage adapter used in local/dev/demo mode. Signed URLs are
 * HMAC tokens served by this same API process (`/storage-upload`,
 * `/storage-download`); a relative base keeps them correct behind any host
 * or port, including supertest's ephemeral ports in tests.
 */
export class LocalStorageAdapter implements StorageAdapter {
  constructor(
    private readonly rootDir: string,
    private readonly secret: string,
    private readonly getBaseUrl: () => string = () => '',
  ) {}

  private resolve(key: string): string {
    // Keys are opaque identifiers built by the API; defense-in-depth: strip
    // any path traversal before mapping onto the filesystem.
    const safeKey = key.replaceAll('\\', '/').split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
    if (!safeKey) throw new AppError('VALIDATION_ERROR', 'Invalid object key');
    return path.resolve(this.rootDir, safeKey);
  }

  async createSignedUploadUrl(key: string, expiresInSeconds: number): Promise<SignedUrl> {
    const { token, expiresAt } = signStorageToken({ method: 'PUT', key, expiresInSeconds }, this.secret);
    return { url: `${this.getBaseUrl()}/storage-upload?token=${encodeURIComponent(token)}`, expiresAt };
  }

  async createSignedDownloadUrl(
    key: string,
    expiresInSeconds: number,
    downloadName?: string,
  ): Promise<SignedUrl> {
    const { token, expiresAt } = signStorageToken(
      { method: 'GET', key, expiresInSeconds, filename: downloadName },
      this.secret,
    );
    return { url: `${this.getBaseUrl()}/storage-download?token=${encodeURIComponent(token)}`, expiresAt };
  }

  async putObject(key: string, body: Readable | Buffer): Promise<StoredObjectInfo> {
    const dest = this.resolve(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const hash = createHash('sha256');
    const ws = createWriteStream(dest);
    if (Buffer.isBuffer(body)) {
      hash.update(body);
      await pipeline(Readable.from(body), ws);
    } else {
      await pipeline(body, async function* (source) {
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          hash.update(buf);
          yield buf;
        }
      }, ws);
    }
    return { key, size: (await fs.stat(dest)).size, etag: hash.digest('hex') };
  }

  async getObject(key: string): Promise<Readable> {
    const p = this.resolve(key);
    await fs.access(p);
    return createReadStream(p);
  }

  async headObject(key: string): Promise<StoredObjectInfo> {
    try {
      const st = await fs.stat(this.resolve(key));
      if (!st.isFile()) throw new Error('not a file');
      return { key, size: st.size, etag: null };
    } catch {
      throw new AppError('NOT_FOUND', `Object not found: ${key}`);
    }
  }

  async deleteObject(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async listObjects(prefix: string): Promise<StoredObjectInfo[]> {
    const out: StoredObjectInfo[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const st = await fs.stat(full);
          const key = path.relative(this.rootDir, full).split(path.sep).join('/');
          if (key.startsWith(prefix)) out.push({ key, size: st.size, etag: null });
        }
      }
    };
    await walk(this.rootDir);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
}
