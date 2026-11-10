import { LocalStorageAdapter } from './local.storage.js';
import { SupabaseStorageAdapter } from './supabase.storage.js';
import type { StorageAdapter } from './storage.interface.js';
import type { Env } from '../config/env.js';

export type { StorageAdapter, SignedUrl, StoredObjectInfo } from './storage.interface.js';

export function createStorageAdapter(env: Env): StorageAdapter {
  if (env.storageMode === 'supabase') {
    if (!env.supabaseUrl || !env.supabaseServiceKey) {
      throw new Error('STORAGE_MODE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    }
    return new SupabaseStorageAdapter(env.supabaseUrl, env.supabaseServiceKey, 'flashspace');
  }
  return new LocalStorageAdapter(
    env.localStorageDir,
    env.localAuthSecret,
    () => env.signedUrlBase,
  );
}
