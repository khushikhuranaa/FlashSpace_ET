/**
 * Password policy shared by the API and mirrored in the web form hints.
 * Supabase Auth enforces its own minimum on the server; these rules are the
 * product-level baseline so the failure is explained before the request.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

export interface PasswordCheck {
  ok: boolean;
  message?: string;
  score: 0 | 1 | 2 | 3 | 4;
}

export function checkPassword(password: string, email?: string): PasswordCheck {
  const value = password ?? '';
  let score: 0 | 1 | 2 | 3 | 4 = 0;
  if (value.length >= PASSWORD_MIN_LENGTH) score = 1;
  if (value.length >= 12) score = 2;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)) score = score === 2 ? 3 : Math.max(score, 2) as 0 | 1 | 2 | 3;
  if (value.length >= 14 && /[^A-Za-z0-9]/.test(value)) score = 4;

  if (value.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`, score };
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, message: `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer`, score };
  }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return { ok: false, message: 'Password must contain at least one letter and one number', score };
  }
  if (email && value.toLowerCase() === email.toLowerCase()) {
    return { ok: false, message: 'Password cannot be the same as your email address', score };
  }
  return { ok: true, score };
}

export function assertValidPassword(password: unknown, email?: string): string {
  if (typeof password !== 'string') {
    throw Object.assign(new Error('Password is required'), { code: 'VALIDATION_ERROR' });
  }
  const check = checkPassword(password, email);
  if (!check.ok) {
    throw Object.assign(new Error(check.message ?? 'Invalid password'), { code: 'VALIDATION_ERROR' });
  }
  return password;
}
