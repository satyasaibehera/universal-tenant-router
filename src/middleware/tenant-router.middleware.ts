import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { pool as controlPlanePool } from '../db/pool';
import type { AuthTokenPayload } from '../services/auth.service';

const TENANT_POOL_MAX = 10;
const CONTROL_PLANE_DB_NAME = 'neondb';

declare module 'express-serve-static-core' {
  interface Request {
    /** Tenant-scoped pg pool resolved by tenantRouter. */
    tenantPool?: Pool;
    /** Active tenant id for this request. */
    currentTenantId?: string;
  }
}

/** In-memory tenant_id → Pool cache. */
const tenantPoolCache = new Map<string, Pool>();

/**
 * In-flight pool creation promises — prevents concurrent requests for the same
 * tenant from opening duplicate pools (async race / "thread-safe" guard).
 */
const pendingTenantPools = new Map<string, Promise<Pool>>();

export class TenantRouterError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'TenantRouterError';
  }
}

/**
 * Dynamic multi-tenant router middleware.
 *
 * 1. Verifies Bearer JWT
 * 2. Resolves target tenant from `x-tenant-id` / params / query
 * 3. Confirms JWT membership for that tenant
 * 4. Attaches a cached (or newly built) tenant pg.Pool to the request
 */
export async function tenantRouter(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractBearerToken(req);
    const payload = verifyAccessToken(token);
    const tenantId = resolveTenantId(req);

    if (!tenantId) {
      throw new TenantRouterError(
        'Tenant id is required (x-tenant-id header, :tenantId param, or tenant_id query)',
        400,
      );
    }

    assertTenantMembership(payload, tenantId);

    const tenantPool = await getOrCreateTenantPool(tenantId);

    req.tenantPool = tenantPool;
    req.currentTenantId = tenantId;
    next();
  } catch (err) {
    if (err instanceof TenantRouterError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    if (err instanceof jwt.JsonWebTokenError) {
      const message =
        err instanceof jwt.TokenExpiredError
          ? 'Access token has expired'
          : 'Invalid access token';
      res.status(401).json({ error: message });
      return;
    }
    next(err);
  }
}

function extractBearerToken(req: Request): string {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') {
    throw new TenantRouterError('Missing Authorization bearer token', 401);
  }

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new TenantRouterError(
      'Authorization header must be Bearer <token>',
      401,
    );
  }

  return token;
}

function verifyAccessToken(token: string): AuthTokenPayload {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new TenantRouterError('JWT_SECRET is not configured', 500);
  }

  const decoded = jwt.verify(token, secret);

  if (typeof decoded === 'string' || !decoded || typeof decoded !== 'object') {
    throw new TenantRouterError('Invalid access token payload', 401);
  }

  const payload = decoded as AuthTokenPayload;
  if (!payload.user_id || !payload.email || !Array.isArray(payload.tenants)) {
    throw new TenantRouterError('Invalid access token payload', 401);
  }

  return payload;
}

function resolveTenantId(req: Request): string | undefined {
  const fromHeader = req.headers['x-tenant-id'];
  if (typeof fromHeader === 'string' && fromHeader.trim()) {
    return fromHeader.trim();
  }
  if (Array.isArray(fromHeader) && fromHeader[0]?.trim()) {
    return fromHeader[0].trim();
  }

  const fromParams =
    (typeof req.params.tenantId === 'string' && req.params.tenantId) ||
    (typeof req.params.tenant_id === 'string' && req.params.tenant_id);
  if (fromParams) {
    return fromParams.trim();
  }

  const fromQuery = req.query.tenant_id ?? req.query.tenantId;
  if (typeof fromQuery === 'string' && fromQuery.trim()) {
    return fromQuery.trim();
  }

  return undefined;
}

function assertTenantMembership(
  payload: AuthTokenPayload,
  tenantId: string,
): void {
  const membership = payload.tenants.find((t) => t.tenant_id === tenantId);
  if (!membership) {
    throw new TenantRouterError(
      'You do not have access to the requested tenant',
      403,
    );
  }
}

