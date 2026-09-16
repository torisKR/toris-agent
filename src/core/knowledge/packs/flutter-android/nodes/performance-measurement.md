---
id: performance-measurement
title: Measure before tuning Flutter
tags: performance, impeller, jank
---

# Measure before tuning Flutter

Guessing at jank wastes a ship window. Capture a baseline on a real device or emulator, name the scenario, then change one thing.

1. Pick a user-visible scenario (scroll, open sheet, first frame after navigation).
2. Record timeline / frame timings with the Flutter tools you actually have.
3. Note GPU vs UI thread. Impeller vs Skia differences are evidence, not folklore.
4. Fix the hottest rebuild or effect, re-measure the same scenario.

Builtin procedure: `skills/flutter-android-performance/SKILL.md`.
