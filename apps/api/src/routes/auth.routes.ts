import { Router, type Request, type Response } from 'express';
import { AppError } from '@flashspace/shared';
import type { Env } from '../config/env.js';
import type { AuthService } from '../services/auth.service.js';
import type { TokenVerifier } from '../services/identity.service.js';
import type { EmailService, VerificationTokensService } from '../services/email.service.js';
import { asyncHandler, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  loginSchema,
  profilePatchSchema,
  registerSchema,
  resetConfirmSchema,
  resetRequestSchema,
  tokenParamSchema,
} from '../validation/schemas.js';
import { hasServiceRole, hasSupabaseConfig } from '../supabase/clients.js';

/**
 * Authentication routes.
 *
 * In `local` mode (development / tests / offline demo) the API owns sign-up and
 * sign-in with scrypt hashes. In `supabase` mode Supabase Auth owns every
 * credential operation performed by the browser, so those two endpoints are
 * disabled here on purpose — there is no second way to create an account.
 */
function authContext(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
}

function bearerToken(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

export function authRoutes(
  authService: AuthService,
  identity: TokenVerifier,
  env: Env,
  email: EmailService,
  verificationTokens: VerificationTokensService,
): Router {
  const router = Router();
  const supabaseMode = env.authMode === 'supabase';

  // Module 9: email verification / password reset are always available in
  // local mode. In Supabase mode these are delegated to the client-side flow
  // (Supabase Auth sends its own emails), but we still expose the endpoints
  // so the app never has to branch on provider for token verification.
  const emailVerificationSupplied = env.emailVerificationMode !== false;
  const passwordResetSupplied = env.passwordResetMode !== false;

  // Public: lets the web client (and operators) see which provider is active
  // without exposing any key material.
  router.get('/auth/config', (_req: Request, res: Response) => {
    res.json({
      mode: env.authMode,
      localAuthEnabled: !supabaseMode,
      supabase: {
        configured: supabaseMode ? hasSupabaseConfig(env) && hasServiceRole(env) : false,
        projectUrl: supabaseMode ? env.supabaseUrl : null,
      },
      features: {
        emailVerification: emailVerificationSupplied,
        passwordRecovery: passwordResetSupplied,
        cloudProfiles: supabaseMode,
        avatarStorage: supabaseMode,
        // TOTP is available whenever Supabase Auth is the provider: the browser
        // enrols/challenges through the SDK and this API only verifies the
        // resulting AAL2 session token.
        mfa: supabaseMode && hasSupabaseConfig(env),
      },
    });
  });

  if (supabaseMode) {
    const handledBySupabase = (operation: string) =>
      asyncHandler(async () => {
        throw new AppError(
          'AUTH_PROVIDER_SUPABASE',
          `${operation} is handled by Supabase Auth in the client; the API only verifies sessions in this mode`,
        );
      });
    router.post('/auth/register', handledBySupabase('Registration'));
    router.post('/auth/login', handledBySupabase('Sign in'));
  } else {
    router.post(
      '/auth/register',
      validateBody(registerSchema),
      asyncHandler(async (req: Request, res: Response) => {
        const { email, password, displayName } = req.body as Record<string, unknown>;
        if (typeof email !== 'string' || typeof password !== 'string' || password.length < 8) {
          throw new AppError('VALIDATION_ERROR', 'email and password (min 8 chars) are required');
        }
        const result = await authService.register(
          email.toLowerCase(),
          password,
          typeof displayName === 'string' && displayName.trim() ? displayName.trim() : email.split('@')[0]!,
          authContext(req),
        );
        res.status(201).json(result);
      }),
    );

    router.post(
      '/auth/login',
      validateBody(loginSchema),
      asyncHandler(async (req: Request, res: Response) => {
        const { email, password } = req.body as Record<string, unknown>;
        if (typeof email !== 'string' || typeof password !== 'string') {
          throw new AppError('VALIDATION_ERROR', 'email and password are required');
        }
        res.json(await authService.login(email.toLowerCase(), password, authContext(req)));
      }),
    );
  }

  // ---- Session lifecycle (local auth) ------------------------------------
  // Rotation is per-session: the refresh token is single-use, and replaying a
  // rotated token revokes every session for the account.
  router.post(
    '/auth/refresh',
    asyncHandler(async (req: Request, res: Response) => {
      const { refreshToken } = req.body as { refreshToken?: unknown };
      if (typeof refreshToken !== 'string' || !refreshToken) {
        throw new AppError('VALIDATION_ERROR', 'refreshToken is required');
      }
      res.json(await authService.refresh(refreshToken, authContext(req)));
    }),
  );

  router.post(
    '/auth/logout',
    requireAuth(identity),
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = authService.sessionIdFromToken(bearerToken(req));
      if (sessionId) await authService.logout(sessionId);
      res.status(204).end();
    }),
  );

  router.post(
    '/auth/logout-all',
    requireAuth(identity),
    asyncHandler(async (req: Request, res: Response) => {
      const revoked = await authService.logoutAll(req.user!.id);
      res.json({ revoked });
    }),
  );

  router.get(
    '/auth/sessions',
    requireAuth(identity),
    asyncHandler(async (req: Request, res: Response) => {
      const current = authService.sessionIdFromToken(bearerToken(req));
      res.json({ sessions: await authService.listSessions(req.user!.id, current) });
    }),
  );

  router.delete(
    '/auth/sessions/:sessionId',
    requireAuth(identity),
    asyncHandler(async (req: Request, res: Response) => {
      const { sessionId } = req.params;
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new AppError('VALIDATION_ERROR', 'sessionId is required');
      }
      await authService.revokeSession(req.user!.id, sessionId);
      res.status(204).end();
    }),
  );

  router.get(
    '/auth/me',
    requireAuth(identity),
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ user: await authService.me(req.user!.id) });
    }),
  );

  router.patch(
    '/auth/me',
    requireAuth(identity),
    validateBody(profilePatchSchema),
    asyncHandler(async (req: Request, res: Response) => {
      if (supabaseMode) {
        throw new AppError(
          'AUTH_PROVIDER_SUPABASE',
          'Profile updates go through PATCH /users/me so Auth and Postgres stay in sync',
        );
      }
      const { displayName, avatarUrl } = req.body as Record<string, unknown>;
      res.json({
        user: await authService.updateProfile(req.user!.id, {
          ...(typeof displayName === 'string' ? { displayName } : {}),
          ...(avatarUrl === null || typeof avatarUrl === 'string' ? { avatarUrl } : {}),
        }),
      });
    }),
  );

  // ---- Module 9: email verification --------------------------------------

  if (emailVerificationSupplied && !supabaseMode) {
    router.post(
      '/auth/verify-email/request',
      requireAuth(identity),
      asyncHandler(async (req: Request, res: Response) => {
        const userId = req.user!.id;
        const profile = await authService.me(userId);
        const tokenResult = await verificationTokens.issueEmailVerificationToken(userId);
        await email.sendVerificationEmail(profile.email, profile.displayName, tokenResult.token);
        // The token is shown once here; the actual verification happens via the
        // link in the email. Never echo the raw token in logs.
        res.json({
          ok: true,
          message: 'Verification email sent. Please check your inbox.',
          expiresInHours: Math.round((new Date(tokenResult.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60)),
        });
      }),
    );

    router.post(
      '/auth/verify-email/:token',
      validateParams(tokenParamSchema),
      asyncHandler(async (req: Request, res: Response) => {
        const { token } = req.params;
        if (typeof token !== 'string' || !token) {
          throw new AppError('VALIDATION_ERROR', 'Invalid token');
        }
        const result = await verificationTokens.verifyEmailToken(token);
        if (!result) {
          throw new AppError('VALIDATION_ERROR', 'Invalid, expired, or already used verification token');
        }
        await authService.markEmailVerified(result.userId);
        res.json({ ok: true, message: 'Email verified successfully.' });
      }),
    );
  } else if (supabaseMode) {
    // In Supabase mode, email verification is owned by Supabase; keep the
    // endpoints present but explain that the client should use the Supabase
    // flow. Do NOT throw here — the frontend still hits these during login.
    router.post('/auth/verify-email/request', asyncHandler(async (_req: Request, res: Response) => {
      res.json({ ok: true, message: 'Email verification is managed by Supabase Auth.' });
    }));
    router.post('/auth/verify-email/:token', asyncHandler(async (_req: Request, res: Response) => {
      res.json({ ok: true, message: 'Email verification is managed by Supabase Auth.' });
    }));
  }

  // ---- Module 9: password reset ------------------------------------------

  if (passwordResetSupplied && !supabaseMode) {
    router.post(
      '/auth/reset-password/request',
      validateBody(resetRequestSchema),
      asyncHandler(async (req: Request, res: Response) => {
        const { email: emailAddr } = req.body as Record<string, unknown>;
        if (typeof emailAddr !== 'string' || !emailAddr) {
          throw new AppError('VALIDATION_ERROR', 'Email is required');
        }
        // Prevent account enumeration: always return the same response.
        const profile = await authService.findByEmail(emailAddr.toLowerCase());
        if (profile) {
          const tokenResult = await verificationTokens.issuePasswordResetToken(profile.id);
          await email.sendPasswordResetEmail(profile.email, profile.displayName, tokenResult.token);
        }
        res.json({ ok: true, message: 'If that email is registered, a password reset link has been sent.' });
      }),
    );

    router.post(
      '/auth/reset-password/confirm',
      validateBody(resetConfirmSchema),
      asyncHandler(async (req: Request, res: Response) => {
        const { token, newPassword } = req.body as Record<string, unknown>;
        if (typeof token !== 'string' || !token) {
          throw new AppError('VALIDATION_ERROR', 'Token is required');
        }
        if (typeof newPassword !== 'string' || newPassword.length < 8) {
          throw new AppError('VALIDATION_ERROR', 'Password must be at least 8 characters');
        }
        const result = await verificationTokens.verifyPasswordResetToken(token);
        if (!result) {
          throw new AppError('VALIDATION_ERROR', 'Invalid, expired, or already used reset token');
        }
        await authService.resetPassword(result.userId, newPassword);
        // Invalidate any email verification token for this user, since the
        // password changed (security best-practice).
        await verificationTokens.invalidateEmailVerificationToken(result.userId);
        res.json({ ok: true, message: 'Password reset successfully.' });
      }),
    );
  } else if (supabaseMode) {
    // In Supabase mode, password reset is owned by Supabase; keep endpoints
    // present and explain delegation.
    router.post('/auth/reset-password/request', asyncHandler(async (_req: Request, res: Response) => {
      res.json({ ok: true, message: 'Password reset is managed by Supabase Auth.' });
    }));
    router.post('/auth/reset-password/confirm', asyncHandler(async (_req: Request, res: Response) => {
      res.json({ ok: true, message: 'Password reset is managed by Supabase Auth.' });
    }));
  }

  return router;
}
