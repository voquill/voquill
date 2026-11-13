/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_FIREBASE_MEASUREMENT_ID: string;
  readonly VITE_USE_EMULATORS?: string;
  readonly VITE_FLAVOR?: string;
  readonly VITE_STRIPE_PUBLIC_KEY?: string;
  readonly VITE_NEW_SERVER_URL?: string;
  readonly VITE_ENTERPRISE_ROUTING_URL_OVERRIDE?: string;
  /** Development builds only: meeting segment roll length, in minutes. */
  readonly VITE_NOTES_DEV_SEGMENT_ROLL_MINUTES?: string;
  /** Development builds only: meeting length limit, in minutes. */
  readonly VITE_NOTES_DEV_RECORDING_LIMIT_MINUTES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
