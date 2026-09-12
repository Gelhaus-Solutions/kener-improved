import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import * as dotenv from "dotenv";

dotenv.config();

const basePath = process.env.KENER_BASE_PATH ? process.env.KENER_BASE_PATH : "";
const buildEnv = process.env.VITE_BUILD_ENV || process.env.NODE_ENV || "development";
const isProduction = buildEnv === "production";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: [vitePreprocess({})],

  kit: {
    adapter: adapter(),
    output: {
      bundleStrategy: "single",
    },
    paths: {
      base: basePath,
      // I3e: absolute, not relative.
      //
      // SvelteKit's default emits links relative to the routed path, which broke
      // the `/o/<slug>/` organisation prefix: the depth came from the real URL
      // while the target came from the rerouted one, so every link on a prefixed
      // page climbed out of the organisation it belonged to. Absolute paths make
      // a link a fact rather than an arithmetic result, and the prefix is put
      // back by the two URL resolvers (`$lib/client/resolver`, `$lib/server/resolver`).
      relative: false,
    },
    csrf: {
      // The origin check moves to `csrfHandle` in src/hooks.server.ts. It is not
      // removed: that handler runs before any form action resolves and applies
      // the same rule, against the host the request actually arrived on.
      //
      // SvelteKit compares `Origin` against `url.origin`, which `adapter-node`
      // pins to the `ORIGIN` environment variable for the whole process. A tenant
      // on its own G4 hostname therefore failed every form POST, sign-in
      // included, because its `Origin` is its own domain while `url.origin` is
      // the main one. `trustedOrigins: ["*"]` was set here to escape that and
      // never worked: SvelteKit matches that list with `includes`, so `"*"` is a
      // literal origin rather than a wildcard and matched nothing. The check has
      // been fully on this whole time.
      //
      // No static list could work, because custom domains are rows an operator
      // adds at runtime, not values known when the app is built. `csrfHandle`
      // covers the same four form content types, refuses a missing or opaque
      // `Origin` exactly as this did, and refuses a genuine cross-origin POST
      // exactly as this did - it just asks the right question about which host
      // the request came in on.
      checkOrigin: false,
    },
  },

  compilerOptions: {
    dev: !isProduction,
    sourcemap: !isProduction,
  },

  onwarn: (warning, handler) => {
    // Suppress specific warnings in production
    const ignoredWarnings = [
      "a11y-",
      "unused-export-let",
      "empty-chunk",
      "module-unused-import",
      "conflicting-svelte-resolve",
    ];

    if (isProduction && warning.code && ignoredWarnings.some((w) => warning.code.startsWith(w))) {
      return;
    }

    handler(warning);
  },
};

export default config;
