import type { AuthUser, Profile } from '@flashspace/shared';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import { signJwt, verifyJwt } from '../utils/jwt.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import type { AuthRepo } from '../repositories/data-layer.interface.js';

export interface AuthResult {
  user: AuthUser;
  token: string;
  expiresAt: string;
}

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export class AuthService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthRepo,
  ) {}

  private toAuthUser(p: Profile): AuthUser {
    return { id: p.id, email: p.email, displayName: p.displayName, role: p.role };
  }

  async register(email: string, password: string, displayName: string): Promise<AuthResult> {
    const existing = this.auth.findByEmail(email);
    if (existing) throw new AppError('EMAIL_ALREADY_REGISTERED', 'That email is already registered');
    const firstUser = this.auth.count() === 0;
    const profile: Profile = {
      id: crypto.randomUUID(),
      email: email.toLowerCase(),
      displayName,
      role: firstUser ? 'ADMIN' : 'USER',
      avatarUrl: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.auth.create(profile, hashPassword(password));
    return this.issueToken(profile);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const account = this.auth.getCredentials(this.auth.findByEmail(email)?.id ?? '');
    const profile = this.auth.findByEmail(email);
    if (!account || !profile || !verifyPassword(password, account.passwordHash)) {
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password');
    }
    return this.issueToken(profile);
  }

  async me(userId: string): Promise<AuthUser> {
    const profile = this.auth.findById(userId);
    if (!profile) throw new AppError('UNAUTHENTICATED', 'User no longer exists');
    return this.toAuthUser(profile);
  }

  async updateProfile(
    userId: string,
    patch: { displayName?: string; avatarUrl?: string | null },
  ): Promise<AuthUser> {
    const profile = this.auth.update(userId, patch);
    if (!profile) throw new AppError('NOT_FOUND', 'User not found');
    return this.toAuthUser(profile);
  }

  async verifyToken(token: string): Promise<AuthUser> {
    const payload = verifyJwt(token, this.env.localAuthSecret);
    if (!payload) throw new AppError('UNAUTHENTICATED', 'Invalid or expired session token');
    return this.me(payload.sub);
  }

  private issueToken(profile: Profile): AuthResult {
    const token = signJwt({ sub: profile.id, email: profile.email }, this.env.localAuthSecret, TOKEN_TTL_SECONDS);
    return {
      user: this.toAuthUser(profile),
      token,
      expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
    };
  }
}
