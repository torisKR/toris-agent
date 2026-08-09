# Toris Studio Design System

## Product promise

Toris Studio is a local creator operations room at `127.0.0.1:5824`. It keeps post drafts, source media, renders, quality evidence, and review state on the user's Mac. The interface must never imply that `submitted` means `live verified`.

## Design read

The product feels like a quiet edit bay: cinematic media focus, operational density around the edges, and restrained motion. The primary sequence is review queue → inspect → edit → render → verify → approve. Public publishing is visually and behaviorally isolated from ordinary creation.

## Tokens

- Canvas: `#090b0f`; panel: `#11151b`; raised: `#171c23`; border: `#2a3039`.
- Primary text: `#f4efe6`; secondary: `#a8b0bc`; quiet: `#727b88`.
- Active coral: `#ff7657`; verified green: `#72d6a0`; review amber: `#f5bf68`; failure red: `#ff6f76`.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48 pixels.
- Radius: 8 controls, 12 cards, 16 media frames. Avoid decorative pill containers; reserve full pills for compact status badges.
- Typography: system sans for Korean UI; editorial headings use tighter tracking; metadata uses tabular numerals.
- Shadow: one restrained elevation only, `0 16px 50px rgb(0 0 0 / .28)`.

## Layout

- Desktop 1280+: 248px review rail, fluid center canvas, 340px inspector.
- Tablet 768–1279: 208px rail plus canvas; inspector becomes an in-flow panel.
- Mobile 360–767: single column; queue becomes a horizontal filter strip; actions stay after evidence, never sticky over media.
- Every viewport must have zero horizontal overflow.

## Content surfaces

- Video: 9:16 frame, controls, duration/codec/resolution evidence, storyboard/timeline rows.
- Design: contained image canvas with dimensions, source, and review state.
- Post: readable Korean typography preview with separate Threads and X drafts.
- Cards show kind, title, updated time, and status. They do not expose absolute paths, secrets, or credential state.

## States

- `awaiting_review`: amber, reviewable local output.
- `queued` and `rendering`: coral progress with plain time/status text.
- `quality_failed` and `failed`: red evidence row naming the failed rule; no publish action.
- `submitted`: neutral outbound receipt, explicitly not proof of a live URL.
- `live verified`: green only when an external post ID, status, and verified URL are present.
- Empty, loading, offline, and error states preserve the same layout to prevent jumps.

## Components

- Buttons: primary coral, secondary border, quiet text, destructive red. One primary action per region.
- Inputs: persistent labels, 44px minimum target, visible help/error text.
- Badges: compact status only; never use pills for navigation or paragraphs.
- Dialog: title, consequence, evidence summary, explicit confirmation field, cancel-first keyboard order.
- Quality row: rule, measured value, expected value, pass/fail mark.
- Evidence receipt: timestamped local action list with copyable IDs, never credentials.

## Interaction and accessibility

- Visible `:focus-visible` ring on every control; logical DOM/tab order follows the visual sequence.
- Escape closes dialogs; focus returns to the invoking control.
- Status changes use an `aria-live="polite"` region and are not conveyed by color alone.
- Respect `prefers-reduced-motion`; remove transforms and nonessential transitions.
- Text contrast targets WCAG AA. Controls remain usable at 200% zoom.
- Keyboard-only users can create a post, select a content item, inspect quality, and close a publish dialog.

## Publication boundary

External publish is a destructive production action. The dialog requires a checked public-publish acknowledgement and exact text `PUBLISH <contentId>`. The button stays disabled until content hash, review package, and quality evidence pass. Closing or refreshing never confirms publication.

## Reference fidelity

Concept C defines the storyboard/timeline/quality composition; concept B defines the queue/detail relationship. The implementation uses original tokens and components rather than embedding screenshots. The design-system route is implemented and reviewed before product screens.
