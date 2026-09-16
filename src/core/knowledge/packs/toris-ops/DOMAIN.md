---
slug: toris-ops
title: How to run Toris
when: Autonomy, receipts, Design Mode, android verify, isolation, Studio, chat tools
anti: Treating a model claim as a receipt; silent knowledge writes; pushing main at L3
skills: ship-small, reproduce-first, android-verify, release-check
tags: toris, autonomy, receipts, studio
---

# How to run Toris itself

Operating notes for the harness: what each autonomy rung costs, when a run is actually done, and how Design Mode / Android verify attach evidence.

Use this domain whenever the question is "how should Toris behave on this machine?" rather than application code.

## When to use

- Choosing L1–L5 for a chat or run
- Reading a receipt, a patch, or a Design Mode capture
- Debugging why apply was held

## Anti-jobs

- Do not skip the opposite-CLI review to "save time" unless `--no-review` was explicit
- Do not write MEMORY.md from a failed turn
- Do not treat Studio review-room drafts as production publishes
