---
name: release-check
description: Verify a package is actually installable and runnable before publishing or tagging.
when: The user asks to release, publish, tag, or cut a version.
---

# Release check

The bug that survives every test is "it works in the repo but not once installed".

## Procedure

1. **Clean state.** Confirm the working tree is clean and the branch is pushed.
2. **Pack, do not publish.** Build the tarball (`npm pack`) and inspect the file
   list. Anything missing from `files` will be missing for every user.
3. **Install from the tarball** into a scratch prefix — never rely on the repo
   being on disk. Run the binary's `--version` and one real command.
4. **Check metadata.** Version, license, repository URL, and entry points must
   all resolve. A wrong `bin` path breaks the install silently.
5. **Only then** tag and publish, and record what you verified.

## Stop conditions

- The smoke test fails from the tarball → do not publish, fix packaging first.
- Version already exists on the registry → stop, publishing is irreversible.
