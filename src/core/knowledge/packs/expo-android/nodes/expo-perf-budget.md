---
id: expo-perf-budget
title: Expo performance budget
tags: expo, fps, js-thread
---

# Expo performance budget

Name the budget before adding motion.

- UI thread / JS thread / GPU: which one is allowed to spike?
- First interaction vs steady scroll are different budgets
- Images, 3D, and blur are the usual silent costs on Android

Builtin procedure: `skills/expo-android-performance/SKILL.md`.
