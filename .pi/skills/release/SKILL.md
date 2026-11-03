---
name: release
description: Release pi-activity as a public Pi Git package. Invoke explicitly with /skill:release.
disable-model-invocation: true
---

# Release pi-activity

If the user invokes this skill, you can commit, push, tag and publish a GitHub release for this package. You cannot change anything outside this repository.

1. Read `AGENTS.md`. Fetch `origin/main` and tags. Check the latest GitHub release and `package.json`. Work on `main`. Stop on divergence or unclear changes. Keep unrelated work.
2. Choose an unused, higher `vX.Y.Z`. Do not change X without explicit permission. For breaking changes, increment Y and set Z to 0. For other changes, increment Z.
3. Update `package.json`. Write short `docs/release-vX.Y.Z.md` notes.
4. Run `npm test`, `npm run pack:check` and `git diff --check`.
5. Check the staged diff and the package inventory. Include only source, documentation and synthetic fixtures. Never include real logs, credentials or business data. Keep `private: true`, because Pi installs this package from Git.
6. Commit the release with a conventional commit message. Create an annotated version tag on that commit. Push `main` and the tag without force.
7. Publish with `gh release create <tag> --verify-tag --latest --title <tag> --notes-file docs/release-<tag>.md`, without assets.
8. Verify the remote commit and tag, the published non-draft release and the Latest designation. Do not claim success before this check.
9. Report the version, commit, release and check results. Give the install command: `pi install git:github.com/jensilo/pi-activity@<tag>`. Tell users to run `/reload`. Do not install or update a local setup.
