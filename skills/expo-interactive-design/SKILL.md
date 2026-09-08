---
name: expo-interactive-design
description: Design and implement distinctive Expo and React Native interfaces with responsive native composition, reusable components, gesture-driven interaction, purposeful 2D animation, canvas or authored motion, and bounded interactive 3D experiences. Use when creating or redesigning Expo screens, navigation, onboarding, visualizations, games, immersive product moments, microinteractions, transitions, or accessible high-performance motion across Android and other targeted platforms.
---

# Expo Interactive Design

Build a product-specific native experience and choose the smallest animation or 3D stack that delivers it. Respect Expo workflow ownership, navigation lifecycle, accessibility, and Android performance from the start.

## Quick start

Read [execution defaults](../shared-references/execution-defaults.md) and select `execute`, `review`, or `plan`. In the default `execute` mode:

1. inspect the Expo project or brief, runtime/workflow, routes, native ownership, installed dependencies, assets, target platforms, and the screen's single job;
2. state a product-specific direction; ask for a choice only when competing directions would materially change the result;
3. implement one complete route or vertical slice with real content and all relevant states;
4. add purposeful 2D/3D interaction using the smallest supported stack plus reduced-motion and constrained-device fallbacks;
5. critique the real app and validate Android in a production-like path, then check other targeted platforms.

## Operating rules

- Inspect the product, audience, screen job, Expo/React Native versions, workflow, routes, state/data architecture, installed dependencies, app config, assets, target platforms, and device floor before designing.
- Follow explicit art direction. Where open, derive visual language from the product's real subject, content, and user task rather than common AI defaults.
- Use one justified signature interaction; keep supporting elements restrained.
- Do not install a package, prebuild/eject, add native configuration, or change architecture/engine without checking current support, maintenance, license, build impact, Expo Go/development-build needs, and user authorization.
- Never edit generated native files when app config or a config plugin is the durable source of truth.
- Motion must communicate hierarchy, causality, continuity, progress, manipulation, or meaningful delight.
- Read [evidence and verification](../shared-references/evidence-and-verification.md) before claiming performance or usability outcomes.

## Workflow

### 1. Ground the brief and runtime

State the feature, audience, one primary screen job, target platforms/devices, input methods, accessibility needs, content/data states, performance floor, and desired emotional quality.

Inspect Expo SDK, React Native/React versions, router/navigation, managed/prebuild/bare workflow, native-directory ownership, architecture/engine, build profiles, installed animation/gesture/rendering/3D packages, and existing design tokens/components. Determine whether Expo Go supports the intended stack or a development build is genuinely required.

If implementation is requested but visual direction is materially ambiguous, present two or three concise directions and get approval before committing to a strong aesthetic.

### 2. Create the design plan

Define:

- named visual concept linked to the product subject;
- four to six semantic colors with light/dark and contrast behavior;
- typography roles, scale, weight, line height, font-loading/fallback plan;
- spacing/grid, responsive/adaptive layout, safe areas, shape, depth, icon, and imagery rules;
- one signature interaction or visual element;
- plain-language interface vocabulary and consistent action labels;
- loading, empty, error, success, disabled, offline, permission, keyboard, and update states.

Sketch routes and composition. Critique the plan against the brief and replace choices that could belong unchanged to an unrelated app.

### 3. Model navigation, gesture, and motion

For each interaction document trigger, intent, state source, start/end state, duration or physics, interruption/reversal, gesture ownership and arbitration, navigation focus/blur behavior, cleanup, reduced-motion alternative, low-performance fallback, assistive-technology behavior, and completion condition.

Prefer native navigation primitives and one orchestrated transition over custom modal/navigation imitations or scattered entrances when project conventions support them.

### 4. Select the smallest capable stack

Read [motion and 3D decisions](references/motion-and-3d.md). Choose based on installed support and current official documentation:

- static/native layout and platform navigation for structure;
- an existing supported animation and gesture stack for interactive transforms/layout/state changes;
- SVG/canvas/Skia-style rendering or authored animation assets for bounded 2D visuals;
- GL/WebGPU/Three-style rendering only for a real 3D/spatial requirement and with a compatible development-build path.

Do not hard-code a remembered library version or assume a library is installed. Test the simplest viable environment first and use a development build when native requirements demand it.

### 5. Implement in vertical slices

When authorized:

1. establish tokens/theme, safe responsive scaffold, and route integration;
2. implement semantic static states with real content;
3. add gestures and state transitions with clear thread/ownership boundaries;
4. add the signature 2D/3D surface behind a stable component interface;
5. add reduced-motion, screen-reader/input, loading/error, and low-performance fallbacks;
6. handle route focus, background/foreground, asset cleanup, and failure;
7. validate Android before expanding scope, then check other targeted platforms.

Keep routes focused and shared components outside route-only directories according to project conventions. Do not restructure unrelated navigation or state management for an effect.

### 6. Critique the real app

Review captures and interactions on representative Android sizes plus other targeted platforms. Check hierarchy, typography, alignment, contrast, density, safe areas, system bars, text scaling, localization, keyboard/pointer/focus, semantics, touch targets, gesture conflicts, native expectations, and every state.

Remove unnecessary decorative motion or visual noise. Confirm the signature element remains useful after novelty wears off.

### 7. Profile and verify

Use a production-like Android build on physical representative hardware. Measure relevant frame/interaction behavior, JS and UI thread work, render/commit churn, list/route contention, canvas/scene cost, memory, asset/bundle/artifact weight, startup/loading, energy/thermal behavior, and cleanup.

Test reduced motion, screen reader, text scale, contrast, input alternatives, gesture interruption, navigation away/back, background/foreground, offline/slow/missing assets, update/reload lifecycle, and constrained-device fallback. Check web/iOS when targeted, without weakening Android validation.

Report evidence and untested limits. Do not claim smoothness from simulator or visual inspection alone.

## Deliverable

Provide design intent/tokens, route and responsive/state map, interaction specification, stack decision and build implications, implemented files when authorized, accessibility/fallback behavior, visual evidence, Android performance evidence, cross-platform notes, and remaining tradeoffs.

## Definition of done

- The visual direction, tokens, hierarchy, and signature interaction are specific to the product brief.
- A working route or vertical slice covers real content and relevant loading, empty, error, offline, permission, and disabled states.
- Gestures, navigation focus, thread ownership, cleanup, and asset failure behave coherently.
- Reduced motion, screen reader, text scale, input alternatives, and constrained-device fallbacks remain usable.
- Android rendered evidence and production-like performance checks pass, with other targeted platforms checked where available.
- The handoff lists implemented files, build implications, evidence, remaining platform gaps, and any user-only release step.
