/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute relay URL, baked at build time. Unset locally, where the Vite dev proxy handles /ws. */
  readonly VITE_RELAY_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
