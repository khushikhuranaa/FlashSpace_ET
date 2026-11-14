import type { Profile, ProfileRole } from '@flashspace/shared';
import type { AuthRepo, LocalAccount, UserPage, UserQuery } from '../data-layer.interface.js';

/**
 * In-memory profile + credential store for the local auth adapter.
 * (In supabase mode, identities live in auth.users and profiles in Postgres.)
 */
export type { LocalAccount };

export class MemoryAuthRepo implements AuthRepo {
  private readonly accounts = new Map<string, LocalAccount>(); // by userId
  private readonly byEmail = new Map<string, string>();

  create(profile: Profile, passwordHash: string): Profile {
    if (this.byEmail.has(profile.email)) {
      throw new Error('EMAIL_ALREADY_REGISTERED');
    }
    const row: Profile = { status: 'ACTIVE', ...profile };
    this.accounts.set(row.id, { profile: row, passwordHash });
    this.byEmail.set(row.email, row.id);
    return row;
  }

  /** Mirror a Supabase-managed identity; no credentials row is created. */
  ensureProfile(profile: Profile): Profile {
    const existing = this.accounts.get(profile.id);
    if (existing) return existing.profile;
    if (this.byEmail.has(profile.email)) throw new Error('EMAIL_ALREADY_REGISTERED');
    const row: Profile = { status: 'ACTIVE', ...profile };
    this.accounts.set(row.id, { profile: row, passwordHash: '' });
    this.byEmail.set(row.email, row.id);
    return row;
  }

  findById(id: string): Profile | undefined {
    return this.accounts.get(id)?.profile;
  }

  findByEmail(email: string): Profile | undefined {
    const id = this.byEmail.get(email.toLowerCase());
    return id ? this.accounts.get(id)?.profile : undefined;
  }

  getCredentials(id: string): LocalAccount | undefined {
    return this.accounts.get(id);
  }

  update(id: string, patch: Partial<Pick<Profile, 'displayName' | 'avatarUrl'>>): Profile | undefined {
    const acct = this.accounts.get(id);
    if (!acct) return undefined;
    acct.profile = { ...acct.profile, ...patch, updatedAt: new Date().toISOString() };
    return acct.profile;
  }

  promoteToAdmin(id: string): void {
    const acct = this.accounts.get(id);
    if (acct) acct.profile = { ...acct.profile, role: 'ADMIN' };
  }

  count(): number {
    return this.accounts.size;
  }

  all(): Profile[] {
    return [...this.accounts.values()].map((a) => a.profile);
  }

  setPasswordHash(id: string, passwordHash: string): void {
    const acct = this.accounts.get(id);
    if (acct) this.accounts.set(id, { ...acct, passwordHash });
  }

  markEmailVerified(id: string, at: string): void {
    const acct = this.accounts.get(id);
    if (!acct) return;
    acct.profile = { ...acct.profile, emailVerifiedAt: at, updatedAt: new Date().toISOString() };
  }

  updateEmail(id: string, email: string): Profile | undefined {
    const acct = this.accounts.get(id);
    if (!acct) return undefined;
    const normalized = email.toLowerCase();
    if (this.byEmail.has(normalized) && this.byEmail.get(normalized) !== id) return undefined;
    this.byEmail.delete(acct.profile.email);
    this.byEmail.set(normalized, id);
    acct.profile = {
      ...acct.profile,
      email: normalized,
      emailVerifiedAt: null,
      updatedAt: new Date().toISOString(),
    };
    return acct.profile;
  }

  delete(id: string): void {
    const acct = this.accounts.get(id);
    if (!acct) return;
    this.byEmail.delete(acct.profile.email);
    this.accounts.delete(id);
  }

  // ---- Module 11: admin directory + account state ------------------------

  countAdmins(): number {
    return [...this.accounts.values()].filter((a) => a.profile.role === 'ADMIN').length;
  }

  setRole(id: string, role: ProfileRole): Profile | undefined {
    const acct = this.accounts.get(id);
    if (!acct) return undefined;
    acct.profile = { ...acct.profile, role, updatedAt: new Date().toISOString() };
    return acct.profile;
  }

  setStatus(
    id: string,
    patch: {
      status: Profile['status'];
      suspendedAt: string | null;
      suspendedBy: string | null;
      suspensionReason: string | null;
    },
  ): Profile | undefined {
    const acct = this.accounts.get(id);
    if (!acct) return undefined;
    acct.profile = { ...acct.profile, ...patch, updatedAt: new Date().toISOString() };
    return acct.profile;
  }

  touchLastActive(id: string, at: string): void {
    const acct = this.accounts.get(id);
    if (acct) acct.profile = { ...acct.profile, lastActiveAt: at };
  }

  list(query: UserQuery): UserPage {
    const needle = query.q?.trim().toLowerCase() ?? '';
    const matches = [...this.accounts.values()]
      .map((a) => a.profile)
      .filter((p) => {
        if (query.role && p.role !== query.role) return false;
        if (query.status && (p.status ?? 'ACTIVE') !== query.status) return false;
        if (!needle) return true;
        return (
          p.email.toLowerCase().includes(needle) ||
          p.displayName.toLowerCase().includes(needle) ||
          p.id.toLowerCase().includes(needle)
        );
      });

    const sort = query.sort ?? 'created-desc';
    matches.sort((a, b) => {
      switch (sort) {
        case 'created-asc':
          return a.createdAt.localeCompare(b.createdAt);
        case 'name-asc':
          return a.displayName.localeCompare(b.displayName);
        case 'name-desc':
          return b.displayName.localeCompare(a.displayName);
        case 'activity-desc':
          return (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '');
        case 'created-desc':
        default:
          return b.createdAt.localeCompare(a.createdAt);
      }
    });

    return {
      total: matches.length,
      users: matches.slice(query.offset, query.offset + query.limit),
    };
  }
}
