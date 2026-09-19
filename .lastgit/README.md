# org Forgejo venue

`org` is canonical at `http://localhost:3300/EdgeVector/org.git` and uses
Forgejo pull requests as the review surface. `.last-stack/pr-venue` must stay
`forgejo`, and `.lastgit/ci.sh` is the required `ci-required` gate run by
Forgejo Actions.

GitHub is a read-only public mirror. Do not open pull requests or push to that
mirror. The Forgejo checkout is the source of truth.

Keep the Forgejo workflow and the required `Forge CI / ci-required
(pull_request)` context in sync with the branch protection rules.
