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

| Variable              | Default                                   | Purpose                          |
| --------------------- | ----------------------------------------- | -------------------------------- |
| `UPSTREAM_URL`        | `https://github.com/rajnandan1/kener.git` | Where upstream lives             |
| `UPSTREAM_BRANCH`     | `main`                                    | Branch to merge                  |
| `UPSTREAM_REMOTE`     | `upstream`                                | Local remote name                |
| `SKIP_LOCKFILE_REGEN` | unset                                     | Set to `1` to skip `npm install` |

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

Owned keys are aligned across all three stages _before_ the merge runs, so keys
stay in their original position rather than shuffling to the end of the file on
every sync.

### `package-lock.json` - regenerated, never merged

A lockfile conflict is meaningless to resolve by hand. The sync takes upstream's
lockfile, then runs `npm install --package-lock-only` against the freshly merged
`package.json`, which keeps upstream's pinned versions and adds whatever the
fork depends on. Skipped if `package.json` itself is still conflicted, since the
regeneration would be based on a broken file.

### Fork-owned files - `merge=ours`

Files listed in [`.gitattributes`](.gitattributes) under _Fork-owned files_ use
the `ours` merge driver: upstream edits to them are dropped instead of raising a
conflict on every sync. These are files the fork has rewritten wholesale, where
an upstream diff has nothing useful to contribute.

> The `ours` driver is registered by `scripts/sync-upstream.sh`
> (`git config merge.ours.driver true`). It is repo-local config, so **a plain
> `git merge upstream/main` will not honour it** - always sync through the
> script or the workflow.

### When to stop working around an upstream file

The fork's habit is restraint: keep upstream's files as close to upstream as
possible and add beside them instead of inside them. `src/lib/orgPerms.ts` next
to a byte-identical `allPerms.ts`; every fork request handle in
`src/lib/server/http/` so `hooks.server.ts` gains one import and one name in
`sequence(...)`; a handler registry behind a seven-line `+server.ts`. That habit
is what makes a sync cheap, and it is usually right.

**It is a means, not a goal.** The point of keeping a file mergeable is to make
future syncs cheap. When working around a file costs more than the sync it saves,
the trade has inverted and the fork should take the file over.

The test: **if not editing an upstream file would be a medium or major
disadvantage - a feature that cannot be built, a correctness problem, a bug that
stays, or a pile of complexity built solely to avoid one line - then own it
fork-side and move on.** A sync conflict in one file, once, is a small and
predictable cost. Machinery invented to avoid that conflict is an unbounded one,
and it has to be understood by everyone who reads the code afterwards.

Worked example, and the one that prompted this rule:

> **`svelte.config.js` and `paths.relative`.** I3e added an optional
> `/o/<slug>/` organisation prefix so one instance on one hostname can serve
> several tenants. SvelteKit's default emits links relative to the _routed_ path
> while computing depth from the _real_ URL, so every link on a prefixed page
> climbed out of the organisation it belonged to. The fix is one line in
> upstream's `svelte.config.js`: `paths.relative: false`.
>
> Avoiding that line meant either moving every public route under an `[[org]]`
> parameter, or post-processing rendered HTML - both far more invasive, and both
> permanent. The line was taken, the reason written next to it, and a row added
> to the divergence table below.

What owning a file means in practice:

1. **Make the change, and say why at the change**, not only here. The next
   person to read `svelte.config.js` should learn why that line exists without
   opening this document.
2. **Add a row to the divergence table** in _How the fork diverges_.
3. **Decide whether it is also `merge=ours`**, which is a separate question.
   Only when an upstream diff to that file has nothing useful to contribute. A
   one-line divergence in a file upstream still maintains - `svelte.config.js`
   is exactly that - should keep merging normally, so an upstream adapter or
   Vite change still arrives.

The rule does not loosen the one restriction that is not a trade-off: the fork
does not rebrand. Product name, UI strings, seeded site data and docs content
stay identical to upstream, and that restraint is what pays for diverging freely
everywhere else.

### The admin API: reported, not merged

