/** PostgreSQL implementation of `LifecycleTransitionsRepo`. */
import type { Pool } from 'pg';
import type { LifecycleTransition } from '@flashspace/shared';
import type { LifecycleTransitionsRepo } from '../../data-layer.interface.js';
import { mapPostgresError } from '../errors.js';
import { mapLifecycleTransitionRow, type DbRow } from './rows.js';

const COLUMNS = 'id, space_id, actor_id, previous_status, new_status, reason, "timestamp"';

export class PostgresLifecycleTransitionsRepo implements LifecycleTransitionsRepo {
  constructor(private readonly pool: Pool) {}

  async insert(transition: LifecycleTransition): Promise<LifecycleTransition> {
    try {
      await this.pool.query(
        `insert into lifecycle_transitions
           (id, space_id, actor_id, previous_status, new_status, reason, "timestamp")
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          transition.id,
          transition.spaceId,
          transition.actorId,
          transition.previousStatus,
          transition.newStatus,
          transition.reason,
          transition.timestamp,
        ],
      );
      return transition;
    } catch (err) {
      return mapPostgresError(err);
    }
  }

  async listForSpace(spaceId: string, limit = 50): Promise<LifecycleTransition[]> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `select ${COLUMNS} from lifecycle_transitions
          where space_id = $1
          order by "timestamp" desc, id desc
          limit $2`,
        [spaceId, limit],
      );
      return rows.map(mapLifecycleTransitionRow);
    } catch (err) {
      return mapPostgresError(err);
    }
  }
}
