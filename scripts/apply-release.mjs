#!/usr/bin/env node
/**
 * Applies a published GitHub release to the working tree.
 *
 * The GitHub release body *is* the changelog for this fork, so this script
 * takes that body plus the version and writes it everywhere the repo records a
 * release:
 *
 *   1. `package.json` + `package-lock.json` - version bump via `npm version`.
 *   2. `CHANGELOG.md`                       - a new section, newest first.
 *   3. `src/routes/(docs)/docs/content/v<major>/changelogs/vX.Y.Z.md`
 *   4. `src/routes/(docs)/docs.json`         - the sidebar entry for (3).
 *
 * Every step is idempotent: re-running for a version that is already applied
 * rewrites the same content rather than stacking a duplicate. That matters
 * because a release can be edited and re-published, which fires the workflow
 * again.
 *
 * Usage:
 *   node scripts/apply-release.mjs --version 4.2.0 --notes-file notes.md [--date 2026-09-08]
 *   node scripts/apply-release.mjs --version 4.2.0 --notes-file - < notes.md
 *
 * Options:
 *   --version <semver>   Release version, without a leading "v". Required.
 *   --notes-file <path>  File holding the release body, or "-" for stdin. Required.
 *   --date <YYYY-MM-DD>  Release date. Defaults to today (UTC).
 *   --skip-bump          Leave package.json alone; only write the changelogs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const CHANGELOG = join(ROOT, "CHANGELOG.md");
const DOCS_JSON = join(ROOT, "src/routes/(docs)/docs.json");
const DOCS_CONTENT_DIR = join(ROOT, "src/routes/(docs)/docs/content");

const CHANGELOG_PREAMBLE = `# Changelog

Every entry below is the GitHub release body for that version, copied here by
\`scripts/apply-release.mjs\` when the release is published. See
[Releases](https://github.com/Gelhaus-Solutions/kener-improved/releases) for the
originals.
`;

function fail(message) {
  console.error(`apply-release: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { skipBump: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--version":
        args.version = argv[++i];
        break;
      case "--notes-file":
        args.notesFile = argv[++i];
        break;
      case "--date":
        args.date = argv[++i];
        break;
      case "--skip-bump":
        args.skipBump = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  return args;
}

/** Strips a leading "v" and rejects anything that is not plain semver. */
function normaliseVersion(raw) {
  if (!raw) fail("--version is required");

  const version = raw.startsWith("v") ? raw.slice(1) : raw;

  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`invalid version: ${raw} (expected semver like 4.2.0 or 4.2.0-rc.1)`);
  }

  return version;
}

function readNotes(notesFile) {
  if (!notesFile) fail("--notes-file is required");

  const raw = notesFile === "-" ? readFileSync(0, "utf8") : readFileSync(notesFile, "utf8");

  // GitHub sends CRLF for anything typed into the release form.
  const notes = raw.replace(/\r\n/g, "\n").trim();

  if (!notes) {
    fail("the release body is empty - it is the changelog, so there is nothing to record");
  }

  return notes;
}

/** "2026-09-08" -> "September 8, 2026", matching the existing docs changelogs. */
function formatDate(iso) {
  const date = new Date(`${iso}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) fail(`invalid --date: ${iso}`);

  return date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function bumpPackageVersion(version) {
  const current = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

  if (current === version) {
    console.log(`package.json already at ${version}`);
    return;
  }

  execFileSync("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], {
    cwd: ROOT,
    stdio: "inherit",
  });

  console.log(`bumped package.json ${current} -> ${version}`);
}

/**
 * Shifts every ATX heading in the release body down one level, so a top-level
 * `## What's Changed` from GitHub's generator nests under the `## vX.Y.Z`
 * section rather than colliding with it. Headings inside fenced code blocks are
 * left alone.
 */
function demoteHeadings(markdown) {
  let inFence = false;

  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }

      if (inFence) return line;

      const match = /^(#{1,5})(\s)/.exec(line);
      return match ? `#${line}` : line;
    })
    .join("\n");
}

