import { pool } from '../db/pool';

export type AuthProvider = 'supabase' | 'custom';

export const DEFAULT_AUTH_PROVIDER: AuthProvider = 'supabase';
const AUTH_PROVIDER_KEY = 'auth_provider';

export class SettingsError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

function isAuthProvider(value: string): value is AuthProvider {
  return value === 'supabase' || value === 'custom';
}

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '42P01'
  );
}

/**
 * Control-plane feature flags backed by system_settings on Neon.
 */
export class SettingsService {
  /**
   * Read auth_provider. Falls back to 'supabase' when the row or table is missing.
   */
  async getAuthProvider(): Promise<AuthProvider> {
    try {
      const result = await pool.query<{ value: string }>(
        `SELECT value
         FROM system_settings
         WHERE key = $1
         LIMIT 1`,
        [AUTH_PROVIDER_KEY],
      );

      const raw = result.rows[0]?.value?.trim();
      if (raw && isAuthProvider(raw)) {
        return raw;
      }

      return DEFAULT_AUTH_PROVIDER;
    } catch (err) {
      if (isUndefinedTable(err)) {
        return DEFAULT_AUTH_PROVIDER;
      }
      throw err;
    }
  }

  /**
   * Upsert auth_provider into system_settings ('supabase' | 'custom').
   */
  async setAuthProvider(provider: string): Promise<AuthProvider> {
    const normalized = provider?.trim().toLowerCase();
    if (!normalized || !isAuthProvider(normalized)) {
      throw new SettingsError(
        "provider must be either 'supabase' or 'custom'",
        400,
      );
    }

    try {
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [AUTH_PROVIDER_KEY, normalized],
      );
    } catch (err) {
      if (isUndefinedTable(err)) {
        throw new SettingsError(
          'system_settings table does not exist; apply control_plane.sql first',
          503,
        );
      }
      throw err;
    }

    return normalized;
  }
}

export const settingsService = new SettingsService();