`src/routes/(manage)/manage/api/+server.ts` is upstream's whole admin write
surface, a single ~930-line if/else over about a hundred action strings. The fork
replaced it with a handler registry, so its version of that file is seven lines.
No merge between those two is ever meaningful, and it is `merge=ours`.

That would normally mean silently dropping every upstream change to the admin
API, including new actions. So the sync converts the merge it cannot do into a
to-do list it can: it extracts the action strings from upstream's version,
compares them against the registry, and writes the difference into the PR body
under _Admin actions to reconcile_, naming the file to create for each one. It
then refreshes `docs/agents/upstream-manage-api.snapshot.ts`, which exists only
so the next sync can tell "upstream just added this" from "we never had this".

The other half of that trade is that `src/lib/allPerms.ts` is kept
**byte-identical to upstream**, so a new upstream action arrives with its
permission mapping already correct and the report above is the only manual step.
Fork permissions live in `src/lib/orgPerms.ts` and are merged at the consumers.

### Files the fork deleted

If upstream edits a file this fork removed on purpose, git raises a
modify/delete conflict. The sync keeps the deletion.

## What is _not_ resolved automatically

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

| Area                                                                               | Divergence                                                                                                                         |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                                     | `repository`, `homepage`, `bugs` point here; fork-added `scripts` entries and fork-only dependencies (`pdfkit`, `pg-query-stream`) |
| `package.json` `version`                                                           | Fork-owned; the fork releases on its own schedule and numbers                                                                      |
| `README.md`                                                                        | Fork notice at the top; upstream content otherwise                                                                                 |
| `.github/FUNDING.yml`                                                              | Emptied - sponsor upstream directly, not this fork                                                                                 |
| `.github/workflows/publish-*.yml`                                                  | Publish to GHCR only; no Docker Hub, no cosign signing                                                                             |
| `.github/workflows/create-release.yml`                                             | Uses `GITHUB_TOKEN` instead of upstream's `RELEASE_TOKEN`                                                                          |
| `CHANGELOG.md`                                                                     | Fork-only; the GitHub release body, recorded on publish                                                                            |
| `scripts/apply-release.mjs`                                                        | Applies a published release: version bump plus the changelogs                                                                      |
| `scripts/pg-partition-monitoring-data.ts`                                          | Fork-only: converts `monitoring_data` to a partitioned table (B1a)                                                                 |
| `scripts/rollups-backfill.ts`, `scripts/rollups-verify.ts`                         | Fork-only: build the rollup grains, and check them against raw samples (F6b)                                                       |
| `scripts/retention-plan.ts`                                                        | Fork-only: dry-runs the per-grain retention sweep before it deletes (F6c)                                                          |
| `scripts/check-tenancy.ts`, `scripts/check-org-provisioning.ts`                    | Fork-only: assert the tenancy registration and each org's provisioning against the live schema (Z)                                 |
| `tsconfig.scripts.json`                                                            | Fork-only: puts `scripts/`, `migrations/` and `seeds/` under `npm run check`                                                       |
| `.github/ISSUE_TEMPLATE/`                                                          | No upstream assignee                                                                                                               |
| `docs/agents/issue-tracker.md`                                                     | Points at the Plane project, not GitHub Issues                                                                                     |
| `docs/agents/triage-labels.md`                                                     | States that triage labels are unused                                                                                               |
| `CLAUDE.md`, `AGENTS.md`                                                           | Fork-specific agent instructions; no upstream counterpart                                                                          |
| `docs/adr/`                                                                        | ADRs reconstructed by the fork, numbered from 0100                                                                                 |
| `src/routes/(manage)/manage/api/+server.ts`                                        | 7 lines here vs upstream's ~930; upstream's actions are reported, not merged                                                       |
| `scripts/diff-upstream-actions.mjs`, `docs/agents/upstream-manage-api.snapshot.ts` | The machinery that reports them                                                                                                    |
| `svelte.config.js`                                                                 | `paths.relative: false`, so the `/o/<slug>/` org prefix survives into links                                                        |
| `src/**`, `migrations/**`                                                          | Diverge by design; conflicts are resolved by hand on each sync                                                                     |
| `LICENSE`, product name, UI strings, docs content                                  | **Unchanged** - the fork does not rebrand                                                                                          |

