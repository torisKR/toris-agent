---
slug: flutter-android
title: Flutter on Android
when: Flutter performance, Play release, interactive design, device evidence
anti: Claiming a UI fix without a device screenshot; shipping a Play bundle without the release checklist
skills: flutter-android-performance, toris-flutter-play-store-release, flutter-interactive-design, android-verify
tags: flutter, android, play, performance
---

# Flutter on Android

Tacit practices for a Flutter app that has to feel native on Android and actually reach Play.

Use this domain for jank, raster/GPU budgets, motion, and Play Store first-release or update work. `adb` is optional for the rest of Toris; it is **not** optional when you claim a mobile UI fix.

## When to use

- Frame timing, rebuild storms, expensive effects
- Play upload, signing, Fastlane, first-release checklist
- Motion / 3D that must stay at 60fps on a mid device

## Anti-jobs

- Do not treat the web inspector as Android evidence
- Do not skip `android-verify` after a visible UI change
- Do not invent Play Console state
