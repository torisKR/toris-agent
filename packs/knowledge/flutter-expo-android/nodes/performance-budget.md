---
id: performance-budget
title: Measure before claiming a frame fix
tags: performance, budget, jank
---

# Measure before claiming a frame fix

A Flutter or Expo UI change is not faster because the animation looks smoother on a desktop emulator.

1. Name the budget (frames, JS-thread, raster, asset size)
2. Reproduce on a mid-range Android device
3. Change one thing
4. Measure again and cite the numbers

Do not add a 3D or motion scene without a measurement plan.
