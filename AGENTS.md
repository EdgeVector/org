<!-- last-stack:generated-evidence:start (managed by last-stack setup; edits inside are overwritten) -->
## Keep raw evidence outside Git (Tom, 2026-10-23)

- Do not commit raw logs, timing samples, request/reply dumps, generated receipts, or compressed copies.
- This rule overrides an older instruction to commit every proof file or preserve raw output in Git.
- Keep raw output outside the source tree, under `LAST_STACK_EVIDENCE_ROOT` when set.
- The default root is `${XDG_STATE_HOME:-$HOME/.local/state}/last-stack/artifacts/<repo>/`.
- Use a unique directory for each run. Benchmark defaults must use this root or the CI runner's temporary directory.
- Add ignored output directories as a local guard. An ignore rule does not exempt a committed file from CI.
- Commit a short Markdown report, useful source scripts, and an optional compact `artifact.json`.
- State the result, method, source revisions, commands, and limits in the report.
- Upload raw output as a workflow artifact. Use a durable archive when review or recovery needs long retention.
- Record the download URL, SHA-256, source revision, and retention period. Verify the upload before local cleanup.
- Keep secrets out of reports, receipts, and uploaded output.
- A PR permits at most 10 changed evidence files and 100,000 total evidence bytes.
- The required `generated-evidence` check reads committed files. Force-add and compression do not override it.
- Unchanged historical output and deletions do not count. Product JSON configuration remains permitted.
- An intentional product data exception needs an exact path and a reason in the accepted base policy.
- Do not weaken the check, split output across small files, or move it to another PR to evade the rule.

Policy and receipt format: `https://github.com/EdgeVector/.github/tree/main/generated-evidence`.
<!-- last-stack:generated-evidence:end -->

<!-- last-stack:no-tests:start -->
## No tests or test coverage requirements (Tom, 2026-10-09)

Situation: `no-tests-all-repos-20261009`.
Decision: `decision-2026-10-09-retire-all-tests-and-test-coverage`.

- Do not write, add, run, restore, or require tests.
- Remove tests and test coverage requirements from CI and all linters.
- Remove earlier test requirements from agent rules, skills, and routines when found.
- This rule supersedes fixture-test, mutation-probe, coverage, and test-gate rules.
- Keep product code and non-test build, format, lint, secret, and deployment checks.
<!-- last-stack:no-tests:end -->

# Org App — Agent Instructions

## Secrets

- Org E2E keys and org private keys go through **LastSecrets only**.
- Store with `lastsecrets put ... --value-stdin` (the `org` CLI does this for you).
- Persist only `lastsecrets://org-<slug>-e2e` (and `lastsecrets://org-<slug>-private`)
  locators in Brain, Kanban, docs, logs, PRs, and source.
- Invite files (`org invite --out`) contain a raw e2e key — treat like a secret,
  mode 0600, delete after join.

## Cohabitation model

- One LastDB Mini node per user (no per-app `lastdbd`).
- Org metadata and named shared DBs are `org/*` schemas on that same node.
- Personal brain/kanban data stays separate by app namespace; org records use
  `owner_app_id: org` and route by `org_hash`.

## Local loop

The tests are deleted (Tom, 2026-10-09). The gate runs the typecheck.

```sh
bun install
bun run typecheck
bun link          # exposes `org` on PATH
org init
org create edgevector --name "Edge Vector"
org db create edgevector company --name "Company DB"
```

## Venue

- GitHub is the source and review host for `EdgeVector/org`.
- `.last-stack/pr-venue` is `github`. Use `gh` for product PRs.
- The required `ci-required` job runs `.lastgit/ci.sh` for the non-test checks.
- The old Forgejo copy is frozen.
