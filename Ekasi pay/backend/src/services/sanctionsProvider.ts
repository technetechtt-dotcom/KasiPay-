export type ScreeningSubject = {
  subjectHash: string;
  fullName: string;
  dateOfBirth?: string;
  nationality?: string;
  idDocumentHash?: string;
};

export type ScreeningResult = {
  provider: string;
  providerReference: string;
  decision: 'clear' | 'potential_match' | 'confirmed_match' | 'error';
  screenedAt: Date;
  evidenceRef?: string;
};

/**
 * Contract for a real sanctions/PEP screening vendor. No permissive or fake
 * implementation is provided: production startup requires an explicit provider.
 */
export interface SanctionsPepProvider {
  readonly name: string;
  screen(subject: ScreeningSubject, context: {
    requestId: string;
    correlationId: string;
  }): Promise<ScreeningResult>;
}

let provider: SanctionsPepProvider | undefined;

export function registerSanctionsPepProvider(value: SanctionsPepProvider): void {
  if (!value.name.trim()) throw new Error('Sanctions provider name is required.');
  provider = value;
}

export function getSanctionsPepProvider(): SanctionsPepProvider {
  if (!provider) {
    throw Object.assign(new Error('Sanctions/PEP provider is not configured.'), {
      status: 503,
      code: 'SANCTIONS_PROVIDER_UNAVAILABLE',
    });
  }
  return provider;
}
