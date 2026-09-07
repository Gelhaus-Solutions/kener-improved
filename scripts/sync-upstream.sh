#!/usr/bin/env bash
#
# Merge upstream (rajnandan1/kener) into this fork, auto-resolving the classes
# of conflict that a fork produces mechanically rather than meaningfully.
#
# Leaves the merge staged but uncommitted decisions visible: anything it cannot
# resolve is committed *with* conflict markers so the sync PR shows exactly what
# needs a human. Run it from a clean working tree.
#
#   ./scripts/sync-upstream.sh
#
# Env:
#   UPSTREAM_URL        default https://github.com/rajnandan1/kener.git
#   UPSTREAM_BRANCH     default main
#   UPSTREAM_REMOTE     default upstream
#   SKIP_LOCKFILE_REGEN set to 1 to skip `npm install` (offline runs)

set -euo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/rajnandan1/kener.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"

cd "$(git rev-parse --show-toplevel)"

AUTO_RESOLVED=()
WARNINGS=()

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# Emit a step output when running under GitHub Actions; no-op locally.
emit() {
	[ -n "${GITHUB_OUTPUT:-}" ] || return 0
	printf '%s<<__SYNC_EOF__\n%s\n__SYNC_EOF__\n' "$1" "$2" >>"$GITHUB_OUTPUT"
}

finish() {
	emit "status" "$1"
	emit "has_changes" "$2"
	emit "upstream_sha" "${UPSTREAM_SHA:-}"
	emit "commit_count" "${COMMIT_COUNT:-0}"
	emit "auto_resolved" "$(printf '%s\n' "${AUTO_RESOLVED[@]+"${AUTO_RESOLVED[@]}"}")"
	emit "conflicts" "${REMAINING:-}"
	emit "warnings" "$(printf '%s\n' "${WARNINGS[@]+"${WARNINGS[@]}"}")"
	emit "branch" "${SYNC_BRANCH:-}"
}

# --- Locate upstream -------------------------------------------------------

if git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
	git remote set-url "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
else
	git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

log "Fetching $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

UPSTREAM_SHA="$(git rev-parse "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")"
COMMIT_COUNT="$(git rev-list --count "HEAD..$UPSTREAM_SHA")"

if [ "$COMMIT_COUNT" -eq 0 ]; then
	log "Already up to date with upstream ($(git rev-parse --short "$UPSTREAM_SHA"))."
	finish "up-to-date" "false"
	exit 0
fi

log "$COMMIT_COUNT upstream commit(s) to merge."

# --- Merge -----------------------------------------------------------------

# Register the trivial "keep ours" driver that .gitattributes refers to for
# fork-owned files. Without this, git silently falls back to a normal merge.
git config merge.ours.driver true

git merge --no-ff --no-commit "$UPSTREAM_SHA" >/dev/null 2>&1 || true

# --- Auto-resolve ----------------------------------------------------------

conflicted() { git diff --name-only --diff-filter=U; }

LOCKFILE_CONFLICTED=0

while IFS= read -r file; do
	[ -n "$file" ] || continue

	# Stage numbers present for this path: 1=base, 2=ours, 3=theirs.
	stages="$(git ls-files -u -- "$file" | awk '{print $3}' | sort -u | tr '\n' ' ')"

	case "$file" in
	package-lock.json)
		LOCKFILE_CONFLICTED=1
		continue
		;;
	package.json)
		if node scripts/merge-package-json.mjs package.json; then
			git add package.json
			AUTO_RESOLVED+=("package.json (three-way JSON merge)")
		else
			log "package.json needs manual resolution."
		fi
		continue
		;;
	esac

	# Modify/delete conflicts where the fork deliberately deleted the file.
	# Upstream edits to a file we removed on purpose should not resurrect it.
	if ! printf '%s' "$stages" | grep -q '2'; then
		git rm --quiet --force -- "$file"
		AUTO_RESOLVED+=("$file (kept fork deletion)")
		continue
	fi
