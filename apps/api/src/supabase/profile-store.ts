import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import { createServiceClient } from './clients.js';
import type { SupabaseIdentityClaims } from './verify-token.js';

/**
 * Supabase Postgres profile store (Module 1.6).
 *
 * `auth.users` is the identity source of truth and owns credentials; this store
 * manages the application profile that hangs off it (display name, avatar path,
 * preferences, application role, account status). It uses the service-role
 * client because the API is a trusted backend: it never ships that key to the
 * browser, and RLS still governs every browser-initiated access.
 *
 * The client is created lazily so the API can boot in local auth mode with no
 * Supabase configuration at all.
 */

export type ApplicationRole = 'USER' | 'ADMIN';
export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETING';

export interface AccountPreferences {
  notifyInApp: boolean;
  notifyEmail: boolean;
  productUpdates: boolean;
  [key: string]: unknown;
}

export const DEFAULT_PREFERENCES: AccountPreferences = {
  notifyInApp: true,
  notifyEmail: true,
  productUpdates: false,
};

export interface AppProfile {
  /** Text uuid, mirrors auth.users.id (see migration 003). */
  id: string;
  authUserId: string;
  email: string;
  displayName: string;
  role: ApplicationRole;
  /** Bucket-relative Storage path, e.g. `<uid>/avatar-1730.webp`. */
  avatarPath: string | null;
  avatarUrl: string | null;
  preferences: AccountPreferences;
  accountStatus: AccountStatus;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProfileRow {
  id: string;
  auth_user_id: string | null;
  email: string;
  display_name: string;
  role: string;
  avatar_path: string | null;
  avatar_url: string | null;
  preferences: unknown;
  account_status: string;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

const PROFILE_COLUMNS =
  'id, auth_user_id, email, display_name, role, avatar_path, avatar_url, preferences, account_status, email_verified_at, created_at, updated_at';

export function normalizePreferences(value: unknown): AccountPreferences {
  const extra = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    ...extra,
    notifyInApp: typeof extra.notifyInApp === 'boolean' ? extra.notifyInApp : DEFAULT_PREFERENCES.notifyInApp,
    notifyEmail: typeof extra.notifyEmail === 'boolean' ? extra.notifyEmail : DEFAULT_PREFERENCES.notifyEmail,
    productUpdates:
      typeof extra.productUpdates === 'boolean' ? extra.productUpdates : DEFAULT_PREFERENCES.productUpdates,
  };
}

function toProfile(row: ProfileRow): AppProfile {
  return {
    id: row.id,
    authUserId: row.auth_user_id ?? row.id,
    email: row.email,
    displayName: row.display_name,
    // Only USER and ADMIN exist globally; OWNER/EDITOR/VIEWER are per-Space.
    role: row.role === 'ADMIN' ? 'ADMIN' : 'USER',
    avatarPath: row.avatar_path,
    avatarUrl: row.avatar_url,
    preferences: normalizePreferences(row.preferences),
    accountStatus:
      row.account_status === 'SUSPENDED' || row.account_status === 'DELETING' ? row.account_status : 'ACTIVE',
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dbError(context: string, error: { message: string; code?: string }): AppError {
  return new AppError('PROFILE_ERROR', `${context}: ${error.message}`);
}

export class ProfileStore {
  private client: SupabaseClient | null;

  constructor(
    private readonly env: Env,
    client?: SupabaseClient,
  ) {
    this.client = client ?? null;
  }

  private get db(): SupabaseClient {
    this.client ??= createServiceClient(this.env);
    return this.client;
  }

  async byAuthId(authUserId: string): Promise<AppProfile | null> {
    const { data, error } = await this.db
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('auth_user_id', authUserId)
      .maybeSingle<ProfileRow>();
    if (error) throw dbError('Could not load profile', error);
    return data ? toProfile(data) : null;
  }

  async byEmail(email: string): Promise<AppProfile | null> {
    const { data, error } = await this.db
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('email', email.toLowerCase())
      .maybeSingle<ProfileRow>();
    if (error) throw dbError('Could not look up profile', error);
    return data ? toProfile(data) : null;
  }

  /**
   * Return the profile for a verified Supabase identity, creating it when the
   * `on_auth_user_created` trigger has not run (e.g. users created before the
   * migration, or an admin-created account).
   *
   * The application role always starts as USER: nothing in registration or
   * session metadata may grant ADMIN.
   */
  async ensureFromClaims(claims: SupabaseIdentityClaims): Promise<AppProfile> {
    const existing = await this.byAuthId(claims.sub);
    if (existing) return existing;

    let displayName = claims.email.split('@')[0] ?? 'Member';
    let confirmedAt: string | null = null;
    try {
      const { data } = await this.db.auth.admin.getUserById(claims.sub);
      const metadata = (data?.user?.user_metadata ?? {}) as Record<string, unknown>;
      const metaName = typeof metadata.display_name === 'string' ? metadata.display_name.trim() : '';
      if (metaName) displayName = metaName;
      confirmedAt = data?.user?.email_confirmed_at ?? null;
    } catch {
      // Metadata is a nicety: never block authentication on an admin lookup.
    }

    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from('profiles')
      .insert({
        id: claims.sub,
        auth_user_id: claims.sub,
        email: claims.email,
        display_name: displayName.slice(0, 80),
        role: 'USER',
        preferences: DEFAULT_PREFERENCES,
        account_status: 'ACTIVE',
        email_verified_at: confirmedAt,
        created_at: now,
        updated_at: now,
      })
      .select(PROFILE_COLUMNS)
      .single<ProfileRow>();

    if (error) {
      // Unique violation means a concurrent request created it first.
      if (error.code === '23505') {
        const raced = await this.byAuthId(claims.sub);
        if (raced) return raced;
      }
      throw dbError('Could not create profile', error);
    }
    return toProfile(data);
  }

  /** Update the fields a user owns: display name and preferences. */
  async updateOwn(
    authUserId: string,
    patch: { displayName?: string; preferences?: Partial<AccountPreferences> },
  ): Promise<AppProfile> {
    const current = await this.byAuthId(authUserId);
    if (!current) throw new AppError('PROFILE_NOT_FOUND', 'Profile not found');

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.displayName !== undefined) {
      const name = patch.displayName.trim();
      if (!name) throw new AppError('VALIDATION_ERROR', 'Display name cannot be empty');
      if (name.length > 80) throw new AppError('VALIDATION_ERROR', 'Display name must be 80 characters or fewer');
      update.display_name = name;
    }
    if (patch.preferences !== undefined) {
      update.preferences = normalizePreferences({ ...current.preferences, ...patch.preferences });
    }

    const { data, error } = await this.db
      .from('profiles')
      .update(update)
      .eq('auth_user_id', authUserId)
      .select(PROFILE_COLUMNS)
      .single<ProfileRow>();
    if (error) throw dbError('Could not update profile', error);
    return toProfile(data);
  }

  async setAvatar(authUserId: string, avatarPath: string | null): Promise<AppProfile> {
    const { data, error } = await this.db
      .from('profiles')
      .update({ avatar_path: avatarPath, updated_at: new Date().toISOString() })
      .eq('auth_user_id', authUserId)
      .select(PROFILE_COLUMNS)
      .single<ProfileRow>();
    if (error) throw dbError('Could not update avatar', error);
    return toProfile(data);
  }

  async deleteOwn(authUserId: string): Promise<void> {
    const { error } = await this.db.from('profiles').delete().eq('auth_user_id', authUserId);
    if (error) throw dbError('Could not delete profile', error);
  }

  // -- audit log -----------------------------------------------------------

  async recordAudit(
    authUserId: string,
    action: string,
    metadata: Record<string, unknown> = {},
    ctx: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<void> {
    const { error } = await this.db.from('account_audit').insert({
      user_id: authUserId,
      action,
      metadata,
      ip: ctx.ip ?? null,
      user_agent: ctx.userAgent ?? null,
    });
    // Auditing must never take the user's action down with it, but it must be
    // visible in the server log when it fails.
    if (error) console.error('[audit] could not record', action, error.message);
  }

  async auditFor(authUserId: string, limit = 20): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.db
      .from('account_audit')
      .select('id, action, metadata, created_at')
      .eq('user_id', authUserId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw dbError('Could not load account activity', error);
    return (data ?? []) as Record<string, unknown>[];
  }

  // -- legacy linking ------------------------------------------------------

  /**
   * Record an explicit, verified link between a Supabase identity and an
   * existing SQLite account. This never rewrites the SQLite data on its own:
   * it is the mapping the migration step consumes, so ownership transfer stays
   * a reviewed operation instead of an implicit side effect of signing up.
   */
  async createLegacyLink(input: {
    authUserId: string;
    legacyProfileId: string;
    legacyEmail: string;
    tokenHash: string;
  }): Promise<void> {
    const { error } = await this.db.from('legacy_account_links').upsert(
      {
        auth_user_id: input.authUserId,
        legacy_profile_id: input.legacyProfileId,
        legacy_email: input.legacyEmail.toLowerCase(),
        status: 'VERIFIED',
        verification_token_hash: input.tokenHash,
        verified_at: new Date().toISOString(),
      },
      { onConflict: 'auth_user_id' },
    );
    if (error) throw dbError('Could not link the existing account', error);
  }

  async legacyLinkFor(authUserId: string): Promise<{ legacyProfileId: string; status: string } | null> {
    const { data, error } = await this.db
      .from('legacy_account_links')
      .select('legacy_profile_id, status')
      .eq('auth_user_id', authUserId)
      .maybeSingle<{ legacy_profile_id: string; status: string }>();
    if (error) throw dbError('Could not load account link', error);
    return data ? { legacyProfileId: data.legacy_profile_id, status: data.status } : null;
  }
}
