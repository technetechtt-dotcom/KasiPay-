declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express merges via namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; phone: string; role: string; sessionId: string };
    }
  }
}

export {};
