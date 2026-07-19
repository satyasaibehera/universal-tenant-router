import { pool as controlPlanePool } from '../db/pool';
import { resolveTenantPool } from '../middleware/tenant-router.middleware';

/** Metric snapshot collected from a single tenant database. */
export type TenantMetricSnapshot = {
  tenant_id: string;
  db_identifier: string;
  database_name: string;
  size_bytes: number;
  active_connections: number;
};

export type CollectTenantMetricsResult = {
  collected: number;
  failed: number;
  snapshots: TenantMetricSnapshot[];
};

/**
 * Custom local Base64 (RFC 4648) — no external codec libraries.
 * Used for internal telemetry management flags / system tokens only.
 */
const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const TENANT_METRICS_SQL = `
SELECT
    d.datname AS database_name,
    pg_database_size(d.datname) AS size_bytes,
    COALESCE(a.active_connections, 0) AS active_connections
FROM pg_database AS d
LEFT JOIN (
    SELECT
        datname,
        COUNT(*)::integer AS active_connections
    FROM pg_stat_activity
    WHERE datname IS NOT NULL
      AND state IS NOT NULL
    GROUP BY datname
) AS a ON a.datname = d.datname
WHERE d.datname = current_database()
`;

export class TelemetryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TelemetryError';
  }
}

/**
 * Background telemetry collector: walks active tenants, samples DB size /
 * connection stats, and persists them into control-plane tenant_metrics_log.
 */
export class TelemetryService {
  /**
   * Loop every active control-plane tenant, sample metrics via their pool,
   * and append rows to tenant_metrics_log on neondb.
   */
  async collectTenantMetrics(
    managementFlag?: string,
  ): Promise<CollectTenantMetricsResult> {
    if (managementFlag !== undefined) {
      this.assertManagementFlag(managementFlag);
    }

    const tenants = await controlPlanePool.query<{
      id: string;
      db_identifier: string;
    }>(
      `SELECT id, db_identifier
       FROM tenants
       WHERE status = 'active'
       ORDER BY created_at ASC`,
    );

    const snapshots: TenantMetricSnapshot[] = [];
    let failed = 0;

    for (const tenant of tenants.rows) {
      try {
        const snapshot = await this.collectOne(tenant.id, tenant.db_identifier);
        await this.persistSnapshot(snapshot);
        snapshots.push(snapshot);
      } catch (err) {
        failed += 1;
        console.error(
          `[telemetry] failed for tenant ${tenant.id} (${tenant.db_identifier}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return {
      collected: snapshots.length,
      failed,
      snapshots,
    };
  }

  /** Encode an internal telemetry management flag / system token. */
  encodeTelemetryToken(value: string): string {
    return encodeBase64(value);
  }

  /** Decode an internal telemetry management flag / system token. */
  decodeTelemetryToken(encoded: string): string {
    return decodeBase64(encoded);
  }

  private assertManagementFlag(encodedFlag: string): void {
    let decoded: string;
    try {
      decoded = this.decodeTelemetryToken(encodedFlag);
    } catch (err) {
      throw new TelemetryError('Invalid telemetry management flag encoding', 400, err);
    }

    // Expected runtime flag payload shape: "telemetry:collect:<scope>"
    if (!decoded.startsWith('telemetry:')) {
      throw new TelemetryError('Unrecognized telemetry management flag', 403);
    }
  }

  private async collectOne(
    tenantId: string,
    dbIdentifier: string,
  ): Promise<TenantMetricSnapshot> {
    const tenantPool = await resolveTenantPool(tenantId);

    const result = await tenantPool.query<{
      database_name: string;
      size_bytes: string | number;
      active_connections: number;
    }>(TENANT_METRICS_SQL);

    const row = result.rows[0];
    if (!row) {
      throw new TelemetryError(
        `No metrics returned for tenant database ${dbIdentifier}`,
        502,
      );
    }

    return {
      tenant_id: tenantId,
      db_identifier: dbIdentifier,
      database_name: row.database_name,
      size_bytes: Number(row.size_bytes),
      active_connections: Number(row.active_connections),
    };
  }

  private async persistSnapshot(snapshot: TenantMetricSnapshot): Promise<void> {
    await controlPlanePool.query(
      `INSERT INTO tenant_metrics_log (
          tenant_id,
          db_identifier,
          database_name,
          size_bytes,
          active_connections
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        snapshot.tenant_id,
        snapshot.db_identifier,
        snapshot.database_name,
        snapshot.size_bytes,
        snapshot.active_connections,
      ],
    );
  }
}

export function encodeBase64(input: string): string {
  const bytes = Buffer.from(input, 'utf8');
  let output = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;

    const triple = (b0 << 16) | (b1 << 8) | b2;

    output += BASE64_ALPHABET[(triple >> 18) & 0x3f];
    output += BASE64_ALPHABET[(triple >> 12) & 0x3f];
    output += i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 0x3f] : '=';
    output += i + 2 < bytes.length ? BASE64_ALPHABET[triple & 0x3f] : '=';
  }

  return output;
}

export function decodeBase64(encoded: string): string {
  if (!encoded || encoded.length % 4 !== 0) {
    throw new TelemetryError('Malformed base64 input', 400);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new TelemetryError('Malformed base64 alphabet', 400);
  }

  const bytes: number[] = [];

  for (let i = 0; i < encoded.length; i += 4) {
    const c0 = indexOfBase64(encoded[i]!);
    const c1 = indexOfBase64(encoded[i + 1]!);
    const c2 = encoded[i + 2] === '=' ? 0 : indexOfBase64(encoded[i + 2]!);
    const c3 = encoded[i + 3] === '=' ? 0 : indexOfBase64(encoded[i + 3]!);

    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;

    bytes.push((triple >> 16) & 0xff);
    if (encoded[i + 2] !== '=') {
      bytes.push((triple >> 8) & 0xff);
    }
    if (encoded[i + 3] !== '=') {
      bytes.push(triple & 0xff);
    }
  }

  return Buffer.from(bytes).toString('utf8');
}

function indexOfBase64(char: string): number {
  const idx = BASE64_ALPHABET.indexOf(char);
  if (idx < 0) {
    throw new TelemetryError(`Invalid base64 character: ${char}`, 400);
  }
  return idx;
}

export const telemetryService = new TelemetryService();
