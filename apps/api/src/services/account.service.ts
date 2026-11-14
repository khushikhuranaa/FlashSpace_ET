import { createHash, randomBytes } from 'node:crypto';
import type { AuthUser, Profile } from '@flashspace/shared';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { DataLayer } from '../repositories/data-layer.interface.js';
import { ProfileStore, type AccountPreferences, type AppProfile } from '../supabase/profile-store.js';
import { createServiceClient } from '../supabase/clients.js';
import { deleteAuthUser, requestEmailChange, updatePassword, verifyPassword as verifySupabasePassword } from '../supabase/gotrue.js';
import { hashPassword, verifyPassword } from '../utils/password.js';

/**
 * Account management (Module 1.6): profile fields, avatar in Supabase Storage,
 * email and password changes through Supabase Auth, personal data export and
 * account deletion.
 *
 * Authorisation model: every method takes the caller resolved from a verified
 * access token, and uses that id — never an id supplied in the request body.
 */

export interface AccountView {
  id: string;
  email: string;
  displayName: string;
  role: string;
  avatarPath: string | null;
  /** Short-lived signed URL for the private avatars bucket. */
  avatarUrl: string | null;
  preferences: AccountPreferences;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  accountStatus: string;
  createdAt: string;
  updatedAt: string;
  legacyLink: { legacyProfileId: string; status: string } | null;
}

