# Expo motion and 3D decisions

Use this reference after defining the user task, interaction purpose, route lifecycle, and fallback.

## Selection ladder

Choose the lowest capable rung already supported or safely addable to the detected project:

1. **Native/static structure** — responsive layout, platform navigation, press/focus states, and state replacement.
2. **Interactive transform/layout motion** — coordinated state changes, scroll/gesture-driven motion, springs, interruption, and route transitions using the project's supported animation stack.
3. **Vector or authored assets** — icons, illustrations, bounded timelines, or designer-authored state machines.
4. **Canvas/Skia-style 2D rendering** — charts, particles, procedural drawing, editors, or many visual primitives.
5. **GL/WebGPU/Three-style 3D** — a product viewer, spatial visualization, scene, or game mechanic that cannot be communicated adequately in 2D.

Do not escalate for novelty. Confirm current Expo SDK/platform compatibility and whether Expo Go or a development build is required.

## Decision record

| Need | Candidate | Already installed | Expo/platform support | Thread/runtime | Build/asset cost | Accessibility/fallback | Evidence |
|---|---|---|---|---|---|---|---|

Verify maintenance, license, peer/runtime requirements, architecture support, router/lifecycle interaction, web behavior, and release-build behavior. Keep version decisions in the project change, not this reusable skill.

## Gesture and motion contract

Specify:

- user intent and state source of truth;
- hit area, axis, threshold, velocity, simultaneous/exclusive gesture policy, and scroll/navigation conflicts;
- JS, UI/worklet, native, or GPU ownership and crossing frequency;
- cancel, interrupt, reverse, repeat, focus/blur, and background behavior;
- reduced-motion result, semantics, announcement, and keyboard/pointer alternative;
- loading/error/empty state and cleanup.

Avoid sending per-frame data across a thread/runtime boundary. Keep accessibility state synchronized with the visible result.

## 2D budget

Bound object/path count, redraw region, allocations, image/texture size, authored asset complexity, continuously running loops, and offscreen work. Pause invisible routes and assets. Prefer transforms/opacity for frequent motion when supported, but choose semantics and correctness over a blanket rule.

## 3D budget

Define camera, scene purpose, object and polygon range, materials/lights, textures, animation clips, picking/gesture model, frame policy, load state, error path, and constrained-device substitution. Consider compressed assets, instancing, level of detail, demand-based rendering, capped resolution, lazy loading, and cleanup of GPU/native resources.

Keep essential navigation, text, and actions accessible outside the 3D canvas. Provide a meaningful static or 2D alternative for reduced motion, unsupported platforms, and low-performance devices.

## Verification cases

- Expo Go feasibility check, then development build only if required;
- first/cached asset load and missing/slow/corrupt asset;
- rapid, reversed, repeated, and competing gestures;
- route focus/blur, leave/return, deep link, and back behavior;
- background/foreground and update/reload lifecycle;
- text scale, locale expansion, screen reader, keyboard/pointer, and reduced motion;
- constrained Android device in a production-like build;
- targeted web/iOS behavior;
- memory, listener, animation, and GPU-resource cleanup after repeated entry/exit.
