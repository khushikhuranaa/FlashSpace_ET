import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import type { Space, SpaceStatus } from '@flashspace/shared';
import { newId } from '../utils/ids.js';

export interface LifecycleTransition {
  id: string;
  spaceId: string;
  actorId: string | null;
  previousStatus: SpaceStatus;
  newStatus: SpaceStatus;
  reason: string;
  timestamp: string;
}

export interface LifecycleTransitionInput {
  spaceId: string;
  actorId: string | null;
  previousStatus: SpaceStatus;
  newStatus: SpaceStatus;
  reason: string;
}

// Valid state transitions
const VALID_TRANSITIONS: Record<SpaceStatus, SpaceStatus[]> = {
  DRAFT: ['ACTIVE', 'DELETED'],
  ACTIVE: ['WARNING', 'ARCHIVING', 'DELETED'],
  WARNING: ['ACTIVE', 'ARCHIVING', 'DELETED'],
  ARCHIVING: ['ARCHIVED', 'ARCHIVE_FAILED', 'ACTIVE'],
  ARCHIVED: ['DELETED'],
  ARCHIVE_FAILED: ['ARCHIVING', 'ACTIVE', 'DELETED'],
  DELETED: [],
};

export class LifecycleHistoryService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
  ) {}

  /**
   * Record a lifecycle transition with full audit trail.
   */
  async recordTransition(input: LifecycleTransitionInput): Promise<LifecycleTransition> {
    // Validate the transition
    this.validateTransition(input.previousStatus, input.newStatus);

    const transition: LifecycleTransition = {
      id: newId(),
      spaceId: input.spaceId,
      actorId: input.actorId,
      previousStatus: input.previousStatus,
      newStatus: input.newStatus,
      reason: input.reason,
      timestamp: new Date().toISOString(),
    };

    await this.db.lifecycleTransitions.insert(transition);
    return transition;
  }

  /**
   * Validate that a transition is allowed.
   */
  validateTransition(from: SpaceStatus, to: SpaceStatus): void {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new AppError(
        'INVALID_TRANSITION',
        `Invalid lifecycle transition: ${from} → ${to}. Allowed: ${allowed.join(', ') || 'none'}`,
      );
    }
  }

  /**
   * Perform a validated lifecycle transition with history recording.
   */
  async transitionSpace(
    spaceId: string,
    newStatus: SpaceStatus,
    actorId: string | null,
    reason: string,
  ): Promise<{ space: Space; transition: LifecycleTransition }> {
    const space = await this.db.spaces.findById(spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    const previousStatus = space.status;
    this.validateTransition(previousStatus, newStatus);

    // Check for conflicting transitions (prevent duplicate processing)
    const recentTransitions = await this.db.lifecycleTransitions.listForSpace(spaceId, 1);
    const lastTransition = recentTransitions[0];
    if (lastTransition && lastTransition.timestamp > space.updatedAt) {
      throw new AppError(
        'CONCURRENT_TRANSITION',
        'A more recent transition has already been recorded',
      );
    }

    // Update the space status
    const updated = await this.db.spaces.update(spaceId, {
      status: newStatus,
      updatedAt: new Date().toISOString(),
    });

    if (!updated) throw new AppError('UPDATE_FAILED', 'Failed to update space status');

    // Record the transition
    const transition = await this.recordTransition({
      spaceId,
      actorId,
      previousStatus,
      newStatus,
      reason,
    });

    // Log activity
    await this.db.activity.append({
      userId: actorId,
      spaceId,
      fileId: null,
      action: 'LIFECYCLE_TRANSITION',
      metadata: {
        from: previousStatus,
        to: newStatus,
        reason,
        transitionId: transition.id,
      },
    });

    return { space: updated, transition };
  }

  /**
   * Get lifecycle transition history for a space.
   */
  async getHistory(spaceId: string, limit = 50): Promise<LifecycleTransition[]> {
    const space = await this.db.spaces.findById(spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');
    return this.db.lifecycleTransitions.listForSpace(spaceId, limit);
  }

  /**
   * Get the current status and recent history for a space.
   */
  async getStatus(spaceId: string): Promise<{
    space: Space;
    currentStatus: SpaceStatus;
    history: LifecycleTransition[];
  }> {
    const space = await this.db.spaces.findById(spaceId);
    if (!space) throw new AppError('SPACE_NOT_FOUND', 'Space not found');

    const history = await this.db.lifecycleTransitions.listForSpace(spaceId, 10);

    return {
      space,
      currentStatus: space.status,
      history,
    };
  }
}