const ALLOWED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Reject a payload whose magic bytes do not match the declared image type. */
function sniffImageType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export class AccountService {
  constructor(
    private readonly env: Env,
    private readonly db: DataLayer,
    private readonly profiles: ProfileStore,
  ) {}

  private get localMode(): boolean {
    return this.env.authMode !== 'supabase';
  }

  /** Local-mode view: everything comes from the SQLite/memory profile row. */
  private localView(profile: Profile): AccountView {
    return {
      id: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      role: profile.role,
      avatarPath: null,
      avatarUrl: profile.avatarUrl ?? null,
      preferences: { notifyInApp: true, notifyEmail: true, productUpdates: false },
      emailVerified: Boolean(profile.emailVerifiedAt),
      emailVerifiedAt: profile.emailVerifiedAt ?? null,
      accountStatus: profile.status ?? 'ACTIVE',
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      legacyLink: null,
    };
  }

  private async localProfile(user: AuthUser): Promise<Profile> {
    const profile = await this.db.auth.findById(user.id);
    if (!profile) throw new AppError('PROFILE_NOT_FOUND', 'Profile not found');
    return profile;
  }

  private async profile(user: AuthUser): Promise<AppProfile> {
    const profile = await this.profiles.byAuthId(user.id);
    if (!profile) throw new AppError('PROFILE_NOT_FOUND', 'Profile not found');
    return profile;
  }

  private async signedAvatar(profile: AppProfile): Promise<string | null> {
    if (!profile.avatarPath) return null;
    const { data, error } = await createServiceClient(this.env)
      .storage.from(this.env.avatarsBucket)
      .createSignedUrl(profile.avatarPath, 60 * 60);
    if (error) return null;
    return data?.signedUrl ?? null;
  }

  private async view(profile: AppProfile): Promise<AccountView> {
    return {
      id: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      role: profile.role,
      avatarPath: profile.avatarPath,
      avatarUrl: await this.signedAvatar(profile),
      preferences: profile.preferences,
      emailVerified: Boolean(profile.emailVerifiedAt),
      emailVerifiedAt: profile.emailVerifiedAt,
      accountStatus: profile.accountStatus,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      legacyLink: await this.profiles.legacyLinkFor(profile.authUserId),
    };
  }

  async me(user: AuthUser): Promise<AccountView> {
    if (this.localMode) return this.localView(await this.localProfile(user));
    return this.view(await this.profile(user));
  }

  /** Display name and notification preferences — the only user-editable fields. */
  async update(
    user: AuthUser,
    patch: { displayName?: string; preferences?: Partial<AccountPreferences> },
    ctx: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<AccountView> {
    if (this.localMode) {
      const updated = await this.db.auth.update(user.id, {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      });
      if (!updated) throw new AppError('PROFILE_NOT_FOUND', 'Profile not found');
      await this.db.activity.append({
        userId: user.id,
        spaceId: null,
        fileId: null,
        action: 'PROFILE_UPDATED',
        metadata: { fields: Object.keys(patch) },
      });
      void ctx;
      return this.localView(updated);
    }
    const profile = await this.profiles.updateOwn(user.id, patch);
    await this.db.auth.update(user.id, { displayName: profile.displayName });
    await this.profiles.recordAudit(user.id, 'PROFILE_UPDATED', { fields: Object.keys(patch) }, ctx);
    return this.view(profile);
  }

  async uploadAvatar(user: AuthUser, buffer: Buffer, contentType: string): Promise<AccountView> {
    if (this.localMode) {
      throw new AppError(
        'CONFIGURATION_REQUIRED',
        'Profile pictures need Supabase Storage. Set AUTH_MODE=supabase and storage keys to enable them.',
      );
    }
    if (!ALLOWED_AVATAR_TYPES.includes(contentType as (typeof ALLOWED_AVATAR_TYPES)[number])) {
      throw new AppError('INVALID_FILE_TYPE', 'Avatar must be a PNG, JPEG, WebP or GIF image');
    }
    if (buffer.length === 0) throw new AppError('VALIDATION_ERROR', 'The uploaded file is empty');
    if (buffer.length > this.env.maxAvatarBytes) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Avatar must be smaller than ${Math.round(this.env.maxAvatarBytes / 1024 / 1024)} MB`,
      );
    }
    const sniffed = sniffImageType(buffer);
    if (sniffed !== contentType) {
      throw new AppError('INVALID_FILE_TYPE', 'File content does not match its declared image type');
    }

    const current = await this.profile(user);
    const client = createServiceClient(this.env);
    const path = `${user.id}/avatar-${Date.now()}.${EXT_BY_TYPE[contentType]}`;

    const { error: uploadError } = await client.storage
      .from(this.env.avatarsBucket)
      .upload(path, buffer, { contentType, upsert: false, cacheControl: '3600' });
    if (uploadError) throw new AppError('STORAGE_ERROR', `Could not store the avatar: ${uploadError.message}`);

    const updated = await this.profiles.setAvatar(user.id, path);
    // Replace, not accumulate: drop the previous object once the new one is live.
    if (current.avatarPath && current.avatarPath !== path) {
      await client.storage.from(this.env.avatarsBucket).remove([current.avatarPath]);
    }
    await this.profiles.recordAudit(user.id, 'AVATAR_UPDATED', { path });
    return this.view(updated);
  }

  async removeAvatar(user: AuthUser): Promise<AccountView> {
    if (this.localMode) return this.localView(await this.localProfile(user));
    const current = await this.profile(user);
    if (current.avatarPath) {
      await createServiceClient(this.env).storage.from(this.env.avatarsBucket).remove([current.avatarPath]);
    }
    const updated = await this.profiles.setAvatar(user.id, null);
    await this.profiles.recordAudit(user.id, 'AVATAR_REMOVED', {});
    return this.view(updated);
  }

  /**
   * Start an email change. Ownership of the NEW address is proven by Supabase's
   * confirmation link; nothing in Postgres changes until that link is followed.
   */
  async requestEmailChange(user: AuthUser, accessToken: string, newEmail: string): Promise<{ pending: string }> {
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw new AppError('VALIDATION_ERROR', 'Enter a valid email address');
    }
    if (email === user.email.toLowerCase()) {
      throw new AppError('VALIDATION_ERROR', 'That is already your email address');
    }
    if (this.localMode) {
      const taken = await this.db.auth.findByEmail(email);
      if (taken && taken.id !== user.id) {
        throw new AppError('EMAIL_ALREADY_REGISTERED', 'That email is already registered');
      }
      const updated = await this.db.auth.updateEmail(user.id, email);
      if (!updated) throw new AppError('EMAIL_ALREADY_REGISTERED', 'That email is already registered');
      // A link sent to the old address must not be able to verify the new one.
      const pendingVerification = await this.db.verificationTokens.findByPurposeAndUserId(
        'email-verification',
        user.id,
      );
      if (pendingVerification) {
        await this.db.verificationTokens.destroy(pendingVerification.id);
      }
      await this.db.activity.append({
        userId: user.id,
        spaceId: null,
        fileId: null,
        action: 'EMAIL_CHANGED',
        metadata: { email },
      });
      void accessToken;
      return { pending: email };
    }

    const taken = await this.profiles.byEmail(email);
    if (taken) throw new AppError('EMAIL_ALREADY_REGISTERED', 'That email is already registered');

    await requestEmailChange(this.env, accessToken, email);
    await this.profiles.recordAudit(user.id, 'EMAIL_CHANGE_REQUESTED', { newEmail: email });
    return { pending: email };
  }

  /** Change the password after proving knowledge of the current one. */
  async changePassword(
    user: AuthUser,
    accessToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (this.localMode) {
      const account = await this.db.auth.getCredentials(user.id);
      if (!account || !verifyPassword(currentPassword, account.passwordHash)) {
        throw new AppError('REAUTH_REQUIRED', 'Your current password is incorrect');
      }
      await this.db.auth.setPasswordHash(user.id, hashPassword(newPassword));
      // A password change is a credential rotation: retire every existing
      // session, exactly like a completed reset. The current token is included
      // so a stolen session cannot outlive the change.
      await this.db.sessions.revokeAllForUser(user.id, new Date().toISOString());
      // A reset link requested before the change must not be able to undo it.
      const pendingReset = await this.db.verificationTokens.findByPurposeAndUserId(
        'password-reset',
        user.id,
      );
      if (pendingReset) await this.db.verificationTokens.destroy(pendingReset.id);
      await this.db.activity.append({
        userId: user.id,
        spaceId: null,
        fileId: null,
        action: 'PASSWORD_CHANGED',
        metadata: { actor: 'self' },
      });
      void accessToken;
      return;
    }
    const profile = await this.profile(user);
    if (!(await verifySupabasePassword(this.env, profile.email, currentPassword))) {
      throw new AppError('REAUTH_REQUIRED', 'Your current password is incorrect');
    }
    await updatePassword(this.env, accessToken, newPassword);
    await this.profiles.recordAudit(user.id, 'PASSWORD_CHANGED', {});
  }

  /**
   * Personal data export. Contains only data the user is entitled to, and never
   * credentials, tokens or verification secrets.
   */
  async export(user: AuthUser): Promise<Record<string, unknown>> {
    if (this.localMode) return this.localExport(user);
    const profile = await this.profile(user);
    const spaces = await this.db.spaces.list();
    const memberships = await this.db.members.listForUser(user.id);
    const owned = spaces.filter((s) => s.ownerId === user.id);
    const memberOf = [];
    for (const m of memberships) {
      const space = spaces.find((s) => s.id === m.spaceId);
      memberOf.push({ spaceId: m.spaceId, spaceName: space?.name ?? null, role: m.role, status: m.status, joinedAt: m.joinedAt });
    }
    const activity = await this.db.activity.listAll(1000);
    const notifications = await this.db.notifications.listForUser(user.id);

    return {
      exportVersion: 1,
      generatedAt: new Date().toISOString(),
      account: {
        id: profile.id,
        email: profile.email,
        displayName: profile.displayName,
        role: profile.role,
        preferences: profile.preferences,
        emailVerifiedAt: profile.emailVerifiedAt,
        accountStatus: profile.accountStatus,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      },
      ownedSpaces: owned.map((s) => ({
        id: s.id,
        name: s.name,
        purpose: s.purpose,
        description: s.description,
        status: s.status,
        startAt: s.startAt,
        expiryAt: s.expiryAt,
        createdAt: s.createdAt,
      })),
      memberships: memberOf,
      activity: activity.filter((a) => a.userId === user.id),
      notifications: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        createdAt: n.createdAt,
        readAt: n.readAt,
      })),
      accountAudit: await this.profiles.auditFor(user.id, 200),
    };
  }

  /** Personal data export in local-auth mode. */
  private async localExport(user: AuthUser): Promise<Record<string, unknown>> {
    const profile = await this.localProfile(user);
    const spaces = await this.db.spaces.list();
    const memberships = await this.db.members.listForUser(user.id);
    const owned = spaces.filter((s) => s.ownerId === user.id);
    const memberOf = memberships.map((m) => {
      const space = spaces.find((s) => s.id === m.spaceId);
      return {
        spaceId: m.spaceId,
        spaceName: space?.name ?? null,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt,
      };
    });
    const notifications = await this.db.notifications.listForUser(user.id);
    const activity = (await this.db.activity.listAll(1000)).filter((a) => a.userId === user.id);

    return {
      exportVersion: 1,
      generatedAt: new Date().toISOString(),
      account: {
        id: profile.id,
        email: profile.email,
        displayName: profile.displayName,
        role: profile.role,
        emailVerifiedAt: profile.emailVerifiedAt ?? null,
        accountStatus: profile.status ?? 'ACTIVE',
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      },
      ownedSpaces: owned.map((s) => ({
        id: s.id,
        name: s.name,
        purpose: s.purpose,
        description: s.description,
        status: s.status,
        startAt: s.startAt,
        expiryAt: s.expiryAt,
        createdAt: s.createdAt,
      })),
      memberships: memberOf,
      activity,
      notifications: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        createdAt: n.createdAt,
        readAt: n.readAt,
      })),
    };
  }

  /**
   * Delete the account.
   *
   * Refuses while the user owns Spaces that still have other active members:
   * deleting those would destroy other people's access. Every other owned Space
   * is soft-deleted, memberships are revoked, the avatar object is removed, and
   * finally the Supabase auth user is deleted (which revokes all sessions and
   * cascades the profile row).
   */
  async deleteAccount(user: AuthUser, accessToken: string, password: string): Promise<void> {
    if (this.localMode) {
      const account = await this.db.auth.getCredentials(user.id);
      if (!account || !verifyPassword(password, account.passwordHash)) {
        throw new AppError('REAUTH_REQUIRED', 'Your password is incorrect');
      }
      const owned = (await this.db.spaces.list()).filter(
        (s) => s.ownerId === user.id && s.status !== 'DELETED',
      );
      const shared: string[] = [];
      for (const space of owned) {
        const others = (await this.db.members.listForSpace(space.id)).filter(
          (m) => m.userId !== user.id && m.status === 'ACTIVE',
        );
        if (others.length > 0) shared.push(space.name);
      }
      if (shared.length) {
        throw new AppError(
          'OWNED_SPACES_SHARED',
          `Transfer or delete these Spaces first, they still have other members: ${shared.join(', ')}`,
        );
      }
      for (const membership of await this.db.members.listForUser(user.id)) {
        if (membership.status === 'ACTIVE') {
          await this.db.members.update(membership.spaceId, user.id, {
            status: 'REVOKED',
            revokedAt: new Date().toISOString(),
          });
        }
      }
      for (const space of owned) await this.db.spaces.update(space.id, { status: 'DELETED' });
      await this.db.auth.delete(user.id);
      void accessToken;
      return;
    }
    const profile = await this.profile(user);
    if (!(await verifySupabasePassword(this.env, profile.email, password))) {
      throw new AppError('REAUTH_REQUIRED', 'Your password is incorrect');
    }

    const spaces = await this.db.spaces.list();
    const owned = spaces.filter((s) => s.ownerId === user.id && s.status !== 'DELETED');
    const shared: string[] = [];
    for (const space of owned) {
      const others = (await this.db.members.listForSpace(space.id)).filter(
        (m) => m.userId !== user.id && m.status === 'ACTIVE',
      );
      if (others.length > 0) shared.push(space.name);
    }
    if (shared.length) {
      throw new AppError(
        'OWNED_SPACES_SHARED',
        `Transfer or delete these Spaces first, they still have other members: ${shared.join(', ')}`,
      );
    }

    // Local cleanup first: if Supabase succeeds but this fails we still have an
    // authenticated user able to retry, which is the safer order.
    for (const membership of await this.db.members.listForUser(user.id)) {
      if (membership.status === 'ACTIVE') {
        await this.db.members.update(membership.spaceId, user.id, {
          status: 'REVOKED',
          revokedAt: new Date().toISOString(),
        });
      }
    }
    for (const space of owned) {
      await this.db.spaces.update(space.id, { status: 'DELETED' });
    }

    if (profile.avatarPath) {
      await createServiceClient(this.env).storage.from(this.env.avatarsBucket).remove([profile.avatarPath]);
    }

    await deleteAuthUser(this.env, user.id);
    // The FK cascade removes the profile row; the local mirror stays for
    // referential integrity of archives and activity history.
    await this.profiles.deleteOwn(user.id).catch(() => undefined);
    void accessToken;
  }

  /**
   * Link an existing FlashSpace (SQLite) account to this Supabase identity.
   *
   * Both sides must be proven: the Supabase email must be verified, and the
   * caller must present the legacy account's password. A link only records the
   * mapping — moving Space ownership stays an explicit, verifiable migration so
   * a mistyped address can never silently capture someone else's data.
   */
  async linkLegacyAccount(
    user: AuthUser,
    accessToken: string,
    input: { email: string; password: string },
  ): Promise<{ linked: true; legacyProfileId: string }> {
    if (this.localMode) {
      throw new AppError('CONFIGURATION_REQUIRED', 'Account linking is only available with Supabase Auth');
    }
    const profile = await this.profile(user);
    if (!profile.emailVerifiedAt) {
      throw new AppError(
        'EMAIL_NOT_VERIFIED',
        'Verify your email address before linking an existing account',
      );
    }
    const email = input.email.trim().toLowerCase();
    if (email !== profile.email) {
      throw new AppError('VALIDATION_ERROR', 'The legacy account email must match your verified email');
    }
    const legacy = await this.db.auth.findByEmail(email);
    if (!legacy) throw new AppError('LEGACY_ACCOUNT_NOT_FOUND', 'No FlashSpace account uses that email');
    if (legacy.id === user.id) {
      throw new AppError('VALIDATION_ERROR', 'This Supabase account is already the application account');
    }
    const credentials = await this.db.auth.getCredentials(legacy.id);
    if (!credentials) {
      throw new AppError('LEGACY_ACCOUNT_NOT_FOUND', 'That account has no local credentials to verify');
    }
    const { verifyPassword: verifyLegacyHash } = await import('../utils/password.js');
    if (!verifyLegacyHash(input.password, credentials.passwordHash)) {
      throw new AppError('REAUTH_REQUIRED', 'The existing account password is incorrect');
    }

    const tokenHash = createHash('sha256')
      .update(`${user.id}:${legacy.id}:${randomBytes(16).toString('hex')}`)
      .digest('hex');
    await this.profiles.createLegacyLink({
      authUserId: user.id,
      legacyProfileId: legacy.id,
      legacyEmail: email,
      tokenHash,
    });
    await this.profiles.recordAudit(user.id, 'LEGACY_ACCOUNT_LINKED', { legacyProfileId: legacy.id });
    void accessToken;
    return { linked: true, legacyProfileId: legacy.id };
  }
}
