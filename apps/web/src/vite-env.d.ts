/// <reference types="vite/client" />

/**
 * Types the environment variables this app reads.
 *
 * Vite only exposes `VITE_`-prefixed variables to client code — anything else is
 * `undefined` in the browser with no warning
 * (`docs/engineering/ENVIRONMENT_VARIABLES.md`). Declaring them here means a
 * typo in `import.meta.env.VITE_API_BASE_UR` is a type error rather than a
 * runtime `undefined` that falls through to the default.
 *
 * Optional rather than required: the variable genuinely may be unset in
 * development, and `http.ts` supplies the documented default.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
