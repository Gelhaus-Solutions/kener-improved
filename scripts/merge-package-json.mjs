#!/usr/bin/env node
/**
 * Three-way merge for package.json during an upstream sync.
 *
 * Reads the three conflict stages straight out of the git index
 * (:1 = merge base, :2 = ours/fork, :3 = theirs/upstream) and writes a
 * resolved package.json. Exits non-zero and leaves the file untouched when
 * something genuinely needs a human.
 *
 * Usage: node scripts/merge-package-json.mjs [path]
 */

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const FILE = process.argv[2] ?? "package.json"

/** Marker for "this key does not exist at this stage". */
const MISSING = Symbol("missing")

/**
 * Keys the fork owns outright. Our value always wins, and upstream edits to
 * them are dropped silently rather than reported as a conflict.
 */
const FORK_OWNED_KEYS = ["repository", "bugs", "homepage", "funding"]

/**
 * Keys where upstream is authoritative. Notably `version`: the fork tracks
 * upstream release numbers, so a version bump on both sides is not a conflict.
 */
const UPSTREAM_OWNED_KEYS = ["version"]

function readStage(stage) {
	try {
		const raw = execFileSync("git", ["show", `:${stage}:${FILE}`], {
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024
		})
		return JSON.parse(raw)
	} catch {
		return MISSING
	}
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function equal(a, b) {
	if (a === MISSING || b === MISSING) return a === b
	return JSON.stringify(a) === JSON.stringify(b)
}

const conflicts = []
const notes = []

/**
 * Union merge for arrays of primitives (`keywords`, `files`, ...): keep every
 * entry either side added, drop every entry either side removed. Arrays
 * holding objects are treated as atomic instead, since positional merging
 * would produce nonsense.
 */
function mergeArray(base, ours, theirs, path) {
	const primitive = (arr) => arr.every((v) => v === null || typeof v !== "object")
	if (!primitive(ours) || !primitive(theirs) || (base !== MISSING && !primitive(base))) {
		conflicts.push(path)
		return MISSING
	}

	const baseArr = base === MISSING ? [] : base
	const removed = new Set([
		...baseArr.filter((v) => !ours.includes(v)),
		...baseArr.filter((v) => !theirs.includes(v))
	])

	const out = []
	for (const value of [...theirs, ...ours]) {
		if (removed.has(value) || out.includes(value)) continue
		out.push(value)
	}
	notes.push(`${path}: union-merged (${out.length} entries)`)
	return out
}

function merge(base, ours, theirs, path) {
	// Nobody disagrees, or only one side moved.
	if (equal(ours, theirs)) return ours
	if (equal(base, ours)) return theirs
	if (equal(base, theirs)) return ours

	// Both sides changed. Recurse if the shapes allow it.
	if (isPlainObject(ours) && isPlainObject(theirs)) {
		const baseObj = isPlainObject(base) ? base : {}
		// Upstream key order first so the file keeps drifting toward upstream's
		// layout; fork-only keys are appended after.
		const keys = [...new Set([...Object.keys(theirs), ...Object.keys(baseObj), ...Object.keys(ours)])]

		const out = {}
		for (const key of keys) {
			const childPath = path ? `${path}.${key}` : key
			const merged = merge(
				key in baseObj ? baseObj[key] : MISSING,
				key in ours ? ours[key] : MISSING,
				key in theirs ? theirs[key] : MISSING,
				childPath
			)
			if (merged !== MISSING) out[key] = merged
		}
		return out
	}

	if (Array.isArray(ours) && Array.isArray(theirs)) {
		return mergeArray(base, ours, theirs, path)
	}

	conflicts.push(path)
	return MISSING
}

const baseRaw = readStage(1)
const ours = readStage(2)
const theirs = readStage(3)

if (ours === MISSING || theirs === MISSING) {
	console.error(`[merge-package-json] ${FILE}: missing conflict stages; not a two-sided conflict.`)
	process.exit(2)
}

const base = baseRaw === MISSING ? {} : baseRaw

/**
 * Copy `key` from `src` onto `dest` (deleting it when `src` lacks it), so that
 * an owned key looks unchanged to the structural merge below. Deciding
 * ownership up front — rather than overwriting the merge result afterwards —
 * keeps the key in its original position instead of shuffling it to the end of
 * the file on every sync.
 */
function align(dest, key, src) {
	if (key in src) dest[key] = src[key]
	else delete dest[key]
}

for (const key of FORK_OWNED_KEYS) {
	if (!equal(key in ours ? ours[key] : MISSING, key in theirs ? theirs[key] : MISSING)) {
		notes.push(`${key}: kept fork value`)
	}
	align(base, key, ours)
	align(theirs, key, ours)
}

for (const key of UPSTREAM_OWNED_KEYS) {
	if (!equal(key in ours ? ours[key] : MISSING, key in theirs ? theirs[key] : MISSING)) {
		notes.push(`${key}: took upstream value ${JSON.stringify(theirs[key])}`)
	}
	align(base, key, theirs)
	align(ours, key, theirs)
}

const merged = merge(base, ours, theirs, "")

if (conflicts.length > 0) {
	console.error(`[merge-package-json] ${FILE}: cannot auto-resolve:`)
	for (const path of conflicts) console.error(`  - ${path}`)
	process.exit(1)
}

// Match the existing file's trailing-newline convention.
const existing = (() => {
	try {
		return readFileSync(FILE, "utf8")
	} catch {
		return "\n"
	}
})()
writeFileSync(FILE, JSON.stringify(merged, null, 2) + (existing.endsWith("\n") ? "\n" : ""))

console.log(`[merge-package-json] ${FILE}: resolved automatically.`)
for (const note of notes) console.log(`  - ${note}`)
