import * as esbuild from "esbuild";
import { readFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// Builds the standalone Kener probe (B1c).
//
// **Everything is bundled, unlike `scripts/build-server.js`.** That build
// externalises every dependency because the server ships beside the repo's own
// `node_modules`. The probe ships alone, usually into a container that holds
// nothing else, so a bundle with no `node_modules` at all is the whole point:
// one file to copy, and no install step in the image.
//
// The five service classes come from `../src` by relative import, so the probe
// and Kener run the same check logic compiled from the same source rather than
// two copies that agree by inspection. That is why this build resolves `$lib`
// the way the server build does: `tool.ts`, which `apiCall` imports, uses the
// SvelteKit alias.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));

mkdirSync(resolve(here, "dist"), { recursive: true });

await esbuild.build({
  entryPoints: [resolve(here, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: resolve(here, "dist/probe.js"),
  alias: {
    $lib: resolve(repoRoot, "src/lib"),
  },
  define: {
    // `version.ts` reads this, and without it the bundle would carry an
    // unresolved `import.meta.env` that throws on the first API check.
    "import.meta.env.PACKAGE_VERSION": JSON.stringify(pkg.version),
  },
  plugins: [
    {
      // `tool.ts` imports the knexfile by relative path, which `alias` cannot
      // match, so it takes a resolver. See `src/no-database.ts` for why the
      // probe must not carry Kener's database configuration.
      name: "stub-knexfile",
      setup(build) {
        build.onResolve({ filter: /knexfile(\.js|\.ts)?$/ }, () => ({
          path: resolve(here, "src/no-database.ts"),
        }));
      },
    },
  ],
  banner: {
    // `ws` and its transitive CJS dependencies call `require` at load time, and
    // an ESM bundle has no `require` to give them. This is the standard shim and
    // it is why the output can be ESM without every CJS dependency breaking.
    js: [
      "// Kener remote probe - built with esbuild",
      "import { createRequire as __kenerCreateRequire } from 'module';",
      "const require = __kenerCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

console.log(`Probe build completed: probe/dist/probe.js (v${pkg.version})`);
