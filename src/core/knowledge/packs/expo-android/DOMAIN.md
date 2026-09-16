---
slug: expo-android
title: Expo on Android
when: Expo Android performance, interactive design, motion, device evidence
anti: Shipping heavy 3D/motion without a frame budget; claiming a fix from web-only Expo Go
skills: expo-android-performance, expo-interactive-design, android-verify
tags: expo, android, performance, motion
---

# Expo on Android

Performance and design habits for Expo apps that have to feel native on Android.

Use this domain when the work is Reanimated / Skia / 3D, JS thread load, or Android-specific Expo config. Pair with `expo-android-performance` and `expo-interactive-design`. Verify on a device the way Flutter does.

## When to use

- Dropped frames, bridge chatter, oversized assets
- Motion systems that must not hitch on first run
- Android navigation bar, edge-to-edge, and permission surfaces

## Anti-jobs

- Do not treat Expo web as Android proof
- Do not add a 3D scene without a measurement plan
- Do not hide a JS-thread stall behind a prettier animation
