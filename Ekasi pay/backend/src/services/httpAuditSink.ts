import { createHmac } from 'node:crypto';

import type { ExternalAuditSink } from './auditSinkPg.js';

/**
 * HTTPS audit sink. Signs each payload so an immutable receiver can verify origin.
 * Requires AUDIT_SINK_ENDPOINT + AUDIT_SINK_API_KEY.
 */
export function createHttpAuditSink(options?: {
  endpoint?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): ExternalAuditSink {
  const endpoint = (options?.endpoint ?? process.env.AUDIT_SINK_ENDPOINT ?? '').trim();
  const apiKey = (options?.apiKey ?? process.env.AUDIT_SINK_API_KEY ?? '').trim();
  const fetchImpl = options?.fetchImpl ?? fetch;
  if (!endpoint || !apiKey) {
    throw new Error('AUDIT_SINK_ENDPOINT and AUDIT_SINK_API_KEY are required for HTTP audit sink.');
  }

  return {
    async deliver(event) {
      const body = JSON.stringify({
        id: event.id,
        type: event.type,
        actorType: event.actorType,
        actorId: event.actorId,
        targetType: event.targetType,
        targetId: event.targetId,
        safeMetadata: event.safeMetadata,
        requestId: event.requestId,
        correlationId: event.correlationId,
        financialReference: event.financialReference,
        createdAt: event.createdAt,
      });
      const signature = createHmac('sha256', apiKey).update(body).digest('base64url');
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'x-audit-signature': signature,
        },
        body,
      });
      if (!response.ok) {
        throw new Error(`audit sink HTTP ${response.status}`);
      }
    },
  };
}