function writeRootChangelog(version, isoDate, notes) {
  const heading = `## v${version} - ${isoDate}`;
  const section = `${heading}\n\n${demoteHeadings(notes)}\n`;

  const existing = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : CHANGELOG_PREAMBLE;

  // Split off the preamble so the newest release always lands directly above
  // the previous one rather than at the top of the file.
  const firstSection = existing.search(/^## /m);
  const preamble = firstSection === -1 ? existing : existing.slice(0, firstSection);
  const sections = firstSection === -1 ? [] : splitSections(existing.slice(firstSection));

  // A release can be edited and re-published, which runs this again. Replace
  // the existing section where it already sits rather than hoisting an old
  // version back to the top of the file.
  const prefix = `## v${version} `;
  const at = sections.findIndex((s) => s.startsWith(prefix));
  const updated = at === -1 ? [section, ...sections] : sections.with(at, section);

  writeFileSync(CHANGELOG, `${preamble.trimEnd()}\n\n${updated.join("\n")}`);
  console.log(`wrote ${heading} to CHANGELOG.md`);
}

/** Splits a changelog body into its top-level `## ` sections. */
function splitSections(body) {
  const sections = [];
  let current = [];

  for (const line of body.split("\n")) {
    if (line.startsWith("## ") && current.length > 0) {
      sections.push(current.join("\n").trim() + "\n");
      current = [];
    }
    current.push(line);
  }

  if (current.length > 0) sections.push(current.join("\n").trim() + "\n");

  return sections;
}

function writeDocsChangelog(version, prettyDate, notes) {
  // Kept in step with the "v<major>.x" sidebar group addDocsNavEntry writes to.
  const dir = join(DOCS_CONTENT_DIR, `v${version.split(".")[0]}`, "changelogs");
  mkdirSync(dir, { recursive: true });

  const file = join(dir, `v${version}.md`);
  const frontmatter = [
    "---",
    `title: v${version} Changelog`,
    `description: See what's new in Kener v${version}, including new features, improvements, and bug fixes`,
    "---",
  ].join("\n");

  writeFileSync(file, `${frontmatter}\n\nRelease date: **${prettyDate}**\n\n${notes}\n`);
  console.log(`wrote docs changelog v${version}.md`);
}

/**
 * Adds the sidebar entry for the new changelog page under the matching
 * "v<major>.x" group, newest first.
 *
 * docs.json is upstream content, so this splices the entry in as text and
 * leaves every other byte of the file alone. Round-tripping it through
 * JSON.parse/stringify would strip the blank lines upstream keeps in there and
 * turn every release into a merge conflict on the next sync.
 */
function addDocsNavEntry(version) {
  const source = readFileSync(DOCS_JSON, "utf8");
  const major = version.split(".")[0];
  const content = `v${major}/changelogs/v${version}`;

  if (source.includes(`"content": "${content}"`)) {
    console.log(`docs.json already lists v${version}`);
    return;
  }

  const tabIndex = source.indexOf('"name": "Changelogs"');
  if (tabIndex === -1) fail('no "Changelogs" tab in docs.json');

  const groupIndex = source.indexOf(`"group": "v${major}.x"`, tabIndex);
  if (groupIndex === -1) fail(`no "v${major}.x" group under the Changelogs tab in docs.json`);

  const pagesMatch = /"pages": \[\n/.exec(source.slice(groupIndex));
  if (!pagesMatch) fail(`no "pages" array in the "v${major}.x" changelog group`);

  const insertAt = groupIndex + pagesMatch.index + pagesMatch[0].length;

  // Match the indentation of whatever entry currently sits first.
  const indent = /^(\s*)/.exec(source.slice(insertAt))[1];
  const entry =
    `${indent}{\n` + `${indent}  "title": "v${version}",\n` + `${indent}  "content": "${content}"\n` + `${indent}},\n`;

  const updated = source.slice(0, insertAt) + entry + source.slice(insertAt);

  // Cheap guard against splicing into the wrong place.
  try {
    JSON.parse(updated);
  } catch (error) {
    fail(`the docs.json edit produced invalid JSON: ${error.message}`);
  }

  writeFileSync(DOCS_JSON, updated);
  console.log(`added docs.json sidebar entry for v${version}`);
}

const args = parseArgs(process.argv.slice(2));
const version = normaliseVersion(args.version);
const notes = readNotes(args.notesFile);
const isoDate = args.date ?? new Date().toISOString().slice(0, 10);
const prettyDate = formatDate(isoDate);

if (!args.skipBump) bumpPackageVersion(version);

writeRootChangelog(version, isoDate, notes);
writeDocsChangelog(version, prettyDate, notes);
addDocsNavEntry(version);

console.log(`apply-release: v${version} applied`);
