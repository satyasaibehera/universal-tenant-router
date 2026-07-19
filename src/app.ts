import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { authRouter } from './controllers/auth.controller';
import { tenantRouter } from './middleware/tenant-router.middleware';
import { telemetryService } from './services/telemetry.service';

const REQUIRED_ENV = [
  'DATABASE_URL',
  'JWT_SECRET',
  'BASE_TENANT_POOLER_URL',
] as const;

const TELEMETRY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }
}

function createApp() {
  const app = express();

  app.use(express.json());

  // Public identity endpoints: /auth/register|login|verify
  app.use('/auth', authRouter);

  // Protected multi-tenant business API — every request passes tenantRouter
  const api = express.Router();
  api.use(tenantRouter);

  api.get('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.tenantPool || !req.currentTenantId) {
        res.status(500).json({ error: 'Tenant pool was not attached to request' });
        return;
      }

      const result = await req.tenantPool.query<{
        database_name: string;
        now: Date;
      }>(
        `SELECT current_database() AS database_name, NOW() AS now`,
      );

      res.status(200).json({
        tenant_id: req.currentTenantId,
        database: result.rows[0]?.database_name,
        server_time: result.rows[0]?.now,
        message: 'Tenant connection switching is active',
      });
    } catch (err) {
      next(err);
    }
  });

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

async function startTelemetryScheduler(): Promise<NodeJS.Timeout> {
  const run = async () => {
    try {
      const result = await telemetryService.collectTenantMetrics();
      console.log(
        `[telemetry] collected=${result.collected} failed=${result.failed}`,
      );
    } catch (err) {
      console.error('[telemetry] collection cycle failed:', err);
    }
  };

  // Kick once shortly after boot, then every 6 hours.
  setTimeout(() => {
    void run();
  }, 5_000);

  return setInterval(() => {
    void run();
  }, TELEMETRY_INTERVAL_MS);
}

async function bootstrap(): Promise<void> {
  assertRequiredEnv();

  const app = createApp();
  const port = Number(process.env.PORT) || 3000;

  await startTelemetryScheduler();

  app.listen(port, () => {
    console.log(`[app] Universal Tenant Router listening on :${port}`);
  });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('[app] failed to start:', err);
    process.exit(1);
  });
}

export { createApp, bootstrap };
