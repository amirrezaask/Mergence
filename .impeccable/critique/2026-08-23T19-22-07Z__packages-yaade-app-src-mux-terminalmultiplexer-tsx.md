---
target: YAADE terminal multiplexer top chrome
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
timestamp: 2026-08-23T19-22-07Z
slug: packages-yaade-app-src-mux-terminalmultiplexer-tsx
---
⚠️ DEGRADED: single-context (both required sub-agents cold-started and returned no output; assessments were completed sequentially inline)

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3 | Active states exist, but the session dot is ambiguous and window selection is weaker than session selection. |
| 2 | Match system / real world | 3 | Session → Window is understandable, but an existing tab named “New tab” beside a `+` action is confusing. |
| 3 | User control and freedom | 3 | Close, rename, reorder, and create are available; close recovery is not evident. |
| 4 | Consistency and standards | 2 | Session and window selectors use different visual weight, radii, and grouping logic. |
| 5 | Error prevention | 2 | Small, adjacent close controls increase accidental-close risk. |
| 6 | Recognition rather than recall | 3 | Text labels help; repeated terminal icons and the unlabeled blue dot weaken meaning. |
| 7 | Flexibility and efficiency | 4 | Strong keyboard navigation, shortcuts, drag reorder, and inline rename support. |
| 8 | Aesthetic and minimalist design | 2 | The bar is restrained, but oversized chrome and uneven dead space make it feel unresolved. |
| 9 | Error recovery | 2 | Errors are surfaced elsewhere in the shell, but tab-close undo/recovery is not visible. |
| 10 | Help and documentation | 2 | Tooltips expose shortcuts, but the Session/Window hierarchy is not explained in context. |
| **Total** |  | **26/40** | **Acceptable — solid behavior, significant visual refinement needed** |

## Design Specificity Verdict

**LLM assessment:** The hierarchy is product-specific, but the current visual language is still category-interchangeable: dark glass, rounded pills, Lucide terminal icons, and a spaced wordmark. The distinctive opportunity is not more decoration—it is a compact, unmistakably operational Session → Window → Terminal grammar.

The Superlogical reference succeeds through density and continuity: one calm titlebar, content-sized tabs, shallow active states, short travel distances, and almost no dead width. YAADE should borrow that discipline without copying macOS traffic lights or native-window chrome.

**Deterministic scan:** `detect.mjs --json packages/yaade-app/src/mux` returned **0 findings** with exit code `0`. This is credible for mechanical quality, but the detector cannot perceive the spacing and hierarchy problems visible in the screenshot.

**Visual overlays:** No reliable overlay is available. The bounded Playwright attempt stopped at test discovery because the supplied path did not match the configured project `testDir`; no app or persistent server was left running.

## Overall Impression

The shell looks polished at first glance, but it behaves visually like a roomy product header rather than a fast terminal multiplexer. The biggest opportunity is to turn the top row into one compact tab system with a strict spacing rhythm and one coherent tab atom.

## What’s Working

- **Restrained material treatment:** The dark palette, subtle border, and low-noise active fill are appropriate for long terminal sessions.
- **Strong interaction foundation:** Roving tab focus, arrow navigation, drag reorder, rename, tooltips, and shared-layout animation are already better than most terminal UIs.
- **Progressive controls:** Hiding inactive close icons is directionally right and matches the reference’s quiet chrome.

## Priority Issues

### [P2] Hidden close buttons create visible dead space between tabs

**Why it matters:** In `SessionWindowTabStrip.tsx:143–167`, the active pill belongs only to the label button while the close button is a sibling that remains in layout at `opacity: 0`. This reserves width after every inactive tab and visually detaches the active close icon from its pill.

The screenshot shows roughly **108 px** between the Session pill’s right edge and the first Window icon, and nearly **200 px** from the end of “Window 1” to the next tab’s icon in physical screenshot pixels. The tab strip therefore reads as isolated labels rather than a continuous sequence.

**Fix:** Make label and close one contiguous tab atom. Overlay the close control at the tab’s right edge, reserve only 20–24 px inside the label, and use a consistent **2–4 px inter-tab gap**. The active background must wrap both label and close.

**Suggested command:** `/impeccable layout`

### [P2] The hierarchy is visually inverted

