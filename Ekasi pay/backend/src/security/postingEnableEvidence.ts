/**
 * Pure checks for enabling FINANCIAL_POSTING after pause.
 * Keep free of DB/route deps so CI unit tests gate the evidence rules.
 */

export type PostingEnableEvidence = {
  evidenceReleaseSha?: unknown;
  productionReadinessPassed?: unknown;
};

export type EvidenceCheckResult =
  | { ok: true; evidenceSha: string }
  | { ok: false; code: string; message: string; status: number };

const SHA_RE = /^[0-9a-f]{7,64}$/i;

export function validatePostingEnableEvidence(
  payload: PostingEnableEvidence,
  runtimeReleaseSha: string | undefined = process.env.RELEASE_SHA || process.env.GITHUB_SHA,
): EvidenceCheckResult {
  const evidenceSha = String(payload.evidenceReleaseSha ?? '').trim();
  if (!SHA_RE.test(evidenceSha)) {
    return {
      ok: false,
      status: 400,
      code: 'POSTING_ENABLE_EVIDENCE_REQUIRED',
      message:
        'Approved resume requires payload.evidenceReleaseSha (CI tip SHA of the reviewed build).',
    };
  }
  if (payload.productionReadinessPassed !== true) {
    return {
      ok: false,
      status: 400,
      code: 'POSTING_ENABLE_READINESS_REQUIRED',
      message:
        'Approved resume requires payload.productionReadinessPassed=true after production:ready evidence.',
    };
  }
  const expectedSha = String(runtimeReleaseSha ?? '').trim();
  if (expectedSha && evidenceSha.toLowerCase() !== expectedSha.toLowerCase()) {
    return {
      ok: false,
      status: 409,
      code: 'POSTING_ENABLE_EVIDENCE_MISMATCH',
      message: `Evidence release SHA ${evidenceSha} does not match runtime RELEASE_SHA/GITHUB_SHA.`,
    };
  }
  return { ok: true, evidenceSha };
}
