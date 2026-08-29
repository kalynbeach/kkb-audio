# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues.

## Tool selection

Use the GitHub integration native to the active agent:

- **Pi**: use the `gh` CLI.
- **Codex**: use its GitHub plugin or connector. Do not default to `gh` when the connector supports the operation.
- **Fallback**: if the active agent's GitHub integration cannot perform an operation, use `gh` when it is available.

The commands below show the `gh` equivalents for Pi. Codex should perform the same operations through its GitHub connector.

## Conventions

- **Create an issue**: create an issue with the supplied title and body. Pi uses `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: fetch its body, comments, and labels. Pi uses `gh issue view <number> --comments`, filtering comments with `jq` when needed and also fetching labels.
- **List issues**: fetch the requested issue fields with the appropriate label and state filters. Pi uses `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`.
- **Comment on an issue**: add the supplied comment. Pi uses `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: update the issue's labels. Pi uses `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue**: close it with the supplied explanation. Pi uses `gh issue close <number> --comment "..."`.

Pi infers the repository from `git remote -v`; `gh` does this automatically inside a clone. Codex should target the repository identified by the current clone's remote.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues:

- **Read a PR**: fetch its metadata, comments, and diff. Pi uses `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external PRs for triage**: fetch open PRs with their metadata, labels, authors, author associations, and comments. Keep only `authorAssociation` values of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`. Pi uses `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`.
- **Comment, label, or close**: perform the corresponding PR operation. Pi uses `gh pr comment`, `gh pr edit --add-label` or `--remove-label`, and `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either. Resolve its type through the active GitHub integration. Pi uses `gh pr view 42` and falls back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue through the active agent's GitHub integration.

## When a skill says "fetch the relevant ticket"

Fetch the GitHub issue's body, comments, and labels through the active agent's GitHub integration. Pi uses `gh issue view <number> --comments` and fetches labels as needed.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: create a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. Pi uses `gh issue create --label wayfinder:map`.
- **Child ticket**: create an issue and link it to the map as a GitHub sub-issue. Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Apply a `wayfinder:<type>` label using `research`, `prototype`, `grilling`, or `task`. Once claimed, assign the ticket to the driving developer. Pi uses `gh api` for the sub-issues endpoint.
- **Blocking**: use GitHub's native issue dependencies. Pi adds an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric database ID from `gh api repos/<owner>/<repo>/issues/<n> --jq .id`, not its issue number or `node_id`. GitHub reports open blockers in `issue_dependencies_summary.blocked_by`. Where dependencies aren't available, add `Blocked by: #<n>, #<n>` at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, drop any with an open blocker or assignee, and take the first in map order. Pi uses `gh issue list --state open`, scopes the results to the map's children or task list, and checks `issue_dependencies_summary.blocked_by` or the fallback `Blocked by` line.
- **Claim**: assign the ticket to the active developer before starting work. Pi uses `gh issue edit <n> --add-assignee @me`. This is the session's first write.
- **Resolve**: comment with the answer, close the ticket, then append a context pointer with a gist and link to the map's Decisions-so-far. Pi uses `gh issue comment <n> --body "<answer>"` followed by `gh issue close <n>`.
