import type { AuthUser, Profile } from '@flashspace/shared';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import { ProfileStore, type AppProfile } from '../supabase/profile-store.js';
import { verifySupabaseToken } from '../supabase/verify-token.js';

/**
 * Anything that can turn a bearer token into an AuthUser. `AuthService` is the
 * local implementation; `SupabaseIdentityService` is the production one, so the
 * middleware does not need to know which mode is active.
 */
export interface TokenVerifier {
  verifyToken(token: string): Promise<AuthUser>;
}

/**
 * Supabase-mode identity resolution (Module 1.5).
 *
 *   1. Verify the access token against the project's JWKS (issuer + audience).
 *   2. Load — or lazily create — the application profile in Postgres.
 *   3. Mirror a minimal profile row into the local DataLayer so the existing
 *      Space / file / archive services keep resolving names and roles without
 *      knowing anything about Supabase.
 *
 * The application role always comes from Postgres, never from the token, so a
 * stale or tampered claim cannot grant ADMIN. Space roles remain in `members`
 * and are untouched by this service.
 */
export class SupabaseIdentityService implements TokenVerifier {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly profiles: ProfileStore,
  ) {}

  async verifyToken(token: string): Promise<AuthUser> {
    const claims = await verifySupabaseToken(token, this.env);
    const profile = await this.profiles.ensureFromClaims(claims);
    if (profile.accountStatus !== 'ACTIVE') {
      throw new AppError('ACCOUNT_DISABLED', 'This account is not active. Contact support.');
    }
    await this.mirror(profile);
    return {
      id: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      role: profile.role,
    };
  }

  /**
   * Keep the local profile row aligned with the Supabase profile.
   *
   * If the email already belongs to a different local profile we refuse instead
   * of creating a second row: that is precisely the legacy-account case, and it
   * must be resolved by the explicit linking flow, not by a silent duplicate.
   */
  private async mirror(profile: AppProfile): Promise<void> {
    const existing = await this.db.auth.findById(profile.id);
    if (existing) {
      if (existing.displayName !== profile.displayName || existing.avatarUrl !== profile.avatarUrl) {
        await this.db.auth.update(profile.id, {
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
        });
      }
      return;
    }

    const sameEmail = await this.db.auth.findByEmail(profile.email);
    if (sameEmail && sameEmail.id !== profile.id) {
      throw new AppError(
        'LEGACY_ACCOUNT_EXISTS',
        'An existing FlashSpace account uses this email. Link it from Settings to keep your Spaces and files.',
      );
    }

    await this.db.auth.ensureProfile({
      id: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      role: profile.role,
      avatarUrl: profile.avatarUrl,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    } satisfies Profile);
  }
}
