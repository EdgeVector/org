<!-- last-stack:generated-evidence:start (managed by last-stack setup; edits inside are overwritten) -->
## Keep raw output outside Git (Tom, 2026-10-23)

- Do not commit raw logs, samples, request/reply dumps, generated receipts, or compressed copies.
- Use the CI summary and artifacts as the validation record. Link the run in the PR.
- Do not create a separate report or `artifact.json` for routine CI. This rule replaces older proof-file requirements.
- Keep useful source scripts and durable design conclusions in Git. Optional evidence files have a cap of 10 files and 100,000 bytes per PR.
- CI keeps raw output in the runner's temporary directory. Other output uses a unique directory outside Git. Use `LAST_STACK_EVIDENCE_ROOT`, or `${XDG_STATE_HOME:-$HOME/.local/state}/last-stack/artifacts/<repo>/`.
- CI records the source revision, download URL, checksum, and expiration. Archive selected results when long retention is necessary.
- Keep secrets out of all output. Verify retained output before cleanup.
- Keep the required `generated-evidence` check and output ignores. Do not evade the check. Product-data exceptions require an exact path and reason in the accepted base policy.

Policy: https://github.com/EdgeVector/.github/tree/main/generated-evidence.
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