/** Resolve (or lazily create) a cached pg.Pool for a tenant database. */
export async function resolveTenantPool(tenantId: string): Promise<Pool> {
  return getOrCreateTenantPool(tenantId);
}

async function getOrCreateTenantPool(tenantId: string): Promise<Pool> {
  const cached = tenantPoolCache.get(tenantId);
  if (cached) {
    return cached;
  }

  const inflight = pendingTenantPools.get(tenantId);
  if (inflight) {
    return inflight;
  }

  const creation = createTenantPool(tenantId)
    .then((created) => {
      tenantPoolCache.set(tenantId, created);
      return created;
    })
    .finally(() => {
      pendingTenantPools.delete(tenantId);
    });

  pendingTenantPools.set(tenantId, creation);
  return creation;
}

async function createTenantPool(tenantId: string): Promise<Pool> {
  const result = await controlPlanePool.query<{
    db_identifier: string;
    status: string;
  }>(
    `SELECT db_identifier, status
     FROM tenants
     WHERE id = $1`,
    [tenantId],
  );

  const tenant = result.rows[0];
  if (!tenant) {
    throw new TenantRouterError('Tenant not found', 404);
  }

  if (tenant.status !== 'active') {
    throw new TenantRouterError(
      'Tenant account is suspended or inactive',
      403,
    );
  }

  const connectionString = buildTenantConnectionString(tenant.db_identifier);

  return new Pool({
    connectionString,
    max: TENANT_POOL_MAX,
  });
}

/**
 * Build a tenant DB URL from BASE_TENANT_POOLER_URL by swapping `/neondb`
 * (or the current path) for `/${db_identifier}`.
 */
export function buildTenantConnectionString(dbIdentifier: string): string {
  const base = process.env.BASE_TENANT_POOLER_URL;
  if (!base) {
    throw new TenantRouterError(
      'BASE_TENANT_POOLER_URL is not configured',
      500,
    );
  }

  if (!dbIdentifier || /[/\s?]/.test(dbIdentifier)) {
    throw new TenantRouterError('Invalid tenant database identifier', 500);
  }

  try {
    const url = new URL(base);
    const currentPath = url.pathname.replace(/\/+$/, '') || '';
    const controlPlanePath = `/${CONTROL_PLANE_DB_NAME}`;

    if (
      currentPath === controlPlanePath ||
      currentPath.endsWith(controlPlanePath)
    ) {
      url.pathname = currentPath.replace(
        new RegExp(`${controlPlanePath}$`),
        `/${dbIdentifier}`,
      );
    } else if (!currentPath || currentPath === '/') {
      url.pathname = `/${dbIdentifier}`;
    } else {
      // Replace whatever database name is already in the path.
      const segments = currentPath.split('/').filter(Boolean);
      segments[segments.length - 1] = dbIdentifier;
      url.pathname = `/${segments.join('/')}`;
    }

    return url.toString();
  } catch {
    // Fallback for non-standard connection strings the URL parser rejects.
    if (base.includes(`/${CONTROL_PLANE_DB_NAME}`)) {
      return base.replace(`/${CONTROL_PLANE_DB_NAME}`, `/${dbIdentifier}`);
    }
    if (base.includes('?')) {
      const [withoutQuery, query] = base.split('?', 2);
      const trimmed = withoutQuery.replace(/\/+$/, '');
      return `${trimmed}/${dbIdentifier}?${query}`;
    }
    return `${base.replace(/\/+$/, '')}/${dbIdentifier}`;
  }
}

/** Test / ops helper: drop a cached pool (ends connections). */
export async function evictTenantPool(tenantId: string): Promise<void> {
  const existing = tenantPoolCache.get(tenantId);
  if (!existing) {
    return;
  }
  tenantPoolCache.delete(tenantId);
  await existing.end();
}

/** Test / ops helper: clear the entire pool cache. */
export async function clearTenantPoolCache(): Promise<void> {
  const pools = [...tenantPoolCache.values()];
  tenantPoolCache.clear();
  pendingTenantPools.clear();
  await Promise.all(pools.map((p) => p.end()));
}
