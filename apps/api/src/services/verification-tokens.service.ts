/**
 * Verification tokens — hashed, single-use, time-boxed tokens for:
 *  - Email verification (account onboarding)
 *  - Password reset (account recovery)
 *
 * Tokens are stored as SHA-256 hashes only. Raw tokens are never written to
 * the database and are only ever shown once — in the email link or the API
 * response that creates them.
 *
 * This is intentionally provider-independent and separate from the email
 * transport layer so that the same token model can back an SMTP flow, a mock
 * flow, or future provider swaps without reshaping token storage.
 */

import crypto from 'node:crypto';
import type { DataLayer } from '../repositories/data-layer.interface.js';

// ---------------------------------------------------------------------------
// Generic hashed-token store
// ---------------------------------------------------------------------------

export interface HashedTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  purpose: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface VerificationTokensRepo {
  insert(row: HashedTokenRow): HashedTokenRow;
  findByPurposeAndUserId(purpose: string, userId: string): HashedTokenRow | undefined;
  findByTokenHash(tokenHash: string, purpose: string): HashedTokenRow | undefined;
  markUsed(id: string): HashedTokenRow | undefined;
  destroy(id: string): boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type TokenPurpose = 'email-verification' | 'password-reset';

export interface VerifyEmailToken {
  token: string; // raw token, shown once to the caller
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface PasswordResetToken {
  token: string; // raw token, shown once to the caller
  userId: string;
  createdAt: string;
  expiresAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class VerificationTokensService {
  private readonly dl: DataLayer;
  private readonly emailExpiryMs: number;
  private readonly resetExpiryMs: number;

  constructor(
    dl: DataLayer,
    emailExpiryMs = 24 * 60 * 60 * 1000,
    resetExpiryMs = 60 * 60 * 1000,
  ) {
    this.dl = dl;
    this.emailExpiryMs = emailExpiryMs;
    this.resetExpiryMs = resetExpiryMs;
  }

  // ---- Email verification -------------------------------------------------

  async issueEmailVerificationToken(userId: string): Promise<VerifyEmailToken> {
    // Only the newest verification link stays valid. This prevents an old
    // mailbox copy from remaining usable after a duplicate request.
    await this.invalidateEmailVerificationToken(userId);
    const raw = createToken();
    const now = new Date();
    const row: HashedTokenRow = {
      id: crypto.randomUUID(),
      userId,
      tokenHash: hashToken(raw),
      purpose: 'email-verification',
      expiresAt: new Date(now.getTime() + this.emailExpiryMs).toISOString(),
      usedAt: null,
      createdAt: nowIso(),
    };
    await this.dl.verificationTokens.insert(row);
    return {
      token: raw,
      userId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  async verifyEmailToken(rawToken: string): Promise<VerifyEmailToken | null> {
    const hash = hashToken(rawToken);
    const row = await this.dl.verificationTokens.findByTokenHash(hash, 'email-verification');
    if (!row) return null;
    if (new Date(row.expiresAt) < new Date()) {
      // Expired — consume it so it cannot be reused after expiry either.
      await this.dl.verificationTokens.markUsed(row.id);
      return null;
    }
    if (row.usedAt) {
      return null;
    }
    // Consume token now (single use).
    const updated = await this.dl.verificationTokens.markUsed(row.id);
    if (!updated) return null;
    return {
      token: rawToken,
      userId: updated.userId,
      createdAt: updated.createdAt,
      expiresAt: updated.expiresAt,
    };
  }

  /** Invalidate any outstanding email verification token for a user. */
  async invalidateEmailVerificationToken(userId: string): Promise<boolean> {
    const row = await this.dl.verificationTokens.findByPurposeAndUserId('email-verification', userId);
    if (!row) return false;
    return await this.dl.verificationTokens.destroy(row.id);
  }

  // ---- Password reset ------------------------------------------------------

  async issuePasswordResetToken(userId: string): Promise<PasswordResetToken> {
    const raw = createToken();
    const now = new Date();
    const row: HashedTokenRow = {
      id: crypto.randomUUID(),
      userId,
      tokenHash: hashToken(raw),
      purpose: 'password-reset',
      expiresAt: new Date(now.getTime() + this.resetExpiryMs).toISOString(),
      usedAt: null,
      createdAt: nowIso(),
    };
    // Rotate before inserting so the lookup cannot return the new row itself.
    const prior = await this.dl.verificationTokens.findByPurposeAndUserId('password-reset', userId);
    if (prior) await this.dl.verificationTokens.destroy(prior.id);
    await this.dl.verificationTokens.insert(row);
    return {
      token: raw,
      userId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  async verifyPasswordResetToken(rawToken: string): Promise<PasswordResetToken | null> {
    const hash = hashToken(rawToken);
    const row = await this.dl.verificationTokens.findByTokenHash(hash, 'password-reset');
    if (!row) return null;
    if (new Date(row.expiresAt) < new Date()) {
      await this.dl.verificationTokens.markUsed(row.id);
      return null;
    }
    if (row.usedAt) {
      return null;
    }
    const updated = await this.dl.verificationTokens.markUsed(row.id);
    if (!updated) return null;
    return {
      token: rawToken,
      userId: updated.userId,
      createdAt: updated.createdAt,
      expiresAt: updated.expiresAt,
    };
  }
}
