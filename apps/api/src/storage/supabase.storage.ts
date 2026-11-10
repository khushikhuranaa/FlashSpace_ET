import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Readable } from 'node:stream';
import { AppError } from '@flashspace/shared';
import type { SignedUrl, StorageAdapter, StoredObjectInfo } from './storage.interface.js';

/**
 * Supabase Storage adapter (free tier). Uses the service role key server-side
 * only. Signed upload/download URLs are short-lived; the browser never receives
 * provider credentials (PRD §7.3, §13.3).
 */
export class SupabaseStorageAdapter implements StorageAdapter {
  private readonly client: SupabaseClient;

  constructor(
    supabaseUrl: string,
    serviceKey: string,
    private readonly bucket: string,
    private readonly signedUrlExpirySeconds = 600,
  ) {
    this.client = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async createSignedUploadUrl(key: string, expiresInSeconds: number): Promise<SignedUrl> {
    // supabase-js v2 types this as (key) with options object { expiresIn };
    // accept both shapes at runtime while satisfying the strict type.
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUploadUrl(key, expiresInSeconds as unknown as { upsert: boolean } & { expiresIn?: number });
    if (error || !data) {
      throw new AppError('STORAGE_ERROR', `Failed to create upload URL: ${error?.message ?? 'unknown'}`);
    }
    return {
      url: data.signedUrl,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  async createSignedDownloadUrl(
    key: string,
    expiresInSeconds: number,
    downloadName?: string,
  ): Promise<SignedUrl> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(key, expiresInSeconds, {
        download: downloadName ?? true,
      });
    if (error || !data?.signedUrl) {
      throw new AppError('STORAGE_ERROR', `Failed to create download URL: ${error?.message ?? 'unknown'}`);
    }
    return {
      url: data.signedUrl,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  async putObject(key: string, body: Readable | Buffer): Promise<StoredObjectInfo> {
    // Buffer the stream: Supabase JS upload takes Blob/Buffer. Archives are
    // chunked by the archive engine to keep peak memory bounded.
    const payload = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    const { error } = await this.client.storage.from(this.bucket).upload(key, payload, {
      upsert: true,
      contentType: 'application/octet-stream',
    });
    if (error) throw new AppError('STORAGE_ERROR', `Upload failed: ${error.message}`);
    const head = await this.headObject(key);
    return { key, size: head.size, etag: null };
  }

  async getObject(key: string): Promise<Readable> {
    const { data, error } = await this.client.storage.from(this.bucket).download(key);
    if (error || !data) {
      throw new AppError('NOT_FOUND', `Object not found: ${key}`);
    }
    const buf = Buffer.from(await data.arrayBuffer());
    return Readable.from(buf);
  }

  async headObject(key: string): Promise<StoredObjectInfo> {
    const { data, error } = await this.client.storage.from(this.bucket).list(
      key.slice(0, key.lastIndexOf('/')),
      { search: key.slice(key.lastIndexOf('/') + 1), limit: 1 },
    );
    const match = data?.[0];
    if (error || !match) throw new AppError('NOT_FOUND', `Object not found: ${key}`);
    return { key, size: match.metadata?.size ?? 0, etag: (match.metadata?.eTag as string) ?? null };
  }

  async deleteObject(key: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([key]);
    if (error) throw new AppError('STORAGE_ERROR', `Delete failed: ${error.message}`);
  }

  async listObjects(prefix: string): Promise<StoredObjectInfo[]> {
    const out: StoredObjectInfo[] = [];
    const walk = async (dir: string): Promise<void> => {
      const { data, error } = await this.client.storage.from(this.bucket).list(dir, { limit: 1000 });
      if (error) return;
      for (const entry of data ?? []) {
        const key = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.id === null) {
          await walk(key); // folder
        } else if (key.startsWith(prefix)) {
          out.push({ key, size: entry.metadata?.size ?? 0, etag: null });
        }
      }
    };
    await walk(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
    return out;
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
