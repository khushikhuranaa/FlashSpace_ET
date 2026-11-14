import { createHash, randomBytes } from 'node:crypto';
import type { AuthUser, Profile } from '@flashspace/shared';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import { signJwt, verifyJwt } from '../utils/jwt.js';
import { hashPassword, needsRehash, verifyPassword } from '../utils/password.js';
import type { AuthRepo, AuthSession, SessionsRepo } from '../repositories/data-layer.interface.js';

/** Access tokens are deliberately short-lived; sessions live on refresh tokens. */
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Refresh 15s before expiry so a slow request never races the clock. */
const ACCESS_REFRESH_SKEW_SECONDS = 15;

export interface AuthResult {
  user: AuthUser;
  token: string;
  expiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  sessionId: string;
}

export interface SessionView {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  current: boolean;
  userAgent: string | null;
  ip: string | null;
}

export interface AuthContext {
  userAgent?: string | null;
  ip?: string | null;
}

export class AuthService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthRepo,
    private readonly sessions: SessionsRepo,
  ) {}

  private toAuthUser(p: Profile): AuthUser {
    return {
      id: p.id,
      email: p.email,
      displayName: p.displayName,
      role: p.role,
      emailVerifiedAt: p.emailVerifiedAt ?? null,
    };
  }

  async register(
    email: string,
    password: string,
    displayName: string,
    ctx: AuthContext = {},
  ): Promise<AuthResult> {
    const existing = await this.auth.findByEmail(email);
    if (existing) throw new AppError('EMAIL_ALREADY_REGISTERED', 'That email is already registered');
    const firstUser = (await this.auth.count()) === 0;
    const profile: Profile = {
      id: crypto.randomUUID(),
      email: email.toLowerCase(),
      displayName,
      role: firstUser ? 'ADMIN' : 'USER',
      avatarUrl: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.auth.create(profile, hashPassword(password));
    return this.startSession(profile, ctx);
  }

  /**
   * Module 11: a suspended account cannot authenticate or keep using a token.
   * `me()` is called on every authenticated request, so flipping the profile
   * status invalidates existing sessions without needing a token blacklist.
   */
  private assertActive(profile: Profile): void {
    if ((profile.status ?? 'ACTIVE') === 'SUSPENDED') {
      throw new AppError(
        'ACCOUNT_SUSPENDED',
        profile.suspensionReason
          ? `This account is suspended: ${profile.suspensionReason}`
          : 'This account is suspended. Contact an administrator.',
      );
    }
  }

  async login(email: string, password: string, ctx: AuthContext = {}): Promise<AuthResult> {
    const profile = await this.auth.findByEmail(email);
    const account = profile ? await this.auth.getCredentials(profile.id) : undefined;
    if (!profile || !account || !verifyPassword(password, account.passwordHash)) {
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password');
    }
    this.assertActive(profile);
    // Transparent upgrade: legacy or weaker hashes are re-hashed with the
    // current cost after the password has been proven correct.
    if (needsRehash(account.passwordHash)) {
      await this.auth.setPasswordHash(profile.id, hashPassword(password));
    }
    const at = new Date().toISOString();
    await this.auth.touchLastActive(profile.id, at);
    return this.startSession({ ...profile, lastActiveAt: at }, ctx);
  }

  async me(userId: string): Promise<AuthUser> {
    const profile = await this.auth.findById(userId);
    if (!profile) throw new AppError('UNAUTHENTICATED', 'User no longer exists');
    this.assertActive(profile);
    return this.toAuthUser(profile);
  }

  async updateProfile(
    userId: string,
    patch: { displayName?: string; avatarUrl?: string | null },
  ): Promise<AuthUser> {
    const profile = await this.auth.update(userId, patch);
    if (!profile) throw new AppError('NOT_FOUND', 'User not found');
    return this.toAuthUser(profile);
  }

  /** Module 9: mark the authenticated user's email as verified. */
  async markEmailVerified(userId: string): Promise<void> {
    const profile = await this.auth.findById(userId);
    if (!profile) throw new AppError('NOT_FOUND', 'User not found');
    await this.auth.markEmailVerified(userId, new Date().toISOString());
  }

  /** Module 9: find a profile by email (low-level, for token flows). */
  async findByEmail(email: string): Promise<Profile | undefined> {
    return this.auth.findByEmail(email);
  }

  /** Module 9: reset a user's password (after token validation). */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    const profile = await this.auth.findById(userId);
    if (!profile) throw new AppError('NOT_FOUND', 'User not found');
    await this.auth.setPasswordHash(userId, hashPassword(newPassword));
    // A reset is a security event: every existing session must be re-earned.
    await this.sessions.revokeAllForUser(userId, new Date().toISOString());
  }

  // ---- sessions -----------------------------------------------------------

  private hashRefresh(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async startSession(profile: Profile, ctx: AuthContext): Promise<AuthResult> {
    const now = Date.now();
    const refreshToken = randomBytes(32).toString('base64url');
    const session: AuthSession = {
      id: crypto.randomUUID(),
      userId: profile.id,
      refreshTokenHash: this.hashRefresh(refreshToken),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + REFRESH_TTL_MS).toISOString(),
      revokedAt: null,
      lastUsedAt: new Date(now).toISOString(),
      userAgent: ctx.userAgent ?? null,
      ip: ctx.ip ?? null,
    };
    await this.sessions.insert(session);
    return this.sessionResult(profile, session, refreshToken);
  }

  /** Sign an access token bound to the session that owns it. */
  private sessionResult(profile: Profile, session: AuthSession, refreshToken: string): AuthResult {
    const token = signJwt(
      { sub: profile.id, email: profile.email },
      this.env.localAuthSecret,
      ACCESS_TTL_SECONDS,
      { sid: session.id },
    );
    return {
      user: this.toAuthUser(profile),
      token,
      expiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000).toISOString(),
      refreshToken,
      refreshExpiresAt: session.expiresAt,
      sessionId: session.id,
    };
  }

  /**
   * Rotate a refresh token. Reusing a token that was already rotated is treated
   * as theft: every session for that account is revoked immediately.
   */
  async refresh(rawToken: string, ctx: AuthContext = {}): Promise<AuthResult> {
    if (typeof rawToken !== 'string' || rawToken.length < 20) {
      throw new AppError('REFRESH_TOKEN_INVALID', 'This session is no longer valid');
    }
    const hash = this.hashRefresh(rawToken);
    const session = await this.sessions.findByRefreshHash(hash);
    if (!session) throw new AppError('REFRESH_TOKEN_INVALID', 'This session is no longer valid');
    if (session.revokedAt) {
      await this.sessions.revokeAllForUser(session.userId, new Date().toISOString());
      throw new AppError('REFRESH_TOKEN_REUSED', 'Session reuse detected — please sign in again');
    }
    if (new Date(session.expiresAt) <= new Date()) {
      await this.sessions.update(session.id, { revokedAt: new Date().toISOString() });
      throw new AppError('SESSION_EXPIRED', 'Your session has expired — please sign in again');
    }
    const profile = await this.auth.findById(session.userId);
    if (!profile) throw new AppError('UNAUTHENTICATED', 'User no longer exists');
    this.assertActive(profile);

    // Rotate: the presented token is retired before the replacement is issued.
    await this.sessions.update(session.id, { revokedAt: new Date().toISOString() });
    const next = await this.startSession(profile, {
      userAgent: ctx.userAgent ?? session.userAgent,
      ip: ctx.ip ?? session.ip,
    });
    return next;
  }

  /** Session id embedded in a still-valid access token, for logout. */
  sessionIdFromToken(token: string): string | null {
    const payload = verifyJwt(token, this.env.localAuthSecret);
    return typeof payload?.sid === 'string' ? payload.sid : null;
  }

  async logout(sessionId: string): Promise<void> {
    const session = await this.sessions.findById(sessionId);
    if (!session || session.revokedAt) return;
    await this.sessions.update(sessionId, { revokedAt: new Date().toISOString() });
  }

  async logoutAll(userId: string): Promise<number> {
    return this.sessions.revokeAllForUser(userId, new Date().toISOString());
  }

  async listSessions(userId: string, currentSessionId: string | null): Promise<SessionView[]> {
    const rows = await this.sessions.listForUser(userId);
    return rows.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      current: s.id === currentSessionId,
      userAgent: s.userAgent,
      ip: s.ip,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.sessions.findById(sessionId);
    if (!session || session.userId !== userId) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    await this.sessions.update(sessionId, { revokedAt: new Date().toISOString() });
  }

  /**
   * Verify an access token and its session. A token whose session was revoked
   * (logout, password reset, reuse detection) stops working immediately even
   * though its signature is still valid.
   */
  async verifyToken(token: string): Promise<AuthUser> {
    const payload = verifyJwt(token, this.env.localAuthSecret);
    if (!payload) throw new AppError('UNAUTHENTICATED', 'Invalid or expired session token');
    const sessionId = typeof payload.sid === 'string' ? payload.sid : null;
    if (!sessionId) throw new AppError('UNAUTHENTICATED', 'Invalid session token');
    const session = await this.sessions.findById(sessionId);
    if (!session || session.userId !== payload.sub || session.revokedAt) {
      throw new AppError('UNAUTHENTICATED', 'This session has been revoked');
    }
    if (new Date(session.expiresAt) <= new Date()) {
      throw new AppError('UNAUTHENTICATED', 'This session has expired');
    }
    // Cheap housekeeping; no write per request.
    const now = Date.now();
    const last = new Date(session.lastUsedAt).getTime();
    if (now - last > 60_000) {
      await this.sessions.update(session.id, { lastUsedAt: new Date(now).toISOString() });
    }
    return this.me(payload.sub);
  }

  /** Seconds until the access token should be refreshed by the client. */
  static get refreshAfterSeconds(): number {
    return ACCESS_TTL_SECONDS - ACCESS_REFRESH_SKEW_SECONDS;
  }
}
