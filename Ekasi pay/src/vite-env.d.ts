/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string | undefined;
  readonly VITE_APP_VERSION: string | undefined;
  readonly VITE_SUPPORT_WHATSAPP: string | undefined;
  readonly VITE_SUPPORT_PHONE: string | undefined;
  readonly VITE_SUPPORT_PHONE_DISPLAY: string | undefined;
  readonly VITE_SUPPORT_EMAIL: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface KasipaySupportRuntime {
  whatsapp?: string;
  phone?: string;
  phoneDisplay?: string;
  email?: string;
}

interface Window {
  __KASIPAY_API_URL__?: string;
  __KASIPAY_SUPPORT__?: KasipaySupportRuntime;
}
