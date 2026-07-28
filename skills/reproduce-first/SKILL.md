---
name: reproduce-first
description: Reproduce a bug with a command before proposing any fix.
when: The user reports something broken, failing, crashing or behaving wrongly.
---

# Reproduce first

A fix for a bug you never observed is a guess wearing a commit message.

## Procedure

1. **Get the exact command.** Ask for, or infer, the one command that shows the
   failure. Run it. Paste the real output.
2. **Isolate.** Narrow to the smallest input that still fails. Note the exact
   error text and the line it comes from.
3. **Explain the cause** in one sentence, naming the file and line. If you cannot,
   keep investigating — do not start editing.
4. **Write the failing test** that encodes the bug, and watch it fail.
5. **Fix, then re-run** both the new test and the full suite.

## Stop conditions

- You cannot reproduce it → report exactly what you tried and ask for the
  missing detail (input, environment, version). Do not fix speculatively.
- The cause is in a dependency → say so, and propose the workaround separately
  from the upstream fix.
