import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { pool as controlPlanePool } from '../db/pool';
import { buildTenantConnectionString } from '../middleware/tenant-router.middleware';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';
const BASELINE_SQL_PATH = path.join(__dirname, '..', 'db', 'tenant_baseline.sql');

export class LifecycleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LifecycleError';
  }
}

export type ProvisionTenantResult = {
  tenant_id: string;
  company_name: string;
  db_identifier: string;
  status: 'active';
  neon_database: {
    id: number;
    name: string;
    owner_name: string;
    branch_id: string;
  };
};

/**
 * Automated tenant lifecycle: Neon DB allocation → baseline DDL → control-plane activation.
 */
export class LifecycleService {
  /**
   * Provision a brand-new tenant database container, apply baseline schema,
   * and mark the control-plane tenant row active.
   */
  async provisionTenantDatabase(
    tenantId: string,
    companyName: string,
    dbIdentifier: string,
  ): Promise<ProvisionTenantResult> {
    this.assertProvisionInputs(tenantId, companyName, dbIdentifier);

    let controlPlaneInserted = false;
    let neonCreated = false;
    let neonDatabase: ProvisionTenantResult['neon_database'] | null = null;

    try {
      // 1. Register tenant in control plane as suspended while infrastructure is allocated.
      await this.insertProvisioningTenant(tenantId, companyName, dbIdentifier);
      controlPlaneInserted = true;

      // 2. Allocate remote database via Neon Management API.
      neonDatabase = await this.createNeonDatabase(dbIdentifier);
      neonCreated = true;

      // 3. Apply baseline DDL through a transient admin pooler connection.
      await this.applyBaselineSchema(dbIdentifier);

      // 4. Flip control-plane status to active.
      await this.activateTenant(tenantId);

      return {
        tenant_id: tenantId,
        company_name: companyName,
        db_identifier: dbIdentifier,
        status: 'active',
        neon_database: neonDatabase,
      };
    } catch (err) {
      await this.rollbackProvisioning({
        tenantId,
        dbIdentifier,
        controlPlaneInserted,
        neonCreated,
      });

      if (err instanceof LifecycleError) {
        throw err;
      }

      throw new LifecycleError(
        err instanceof Error
          ? `Tenant provisioning failed: ${err.message}`
          : 'Tenant provisioning failed',
        500,
        err,
      );
    }
  }

