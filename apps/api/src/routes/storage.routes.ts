import { Router, type Request, type Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { verifyStorageToken } from '../storage/signed-tokens.js';
import type { StorageAdapter } from '../storage/index.js';
import type { Env } from '../config/env.js';

/**
 * Local-storage signed URL endpoints. These mirror what a provider's signed
 * URLs would do: a caller with a valid, unexpired token can PUT or GET exactly
 * one object key. No credentials, no listing, no cross-key access (PRD §13.3).
 */
export function storageRoutes(env: Env, storage: StorageAdapter): Router {
  const router = Router();

  router.put('/storage-upload', async (req: Request, res: Response) => {
    const token = req.query.token;
    if (typeof token !== 'string') {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Missing token' } });
      return;
    }
    const payload = verifyStorageToken(token, env.localAuthSecret);
    if (!payload.ok || payload.method !== 'PUT') {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } });
      return;
    }

    // Module 14: bound the bytes accepted by an upload. Without this a holder
    // of a valid token (or a client that under-declared its size) could stream
    // unbounded data into API memory before confirmation ever re-checks it.
    const maxBytes = env.fileMaxBytes + 1024;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Upload exceeds the configured file size limit' },
      });
      req.destroy();
      return;
    }

    let received = 0;
    let exceeded = false;
    try {
      const chunks: Buffer[] = [];
      await pipeline(req, async function* (source) {
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          received += buf.length;
          if (received > maxBytes) {
            exceeded = true;
            throw new Error('PAYLOAD_TOO_LARGE');
          }
          chunks.push(buf);
        }
      });
      await storage.putObject(payload.key, Buffer.concat(chunks));
      res.status(200).json({ ok: true });
    } catch (err) {
      if (exceeded || (err as Error)?.message === 'PAYLOAD_TOO_LARGE') {
        // Remove any partially written object so an oversized upload cannot
        // occupy storage it was never granted.
        await storage.deleteObject(payload.key).catch(() => undefined);
        res.status(413).json({
          error: { code: 'PAYLOAD_TOO_LARGE', message: 'Upload exceeds the configured file size limit' },
        });
        req.destroy();
        return;
      }
      res.status(500).json({ error: { code: 'STORAGE_ERROR', message: 'Upload failed' } });
    }
  });

  router.get('/storage-download', async (req: Request, res: Response) => {
    const token = req.query.token;
    if (typeof token !== 'string') {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Missing token' } });
      return;
    }
    const payload = verifyStorageToken(token, env.localAuthSecret);
    if (!payload.ok || payload.method !== 'GET') {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } });
      return;
    }
    try {
      const stream = await storage.getObject(payload.key);
      if (payload.filename) {
        res.setHeader('Content-Disposition', `attachment; filename="${payload.filename.replace(/"/g, '')}"`);
      } else if (payload.mime) {
        // Preview token: the browser may render it, but never as a document
        // with script execution (only image/pdf/text types are issued one).
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      }
      res.setHeader('Content-Type', payload.mime ?? 'application/octet-stream');
      await pipeline(stream, res);
    } catch {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Object not found' } });
    }
  });

  return router;
}