**Why it matters:** The YAADE lockup and bordered Session switcher receive more weight than the active Window. In an operating surface, the current work target should dominate; product identity and scope selection should recede.

The brand and divider consume about **18% of the screenshot width** before the Session control, while the Session pill consumes another **19%**. This leaves the most frequently switched layer competing for the remaining space.

**Fix:** Reduce the brand to a compact mark or quieter wordmark, remove the Session switcher’s shadow-heavy card treatment, and let the selected Window carry the clearest active state. The blue Session dot should be removed or replaced with an unambiguous scope icon—it currently resembles runtime status.

**Suggested command:** `/impeccable distill`

### [P2] The density misses the reference

**Why it matters:** `materials.css:106–107` sets a **52 px bar** with **36 px pills**. Combined with `0.875rem` side padding and `0.75rem` header gaps in `globals.css:362–375`, the result feels presentation-oriented. Superlogical’s reference feels fast because its chrome is subordinate to terminal content.

**Fix:** For desktop, target a **40–44 px bar**, **30–32 px controls**, 8 px outer padding, and a 4 px rhythm. Keep 44 px touch targets for mobile rather than using mobile density everywhere.

**Suggested command:** `/impeccable layout`

### [P2] “New tab” is both an object and an action

**Why it matters:** An existing Window titled “New tab” sits directly beside the `+` New tab action. A first-time user can reasonably read the selected pill as the creation button.

**Fix:** Assign immediate meaningful defaults such as `Window 2`, current directory, or active process. Keep “New tab” exclusively for the creation action or tooltip.

**Suggested command:** `/impeccable clarify`

### [P1] Close controls are undersized and fragile under keyboard/zoom use

**Why it matters:** `SessionWindowTabStrip.tsx:167` forces the close button to `size-5`—**20×20 px**. This is below the 24 px WCAG 2.2 target-size baseline unless the spacing exception is carefully maintained. The control is also visually hidden while remaining part of keyboard traversal.

**Fix:** Use a 24–28 px close hit target inside the tab, reveal it on hover and `:focus-visible`, verify focus order at 200% zoom, and ensure horizontal overflow never pushes the `+` or Settings controls off-screen.

**Suggested command:** `/impeccable audit`

## Cognitive Load

**Moderate: 3/8 checklist failures**

- **Grouping fails:** Session scope, Window tabs, close controls, creation, and Settings share one row without a strong structural grammar.
- **Visual hierarchy fails:** Session selection is heavier than the active Window.
- **Minimal choices is strained:** With two windows visible, the row exposes Session switch, two window choices, active close, New tab, and Settings—more than four competing actions.

Chunking, single-focus, and progressive disclosure are otherwise reasonably handled.

## Emotional Journey

The first impression is polished and calm. During repeated use, the wide gaps and large controls make switching feel slower than it is. The detached close icon and “New tab” ambiguity introduce a small hesitation at exactly the moment the user expects effortless navigation. A denser, contiguous strip would make the shell feel more confident and tool-like.

## Persona Red Flags

- **Alex, power user:** Keyboard support is excellent, but pointer travel is unnecessarily long and the 52 px header spends too much terminal space. Invisible close-button width makes multi-window scanning slower.
- **Sam, keyboard/low-vision user:** The 20 px close target is weak; hidden-but-focusable controls can make focus progression surprising; 200% zoom may compress the window strip between a fixed brand, Session control, and Settings.
- **Jordan, first-timer:** The blue dot has no obvious meaning, Session and Window are not visibly explained as hierarchy levels, and “New tab” appears as both the current object and adjacent action.

## Minor Observations

- The same Terminal icon represents the product brand and every Window, weakening its semantic value.
- The active pill’s shadow stops before its close button.
- `gap-1.5` is declared in the component and repeated as `0.375rem` in global CSS, creating two geometry authorities.
- The widely tracked YAADE wordmark and tightly tracked Session label produce competing typographic voices.
- The active Session’s blue dot risks being mistaken for process or connection status.

## Questions to Consider

- What if the top bar behaved like one continuous instrument panel rather than brand + selector + tabs?
- Could Session become quieter context while Window becomes the unmistakable active work target?
- Would users ever intentionally keep a Window named “New tab,” or should runtime context name it immediately?