Not every row here is `merge=ours`. A file is _fork-owned_ only when an upstream
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
  New packages default to private; make them public in the repo's _Packages_
  settings if you want to pull without authenticating.

## Releases

**The fork does not adopt upstream releases.** Upstream tagging 4.2.0 is not an
event here: no version bump, no release, nothing to do. The code from that
release arrives the same way every other upstream change does, through the next
sync PR, and lands under whatever version this fork is on.

What the fork took from upstream is the release _machinery_, not the releases.
The fork numbers on its own schedule.

Two consequences worth stating plainly, because both used to be the other way
round:

- `version` in `package.json` is **fork-owned** in the sync merge. An upstream
  version bump never moves ours.
- The fork's version number carries **no relationship** to upstream's. Do not
  read it as "based on upstream 4.1.5", and do not bump it to match upstream.

### Cutting a release

Publishing a GitHub release is the whole trigger. Either create it in the
GitHub UI, or run **Actions -> Create Release -> Run workflow**
([`create-release.yml`](.github/workflows/create-release.yml)), which only
creates the tag and the release with auto-generated notes.

**The release body is the changelog.** Write it in the release form, or press
_Generate release notes_. An empty body fails the workflow, because there would
be nothing to record.

[`publish-release.yml`](.github/workflows/publish-release.yml) then does the
rest, in order:

1. `scripts/apply-release.mjs` bumps `package.json` and `package-lock.json` to
   the tag's version and writes the release body into `CHANGELOG.md`, into
   `src/routes/(docs)/docs/content/v4/changelogs/vX.Y.Z.md`, and into the
   `docs.json` sidebar.
2. It commits that to `main` as `chore(release): vX.Y.Z` and **moves the tag**
   onto the commit, so the tag, the release and the image all describe the same
   tree.
3. It builds and pushes the Docker images.

Two requirements follow from step 2:

- The tag has to be at the head of `main` when the release is published.
  Releasing from an older commit fails the workflow rather than quietly
  widening the release.
- `main` has to accept a push from `github-actions[bot]`. If the branch is
  protected, allow that actor to bypass.

The script is runnable by hand, which is the way to repair a release the
workflow could not finish:

```bash
node scripts/apply-release.mjs --version 4.2.0 --notes-file notes.md
```

It is idempotent: re-running it for a version already applied rewrites that
entry in place rather than stacking a duplicate. That matters because editing
and re-publishing a release fires the workflow again.

Because a release writes into `docs.json` and adds a changelog page, both of
which are upstream content, a sync can conflict there. The `docs.json` edit is a
minimal text splice specifically so the conflict stays small. A changelog
_filename_ collision - upstream releasing the same version number this fork
already used - is resolved by hand.

### Docker images

Published to GHCR only, `linux/amd64` only, Debian base (`node:24-slim`). The
`-w-docs` variants bundle the documentation site.

There is no `arm64` image. Building one on a GitHub-hosted runner means QEMU
emulation, which is slow enough to dominate the release; add an `arm64` runner
to the matrix if the platform is wanted back, rather than re-enabling emulation.

| Tag                         | Built by                                    |
| --------------------------- | ------------------------------------------- |
| `:main`, `:main-w-docs`     | every push to `main`, ungated by tests      |
| `:main-<sha>`               | same build, pinned to the commit            |
| `:latest`, `:latest-w-docs` | a published, non-pre-release GitHub release |
| `:X.Y.Z`, `:vX.Y.Z`         | every published release, pre-releases too   |

A pre-release publishes its version tags but never moves `:latest`.

## Nothing is contributed back

This fork does not open pull requests against
[rajnandan1/kener](https://github.com/rajnandan1/kener). Fix things here, on a
branch off this fork's `main`, including fixes that are not fork-specific. The
sync is one-directional by decision, not by oversight.

Upstream bugs that this fork also carries may still be _reported_ upstream, so
an upstream fix arrives on the next sync. Reporting is not contributing.
