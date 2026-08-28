/**
 * Path prefix the app is served under — "/" locally, "/Metang/" on GitHub Pages.
 *
 * `import.meta.env` is injected by Vite and does not exist under plain Node, so
 * the tests (which import these modules directly via tsx) see `undefined`. The
 * optional chain keeps module-scope evaluation from throwing there; without it
 * `test/body.test.ts` dies on import.
 */
export const BASE: string = import.meta.env?.BASE_URL ?? "/";