  private assertProvisionInputs(
    tenantId: string,
    companyName: string,
    dbIdentifier: string,
  ): void {
    if (!tenantId?.trim()) {
      throw new LifecycleError('tenantId is required', 400);
    }
    if (!companyName?.trim()) {
      throw new LifecycleError('companyName is required', 400);
    }
    if (!dbIdentifier?.trim()) {
      throw new LifecycleError('dbIdentifier is required', 400);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbIdentifier)) {
      throw new LifecycleError(
        'dbIdentifier must be a valid PostgreSQL database name',
        400,
      );
    }
  }

  private async insertProvisioningTenant(
    tenantId: string,
    companyName: string,
    dbIdentifier: string,
  ): Promise<void> {
    try {
      await controlPlanePool.query(
        `INSERT INTO tenants (id, company_name, db_identifier, status)
         VALUES ($1, $2, $3, 'suspended')`,
        [tenantId, companyName.trim(), dbIdentifier],
      );
    } catch (err: unknown) {
      if (this.isUniqueViolation(err)) {
        throw new LifecycleError(
          'Tenant id or db_identifier already exists in control plane',
          409,
          err,
        );
      }
      throw err;
    }
  }

  /**
   * Create a database in the Neon project cluster.
   *
   * Neon’s Management API requires a branch path segment in addition to the
   * project id (`/projects/{id}/branches/{branch}/databases`). Branch and
   * owner are read from NEON_BRANCH_ID / NEON_OWNER_NAME.
   */
  private async createNeonDatabase(
    dbIdentifier: string,
  ): Promise<ProvisionTenantResult['neon_database']> {
    const projectId = process.env.NEON_PROJECT_ID;
    const apiKey = process.env.NEON_API_KEY;
    const branchId = process.env.NEON_BRANCH_ID;
    const ownerName = process.env.NEON_OWNER_NAME ?? 'neondb_owner';

    if (!projectId || !apiKey) {
      throw new LifecycleError(
        'NEON_PROJECT_ID and NEON_API_KEY must be configured',
        500,
      );
    }
    if (!branchId) {
      throw new LifecycleError(
        'NEON_BRANCH_ID must be configured for database provisioning',
        500,
      );
    }

    // Project-scoped databases collection under the target branch.
    const endpoint =
      `${NEON_API_BASE}/projects/${projectId}/branches/${branchId}/databases`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          database: {
            name: dbIdentifier,
            owner_name: ownerName,
          },
        }),
      });
    } catch (err) {
      throw new LifecycleError(
        'Failed to reach Neon Management API',
        502,
        err,
      );
    }

    if (!response.ok) {
      const detail = await this.safeReadBody(response);
      throw new LifecycleError(
        `Neon database creation failed (${response.status}): ${detail}`,
        502,
      );
    }

    const body = (await response.json()) as {
      database?: {
        id: number;
        name: string;
        owner_name: string;
        branch_id: string;
      };
    };

    if (!body.database) {
      throw new LifecycleError(
        'Neon API returned an unexpected create-database response',
        502,
      );
    }

    return {
      id: body.database.id,
      name: body.database.name,
      owner_name: body.database.owner_name,
      branch_id: body.database.branch_id,
    };
  }

  private async applyBaselineSchema(dbIdentifier: string): Promise<void> {
    let ddl: string;
    try {
      ddl = await readFile(BASELINE_SQL_PATH, 'utf8');
    } catch (err) {
      throw new LifecycleError(
        `Unable to read baseline DDL at ${BASELINE_SQL_PATH}`,
        500,
        err,
      );
    }

    if (!ddl.trim()) {
      throw new LifecycleError('Baseline DDL file is empty', 500);
    }

    let connectionString: string;
    try {
      connectionString = buildTenantConnectionString(dbIdentifier);
    } catch (err) {
      throw new LifecycleError(
        'BASE_TENANT_POOLER_URL is missing or invalid',
        500,
        err,
      );
    }

    const transientPool = new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 15_000,
    });

    try {
      await transientPool.query(ddl);
    } catch (err) {
      throw new LifecycleError(
        `Failed to apply baseline schema to ${dbIdentifier}`,
        500,
        err,
      );
    } finally {
      await transientPool.end().catch(() => undefined);
    }
  }

  private async activateTenant(tenantId: string): Promise<void> {
    const result = await controlPlanePool.query(
      `UPDATE tenants
       SET status = 'active'
       WHERE id = $1
       RETURNING id`,
      [tenantId],
    );

    if (result.rowCount === 0) {
      throw new LifecycleError(
        'Control plane tenant row missing during activation',
        500,
      );
    }
  }

  private async rollbackProvisioning(state: {
    tenantId: string;
    dbIdentifier: string;
    controlPlaneInserted: boolean;
    neonCreated: boolean;
  }): Promise<void> {
    if (state.neonCreated) {
      try {
        await this.deleteNeonDatabase(state.dbIdentifier);
      } catch {
        // Best-effort remote cleanup; surface original error to caller.
      }
    }

    if (state.controlPlaneInserted) {
      try {
        await controlPlanePool.query(`DELETE FROM tenants WHERE id = $1`, [
          state.tenantId,
        ]);
      } catch {
        // Best-effort control-plane cleanup.
      }
    }
  }

  private async deleteNeonDatabase(dbIdentifier: string): Promise<void> {
    const projectId = process.env.NEON_PROJECT_ID;
    const apiKey = process.env.NEON_API_KEY;
    const branchId = process.env.NEON_BRANCH_ID;

    if (!projectId || !apiKey || !branchId) {
      return;
    }

    const endpoint =
      `${NEON_API_BASE}/projects/${projectId}/branches/${branchId}/databases/${encodeURIComponent(dbIdentifier)}`;

    const response = await fetch(endpoint, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    // 404 means already gone — treat as successful rollback.
    if (!response.ok && response.status !== 404) {
      const detail = await this.safeReadBody(response);
      throw new LifecycleError(
        `Neon database rollback failed (${response.status}): ${detail}`,
        502,
      );
    }
  }

  private async safeReadBody(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text || response.statusText;
    } catch {
      return response.statusText;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    );
  }
}

export const lifecycleService = new LifecycleService();
