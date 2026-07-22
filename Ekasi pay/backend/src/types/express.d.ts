declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express merges via namespace
  namespace Express {
    interface Request {
      requestId: string;
      correlationId: string;
      auth?: { userId: string; phone: string; role: string; sessionId: string };
      opsAuth?: {
        operatorId: string;
        username: string;
        role: 'admin' | 'operations' | 'compliance' | 'finance' | 'support';
        sessionId: string;
        tokenVersion: number;
      };
      productReadiness?: {
        product: string;
        environment: string;
        enabled: boolean;
        databaseApproved: boolean;
        configEnabled: boolean;
        controls: Array<{
          control: string;
          approved: boolean;
          evidenceSha256: string | null;
          artifactSha256: string | null;
          recordedAt: string | null;
        }>;
        missing: string[];
      };
    }
  }
}

export {};
