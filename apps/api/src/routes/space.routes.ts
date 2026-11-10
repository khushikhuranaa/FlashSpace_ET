import { Router, type Request, type Response } from 'express';
import { AppError } from '@flashspace/shared';
import type { SpacesService } from '../services/spaces.service.js';
import type { FilesService } from '../services/files.service.js';
import type { ExtensionService } from '../services/extension.service.js';
import type { MembershipService } from '../services/membership.service.js';
import type { ArchiveService } from '../services/archive.service.js';
import { asyncHandler } from '../middleware/auth.js';

function parseId(req: Request, name: string): string {
  const id = req.params[name];
  if (!id) throw new AppError('VALIDATION_ERROR', `Missing ${name}`);
  return id;
}

export function spaceRoutes(
  spaces: SpacesService,
  files: FilesService,
  extensions: ExtensionService,
  membership: MembershipService,
  archive: ArchiveService,
): Router {
  const router = Router();

  // -- Spaces --------------------------------------------------------------

  router.get(
    '/spaces',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ spaces: spaces.listForUser(req.user!.id) });
    }),
  );

  router.post(
    '/spaces',
    asyncHandler(async (req: Request, res: Response) => {
      const { name, purpose, description, startAt, expiryAt } = req.body as Record<string, unknown>;
      if (typeof name !== 'string' || !name.trim() || typeof purpose !== 'string' || !purpose.trim()) {
        throw new AppError('VALIDATION_ERROR', 'name and purpose are required');
      }
      if (typeof startAt !== 'string' || typeof expiryAt !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'startAt and expiryAt ISO datetimes are required');
      }
      res.status(201).json({
        space: spaces.create(req.user!, {
          name: name.trim(),
          purpose: purpose.trim(),
          description: typeof description === 'string' ? description : '',
          startAt,
          expiryAt,
        }),
      });
    }),
  );

  router.get(
    '/spaces/:spaceId',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ space: spaces.getForUser(parseId(req, 'spaceId'), req.user!.id) });
    }),
  );

  router.patch(
    '/spaces/:spaceId',
    asyncHandler(async (req: Request, res: Response) => {
      const { name, purpose, description, expiryAt } = req.body as Record<string, unknown>;
      res.json({
        space: spaces.update(req.user!, parseId(req, 'spaceId'), {
          ...(typeof name === 'string' ? { name } : {}),
          ...(typeof purpose === 'string' ? { purpose } : {}),
          ...(typeof description === 'string' ? { description } : {}),
          ...(typeof expiryAt === 'string' ? { expiryAt } : {}),
        }),
      });
    }),
  );

  router.delete(
    '/spaces/:spaceId',
    asyncHandler(async (req: Request, res: Response) => {
      spaces.delete(req.user!, parseId(req, 'spaceId'));
      res.status(204).end();
    }),
  );

  // Archive on demand: the owner freezes the Space into their Vault early.
  router.post(
    '/spaces/:spaceId/archive',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ archive: await archive.archiveNow(req.user!, parseId(req, 'spaceId')) });
    }),
  );

  // -- Members -------------------------------------------------------------

  router.get(
    '/spaces/:spaceId/members',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(membership.membersPayload(req.user!, parseId(req, 'spaceId')));
    }),
  );

  router.post(
    '/spaces/:spaceId/invitations',
    asyncHandler(async (req: Request, res: Response) => {
      const { email, role } = req.body as Record<string, unknown>;
      if (typeof email !== 'string' || (role !== 'EDITOR' && role !== 'VIEWER')) {
        throw new AppError('VALIDATION_ERROR', 'email and role (EDITOR|VIEWER) are required');
      }
      const result = membership.invite(req.user!, parseId(req, 'spaceId'), email, role);
      res.status(202).json(result);
    }),
  );

  // Invite-by-link: the owner shares a URL; anyone signed in can ask to join.
  router.post(
    '/spaces/:spaceId/invite-link',
    asyncHandler(async (req: Request, res: Response) => {
      const { role } = req.body as Record<string, unknown>;
      if (role !== undefined && role !== 'EDITOR' && role !== 'VIEWER') {
        throw new AppError('VALIDATION_ERROR', 'role must be EDITOR or VIEWER');
      }
      res.json({ inviteLink: membership.createInviteLink(req.user!, parseId(req, 'spaceId'), role ?? 'VIEWER') });
    }),
  );

  router.delete(
    '/spaces/:spaceId/invite-link',
    asyncHandler(async (req: Request, res: Response) => {
      membership.revokeInviteLink(req.user!, parseId(req, 'spaceId'));
      res.status(204).end();
    }),
  );

  router.get(
    '/spaces/:spaceId/join-requests',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ requests: membership.listJoinRequests(req.user!, parseId(req, 'spaceId')) });
    }),
  );

  router.patch(
    '/spaces/:spaceId/members/:userId',
    asyncHandler(async (req: Request, res: Response) => {
      const { role } = req.body as Record<string, unknown>;
      if (role !== 'EDITOR' && role !== 'VIEWER') {
        throw new AppError('VALIDATION_ERROR', 'role must be EDITOR or VIEWER');
      }
      res.json({ member: spaces.changeRole(req.user!, parseId(req, 'spaceId'), parseId(req, 'userId'), role) });
    }),
  );

  router.delete(
    '/spaces/:spaceId/members/:userId',
    asyncHandler(async (req: Request, res: Response) => {
      spaces.revoke(req.user!, parseId(req, 'spaceId'), parseId(req, 'userId'));
      res.status(204).end();
    }),
  );

  router.get(
    '/spaces/:spaceId/activity',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ activity: spaces.listActivity(parseId(req, 'spaceId'), req.user!.id) });
    }),
  );

  // -- Join requests (shared by link requests and email invitations) --------

  router.get(
    '/join-links/:token',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ space: membership.previewInviteLink(req.user!, parseId(req, 'token')) });
    }),
  );

  router.post(
    '/join-links/:token/requests',
    asyncHandler(async (req: Request, res: Response) => {
      res.status(201).json({ request: membership.requestJoinByLink(req.user!, parseId(req, 'token')) });
    }),
  );

  router.post(
    '/join-requests/:requestId/decision',
    asyncHandler(async (req: Request, res: Response) => {
      const { decision } = req.body as Record<string, unknown>;
      if (decision !== 'ACCEPT' && decision !== 'DECLINE') {
        throw new AppError('VALIDATION_ERROR', 'decision must be ACCEPT or DECLINE');
      }
      res.json({ request: membership.decide(req.user!, parseId(req, 'requestId'), decision) });
    }),
  );

  // -- Folders -------------------------------------------------------------

  router.get(
    '/spaces/:spaceId/folders',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ folders: spaces.listFolders(parseId(req, 'spaceId'), req.user!.id) });
    }),
  );

  router.post(
    '/spaces/:spaceId/folders',
    asyncHandler(async (req: Request, res: Response) => {
      const { name, parentId } = req.body as Record<string, unknown>;
      if (typeof name !== 'string' || !name.trim()) {
        throw new AppError('VALIDATION_ERROR', 'name is required');
      }
      if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'parentId must be a string or null');
      }
      res.status(201).json({
        folder: spaces.createFolder(req.user!, parseId(req, 'spaceId'), {
          name,
          parentId: (parentId as string | null | undefined) ?? null,
        }),
      });
    }),
  );

  // -- Files ---------------------------------------------------------------

  router.get(
    '/spaces/:spaceId/files',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ files: files.list(req.user!, parseId(req, 'spaceId')) });
    }),
  );

  router.post(
    '/spaces/:spaceId/files/init-upload',
    asyncHandler(async (req: Request, res: Response) => {
      const { name, mimeType, sizeBytes, folderId } = req.body as Record<string, unknown>;
      if (typeof name !== 'string' || typeof sizeBytes !== 'number' || sizeBytes < 0) {
        throw new AppError('VALIDATION_ERROR', 'name and sizeBytes are required');
      }
      if (folderId !== undefined && folderId !== null && typeof folderId !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'folderId must be a string or null');
      }
      const result = await files.initUpload(req.user!, parseId(req, 'spaceId'), {
        name,
        mimeType: typeof mimeType === 'string' ? mimeType : 'application/octet-stream',
        sizeBytes,
        folderId: (folderId as string | null | undefined) ?? null,
      });
      res.status(201).json(result);
    }),
  );

  router.post(
    '/spaces/:spaceId/files/:fileId/confirm-upload',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({
        file: await files.confirmUpload(req.user!, parseId(req, 'spaceId'), parseId(req, 'fileId')),
      });
    }),
  );

  router.post(
    '/spaces/:spaceId/files/:fileId/download',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await files.download(req.user!, parseId(req, 'spaceId'), parseId(req, 'fileId')));
    }),
  );

  router.patch(
    '/spaces/:spaceId/files/:fileId',
    asyncHandler(async (req: Request, res: Response) => {
      const { name } = req.body as Record<string, unknown>;
      if (typeof name !== 'string') throw new AppError('VALIDATION_ERROR', 'name is required');
      res.json({ file: await files.rename(req.user!, parseId(req, 'spaceId'), parseId(req, 'fileId'), name) });
    }),
  );

  router.delete(
    '/spaces/:spaceId/files/:fileId',
    asyncHandler(async (req: Request, res: Response) => {
      await files.remove(req.user!, parseId(req, 'spaceId'), parseId(req, 'fileId'));
      res.status(204).end();
    }),
  );

  // -- Extensions ----------------------------------------------------------

  router.post(
    '/spaces/:spaceId/extensions',
    asyncHandler(async (req: Request, res: Response) => {
      const { requestedDays, reason } = req.body as Record<string, unknown>;
      if (typeof requestedDays !== 'number' || typeof reason !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'requestedDays (number) and reason are required');
      }
      res.status(201).json({ request: extensions.request(req.user!, parseId(req, 'spaceId'), requestedDays, reason) });
    }),
  );

  router.get(
    '/spaces/:spaceId/extensions',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ requests: extensions.listForSpace(req.user!, parseId(req, 'spaceId')) });
    }),
  );

  return router;
}
