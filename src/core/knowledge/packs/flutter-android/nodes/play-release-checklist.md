---
id: play-release-checklist
title: Play release checklist
tags: play, signing, fastlane
---

# Play release checklist

First Play upload is a procedure, not a vibe. Use the bundled Fastlane / signing helpers rather than improvising keystores in chat.

- Confirm applicationId, versionName/versionCode, signing, and Play track
- Keep secrets out of git; the release skill's env examples exist for a reason
- A release that cannot be reproduced from the repo is not released

Builtin procedure: `skills/toris-flutter-play-store-release/SKILL.md`.
