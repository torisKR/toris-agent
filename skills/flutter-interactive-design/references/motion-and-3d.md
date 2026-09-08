# Flutter motion and 3D decisions

Use this reference after the interaction purpose and fallback have been defined.

## Selection ladder

Choose the lowest rung that fully serves the experience:

1. **Static/layout and SDK transitions** — responsive layout, state change, route continuity, opacity/transform, hero/shared-element concepts, and simple physics.
2. **Explicit timeline or gesture control** — coordinated controllers, curves/springs, draggable/scrubbable states, and interruption.
3. **Custom 2D drawing** — charts, particles, procedural illustrations, editor canvases, or highly specific rendering.
4. **Shader or authored animation asset** — a bounded signature effect or designer-authored state machine with a clear asset pipeline.
5. **Maintained 2D runtime/engine** — game-like world, collision, camera, sprites, or many continuously updated entities.
6. **Bounded 3D** — a product viewer, spatial visualization, scene, or game mechanic that cannot be expressed clearly in 2D.

Do not escalate because a higher rung looks more impressive.

## Decision record

| Need | Candidate | Existing support | Platforms | Build/asset cost | Accessibility/fallback | Lifecycle risk | Evidence for choice |
|---|---|---|---|---|---|---|---|

Verify current maintenance, license, Flutter/Dart constraints, renderer/platform support, native requirements, web/desktop implications, and release-build behavior before selecting a dependency.

## Interaction contract

For each interaction specify:

- trigger and intended meaning;
- state machine and source of truth;
- gesture hit area, axis, threshold, velocity, and conflict policy;
- cancel, interrupt, reverse, resume, and repeated-input behavior;
- focus, semantics announcement, keyboard/pointer equivalent, and reduced-motion result;
- duration/physics and content synchronization;
- resource ownership and disposal;
- loading/error/empty and background/foreground behavior.

## 2D and shader budget

Bound canvas size, draw calls/objects, path complexity, allocations per frame, image/texture resolution, shader inputs, offscreen layers, and continuously running animation. Cache only proven stable work. Pause invisible scenes and avoid rebuilding unrelated UI from per-frame state.

## 3D budget

Define the smallest scene: camera, objects, polygon/vertex range, materials/lights, textures, animation clips, picking/gestures, frame policy, loading progress, and device fallback. Consider level of detail, instancing, compressed assets, on-demand rendering, capped pixel ratio, and static/2D substitution on constrained devices.

Keep essential navigation and content outside the 3D surface. A screen reader and a user with reduced motion must still complete the task.

## Verification cases

- first load and cached load;
- rapid/reversed/repeated gesture;
- route leave/return and background/foreground;
- orientation/window resize where supported;
- text scaling, locale expansion, semantics/screen reader, keyboard/pointer;
- reduced motion and low-performance fallback;
- missing/corrupt/slow asset;
- constrained Android device and production-representative build;
- memory/resource cleanup after repeated entry and exit.
