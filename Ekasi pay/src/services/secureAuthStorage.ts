const REFRESH_KEY = 'ekasi.refresh';

type SecureStoragePlugin = {
  get(options: { key: string }): Promise<{ value?: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
};

function nativePlugin(): SecureStoragePlugin | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as Window & {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      Plugins?: { SecureStoragePlugin?: SecureStoragePlugin };
    };
  }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  const plugin = cap.Plugins?.SecureStoragePlugin;
  if (!plugin) {
    throw new Error('Native secure-storage plugin is required in release builds.');
  }
  return plugin;
}

let webMemoryRefresh: string | null = null;

export async function readSecureRefresh(): Promise<string | null> {
  const plugin = nativePlugin();
  if (plugin) return (await plugin.get({ key: REFRESH_KEY })).value ?? null;
  return webMemoryRefresh;
}

export function writeSecureRefresh(value: string | null): void {
  const plugin = nativePlugin();
  if (plugin) {
    void (value
      ? plugin.set({ key: REFRESH_KEY, value })
      : plugin.remove({ key: REFRESH_KEY }));
    return;
  }
  // Browser refresh tokens belong in HttpOnly cookies; memory is compatibility-only.
  webMemoryRefresh = value;
}

export function clearSecureRefresh(): void {
  writeSecureRefresh(null);
}
