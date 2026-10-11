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
