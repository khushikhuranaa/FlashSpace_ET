import { Router, type Request, type Response } from 'express';
import { AppError, SPACE_SORTS, SPACE_TEMPLATES, SPACE_STATUSES } from '@flashspace/shared';
import { DEFAULT_FILE_LIMIT, MAX_FILE_LIMIT } from '../services/file-manager.service.js';
import type { SpaceListQuery, SpaceSort, SpaceStatus } from '@flashspace/shared';
import type { SpacesService } from '../services/spaces.service.js';
import type { FilesService } from '../services/files.service.js';
import type { ExtensionService } from '../services/extension.service.js';
import type { MembershipService } from '../services/membership.service.js';
import type { ArchiveService } from '../services/archive.service.js';
import type { SpaceManagementService } from '../services/space-management.service.js';
import type { FileManagerService } from '../services/file-manager.service.js';
import type { ActivityService } from '../services/activity.service.js';
import { activityQuerySchema } from '@flashspace/shared';
import { asyncHandler } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  initUploadSchema,
  invitationSchema,
  renameFileSchema,
  spaceCreateSchema,
  spacePatchSchema,
} from '../validation/schemas.js';
import { activityFilters, sendCsv } from './activity-http.js';

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
  management: SpaceManagementService,
  manager: FileManagerService,
  env: { fileMaxBytes: number; spaceMaxBytes: number; uploadBlockedExtensions: string[] },
  db: import('../repositories/data-layer.interface.js').DataLayer,
  activity: ActivityService,
): Router {
  const router = Router();

  // -- Spaces --------------------------------------------------------------

  router.get(
    '/spaces',
    asyncHandler(async (req: Request, res: Response) => {
      const query = parseListQuery(req);
      const { spaces: list, total } = await management.list(req.user!, query);
      res.json({ spaces: list, total, limit: query.limit ?? 50, offset: query.offset ?? 0 });
    }),
  );

  // Declared before `/spaces/:spaceId` so "recent"/"favorites" are not read as ids.
  router.get(
    '/spaces/recent',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ spaces: await management.recent(req.user!, 6) });
    }),
  );

  router.get(
    '/spaces/favorites',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ spaces: await management.favorites(req.user!) });
    }),
  );

  router.post(
    '/spaces',
    validateBody(spaceCreateSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { name, purpose, description, startAt, expiryAt, templateId } = req.body as Record<string, unknown>;
      if (typeof startAt !== 'string' || typeof expiryAt !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'startAt and expiryAt ISO datetimes are required');
      }

      // A template is only a prefill for the normal creation path: it cannot
      // supply its own owner, membership or lifecycle state.
      let template = null;
      if (templateId !== undefined && templateId !== null) {
        if (typeof templateId !== 'string') {
          throw new AppError('VALIDATION_ERROR', 'templateId must be a string');
        }
        template = SPACE_TEMPLATES.find((t) => t.id === templateId) ?? null;
        if (!template) throw new AppError('VALIDATION_ERROR', 'Unknown template');
      }

      const finalName = typeof name === 'string' && name.trim() ? name : template?.name ?? '';
      const finalPurpose =
        typeof purpose === 'string' && purpose.trim() ? purpose : template?.purpose ?? '';
      if (!finalName.trim() || !finalPurpose.trim()) {
        throw new AppError('VALIDATION_ERROR', 'name and purpose are required');
      }

      const space = await spaces.create(req.user!, {
        name: finalName,
        purpose: finalPurpose,
        description:
          typeof description === 'string' ? description : (template?.description ?? ''),
        startAt,
        expiryAt,
        folders: template?.folders ?? [],
      });
      res.status(201).json({ space, templateId: template?.id ?? null });
    }),
  );

  router.get(
    '/spaces/:spaceId',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ space: await spaces.getForUser(parseId(req, 'spaceId'), req.user!.id) });
    }),
  );

  router.patch(
    '/spaces/:spaceId',
    validateBody(spacePatchSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { name, purpose, description, expiryAt } = req.body as Record<string, unknown>;
      res.json({
        space: await spaces.update(req.user!, parseId(req, 'spaceId'), {
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
      await spaces.delete(req.user!, parseId(req, 'spaceId'));
      res.status(204).end();
    }),
  );

  // -- Module 3: settings, storage, favourites, duplication -----------------

  router.patch(
    '/spaces/:spaceId/settings',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      const patch: Parameters<SpaceManagementService['settings']>[2] = {};
      if (body.name !== undefined) {
        if (typeof body.name !== 'string') throw new AppError('VALIDATION_ERROR', 'name must be a string');
        patch.name = body.name;
      }
      if (body.purpose !== undefined) {
        if (typeof body.purpose !== 'string') throw new AppError('VALIDATION_ERROR', 'purpose must be a string');
        patch.purpose = body.purpose;
      }
      if (body.description !== undefined) {
        if (typeof body.description !== 'string') {
          throw new AppError('VALIDATION_ERROR', 'description must be a string');
        }
        patch.description = body.description;
      }
      if (body.expiryAt !== undefined) {
        if (typeof body.expiryAt !== 'string') {
          throw new AppError('VALIDATION_ERROR', 'expiryAt must be an ISO datetime');
        }
        patch.expiryAt = body.expiryAt;
      }
      if (body.invitationsEnabled !== undefined) {
        if (typeof body.invitationsEnabled !== 'boolean') {
          throw new AppError('VALIDATION_ERROR', 'invitationsEnabled must be a boolean');
        }
        patch.invitationsEnabled = body.invitationsEnabled;
      }
      if (body.defaultInviteRole !== undefined) {
        if (body.defaultInviteRole !== 'EDITOR' && body.defaultInviteRole !== 'VIEWER') {
          throw new AppError('VALIDATION_ERROR', 'defaultInviteRole must be EDITOR or VIEWER');
        }
        patch.defaultInviteRole = body.defaultInviteRole;
      }
      if (Object.keys(patch).length === 0) {
        throw new AppError('VALIDATION_ERROR', 'No supported settings were provided');
      }
      res.json({ space: await management.settings(req.user!, parseId(req, 'spaceId'), patch) });
    }),
  );

  router.get(
    '/spaces/:spaceId/storage',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ storage: await management.storageBreakdown(req.user!, parseId(req, 'spaceId')) });
    }),
  );

  router.post(
    '/spaces/:spaceId/favorite',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await management.setFavorite(req.user!, parseId(req, 'spaceId'), true));
    }),
  );

  router.delete(
    '/spaces/:spaceId/favorite',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await management.setFavorite(req.user!, parseId(req, 'spaceId'), false));
    }),
  );

  router.post(
    '/spaces/:spaceId/duplicate',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      if (body.name !== undefined && typeof body.name !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'name must be a string');
      }
      if (body.expiryAt !== undefined && typeof body.expiryAt !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'expiryAt must be an ISO datetime');
      }
      if (body.copyFiles !== undefined && typeof body.copyFiles !== 'boolean') {
        throw new AppError('VALIDATION_ERROR', 'copyFiles must be a boolean');
      }
      res.status(201).json(
        await management.duplicate(req.user!, parseId(req, 'spaceId'), {
          name: body.name as string | undefined,
          expiryAt: body.expiryAt as string | undefined,
          copyFiles: Boolean(body.copyFiles),
        }),
      );
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
      res.json(await membership.membersPayload(req.user!, parseId(req, 'spaceId')));
    }),
  );

  router.post(
    '/spaces/:spaceId/invitations',
    validateBody(invitationSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { email, role } = req.body as Record<string, unknown>;
      if (typeof email !== 'string' || (role !== 'EDITOR' && role !== 'VIEWER')) {
        throw new AppError('VALIDATION_ERROR', 'email and role (EDITOR|VIEWER) are required');
      }
      const result = await membership.invite(req.user!, parseId(req, 'spaceId'), email, role);
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
      // No role supplied means "use this Space's default invite role".
      res.json({
        inviteLink: await membership.createInviteLink(
          req.user!,
          parseId(req, 'spaceId'),
          role as 'EDITOR' | 'VIEWER' | undefined,
        ),
      });
    }),
  );

  router.delete(
    '/spaces/:spaceId/invite-link',
    asyncHandler(async (req: Request, res: Response) => {
      await membership.revokeInviteLink(req.user!, parseId(req, 'spaceId'));
      res.status(204).end();
    }),
  );

  router.get(
    '/spaces/:spaceId/join-requests',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ requests: await membership.listJoinRequests(req.user!, parseId(req, 'spaceId')) });
    }),
  );

  router.patch(
    '/spaces/:spaceId/members/:userId',
    asyncHandler(async (req: Request, res: Response) => {
      const { role } = req.body as Record<string, unknown>;
      if (role !== 'EDITOR' && role !== 'VIEWER') {
        throw new AppError('VALIDATION_ERROR', 'role must be EDITOR or VIEWER');
      }
      res.json({ member: await spaces.changeRole(req.user!, parseId(req, 'spaceId'), parseId(req, 'userId'), role) });
    }),
  );

  router.delete(
    '/spaces/:spaceId/members/:userId',
    asyncHandler(async (req: Request, res: Response) => {
      await spaces.revoke(req.user!, parseId(req, 'spaceId'), parseId(req, 'userId'));
      res.status(204).end();
    }),
  );

  // Leave the Space (self-removal). Spec §3.5.
  router.post(
    '/spaces/:spaceId/leave',
    asyncHandler(async (req: Request, res: Response) => {
      await membership.leaveSpace(req.user!, parseId(req, 'spaceId'));
      res.status(204).end();
    }),
  );

  // Resend an invitation email. Spec §1.7.
  router.post(
    '/invitations/:invitationId/resend',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await membership.resendInvitation(req.user!, parseId(req, 'invitationId')));
    }),
  );

  /**
   * Space activity (Module 12). Filters and pagination are server-side and the
   * caller's Space role is checked before any row is read, so a removed member
   * cannot read history they used to see.
   */
  router.get(
    '/spaces/:spaceId/activity',
    asyncHandler(async (req: Request, res: Response) => {
      const spaceId = parseId(req, 'spaceId');
      const parsed = activityQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid activity query');
      }
      const page = await activity.listForSpace(req.user!, spaceId, activityFilters(req.query, parsed.data));
      // `activity` keeps the original response key for existing clients.
      res.json({ activity: page.entries, total: page.total, limit: page.limit, offset: page.offset });
    }),
  );

  router.get(
    '/spaces/:spaceId/activity/export',
    asyncHandler(async (req: Request, res: Response) => {
      const spaceId = parseId(req, 'spaceId');
      const parsed = activityQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid activity query');
      }
      const file = await activity.exportCsv(req.user!, { kind: 'space', spaceId }, activityFilters(req.query, parsed.data));
      sendCsv(res, file);
    }),
  );

  // -- Join requests (shared by link requests and email invitations) --------

  // Authenticated preview (same data, requires sign-in).
  router.get(
    '/join-links/:token',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ space: await membership.previewInviteLink(req.user!, parseId(req, 'token')) });
    }),
  );

  router.post(
    '/join-links/:token/requests',
    asyncHandler(async (req: Request, res: Response) => {
      res.status(201).json({ request: await membership.requestJoinByLink(req.user!, parseId(req, 'token')) });
    }),
  );

  router.post(
    '/join-requests/:requestId/decision',
    asyncHandler(async (req: Request, res: Response) => {
      const { decision } = req.body as Record<string, unknown>;
      if (decision !== 'ACCEPT' && decision !== 'DECLINE') {
        throw new AppError('VALIDATION_ERROR', 'decision must be ACCEPT or DECLINE');
      }
      res.json({ request: await membership.decide(req.user!, parseId(req, 'requestId'), decision) });
    }),
  );

  // Token-based invitation acceptance. Spec §2.6.
  router.post(
    '/invitations/accept',
    asyncHandler(async (req: Request, res: Response) => {
      const { token } = req.body as Record<string, unknown>;
      if (typeof token !== 'string') throw new AppError('VALIDATION_ERROR', 'token is required');
      const result = await membership.acceptInvitationByToken(req.user!, token);
      res.json({ invitation: result.invitation, member: result.member });
    }),
  );

  router.post(
    '/invitations/decline',
    asyncHandler(async (req: Request, res: Response) => {
      const { token } = req.body as Record<string, unknown>;
      if (typeof token !== 'string') throw new AppError('VALIDATION_ERROR', 'token is required');
      res.json({ invitation: await membership.declineInvitationByToken(req.user!, token) });
    }),
  );

  // Accept/decline straight from an in-app notification. The invitation is
  // resolved from the caller's verified email, never from client-supplied ids.
  router.post(
    '/spaces/:spaceId/invitations/decision',
    asyncHandler(async (req: Request, res: Response) => {
      const { decision } = req.body as Record<string, unknown>;
      if (decision !== 'ACCEPT' && decision !== 'DECLINE') {
        throw new AppError('VALIDATION_ERROR', 'decision must be ACCEPT or DECLINE');
      }
      res.json(await membership.decideInvitationForSpace(req.user!, parseId(req, 'spaceId'), decision));
    }),
  );

  // Validate an invitation token (for the join page to check invitation status)
  router.post(
    '/invitations/validate',
    asyncHandler(async (req: Request, res: Response) => {
      const { token } = req.body as Record<string, unknown>;
      if (typeof token !== 'string') throw new AppError('VALIDATION_ERROR', 'token is required');
      
      const invitation = await membership.findInvitationByTokenForValidation(token);
      if (!invitation) {
        throw new AppError('INVITATION_INVALID', 'This invitation link is no longer valid');
      }

      const space = await db.spaces.findById(invitation.spaceId);
      if (!space || space.status === 'DELETED') {
        throw new AppError('SPACE_NOT_FOUND', 'Space not found');
      }

      const actor = req.user!;
      const alreadyMember = (await spaces.roleOf(invitation.spaceId, actor.id)) !== null;
      const inviter = await db.auth.findById(invitation.inviterId);
      const memberCount = (await db.members.listForSpace(invitation.spaceId)).filter(m => m.status === 'ACTIVE').length;

      res.json({
        invitation,
        invitationSpaceName: space.name,
        invitationSpacePurpose: space.purpose,
        invitationSpaceDescription: space.description,
        inviterDisplayName: inviter?.displayName ?? 'Space owner',
        memberCount,
        alreadyMember,
      });
    }),
  );

  // -- Folders -------------------------------------------------------------

  router.get(
    '/spaces/:spaceId/folders',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ folders: await spaces.listFolders(parseId(req, 'spaceId'), req.user!.id) });
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
        folder: await spaces.createFolder(req.user!, parseId(req, 'spaceId'), {
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
      // `folderId` absent = whole Space, `root` = Space root, otherwise an id.
      const folderRaw = req.query.folderId;
      const folderId =
        folderRaw === undefined ? undefined : folderRaw === 'root' ? null : String(folderRaw);
      const typeRaw = typeof req.query.type === 'string' ? req.query.type : 'all';
      if (!['all', 'image', 'pdf', 'document', 'text', 'other'].includes(typeRaw)) {
        throw new AppError('VALIDATION_ERROR', 'Unknown file type filter');
      }
      const sortRaw = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
      if (!['name-asc', 'name-desc', 'size-asc', 'size-desc', 'newest', 'oldest'].includes(sortRaw)) {
        throw new AppError('VALIDATION_ERROR', 'Unknown file sort');
      }
      const int = (value: unknown): number | undefined => {
        if (typeof value !== 'string' || !value) return undefined;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) throw new AppError('VALIDATION_ERROR', 'Invalid numeric query');
        return Math.trunc(parsed);
      };
      const result = await manager.list(req.user!, parseId(req, 'spaceId'), {
        folderId,
        type: typeRaw as 'all' | 'image' | 'pdf' | 'document' | 'text' | 'other',
        q: typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : undefined,
        sort: sortRaw as 'name-asc' | 'name-desc' | 'size-asc' | 'size-desc' | 'newest' | 'oldest',
        includeDeleted: req.query.includeDeleted === 'true',
        limit: int(req.query.limit),
        offset: int(req.query.offset),
      });
      res.json(result);
    }),
  );

  router.post(
    '/spaces/:spaceId/files/init-upload',
    validateBody(initUploadSchema),
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
    validateBody(renameFileSchema),
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

  // -- Module 4: file manager ---------------------------------------------

  router.get(
    '/spaces/:spaceId/files/:fileId',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ file: await manager.details(req.user!, parseId(req, 'spaceId'), parseId(req, 'fileId')) });
    }),
  );

  router.post(
    '/spaces/:spaceId/files/:fileId/preview',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ preview: await manager.preview(req.user!, parseId(req, 'spaceId'), parseId(req, 'fileId')) });
    }),
  );

  router.post(
    '/spaces/:spaceId/files/:fileId/move',
    asyncHandler(async (req: Request, res: Response) => {
      const { folderId } = req.body as Record<string, unknown>;
      if (folderId !== null && folderId !== undefined && typeof folderId !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'folderId must be a string or null');
      }
      res.json({
        file: await manager.move(
          req.user!,
          parseId(req, 'spaceId'),
          parseId(req, 'fileId'),
          (folderId as string | null | undefined) ?? null,
        ),
      });
    }),
  );

  router.post(
    '/spaces/:spaceId/files/:fileId/restore',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ file: await manager.restore(req.user!, parseId(req, 'spaceId'), parseId(req, 'fileId')) });
    }),
  );

  router.delete(
    '/spaces/:spaceId/files/:fileId/upload',
    asyncHandler(async (req: Request, res: Response) => {
      await manager.cancelUpload(req.user!, parseId(req, 'spaceId'), parseId(req, 'fileId'));
      res.status(204).end();
    }),
  );

  const parseIds = (body: Record<string, unknown>): string[] => {
    if (!Array.isArray(body.fileIds) || body.fileIds.some((id) => typeof id !== 'string')) {
      throw new AppError('VALIDATION_ERROR', 'fileIds must be an array of strings');
    }
    return body.fileIds as string[];
  };

  router.post(
    '/spaces/:spaceId/files/bulk-delete',
    asyncHandler(async (req: Request, res: Response) => {
      const ids = parseIds(req.body as Record<string, unknown>);
      res.json(await manager.bulkDelete(req.user!, parseId(req, 'spaceId'), ids));
    }),
  );

  router.post(
    '/spaces/:spaceId/files/bulk-move',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      const ids = parseIds(body);
      if (body.folderId !== null && body.folderId !== undefined && typeof body.folderId !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'folderId must be a string or null');
      }
      res.json(
        await manager.bulkMove(
          req.user!,
          parseId(req, 'spaceId'),
          ids,
          (body.folderId as string | null | undefined) ?? null,
        ),
      );
    }),
  );

  router.post(
    '/spaces/:spaceId/files/bulk-download',
    asyncHandler(async (req: Request, res: Response) => {
      const ids = parseIds(req.body as Record<string, unknown>);
      const { stream, filename, fileCount } = await manager.bulkDownload(
        req.user!,
        parseId(req, 'spaceId'),
        ids,
      );
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
      res.setHeader('X-File-Count', String(fileCount));
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }),
  );

  // -- Upload configuration ---------------------------------------------

  router.get(
    '/upload-config',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({
        config: {
          maxUploadBytes: env.fileMaxBytes,
          maxSpaceBytes: env.spaceMaxBytes,
          blockedExtensions: env.uploadBlockedExtensions,
          defaultLimit: DEFAULT_FILE_LIMIT,
          maxLimit: MAX_FILE_LIMIT,
        },
      });
    }),
  );

  // -- Module 4: folder management ----------------------------------------

  router.get(
    '/spaces/:spaceId/folders/stats',
    asyncHandler(async (req: Request, res: Response) => {
      const raw = req.query.folderId;
      const folderId = raw === undefined || raw === 'root' ? null : String(raw);
      res.json({ stats: await manager.folderStats(req.user!, parseId(req, 'spaceId'), folderId) });
    }),
  );

  router.patch(
    '/spaces/:spaceId/folders/:folderId',
    asyncHandler(async (req: Request, res: Response) => {
      const { name } = req.body as Record<string, unknown>;
      if (typeof name !== 'string' || !name.trim()) {
        throw new AppError('VALIDATION_ERROR', 'name is required');
      }
      res.json({
        folder: await manager.renameFolder(
          req.user!,
          parseId(req, 'spaceId'),
          parseId(req, 'folderId'),
          name,
        ),
      });
    }),
  );

  router.post(
    '/spaces/:spaceId/folders/:folderId/move',
    asyncHandler(async (req: Request, res: Response) => {
      const { parentId } = req.body as Record<string, unknown>;
      if (parentId !== null && parentId !== undefined && typeof parentId !== 'string') {
        throw new AppError('VALIDATION_ERROR', 'parentId must be a string or null');
      }
      res.json({
        folder: await manager.moveFolder(
          req.user!,
          parseId(req, 'spaceId'),
          parseId(req, 'folderId'),
          (parentId as string | null | undefined) ?? null,
        ),
      });
    }),
  );

  router.delete(
    '/spaces/:spaceId/folders/:folderId',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(
        await manager.deleteFolder(
          req.user!,
          parseId(req, 'spaceId'),
          parseId(req, 'folderId'),
          req.query.recursive === 'true',
        ),
      );
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
      res.status(201).json({ request: await extensions.request(req.user!, parseId(req, 'spaceId'), requestedDays, reason) });
    }),
  );

  router.get(
    '/spaces/:spaceId/extensions',
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ requests: await extensions.listForSpace(req.user!, parseId(req, 'spaceId')) });
    }),
  );

  return router;
}

