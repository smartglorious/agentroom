declare const __AR_VERSION__: string | undefined;

/** The package version, injected by esbuild (`define`); "dev" when run from sources without a bundle. */
export const VERSION: string = typeof __AR_VERSION__ === "string" ? __AR_VERSION__ : "dev";
