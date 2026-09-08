---
name: flutter-interactive-design
description: Design and implement distinctive Flutter interfaces with responsive composition, reusable components, gesture-driven interaction, purposeful 2D animation, custom painting and shaders, and bounded interactive 3D experiences. Use when creating or redesigning Flutter screens, design systems, onboarding, visualizations, games, immersive product moments, microinteractions, navigation transitions, or accessible high-performance motion.
---

# Flutter Interactive Design

Create an intentional product-specific visual system, then implement only the motion and 2D/3D technology that serves the interaction. Treat accessibility, lifecycle, and frame performance as design constraints.

## Quick start

Read [execution defaults](../shared-references/execution-defaults.md) and select `execute`, `review`, or `plan`. In the default `execute` mode:

1. inspect the Flutter project or brief, routes/state, existing visual system, dependencies, assets, target devices, and the screen's single job;
2. state an intentional direction tied to the product; ask for a choice only when competing directions would materially change the result;
3. implement one complete vertical slice with real content and all relevant states;
4. add purposeful 2D/3D interaction using the smallest capable technology plus reduced-motion and constrained-device fallbacks;
5. critique the rendered result and validate accessibility, lifecycle, and production-representative frame behavior.

## Operating rules

- Inspect the product, audience, screen job, existing design system, Flutter version, routes/state architecture, dependencies, assets, target platforms, and device floor before designing.
- Follow the user's explicit art direction. Where it is open, derive choices from the product's subject and content rather than a reusable AI aesthetic.
- Spend visual boldness in one justified signature element; keep supporting UI disciplined.
- Do not add a package, shader, runtime, WebView/native integration, or asset pipeline without checking maintenance, license, platform support, build impact, and user authorization.
- Motion must explain hierarchy, causality, continuity, progress, manipulation, or meaningful delight. Remove motion that only decorates.
- Preserve unrelated changes and current project conventions.
- Read [evidence and verification](../shared-references/evidence-and-verification.md) before claiming performance or usability outcomes.

## Workflow

### 1. Ground the brief

State the product/feature, audience, one primary screen job, target devices/platforms, input methods, accessibility requirements, performance floor, content/data states, and desired emotional quality. Inventory existing colors, type, spacing, shapes, icons, imagery, motion, components, and brand constraints.

If the user asked for implementation but the visual direction is materially ambiguous, present two or three concise directions and obtain approval before making a strong aesthetic commitment.

### 2. Create an intentional design plan

Define:

- a named visual concept tied to the subject;
- four to six semantic colors with contrast intent;
- typography roles, scale, weight, line height, and fallback behavior;
- spacing, grid, breakpoints/adaptive behavior, shape, elevation/material, icon, and imagery rules;
- one signature interaction or visual element;
- a content hierarchy and plain-language interface vocabulary;
- loading, empty, error, success, disabled, offline, and permission states.

Sketch the composition in prose or a compact wireframe. Critique it against the brief: replace any choice that could be dropped unchanged into an unrelated app.

### 3. Model interaction and motion

For every animated interaction document trigger, user intent, start/end state, duration or physics, interruption/reversal, gesture ownership, focus/semantics behavior, reduced-motion alternative, low-performance fallback, and completion condition.

Prefer a single orchestrated transition to scattered entrances. Keep actions consistently named and make errors explain recovery.

### 4. Select the smallest capable technology

Read [motion and 3D decisions](references/motion-and-3d.md). Start with Flutter SDK primitives. Move to custom paint, fragment shaders, authored animation runtimes, a maintained 2D engine, or bounded 3D only when the design requires it and the project supports it.

Inspect installed packages and current official/project documentation. Do not prescribe a remembered package or version as universally correct.

### 5. Implement in vertical slices

When authorized:

1. establish tokens/theme and responsive scaffold;
2. implement semantic static states with real content;
3. add gestures and state transitions;
4. add the signature 2D/3D moment behind a stable interface;
5. add reduced-motion, assistive-technology, loading, error, and low-performance fallbacks;
6. integrate navigation/lifecycle and cleanup;
7. test each slice before expanding.

Keep widgets/components focused, state ownership explicit, and animation controllers/resources disposed. Do not restructure unrelated routes or state management merely to fit an effect.

### 6. Critique visually and behaviorally

Review captures on representative sizes and themes. Check hierarchy, alignment, typography, contrast, density, safe areas, text scaling, localization expansion, keyboard/pointer/focus behavior where supported, semantics, gesture conflicts, state transitions, and whether the signature element still serves the product.

Remove one unnecessary decorative element or motion if the result feels overworked.

### 7. Profile and verify

Use a production-representative Flutter build and physical devices. Inspect frame pacing, UI/raster work, rebuild scope, layout churn, image/texture and shader cost, memory, asset/package weight, startup/loading, energy/thermal behavior, and lifecycle cleanup relevant to the design.

Test reduced motion, screen reader/semantics, text scale, contrast, touch targets, keyboard/pointer where targeted, interruption, background/foreground, route changes, loading failure, and low-end fallback. Report measured evidence and remaining limits; do not claim smoothness from visual inspection alone.

## Deliverable

Provide design intent and tokens, responsive/state map, interaction specification, technology decision and risks, implemented files when authorized, accessibility/fallback behavior, visual evidence, performance evidence, and remaining tradeoffs.

## Definition of done

- The visual direction, tokens, hierarchy, and signature interaction are specific to the product brief.
- A working vertical slice covers real content plus loading, empty, error, and disabled states as applicable.
- Gestures and motion handle interruption, lifecycle, and navigation without decorative excess.
- Reduced motion, semantics/screen reader, text scale, and constrained-device fallbacks remain usable.
- Representative screenshots or rendered evidence and relevant frame/resource checks are reviewed.
- The handoff lists implemented files, visual/performance evidence, remaining platform gaps, and any user-only release step.
