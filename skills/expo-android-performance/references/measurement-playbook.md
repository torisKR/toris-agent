# Expo Android measurement playbook

Select current commands and profilers from the detected Expo SDK, React Native version, Android setup, build service/profile, and official documentation. Avoid memorized commands that do not match the project workflow.

## Reproducibility sheet

Record:

- commit, dirty state, package manager, and lockfile;
- Expo/React Native/React versions, architecture, JavaScript engine, workflow, and native-directory ownership;
- app config, build profile/variant, ABI, minification/shrinking, update/runtime version, and artifact;
- physical device, Android version, memory/chipset, refresh rate, power/thermal state;
- install/update state, cold/warm launch, caches/persistence, account/data, and network;
- exact scenario, capture duration, tool versions/settings, and raw artifact location.

## Metric table

| Surface | Symptom | Metric and unit | Thread/layer | Run type/count | Baseline median | Range | Budget | Evidence |
|---|---|---|---|---|---:|---:|---:|---|

Keep JS, UI/render, and native/startup attribution explicit. Do not infer the blocked layer from visible jank alone.

## Controlled trials

- Prefer a physical representative Android device and include a constrained device when relevant.
- Use a production-like artifact without development-server, debug overlay, or remote-debugger distortion.
- Separate cold/warm start and first/subsequent navigation.
- Hold route, data volume, gestures, network, cache, and update state constant.
- Preserve raw runs and report median plus range.
- Loop mount/unmount, navigation, background/foreground, or data refresh when investigating retained memory.
- Match build profiles, ABIs, symbols, assets, and shrinking when comparing artifact size.

## Scenario menu

Choose only scenarios relevant to the report:

- process start to first usable screen;
- deep link to usable destination;
- first and repeated navigation to a heavy route;
- list initial render, sustained scroll, pagination, and item interaction;
- image-rich screen cold/warm cache;
- offline hydration and reconnect;
- gesture/animation under concurrent data work;
- background/foreground and update/reload lifecycle;
- production bundle and Android artifact composition.

## Report comparison

| Metric | Before median (range) | After median (range) | Change | Layer attribution | Correctness | Confidence/limits |
|---|---:|---:|---:|---|---|---|

Use `inconclusive` when environment mismatch or variance prevents a defensible result. Preserve a runnable command, trace recipe, budget, or benchmark for regression checks.
