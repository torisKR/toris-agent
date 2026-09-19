---
id: device-evidence
title: Device evidence before claiming a fix
tags: adb, screenshot, verify
---

# Device evidence before claiming a fix

A mobile UI fix is not done because the web inspector looks right.

1. `toris android devices` — note serial and state
2. Reproduce the screen on that device
3. Screenshot under `~/.toris/android/`
4. Cite the path. "Looks good" without a screenshot is a vibe.

If `adb` is missing, say so and stop. Builtin procedure: `skills/android-verify/SKILL.md`.
