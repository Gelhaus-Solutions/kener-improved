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

/** Every relative import specifier in a source file. */
function importsIn(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
}

/** Resolve a relative specifier against the importing file, trying the extensions the repo uses. */
function resolveFrom(importer: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base, `${base}.ts`, `${base}.js`, path.join(base, "index.ts"), path.join(base, "index.js")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  // A `.js` specifier that is really a `.ts` file on disk, which is how most of
  // `src/` is written.
  if (base.endsWith(".js")) {
    const asTs = `${base.slice(0, -3)}.ts`;
    if (fs.existsSync(asTs)) return asTs;
  }
  return null;
}

/**
 * Every file under `src/` that booting the seeds and migrations actually reaches,
 * following imports **transitively**.
 *
 * Transitive, and that is the whole point. An earlier version of this test looked
 * only at what `seeds/*.ts` imported directly, which made it blind the moment a
 * seed stopped importing its data module and started importing something that
 * did. I3b did exactly that: the three seeds became one-line wrappers over
 * `provisionOrg.ts`, and with a direct-only scan the five email templates and two
 * data modules it pulls in stopped being checked at all - while still being
 * required at boot. The guard would have gone quiet at the exact moment it
 * mattered.
 */
function reachableSrcFiles(): Array<{ file: string; specifier: string }> {
  const found = new Map<string, string>();
  const queue: Array<{ importer: string; from: string }> = [];

  for (const dir of ["seeds", "migrations"]) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full)) {
      if (!entry.endsWith(".ts")) continue;
      queue.push({ importer: path.join(full, entry), from: `${dir}/${entry}` });
    }
  }

  const seen = new Set<string>();
  while (queue.length > 0) {
    const { importer, from } = queue.shift()!;
    if (seen.has(importer)) continue;
    seen.add(importer);

    for (const specifier of importsIn(importer)) {
      const resolved = resolveFrom(importer, specifier);
      if (!resolved) continue;
      const repoPath = path.relative(ROOT, resolved);
      if (!repoPath.startsWith("src/")) continue;
      if (!found.has(repoPath)) found.set(repoPath, from);
      queue.push({ importer: resolved, from });
    }
  }

  return [...found.entries()].map(([specifier, file]) => ({ file, specifier }));
}

describe("the production image ships everything the seeds import", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const imports = reachableSrcFiles();

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

  it.each(imports)("$file reaches $specifier, and the Dockerfile copies it", ({ specifier }) => {
    const repoPath = specifier;

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
