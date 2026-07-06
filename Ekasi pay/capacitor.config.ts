import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'za.co.ekasipay.app',
  appName: 'Ekasi Pay',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