done < <(conflicted)

# The lockfile is generated, never hand-merged. Start from upstream's copy so
# their pinned versions survive, then regenerate against the merged
# package.json to pick up anything the fork adds.
if [ "$LOCKFILE_CONFLICTED" -eq 1 ]; then
	if [ "${SKIP_LOCKFILE_REGEN:-0}" = "1" ]; then
		log "Skipping lockfile regeneration (SKIP_LOCKFILE_REGEN=1)."
		git checkout --theirs -- package-lock.json 2>/dev/null ||
			git checkout --ours -- package-lock.json 2>/dev/null || true
		git add package-lock.json
		WARNINGS+=("package-lock.json: kept upstream's copy without regenerating (SKIP_LOCKFILE_REGEN=1). Run \`npm install\` and commit.")
	elif git diff --name-only --diff-filter=U | grep -qx 'package.json'; then
		log "package.json still conflicted; leaving package-lock.json for manual resolution."
	else
		log "Regenerating package-lock.json"
		git checkout --theirs -- package-lock.json 2>/dev/null ||
			git checkout --ours -- package-lock.json 2>/dev/null || true
		git add package-lock.json
		# Must not be fatal: a registry hiccup or an unpublished version should
		# still produce a reviewable PR rather than aborting the sync entirely.
		NPM_LOG="$(mktemp)"
		if npm install --package-lock-only --ignore-scripts --no-audit --no-fund >"$NPM_LOG" 2>&1; then
			AUTO_RESOLVED+=("package-lock.json (regenerated)")
		else
			log "npm install --package-lock-only failed; keeping upstream's lockfile."
			tail -20 "$NPM_LOG" | sed 's/^/    /'
			NPM_CODE="$(sed -n 's/^npm error code //p' "$NPM_LOG" | head -1)"
			if [ "$NPM_CODE" = "EBADENGINE" ]; then
				# .npmrc sets engine-strict, so an older local Node fails outright.
				REQUIRED="$(node -p 'require("./package.json").engines.node' 2>/dev/null || echo "?")"
				WARNINGS+=("package-lock.json: not regenerated — this repo pins node \"$REQUIRED\" with engine-strict, but the sync ran on $(node -v). Re-run on a matching Node and commit the lockfile.")
			else
				WARNINGS+=("package-lock.json: regeneration failed (${NPM_CODE:-see workflow log}), so upstream's lockfile was kept and may not match the merged package.json. Run \`npm install\` and commit.")
			fi
		fi
		rm -f "$NPM_LOG"
		git add package-lock.json
	fi
fi

# --- Commit ----------------------------------------------------------------

REMAINING="$(conflicted)"
SHORT_SHA="$(git rev-parse --short "$UPSTREAM_SHA")"

if [ -n "$REMAINING" ]; then
	log "Unresolved conflicts:"
	printf '  - %s\n' $REMAINING
	# Stage the marker-bearing files so the merge can be committed and pushed;
	# the PR then carries the conflicts for a human to settle.
	git add -A
	MESSAGE="chore(sync): merge upstream $SHORT_SHA (conflicts need resolution)"
else
	git add -A
	MESSAGE="chore(sync): merge upstream $SHORT_SHA"
fi

git commit --quiet --no-verify -m "$MESSAGE" -m "Merges $COMMIT_COUNT commit(s) from $UPSTREAM_URL@$UPSTREAM_BRANCH."

if [ ${#WARNINGS[@]} -gt 0 ]; then
	log "Warnings:"
	printf '  ! %s\n' "${WARNINGS[@]}"
fi

if [ -n "$REMAINING" ]; then
	finish "conflicts" "true"
elif [ ${#WARNINGS[@]} -gt 0 ]; then
	log "Merged, with warnings."
	finish "warnings" "true"
else
	log "Merged cleanly."
	finish "merged" "true"
fi
