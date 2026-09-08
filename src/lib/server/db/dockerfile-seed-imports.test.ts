import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The production image ships `build/main.js` plus an **allowlist** of individual
// `src/` files, because seeds and migrations are the one thing that still runs
// from source at boot. That allowlist is invisible from the code that depends on
// it: a seed can import a new module, typecheck, pass every test, run perfectly
// in development, and then fail only inside the container with
// "Cannot find module".
//
// That is not hypothetical. `seeds/permissions.ts` and `seeds/roles.ts` have
// imported `src/lib/orgPerms.ts` since P1, the Dockerfile never copied it, and
// the result was that a fresh deployment came up with no permissions and no
// roles at all - the seed threw, and every role was empty. Nothing in CI caught
// it because nothing in CI reads the Dockerfile.
//
// This test reads both, so the next time somebody adds an import the failure is
// a red test rather than a broken deployment.

const ROOT = path.resolve(process.cwd());

/** Every `../src/...` module a file under `seeds/` or `migrations/` imports. */
function srcImportsIn(dir: string): Array<{ file: string; specifier: string }> {
  const found: Array<{ file: string; specifier: string }> = [];
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return found;

  for (const entry of fs.readdirSync(full)) {
    if (!entry.endsWith(".ts")) continue;
    const source = fs.readFileSync(path.join(full, entry), "utf8");
    for (const m of source.matchAll(/from\s+["'](\.\.\/src\/[^"']+)["']/g)) {
      found.push({ file: `${dir}/${entry}`, specifier: m[1] });
    }
  }
  return found;
}

/** Resolve `../src/lib/x.ts` as seen from `seeds/` into a repo-relative path. */
function toRepoPath(specifier: string): string {
  return specifier.replace(/^\.\.\//, "");
}

describe("the production image ships everything the seeds import", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const imports = [...srcImportsIn("seeds"), ...srcImportsIn("migrations")];

  it("finds the imports it is supposed to be checking", () => {
    // Guard on the guard: if the scan silently found nothing, every assertion
    // below would pass vacuously and this file would be worthless.
    expect(imports.length).toBeGreaterThan(0);
  });

  /**
   * Destinations of every COPY in the Dockerfile, normalised to repo-relative.
   *
   * Parsing the destinations rather than substring-matching the whole file
   * matters: an earlier version of this test asked whether the Dockerfile
   * merely *contained* an ancestor path, which `./src/lib/locales` satisfies
   * for anything under `src/lib`, so it passed even with the broken image. A
   * test that cannot fail is worse than no test.
   */
  const copyDestinations = [...dockerfile.matchAll(/^COPY\s+(.+)$/gm)]
    .map((m) =>
      m[1]
        .trim()
        .split(/\s+/)
        .filter((tok) => !tok.startsWith("--")),
    )
    .filter((tokens) => tokens.length >= 2)
    .map((tokens) => tokens[tokens.length - 1].replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((dest) => dest.length > 0 && dest !== ".");

  it.each(imports)("$file imports $specifier, and the Dockerfile copies it", ({ specifier }) => {
    const repoPath = toRepoPath(specifier);

    const copied = copyDestinations.some((dest) => dest === repoPath || repoPath.startsWith(`${dest}/`));

    expect(
      copied,
      `Dockerfile has no COPY covering ${repoPath}. A deployment from this image will fail at boot with "Cannot find module". COPY destinations seen: ${copyDestinations.join(", ")}`,
    ).toBe(true);
  });

  it("copies orgPerms.ts specifically", () => {
    // The one that actually broke, kept as a named case so a regression reads as
    // itself rather than as a generic allowlist miss.
    expect(dockerfile).toContain("src/lib/orgPerms.ts");
  });
});
