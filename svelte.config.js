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
      trustedOrigins: ["*"],
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
