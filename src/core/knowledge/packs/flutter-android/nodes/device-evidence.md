---
id: device-evidence
title: Device evidence before claiming a fix
tags: adb, screenshot, verify
---

# Device evidence before claiming a fix

A Flutter UI fix is not done because the widget inspector looks right.

1. `toris android devices` (or the chat `android` tool) — note serial and state
2. Reproduce the screen on that device
3. Screenshot under `~/.toris/android/screenshots/`
4. Cite the path. "Looks good" without a screenshot is a vibe.

If `adb` is missing, say so and stop. Do not invent a device list.

Builtin procedure: `skills/android-verify/SKILL.md`.
