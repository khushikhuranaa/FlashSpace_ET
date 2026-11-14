/** Password strength — mirrors apps/api/src/utils/password-policy.ts. */

export const PASSWORD_MIN_LENGTH = 8;

export interface StrengthResult {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  /** 0–100, for the meter width. */
  percent: number;
  problems: string[];
}

export function passwordStrength(password: string, email = ''): StrengthResult {
  const value = password ?? '';
  const problems: string[] = [];

  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasDigit = /\d/.test(value);
  const hasSymbol = /[^A-Za-z0-9]/.test(value);

  if (value.length < PASSWORD_MIN_LENGTH) problems.push(`At least ${PASSWORD_MIN_LENGTH} characters`);
  if (value.length > 72) problems.push('72 characters or fewer');
  if (value.length > 0 && (!/[A-Za-z]/.test(value) || !hasDigit)) {
    problems.push('At least one letter and one number');
  }
  if (email && value.toLowerCase() === email.toLowerCase()) problems.push('Cannot match your email');

  let score = 0;
  if (value.length >= PASSWORD_MIN_LENGTH && /[A-Za-z]/.test(value) && hasDigit) score = 1;
  if (score === 1 && value.length >= 10) score = 2;
  if (score >= 2 && hasLower && hasUpper && hasDigit) score = 3;
  if (score === 3 && value.length >= 14 && hasSymbol) score = 4;

  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  return {
    score: score as StrengthResult['score'],
    label: value ? labels[score]! : '',
    percent: value ? [12, 30, 55, 80, 100][score]! : 0,
    problems,
  };
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}
