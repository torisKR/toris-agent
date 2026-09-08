---
name: flutter-android-performance
description: Diagnose, measure, and optimize Android performance in Flutter applications across startup, frame rendering and jank, CPU, memory, network, assets, package size, platform channels, Gradle, and energy behavior. Use when a Flutter Android app feels slow, drops frames, starts slowly, consumes excessive resources, produces an oversized build, regresses after a change, or needs a measurement-backed performance review and implementation.
---

# Flutter Android Performance

Find the limiting resource before changing code. Optimize correctness-preserving release behavior on representative Android hardware and prove outcomes with comparable measurements.

## Quick start

Read [execution defaults](../shared-references/execution-defaults.md) and select `execute`, `review`, or `plan`. In the default `execute` mode:

1. inspect the Flutter/Android project, dirty state, versions, build configuration, dependencies, and reported scenario;
2. make the scenario reproducible and capture a profile/release baseline on the best available representative device;
3. localize the bottleneck with evidence and implement the smallest coherent fix;
4. rerun the same scenario and compare raw samples, median/range, correctness, and side effects;
5. leave a repeatable regression check and a concise evidence handoff.

## Operating rules

- Distinguish audit/diagnosis from implementation. Do not edit when the user asked only for analysis.
- Never use debug behavior to prove production performance; choose profile or release mode appropriate to the measurement.
- Preserve correctness, accessibility, lifecycle behavior, analytics, and unrelated user changes.
- Prefer current official Flutter, Dart, Android, and dependency documentation for version-specific commands or architecture claims.
- Do not add a package, change Gradle/R8/signing, remove resources, or alter product behavior without explaining impact and staying within authorization.
- Read [evidence and verification](../shared-references/evidence-and-verification.md) before reporting gains.

## Workflow

### 1. Define a reproducible scenario

Capture the user-visible symptom and a precise sequence: install/state, launch type, account/data, route, gesture, network condition, duration, and expected behavior. Identify target devices, minimum/typical Android versions, and whether low-end coverage matters.

If no scenario exists, create the smallest representative one before profiling.

### 2. Detect the project and runtime

Inspect rather than assume:

- Flutter and Dart versions, channel/constraints, Android compile/min/target configuration, and build flavors;
- rendering backend and relevant flags actually active for the target build;
- state management, navigation, image/media, database/network, plugins, platform channels, and background work involved in the scenario;
- build mode, ABI, obfuscation/minification/resource shrinking, split strategy, and artifact under test;
- physical device model, chipset/RAM, OS, thermal/battery state, refresh rate, and connection method.

Record local modifications and preserve them.

### 3. Capture a baseline

Read [measurement playbook](references/measurement-playbook.md). Select metrics that match the symptom rather than collecting everything. Possible surfaces include cold/warm startup, frame build/raster timing and jank, rebuild scope, CPU, allocations and retained memory, garbage collection, I/O, network latency/payload, image decode/upload, shader work, platform-channel latency, package/download/install size, energy, and thermal behavior.

Run repeated controlled trials. Save raw evidence or reproducible commands and report median plus range when values vary.

### 4. Localize the bottleneck

Trace the slow interval across layers:

- **Dart/UI:** synchronous work, repeated parsing/formatting, broad rebuilds, layout/intrinsic passes, list construction, animation ownership, isolates, timers, and disposal.
- **Raster/GPU:** overdraw, clipping/saveLayer effects, large images, shader compilation/work, custom paint, texture/video, and scene complexity.
- **Data/I/O:** request waterfalls, oversized payloads, caching, serialization, database queries, file access, and main-isolate work.
- **Native boundary:** chatty platform channels, plugin initialization, Android lifecycle, services, and blocking native work.
- **Build/artifact:** unused assets/code, native libraries/ABIs, compression, symbols, shrinking, and dependency weight.

For every suspected cause, state the evidence that supports it and the experiment that could falsify it. Rank by expected user impact, confidence, risk, and effort.

### 5. Implement the smallest coherent change

When authorized, change one causal area at a time where practical. Examples may include moving proven CPU work off the main isolate, narrowing rebuilds, virtualizing or lazily constructing content, sizing/caching images appropriately, batching native calls, reducing request waterfalls, deferring noncritical initialization, or correcting artifact configuration.

Do not apply folklore optimizations such as adding `const` everywhere, arbitrary caching, blanket repaint boundaries, disabling animations, or changing the renderer without evidence and a regression plan.

### 6. Re-measure and protect regressions

Use the same device class, build, data, scenario, cache/launch state, and measurement method. Compare raw samples, median, range, user-visible correctness, accessibility, crashes, memory peaks, energy/thermal side effects, and artifact differences.

If results are noisy or unfavorable, report them and revert or refine the hypothesis; do not select only favorable runs. Add a benchmark, performance trace, budget, or repeatable manual protocol appropriate to the project.

## Deliverable

Provide:

1. scenario and environment sheet;
2. baseline table with units and raw evidence location;
3. ranked bottleneck hypotheses;
4. changes made or recommended, with risks;
5. comparable before/after table and correctness gates;
6. unverified areas and a regression-monitoring plan.

Do not claim improvement where no comparable before/after evidence exists.

## Definition of done

- The symptom has a reproducible scenario with recorded device, build, and runtime conditions.
- The bottleneck is supported by profiler, trace, artifact, or source evidence rather than folklore.
- The smallest authorized fix is implemented without unrelated restructuring.
- Comparable before/after measurements and correctness/accessibility checks are recorded.
- Negative, noisy, or unavailable measurements are reported honestly.
- The handoff identifies changed files, verification, remaining device coverage, and any user-only release action.
