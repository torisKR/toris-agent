# Flutter Android measurement playbook

Choose the smallest measurement set that can confirm or reject the reported symptom. Select current commands and tools from the detected Flutter/Android versions and official documentation.

## Reproducibility sheet

Record:

- commit and dirty state;
- Flutter/Dart versions and dependency lock state;
- flavor, build mode, ABI, renderer, and build flags;
- device model, RAM/chipset, Android version, refresh rate, power/thermal state;
- installation/update state, cold/warm launch, cache state, account/data, and network;
- exact numbered scenario and capture duration;
- profiler/tool version, sampling settings, and raw artifact location.

## Metric table

| Surface | User symptom | Metric and unit | Run type/count | Baseline median | Range | Target/budget | Evidence |
|---|---|---|---|---:|---:|---:|---|

Do not mix cold and warm startup, debug and release-like builds, or different refresh-rate expectations in one comparison.

## Controlled trial guidance

- Prefer a physical representative device; include a constrained/low-end target when the audience uses one.
- Stabilize device temperature and background activity between longer runs.
- Measure the same route, data volume, gesture, and network profile.
- Preserve raw samples; median without range can hide instability.
- Use timeline evidence to attribute frame delay to UI/Dart versus raster/GPU work.
- Pair memory snapshots with a repeatable lifecycle loop to distinguish a leak from expected caching.
- Compare download/install artifacts using matching flavors, ABIs, symbols, and shrinking settings.

## Correctness gates

Verify launch/deep links, navigation/back behavior, scrolling and gestures, loading/error/empty states, offline or degraded network behavior, background/foreground transitions, rotation/window changes when supported, accessibility semantics, text scaling, reduced motion, analytics, and crash/error logs.

## Report comparison

| Metric | Before median (range) | After median (range) | Absolute/relative change | Correctness status | Confidence and caveat |
|---|---:|---:|---:|---|---|

Use `inconclusive` when variance, environment differences, or insufficient repetitions prevent a defensible conclusion.
