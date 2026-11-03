---
name: release
description: Release pi-activity as a public Pi Git package. Invoke explicitly with /skill:release.
disable-model-invocation: true
---

# Release pi-activity

Explicit invocation authorizes this package's commit, push, tag and GitHub release.
It does not authorize changes outside this repository.

1. Read `AGENTS.md`. Fetch `origin/main` and tags. Check the latest GitHub release and `package.json`. Work on `main`; stop on divergence or ambiguous changes. Preserve unrelated work.
2. Choose an unused, higher `vX.Y.Z`: keep X fixed without explicit permission; breaking changes increment Y and reset Z to 0; non-breaking changes increment Z. Update `package.json` and write short `docs/release-vX.Y.Z.md` notes.
3. Run `npm test`, `npm run pack:check` and `git diff --check`. Review the exact staged diff and package inventory. Include only reviewed source, documentation and synthetic fixtures, never private captures, credentials or business data. Keep `private: true`; distribution uses Git, not npm publishing.
4. Conventional-commit the release. Create an annotated version tag on that commit. Push `main` and that tag without force. Publish with `gh release create <tag> --verify-tag --latest --title <tag> --notes-file docs/release-<tag>.md`, without assets. Verify the remote commit/tag, published non-draft release and Latest designation. Do not claim success before verification.
5. Report the version, commit, release and check results. Give the public install command: `pi install git:github.com/jensilo/pi-activity@<tag>`. Tell users to run `/reload`. Do not install or update a local setup.
