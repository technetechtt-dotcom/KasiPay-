import { MONITORING_DSN, MONITORING_PROVIDER, NODE_ENV } from './config.js';
import { registerTraceHook, structuredLog } from './observability.js';

function dsnHost(dsn: string): string {
  try {
    return new URL(dsn).host;
  } catch {
    return 'invalid-dsn';
  }
}

function shouldPostWebhook(provider: string, dsn: string): boolean {
  const p = provider.toLowerCase();
  // "other" is the explicit webhook sink. Also deliver when provider is unset
  // but DSN is an HTTPS URL (common ops misconfig we still want to exercise).
  return (
    dsn.startsWith('https://') &&
    (p === 'other' || p === '' || p === 'webhook')
  );
}

/**
 * Connect centralized monitoring when configured.
 * - sentry/datadog: log connection marker (SDK optional; DSN proves config)
 * - other/webhook/empty+https: POST error spans to MONITORING_DSN
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
    dsnHost: dsnHost(MONITORING_DSN),
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
      span.status === 'error' &&
      shouldPostWebhook(MONITORING_PROVIDER || '', MONITORING_DSN)
    ) {
      void fetch(MONITORING_DSN, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'ekasi-pay',
          event: 'trace.error',
          pageOnCall: Boolean(span.safeAttributes?.pageOnCall),
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
