/**
 * PostgreSQL error mapping for the repository layer.
 *
 * Services rely on repository behaviour, not on driver-specific error objects.
 * These errors keep the SQLSTATE and constraint name (useful in logs/tests) but
 * never include SQL text or bound values.
 */
export type PostgresErrorCode =
  | 'DUPLICATE'
  | 'FOREIGN_KEY_VIOLATION'
  | 'CONSTRAINT_VIOLATION'
  | 'NOT_NULL_VIOLATION'
  | 'INVALID_INPUT'
  | 'DATABASE_ERROR';

export class PostgresRepositoryError extends Error {
  constructor(
    readonly code: PostgresErrorCode,
    message: string,
    readonly pgCode: string | null = null,
    readonly constraint: string | null = null,
  ) {
    super(message);
    this.name = 'PostgresRepositoryError';
  }
}

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
  detail?: unknown;
}

/** Convert a `pg` error into a small, stable repository error. */
export function mapPostgresError(err: unknown): never {
  if (err instanceof PostgresRepositoryError) throw err;
  const candidate = err as PgErrorLike;
  const pgCode = typeof candidate?.code === 'string' ? candidate.code : null;
  const constraint = typeof candidate?.constraint === 'string' ? candidate.constraint : null;

  switch (pgCode) {
    case '23505':
      throw new PostgresRepositoryError(
        'DUPLICATE',
        `Duplicate value violates a unique constraint${constraint ? ` (${constraint})` : ''}`,
        pgCode,
        constraint,
      );
    case '23503':
      throw new PostgresRepositoryError(
        'FOREIGN_KEY_VIOLATION',
        `Referenced record does not exist${constraint ? ` (${constraint})` : ''}`,
        pgCode,
        constraint,
      );
    case '23514':
      throw new PostgresRepositoryError(
        'CONSTRAINT_VIOLATION',
        `Value violates a check constraint${constraint ? ` (${constraint})` : ''}`,
        pgCode,
        constraint,
      );
    case '23502':
      throw new PostgresRepositoryError(
        'NOT_NULL_VIOLATION',
        `A required column is null${constraint ? ` (${constraint})` : ''}`,
        pgCode,
        constraint,
      );
    case '22P02':
    case '22007':
    case '22008':
      throw new PostgresRepositoryError('INVALID_INPUT', 'Invalid value for a database column', pgCode);
    default:
      throw new PostgresRepositoryError(
        'DATABASE_ERROR',
        err instanceof Error ? err.message : 'Database operation failed',
        pgCode,
      );
  }
}
