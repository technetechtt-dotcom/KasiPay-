import { MONITORING_DSN, MONITORING_PROVIDER, NODE_ENV } from './config.js';
import { registerTraceHook, structuredLog } from './observability.js';

/**
 * Connect centralized monitoring when configured.
 * - sentry/datadog: log connection marker (SDK optional; DSN proves config)
 * - other: POST error spans to MONITORING_DSN as an HTTPS webhook
 * Without MONITORING_DSN this is a no-op so local/dev stays quiet.
 */
export function initMonitoring(): void {
  if (!MONITORING_DSN) {
    if (NODE_ENV === 'production') {
      structuredLog('warn', 'monitoring.unconfigured', {
        message: 'MONITORING_DSN is empty in production.',
      });
    }
    return;
  }
  structuredLog('info', 'monitoring.connected', {
    provider: MONITORING_PROVIDER || 'unspecified',
    dsnHost: (() => {
      try {
        return new URL(MONITORING_DSN).host;
      } catch {
        return 'invalid-dsn';
      }
    })(),
  });
  registerTraceHook((span) => {
    structuredLog(span.status === 'error' ? 'error' : 'info', 'trace.span', {
      traceId: span.traceId,
      name: span.name,
      durationMs: span.durationMs,
      status: span.status,
      ...span.safeAttributes,
    });
    if (
      MONITORING_PROVIDER === 'other' &&
      span.status === 'error' &&
      MONITORING_DSN.startsWith('https://')
    ) {
      void fetch(MONITORING_DSN, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'ekasi-pay',
          event: 'trace.error',
          traceId: span.traceId,
          name: span.name,
          durationMs: span.durationMs,
          attributes: span.safeAttributes,
        }),
      }).catch((error) => {
        structuredLog('warn', 'monitoring.webhook_failed', {
          message: error instanceof Error ? error.message : 'webhook failed',
        });
      });
    }
  });
}
