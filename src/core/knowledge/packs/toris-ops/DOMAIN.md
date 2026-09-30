---
slug: toris-ops
title: How to run Toris
when: Autonomy, receipts, android verify, isolation, terminal chat tools
anti: Treating a model claim as a receipt; silent knowledge writes; pushing main at L3
skills: ship-small, reproduce-first, android-verify, release-check
tags: toris, autonomy, receipts, terminal
---

# How to run Toris itself

Operating notes for the harness: what each autonomy rung costs, when a run is actually done, and how Android verification supplies device evidence.

Use this domain whenever the question is "how should Toris behave on this machine?" rather than application code.

## When to use

- Choosing L1–L5 for a chat or run
- Reading a receipt or an isolated patch
- Debugging why apply was held

## Anti-jobs

- Do not skip the opposite-CLI review to "save time" unless `--no-review` was explicit
- Do not write MEMORY.md from a failed turn
