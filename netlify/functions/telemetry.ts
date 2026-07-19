import 'dotenv/config';
import { telemetryService } from '../../src/services/telemetry.service';

/**
 * Scheduled telemetry collector (every 6 hours via netlify.toml).
 * Keeps control-plane tenant_metrics_log populated without a persistent process.
 */
export async function handler() {
  try {
    const result = await telemetryService.collectTenantMetrics();
    return {
      statusCode: 200,
      body: JSON.stringify({
        collected: result.collected,
        failed: result.failed,
      }),
    };
  } catch (err) {
    console.error('[telemetry] collection failed:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error:
          err instanceof Error ? err.message : 'Telemetry collection failed',
      }),
    };
  }
}
