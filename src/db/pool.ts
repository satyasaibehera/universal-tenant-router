import { Pool, neonConfig } from '@neondatabase/serverless';

/**
 * Route Pool.query() over Neon's low-latency HTTP fetch driver instead of
 * persistent WebSockets — avoids connection starvation / idle timeouts in
 * short-lived Netlify (and other) serverless invocations.
 */
neonConfig.poolQueryViaFetch = true;

/** Serverless-safe pool size: one HTTP-backed slot per pool instance. */
const SERVERLESS_POOL_MAX = 1;

export type NeonPool = Pool;

/**
 * Create a Neon serverless Pool bound to a connection string from process.env
 * (or a dynamically rewritten tenant URL).
 */
export function createNeonPool(connectionString: string): Pool {
  if (!connectionString?.trim()) {
    throw new Error('A PostgreSQL connection string is required');
  }

  return new Pool({
    connectionString,
    max: SERVERLESS_POOL_MAX,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  });
}

let controlPlanePool: Pool | undefined;

/**
 * Lazily construct the shared control-plane pool from process.env.DATABASE_URL
 * so Netlify dashboard env vars are available before the first query.
 */
export function getControlPlanePool(): Pool {
  if (!controlPlanePool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString?.trim()) {
      throw new Error('DATABASE_URL is not configured');
    }
    controlPlanePool = createNeonPool(connectionString);
  }
  return controlPlanePool;
}

/**
 * Drop-in `pool` export used across services. Proxies to a lazily created
 * control-plane Neon Pool so imports remain `import { pool } from '../db/pool'`.
 */
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, property, receiver) {
    const instance = getControlPlanePool();
    const value = Reflect.get(instance, property, receiver);
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});
