# About this fork

`Gelhaus-Solutions/kener-improved` is a fork of **[rajnandan1/kener](https://github.com/rajnandan1/kener)**,
maintained by Gelhaus Solutions. Upstream is MIT-licensed; the original
copyright and `LICENSE` are preserved unchanged.

This fork **diverges on purpose**. Application code under `src/` and the schema
under `migrations/` are expected to differ from upstream, and that divergence
grows over time as the fork adds features upstream does not carry.

What the fork deliberately does **not** do is rename or rebrand. The product
name, the UI strings, the seeded site data and the documentation content stay
identical to upstream. Cosmetic churn is what makes syncing expensive: it
collides with every upstream edit while adding nothing, whereas a real feature
change only collides with upstream work in the same place. Keeping the naming
identical is exactly what buys the freedom to diverge everywhere else.

Nothing here is contributed back upstream. The sync runs in one direction and
continues indefinitely; conflicts in `src/` and `migrations/` are resolved by
hand on each sync PR.

## Staying current with upstream

A scheduled workflow, [`.github/workflows/sync-upstream.yml`](.github/workflows/sync-upstream.yml),
runs daily at 04:17 UTC (and on demand via **Actions → Sync with upstream → Run
workflow**). It merges `rajnandan1/kener@main` into a `sync/upstream-<date>-<run>`
branch and opens a pull request labelled `upstream-sync`.

It never pushes to `main`. Every upstream change lands through a reviewable PR
that CI runs against.

If a sync PR is still open, the next scheduled run **skips** rather than opening
a second one - stacking a merge on top of an unreviewed merge makes conflicts
much harder to read. Merge or close the open PR and the next run proceeds.

### Running a sync locally

```bash
npm run sync:upstream          # merges upstream/main into the current branch
```

Run it from a clean working tree, on a throwaway branch.

> **Node 24+ required.** `.npmrc` sets `engine-strict=true` and `package.json`
> pins `node >=24.14.0`, so the lockfile regeneration step fails outright on an
> older Node. The sync still completes and reports a warning naming the version
> mismatch - but you will need a matching Node (or CI, which runs 24) to produce
> the lockfile.

Environment overrides:

| Variable              | Default                                    | Purpose                              |
| --------------------- | ------------------------------------------ | ------------------------------------ |
| `UPSTREAM_URL`        | `https://github.com/rajnandan1/kener.git`  | Where upstream lives                 |
| `UPSTREAM_BRANCH`     | `main`                                     | Branch to merge                      |
| `UPSTREAM_REMOTE`     | `upstream`                                 | Local remote name                    |
| `SKIP_LOCKFILE_REGEN` | unset                                      | Set to `1` to skip `npm install`     |

## What gets resolved automatically

The sync is only allowed to settle conflicts that are mechanical - where the
"right" answer follows from a rule, not from judgement. Everything else is
handed to a human.

### `package.json` - three-way JSON merge

[`scripts/merge-package-json.mjs`](scripts/merge-package-json.mjs) reads the
three conflict stages out of the git index and merges them per key instead of
per line, so a dependency bump upstream and a dependency addition here no longer
collide:

- **Fork-owned keys** (`repository`, `bugs`, `homepage`, `funding`, `version`) -
  our value always wins, silently. `version` is fork-owned because the fork does
  not adopt upstream releases; see [Releases](#releases).
- **Upstream-owned keys** - none. The mechanism still exists in the script, but
  nothing uses it.
- **Everything else** - a real three-way merge. If only one side changed a key,
  that change is taken. If both sides changed it identically, fine. Arrays of
  strings (`keywords`) are union-merged, honouring removals from either side.
- **Anything genuinely contested** - the script exits non-zero, naming the exact
  key path (e.g. `scripts.build`), and the file keeps its conflict markers.

Owned keys are aligned across all three stages *before* the merge runs, so keys
stay in their original position rather than shuffling to the end of the file on
every sync.

### `package-lock.json` - regenerated, never merged

A lockfile conflict is meaningless to resolve by hand. The sync takes upstream's
lockfile, then runs `npm install --package-lock-only` against the freshly merged
`package.json`, which keeps upstream's pinned versions and adds whatever the
fork depends on. Skipped if `package.json` itself is still conflicted, since the
regeneration would be based on a broken file.

### Fork-owned files - `merge=ours`

Files listed in [`.gitattributes`](.gitattributes) under *Fork-owned files* use
the `ours` merge driver: upstream edits to them are dropped instead of raising a
conflict on every sync. These are files the fork has rewritten wholesale, where
an upstream diff has nothing useful to contribute.

> The `ours` driver is registered by `scripts/sync-upstream.sh`
> (`git config merge.ours.driver true`). It is repo-local config, so **a plain
> `git merge upstream/main` will not honour it** - always sync through the
> script or the workflow.

### Files the fork deleted

If upstream edits a file this fork removed on purpose, git raises a
modify/delete conflict. The sync keeps the deletion.

## What is *not* resolved automatically

Source conflicts in `src/`, `migrations/`, `scripts/` and everywhere else. When
the sync hits one, it still commits and opens the PR - **with the conflict
markers in the tree** - and labels it `needs-manual-resolution`, listing the
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
| `package.json` `version`   | Fork-owned; the fork releases on its own schedule and numbers          |
| `README.md`                | Fork notice at the top; upstream content otherwise                     |
| `.github/FUNDING.yml`      | Emptied - sponsor upstream directly, not this fork                     |
| `.github/workflows/publish-*.yml` | Publish to GHCR only; no Docker Hub, no cosign signing         |
| `.github/workflows/create-release.yml` | Uses `GITHUB_TOKEN` instead of upstream's `RELEASE_TOKEN` |
| `.github/ISSUE_TEMPLATE/`  | No upstream assignee                                                   |
| `docs/agents/issue-tracker.md` | Points at the Plane project, not GitHub Issues                     |
| `docs/agents/triage-labels.md` | States that triage labels are unused                               |
| `CLAUDE.md`, `AGENTS.md`   | Fork-specific agent instructions; no upstream counterpart              |
| `docs/adr/`                | ADRs reconstructed by the fork, numbered from 0100                     |
| `src/**`, `migrations/**`  | Diverge by design; conflicts are resolved by hand on each sync         |
| `LICENSE`, product name, UI strings, docs content | **Unchanged** - the fork does not rebrand       |

Not every row here is `merge=ours`. A file is *fork-owned* only when an upstream
diff to it has nothing useful to contribute, and those are the rows that also
appear in `.gitattributes`. `src/**` and `migrations/**` diverge but are still
merged normally, because upstream changes there are worth reading.

Adding a divergence? Add it to the table above, and to `.gitattributes` as well
if the fork owns the file outright.

## Optional repository setup

Neither is required; the sync works without both.

- **`SYNC_TOKEN` secret** - a PAT with `repo` scope. GitHub suppresses workflow
  runs on PRs opened by the default `GITHUB_TOKEN`, so without this the sync PR
  arrives with no CI results and you have to close/reopen it to get them. With
  it, `test.yml` runs on every sync PR.
- **GHCR packages** - the image workflows push to
  `ghcr.io/gelhaus-solutions/kener-improved` using the built-in `GITHUB_TOKEN`.
  New packages default to private; make them public in the repo's *Packages*
  settings if you want to pull without authenticating.

## Releases

**The fork does not adopt upstream releases.** Upstream tagging 4.2.0 is not an
event here: no version bump, no release, nothing to do. The code from that
release arrives the same way every other upstream change does, through the next
sync PR, and lands under whatever version this fork is on.

What the fork took from upstream is the release *machinery*, not the releases.
[`.github/workflows/create-release.yml`](.github/workflows/create-release.yml)
is adapted from upstream's: a manual **Actions -> Create Release -> Run
workflow** with an explicit version, which bumps `package.json`, tags, and cuts
the GitHub release. The fork numbers on its own schedule.

Two consequences worth stating plainly, because both used to be the other way
round:

- `version` in `package.json` is **fork-owned** in the sync merge. An upstream
  version bump never moves ours.
- The fork's version number carries **no relationship** to upstream's. Do not
  read it as "based on upstream 4.1.5", and do not bump it to match upstream.

The older release pipeline this fork inherited is fully resolved and gone; the
workflow above is the only one.

## Nothing is contributed back

This fork does not open pull requests against
[rajnandan1/kener](https://github.com/rajnandan1/kener). Fix things here, on a
branch off this fork's `main`, including fixes that are not fork-specific. The
sync is one-directional by decision, not by oversight.

Upstream bugs that this fork also carries may still be *reported* upstream, so
an upstream fix arrives on the next sync. Reporting is not contributing.
