import express, { Request, Response, NextFunction, Express } from 'express';
import { authRouter } from './controllers/auth.controller';
import { tenantRouter } from './middleware/tenant-router.middleware';

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

  // Public identity endpoints: /auth/register|login|verify
  app.use('/auth', authRouter);

  // Protected multi-tenant business API — every request passes tenantRouter
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
