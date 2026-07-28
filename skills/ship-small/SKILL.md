---
name: ship-small
description: Land the smallest change that fully solves the problem, with proof it works.
when: The user asks to implement a feature, change behaviour, or refactor.
---

# Ship small

A solo developer has no reviewer and no QA. Size is the only safety net you get.

## Procedure

1. **Locate before you write.** Find the exact file and function that owns the
   behaviour. Read it. If you cannot name the file, you are not ready to edit.
2. **State the seam.** In one sentence: what changes, what stays. If that
   sentence needs an "and also", split the work.
3. **Change one thing.** Touch the fewest files that make the sentence true.
   Resist tidying unrelated code in the same pass.
4. **Prove it.** Run the project's tests. If nothing covers the change, add one
   test that fails before your edit and passes after.
5. **Report the diff honestly.** Say which files changed and what you did not do.

## Stop conditions

- The change needs a new dependency → ask first. Dependencies are forever.
- The change touches more than ~5 files → stop, propose a plan instead.
- Tests were already failing before you started → say so, do not "fix" them silently.
