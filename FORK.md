# About this fork

`Gelhaus-Solutions/kener-improved` is a fork of **[rajnandan1/kener](https://github.com/rajnandan1/kener)**,
maintained by Gelhaus Solutions. Upstream is MIT-licensed; the original
copyright and `LICENSE` are preserved unchanged.

This is a **soft fork**. It deliberately keeps the product, its name, its UI
strings and its documentation identical to upstream, and diverges only where a
fork must: repository metadata, CI targets, and the sync tooling below. Keeping
the divergence small is what makes staying current with upstream cheap.

## Staying current with upstream

A scheduled workflow, [`.github/workflows/sync-upstream.yml`](.github/workflows/sync-upstream.yml),
runs daily at 04:17 UTC (and on demand via **Actions → Sync with upstream → Run
workflow**). It merges `rajnandan1/kener@main` into a `sync/upstream-<date>-<run>`
branch and opens a pull request labelled `upstream-sync`.

It never pushes to `main`. Every upstream change lands through a reviewable PR
that CI runs against.

If a sync PR is still open, the next scheduled run **skips** rather than opening
a second one — stacking a merge on top of an unreviewed merge makes conflicts
much harder to read. Merge or close the open PR and the next run proceeds.

### Running a sync locally

```bash
npm run sync:upstream          # merges upstream/main into the current branch
```

Run it from a clean working tree, on a throwaway branch.

> **Node 24+ required.** `.npmrc` sets `engine-strict=true` and `package.json`
> pins `node >=24.14.0`, so the lockfile regeneration step fails outright on an
> older Node. The sync still completes and reports a warning naming the version
> mismatch — but you will need a matching Node (or CI, which runs 24) to produce
> the lockfile.

Environment overrides:

| Variable              | Default                                    | Purpose                              |
| --------------------- | ------------------------------------------ | ------------------------------------ |
| `UPSTREAM_URL`        | `https://github.com/rajnandan1/kener.git`  | Where upstream lives                 |
| `UPSTREAM_BRANCH`     | `main`                                     | Branch to merge                      |
| `UPSTREAM_REMOTE`     | `upstream`                                 | Local remote name                    |
| `SKIP_LOCKFILE_REGEN` | unset                                      | Set to `1` to skip `npm install`     |

## What gets resolved automatically

The sync is only allowed to settle conflicts that are mechanical — where the
"right" answer follows from a rule, not from judgement. Everything else is
handed to a human.

### `package.json` — three-way JSON merge

[`scripts/merge-package-json.mjs`](scripts/merge-package-json.mjs) reads the
three conflict stages out of the git index and merges them per key instead of
per line, so a dependency bump upstream and a dependency addition here no longer
collide:

- **Fork-owned keys** (`repository`, `bugs`, `homepage`, `funding`) — our value
  always wins, silently.
- **Upstream-owned keys** (`version`) — upstream's value always wins. The fork
  tracks upstream release numbers, so a version bump on both sides is not a
  conflict.
- **Everything else** — a real three-way merge. If only one side changed a key,
  that change is taken. If both sides changed it identically, fine. Arrays of
  strings (`keywords`) are union-merged, honouring removals from either side.
- **Anything genuinely contested** — the script exits non-zero, naming the exact
  key path (e.g. `scripts.build`), and the file keeps its conflict markers.

Owned keys are aligned across all three stages *before* the merge runs, so keys
stay in their original position rather than shuffling to the end of the file on
every sync.

### `package-lock.json` — regenerated, never merged

A lockfile conflict is meaningless to resolve by hand. The sync takes upstream's
lockfile, then runs `npm install --package-lock-only` against the freshly merged
`package.json`, which keeps upstream's pinned versions and adds whatever the
fork depends on. Skipped if `package.json` itself is still conflicted, since the
regeneration would be based on a broken file.

### Fork-owned files — `merge=ours`

Files listed in [`.gitattributes`](.gitattributes) under *Fork-owned files* use
the `ours` merge driver: upstream edits to them are dropped instead of raising a
conflict on every sync. These are files the fork has rewritten wholesale, where
an upstream diff has nothing useful to contribute.

> The `ours` driver is registered by `scripts/sync-upstream.sh`
> (`git config merge.ours.driver true`). It is repo-local config, so **a plain
> `git merge upstream/main` will not honour it** — always sync through the
> script or the workflow.

### Files the fork deleted

If upstream edits a file this fork removed on purpose, git raises a
modify/delete conflict. The sync keeps the deletion.

## What is *not* resolved automatically

Source conflicts in `src/`, `migrations/`, `scripts/` and everywhere else. When
the sync hits one, it still commits and opens the PR — **with the conflict
markers in the tree** — and labels it `needs-manual-resolution`, listing the
affected files in the PR body. That way the merge is already staged and you only
have to settle the disputed hunks:

```bash
git fetch origin
git checkout sync/upstream-<date>-<run>
grep -rn '^<<<<<<<' --exclude-dir=.git .   # find what is left
# fix, then:
git commit -am "fix(sync): resolve conflicts in <files>"
git push
```

## How the fork diverges

| Area                       | Divergence                                                            |
| -------------------------- | --------------------------------------------------------------------- |
| `package.json`             | `repository`, `homepage`, `bugs` point here; `sync:upstream` script    |
| `README.md`                | Fork notice at the top; upstream content otherwise                     |
| `.github/FUNDING.yml`      | Emptied — sponsor upstream directly, not this fork                     |
| `.github/workflows/publish-*.yml` | Publish to GHCR only; no Docker Hub, no cosign signing         |
| `.github/workflows/create-release.yml` | Uses `GITHUB_TOKEN` instead of upstream's `RELEASE_TOKEN` |
| `.github/ISSUE_TEMPLATE/`  | No upstream assignee                                                   |
| `docs/agents/issue-tracker.md` | Points at this repo's issues                                       |
| `LICENSE`, `src/**`, docs content | **Unchanged** — kept identical to upstream on purpose           |

Adding a divergence? If it is a file the fork owns outright, add it to
`.gitattributes` and to the table above.

## Optional repository setup

Neither is required; the sync works without both.

- **`SYNC_TOKEN` secret** — a PAT with `repo` scope. GitHub suppresses workflow
  runs on PRs opened by the default `GITHUB_TOKEN`, so without this the sync PR
  arrives with no CI results and you have to close/reopen it to get them. With
  it, `test.yml` runs on every sync PR.
- **GHCR packages** — the image workflows push to
  `ghcr.io/gelhaus-solutions/kener-improved` using the built-in `GITHUB_TOKEN`.
  New packages default to private; make them public in the repo's *Packages*
  settings if you want to pull without authenticating.

## Contributing back

Fixes that are not fork-specific belong upstream. Branch from `upstream/main`
rather than from this fork's `main`, and open the PR against
[rajnandan1/kener](https://github.com/rajnandan1/kener) so everyone benefits and
the fix arrives here on the next sync anyway.
