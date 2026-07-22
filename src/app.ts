import express, { Request, Response, NextFunction, Express } from 'express';
import { authRouter } from './controllers/auth.controller';
import { settingsRouter } from './controllers/settings.controller';
import { tenantRouter } from './middleware/tenant-router.middleware';
import { pool } from './db/pool';

const REQUIRED_ENV = [
  'DATABASE_URL',
  'JWT_SECRET',
  'BASE_TENANT_POOLER_URL',
] as const;

/**
 * Verify Netlify-dashboard / process.env configuration before serving traffic.
 */
export function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }
}

/**
 * Build the Express application (routes, JWT-backed tenant middleware, JSON body).
 * No app.listen() — the Netlify function wraps this with serverless-http.
 */
export function createApp(): Express {
  assertRequiredEnv();

  const app = express();

  app.use(express.json());

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-tenant-id',
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Public identity endpoints: /auth/register|login|verify
  app.use('/auth', authRouter);

  // Public + admin system settings (control plane — not tenant-scoped)
  // GET  /api/config/auth
  // PUT  /api/admin/settings/auth
  app.use('/api', settingsRouter);

  // Protected multi-tenant business API — JWT + tenant pool switching
  const api = express.Router();
  api.use(tenantRouter);

  api.get(
    '/dashboard',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.tenantPool || !req.currentTenantId) {
          res
            .status(500)
            .json({ error: 'Tenant pool was not attached to request' });
          return;
        }

        const result = await req.tenantPool.query<{
          database_name: string;
          now: Date;
        }>(`SELECT current_database() AS database_name, NOW() AS now`);

        res.status(200).json({
          tenant_id: req.currentTenantId,
          database: result.rows[0]?.database_name,
          server_time: result.rows[0]?.now,
          message: 'Tenant connection switching is active',
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.use('/api', api);

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/health/db', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ database: 'connected' });
    } catch (error) {
      console.error('Database health check failed:', error);
      res.status(500).json({ database: 'disconnected' });
    }
  });

  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      console.error('[app] unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    },
  );

  return app;
}
