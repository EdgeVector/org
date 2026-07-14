# org LastGit venue

`org` is canonical at `lastdb:///org` and uses LastGit change requests as the
review surface. `.last-stack/pr-venue` must stay `lastgit`, and `.lastgit/ci.sh`
is the required `ci-required` gate.

There is currently no GitHub mirror for this private app. That is intentional:
there is no `origin` remote in the canonical checkout and no `.github/workflows`
tree to keep inert.

If a GitHub remote is added later, add LastGit to GitHub mirror automation in
the same change before committing any GitHub workflows. Until then, GitHub
Actions must remain absent so LastGit stays the only live gate.
