import type { Profile } from '@flashspace/shared';
import type { AuthRepo, LocalAccount } from '../data-layer.interface.js';

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
    this.accounts.set(profile.id, { profile, passwordHash });
    this.byEmail.set(profile.email, profile.id);
    return profile;
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
}
