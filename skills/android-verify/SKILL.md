---
name: android-verify
description: Capture Android device or emulator evidence with adb before claiming a mobile UI fix is done.
when: Verifying Expo, Flutter, or other Android UI changes on an emulator or device.
---

# Android verify

A mobile UI fix is not done because the web inspector looks right. Capture
device evidence, then point at it.

`adb` is optional. If it is missing, say so and stop — do not invent a
screenshot or a device list.

## Procedure

1. **See what is connected.** Use the `android` tool with `action: "devices"`
   (or `toris android devices`). Note the serial and state.
2. **Reproduce on device.** Launch or navigate to the screen you changed.
3. **Capture evidence.** `action: "screenshot"` writes a PNG under
   `~/.toris/android/screenshots/`. Cite that path. For crashes or surprising
   behaviour, also take `action: "logcat"`.
4. **Only then claim the fix.** The receipt or chat answer must name the
   artifact path. "Looks good" without a screenshot is a vibe, not evidence.

## Stop conditions

- `adb` is not on PATH → report that Android verify is unavailable. The rest
  of toris still works. Do not pretend you looked at a device.
- No device in `device` state → tell the operator to start an emulator or
  plug in a phone. Do not keep retrying blindly.
- The screenshot does not show the screen you changed → say so, do not crop
  the claim to match the photo.