/** Parses and validates the Space listing query (unknown values are rejected). */
function parseListQuery(req: Request): SpaceListQuery {
  const raw = req.query;
  const statusRaw = typeof raw.status === 'string' ? raw.status : undefined;
  if (statusRaw && statusRaw !== 'ALL' && statusRaw !== 'EXPIRING' && !SPACE_STATUSES.includes(statusRaw as SpaceStatus)) {
    throw new AppError('VALIDATION_ERROR', 'Unknown status filter');
  }
  const sortRaw = typeof raw.sort === 'string' ? raw.sort : undefined;
  if (sortRaw && !SPACE_SORTS.includes(sortRaw as SpaceSort)) {
    throw new AppError('VALIDATION_ERROR', 'Unknown sort option');
  }
  const ownershipRaw = typeof raw.ownership === 'string' ? raw.ownership : undefined;
  if (ownershipRaw && !['all', 'owned', 'shared'].includes(ownershipRaw)) {
    throw new AppError('VALIDATION_ERROR', 'ownership must be all, owned or shared');
  }
  const int = (value: unknown): number | undefined => {
    if (typeof value !== 'string' || !value) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new AppError('VALIDATION_ERROR', 'Invalid numeric query');
    return Math.trunc(parsed);
  };
  return {
    status: statusRaw as SpaceListQuery['status'],
    ownership: ownershipRaw as SpaceListQuery['ownership'],
    q: typeof raw.q === 'string' ? raw.q.slice(0, 120) : undefined,
    purpose: typeof raw.purpose === 'string' ? raw.purpose.slice(0, 120) : undefined,
    sort: sortRaw as SpaceSort | undefined,
    favorite: raw.favorite === 'true',
    limit: int(raw.limit),
    offset: int(raw.offset),
  };
}
