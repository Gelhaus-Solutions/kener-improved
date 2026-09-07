# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in
[`Gelhaus-Solutions/kener-improved`](https://github.com/Gelhaus-Solutions/kener-improved/issues).
Use the `gh` CLI for all operations.

This is a fork (see [FORK.md](../../FORK.md)). A bug that also exists upstream in
`rajnandan1/kener` belongs upstream — file it there so the fix reaches everyone
and arrives here on the next sync. Track fork-specific work here.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

This clone has two remotes (`origin` and `upstream`), so `gh` cannot always infer
the target. Pass it explicitly:

```bash
gh issue list --repo Gelhaus-Solutions/kener-improved
```

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
