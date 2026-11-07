interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_MARS_TILES_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
