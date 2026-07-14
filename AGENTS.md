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

```sh
bun install
bun test
bun run typecheck
bun link          # exposes `org` on PATH
org init
org create edgevector --name "Edge Vector"
org db create edgevector company --name "Company DB"
```

## Venue

Canonical remote: `lastdb:///org`. Review artifacts are LastGit CRs
(`.last-stack/pr-venue` = `lastgit`). Required gate: `.lastgit/ci.sh`.
Do not use GitHub for review. There is no GitHub mirror for this private app
unless a future change adds both an `origin` remote and continuous LastGit to
GitHub mirror sync.
