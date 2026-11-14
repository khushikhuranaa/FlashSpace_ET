import type { AuthUser, ExtensionRequest } from '@flashspace/shared';
import { ACTIVITY_ACTIONS, AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import { newId } from '../utils/ids.js';
import type { SpacesService } from './spaces.service.js';

/**
 * Extension requests (PRD §9.4): members request extra days before expiry.
 * Policy: ADMIN (default) requires an admin decision; AUTO grants instantly
 * up to the configured max, once per Space.
 */
export class ExtensionService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly spaces: SpacesService,
  ) {}

  async request(actor: AuthUser, spaceId: string, requestedDays: number, reason: string): Promise<ExtensionRequest> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    const space = await this.db.spaces.findById(spaceId);
    if (!space || space.status === 'DELETED') throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    if (space.status !== 'WARNING' && space.status !== 'ACTIVE') {
      throw new AppError('SPACE_NOT_WRITABLE', 'Extensions are only possible before archiving starts');
    }
    if (requestedDays < 1 || requestedDays > this.env.maxExtensionDays) {
      throw new AppError('MAX_EXTENSION_EXCEEDED', `Requested days must be between 1 and ${this.env.maxExtensionDays}`);
    }
    if (await this.db.extensionRequests.findPendingForSpace(spaceId)) {
      throw new AppError('PENDING_EXTENSION_EXISTS', 'An extension request is already pending for this Space');
    }
    const req: ExtensionRequest = {
      id: newId(),
      spaceId,
      requesterId: actor.id,
      requestedDays,
      reason,
      status: 'PENDING',
      decidedBy: null,
      decidedAt: null,
      rejectionReason: null,
      adminNote: null,
      previousExpiryAt: null,
      newExpiryAt: null,
      approvalMethod: null,
      createdAt: new Date().toISOString(),
    };
    await this.db.extensionRequests.insert(req);
    await this.db.activity.append({
      userId: actor.id,
      spaceId,
      fileId: null,
      action: 'EXTENSION_REQUESTED',
      metadata: { requestedDays, reason },
    });

    if (this.env.extensionPolicy === 'AUTO') {
      return this.decide(actor, req.id, 'APPROVED', 'AUTOMATIC');
    }
    // Notify OWNER + admins that a decision is awaited.
    await this.spaces.notify(
      space.ownerId,
      spaceId,
      'EXTENSION_DECIDED',
      `Extension requested for "${space.name}"`,
      `${actor.displayName} requested ${requestedDays} extra day(s). Awaiting admin decision.`,
    );
    return req;
  }

  async decide(
    actor: AuthUser,
    requestId: string,
    decision: 'APPROVED' | 'REJECTED',
    method: 'MANUAL' | 'AUTOMATIC' = 'MANUAL',
  ): Promise<ExtensionRequest> {
    // An automatic policy decision is made by the system, not by the requester,
    // so it must not be gated on (or attributed to) an administrator.
    if (method === 'MANUAL' && (await this.db.auth.findById(actor.id))?.role !== 'ADMIN') {
      throw new AppError('ADMIN_REQUIRED', 'Only admins can decide extension requests');
    }
    const req = await this.db.extensionRequests.findById(requestId);
    if (!req) throw new AppError('NOT_FOUND', 'Extension request not found');
    if (req.status !== 'PENDING') {
      throw new AppError('REQUEST_ALREADY_DECIDED', 'This request has already been decided');
    }
    const space = await this.db.spaces.findById(req.spaceId);
    // The authoritative expiry values come from the persisted Space row, never
    // from a client-supplied date.
    const previousExpiryAt = space?.expiryAt ?? null;
    let newExpiryAt: string | null = null;
    if (decision === 'APPROVED' && space) {
      const newExpiry = new Date(space.expiryAt);
      newExpiry.setDate(newExpiry.getDate() + req.requestedDays);
      newExpiryAt = newExpiry.toISOString();
      await this.db.spaces.update(space.id, { expiryAt: newExpiryAt, status: 'ACTIVE' });
    }
    const updated = await this.db.extensionRequests.update(requestId, {
      status: decision,
      decidedBy: actor.id,
      decidedAt: new Date().toISOString(),
      previousExpiryAt,
      newExpiryAt,
      approvalMethod: method,
    });
    await this.spaces.notify(
      req.requesterId,
      req.spaceId,
      'EXTENSION_DECIDED',
      decision === 'APPROVED' ? 'Extension approved' : 'Extension rejected',
      decision === 'APPROVED'
        ? `Your Space expiry was extended by ${req.requestedDays} day(s).`
        : 'Your extension request was rejected by an admin.',
    );
    await this.db.activity.append({
      userId: method === 'AUTOMATIC' ? null : actor.id,
      spaceId: req.spaceId,
      fileId: null,
      action: decision === 'APPROVED' ? 'EXTENSION_APPROVED' : 'EXTENSION_REJECTED',
      actorType: method === 'AUTOMATIC' ? 'SYSTEM' : 'ADMIN',
      category: 'EXTENSION',
      resourceType: 'extension_request',
      resourceId: requestId,
      reason: method === 'AUTOMATIC' ? 'automatic-policy-approval' : null,
      metadata: {
        requestId,
        days: req.requestedDays,
        requesterId: req.requesterId,
        previousExpiryAt,
        newExpiryAt,
        approvalMethod: method,
      },
    });
    if (method === 'AUTOMATIC') {
      await this.db.activity.append({
        spaceId: req.spaceId,
        action: ACTIVITY_ACTIONS.EXTENSION_AUTO_DECIDED,
        actorType: 'SYSTEM',
        category: 'EXTENSION',
        resourceType: 'extension_request',
        resourceId: requestId,
        metadata: { requestId, decision, requesterId: req.requesterId },
      });
    }
    return updated!;
  }

  async listForSpace(actor: AuthUser, spaceId: string): Promise<ExtensionRequest[]> {
    await this.spaces.requireRole(spaceId, actor.id, ['OWNER', 'EDITOR', 'VIEWER']);
    return this.db.extensionRequests.listForSpace(spaceId);
  }

  async listPending(actor: AuthUser): Promise<ExtensionRequest[]> {
    if ((await this.db.auth.findById(actor.id))?.role !== 'ADMIN') {
      throw new AppError('ADMIN_REQUIRED', 'Only admins can view all extension requests');
    }
    return (await this.db.extensionRequests.listAll()).filter((r) => r.status === 'PENDING');
  }
}
