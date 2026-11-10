import { describe, expect, it } from 'vitest';
import { SqliteDataLayer } from '../src/repositories/sqlite/sqlite.data-layer.js';

/**
 * The SQLite repo maps snake_case columns to domain objects. `update()` used to
 * return a merged object that only had the camelCase patch applied, so callers
 * (PATCH /auth/me) received the previous display name even though the row was
 * written correctly.
 */
describe('sqlite auth repository', () => {
  it('returns the patched profile from update()', () => {
    const db = new SqliteDataLayer(':memory:');
    const createdAt = new Date().toISOString();
    db.auth.create(
      {
        id: 'user-1',
        email: 'user@test.dev',
        displayName: 'Before',
        role: 'USER',
        avatarUrl: null,
        createdAt,
        updatedAt: createdAt,
      },
      'hash',
    );

    const updated = db.auth.update('user-1', { displayName: 'After' });

    expect(updated?.displayName).toBe('After');
    expect(db.auth.findById('user-1')?.displayName).toBe('After');
  });
});
