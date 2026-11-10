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
    try {
      const chunks: Buffer[] = [];
      await pipeline(req, async function* (source) {
        for await (const chunk of source) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
      });
      await storage.putObject(payload.key, Buffer.concat(chunks));
      res.status(200).json({ ok: true });
    } catch {
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
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      await pipeline(stream, res);
    } catch {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Object not found' } });
    }
  });

  return router;
}
