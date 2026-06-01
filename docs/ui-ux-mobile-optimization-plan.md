# DumbPad UI/UX Optimization Plan

This document is the working plan for the DumbPad UI/UX optimization effort.
It must be updated after every meaningful UI/UX change so future agents can see
what changed, why it changed, how it was verified, and what remains.

## Goals

DumbPad should feel simple but not shallow: quiet enough for fast capture and
long reading, but polished enough that every surface feels intentional.

The long-term UI/UX work is split into four parts:

1. Mobile PWA experience, with an iOS-influenced app feel. This is the current
   implementation slice.
2. Desktop writing and reading workspace. This is out of scope for this slice.
3. Shared design system: tokens, surface hierarchy, icon sizing, spacing,
   motion, focus states, and dark/light theme parity.
4. Cross-cutting interaction states: sync, offline, conflicts, AI analysis,
   loading, errors, and destructive actions.

This slice only implements the mobile PWA experience. Desktop and full design
system consolidation are recorded here for continuity, but should be handled by
later agents in separate slices.

## Product Principles

- Content comes first. Notes and Thoughts should dominate the screen, while
  controls stay present but visually quiet.
- Fast capture must stay fast. AI, S3, WebSocket, outbox, and visual transitions
  must not block note or Thought creation.
- iOS influence means restrained material, familiar controls, safe areas,
  touch comfort, and cause-and-effect motion. It does not mean decorative blur
  on every element.
- The app should feel local-first and recoverable. Sync, conflict, offline, and
  AI state must be clear without interrupting writing.
- Mobile interactions must not depend on hover. Critical actions need visible
  controls or obvious tap affordances.
- Every interactive target should meet a practical 44px minimum hit area.
- Motion should be short, interruptible, and meaningful, typically 150-300ms.
- Dark and light themes must be designed together, not inferred by inversion.

## Current Mobile Audit

Audit date: 2026-06-02.

Test target:

- URL: `http://localhost:10003`
- Viewport: `390x844`
- App state: authenticated, opened a current notepad, switched to `#thoughts`

Captured references:

- Notepad mobile view: `.playwright-cli/mobile-notepad-audit.png`
- Thoughts mobile view: `.playwright-cli/mobile-thoughts-audit.png`
- Quick Add mobile view: `.playwright-cli/mobile-quickadd-audit.png`
- Sidebar attempt: `.playwright-cli/mobile-sidebar-audit.png`
- Settings modal: `.playwright-cli/mobile-settings-audit.png`

### What Already Works

- There is already an iOS-oriented override file: `public/Assets/ios-theme.css`.
- The top navigation uses a fixed translucent material and compact icon layout.
- The Notepad reading surface is content-forward and generally readable.
- Quick Thoughts cards already have a softer iOS Notes-like direction.
- Quick Add is close to a native sheet pattern: blurred backdrop, focused input,
  clear submit button, and tag selection.
- Important architecture constraints are already respected: frontend remains
  Vanilla JS, no build step, and visual assets are listed in the PWA manifest.

### Observed Mobile Issues

- Header density is high. At 390px width, six icon targets plus the centered
  title compete for space. The title becomes less useful than the controls.
- The mobile app has multiple floating action systems at once: notepad floating
  actions, Thoughts FAB, source toggle, and modal/sheet controls. This raises
  visual noise and z-index risk.
- Sidebar open currently produced a dimmed/blurred overlay without a visible
  sidebar panel in the captured mobile state. This is a functional UX issue,
  not only a style issue.
- Settings is too heavy for a mobile modal. It exposes theme, autosave timing,
  print behavior, sync cache, S3 status, data spaces, advanced destructive
  cloud operations, and JSON/status output in one scrollable surface.
- Quick Add keeps the underlying Thoughts FAB visually present through the
  backdrop. This weakens modal focus.
- Thoughts cards are attractive, but dense: tags, AI suggestions, relation
  counts, copy buttons, subtask controls, and timestamps are all visible in a
  small vertical rhythm.
- Some mobile controls still rely on hover-oriented polish, especially copy and
  secondary actions.
- The current accent color is warm yellow/gold. It gives the app personality,
  but it needs stricter semantic use so warnings, tags, active state, links,
  and primary creation do not all feel equally loud.
- Some Chinese strings appear garbled in raw DOM/source output, although the
  visible browser UI mostly renders correctly. Avoid touching content encoding
  unless a dedicated text-encoding task is opened.

## Recommended Direction

Use an App Shell first approach for this mobile slice.

The priority is to make the mobile structure feel stable before refining every
individual control. The order should be:

1. Mobile shell and layer model.
2. Mobile navigation and sidebar.
3. Notepad mobile reading/editing surface.
4. Quick Thoughts mobile list and filters.
5. Quick Add and lightweight capture.
6. Settings and state surfaces.
7. Final visual pass and verification.

This keeps the work incremental while preventing isolated cosmetic changes from
creating inconsistent layers.

## Implementation Slices

Each slice should be completed, visually checked, tested, and logged before the
next slice starts.

### Slice 1: Mobile Shell And Tokens

Intent:

Create a small mobile design foundation without rewriting the whole styling
system.

Likely files:

- `public/Assets/ios-theme.css`
- `public/Assets/styles.css` only if an existing base rule blocks the mobile
  override

Planned changes:

- Define mobile-specific surface tokens for background, navigation material,
  sheet surface, card surface, separators, scrim, and elevated controls.
- Define a tighter mobile spacing scale based on 4px/8px steps.
- Define consistent mobile radii and shadows. Use large radius for sheets,
  medium radius for cards, pill radius only for compact controls.
- Add or normalize reduced-motion handling for mobile transitions.
- Keep unversioned CSS on the current PWA network-first path; do not alter the
  service worker caching strategy except to include new assets if any are added.

Verification:

- `npm run check`
- Browser screenshot at `390x844` for notepad and Thoughts.
- Confirm no horizontal overflow.

### Slice 2: Header, Navigation, And Floating Actions

Intent:

Make the first viewport feel like a focused mobile app instead of a desktop
toolbar compressed into a phone width.

Planned changes:

- Rebalance the mobile header so primary actions are visible but less crowded.
- Preserve existing actions, but reduce visual competition through grouping,
  sizing, and active-state discipline.
- Make only one creation action visually primary per view:
  - Notepad view: note creation and writing controls.
  - Thoughts view: Thought capture.
- Normalize floating buttons so they do not overlap content, keyboard areas,
  safe areas, or modal sheets.
- Ensure icon buttons have accessible labels and at least 44px hit areas.

Verification:

- Open Notepad view, Thoughts view, and reading mode on `390x844`.
- Check portrait and a narrower width such as `375x812`.
- Confirm scroll helper and Thoughts toggle remain reachable.

### Slice 3: Mobile Sidebar And Overlay

Intent:

Fix the current mobile sidebar failure mode and make navigation feel like an
iOS side sheet or drawer.

Planned changes:

- Ensure opening the menu always reveals a visible sidebar panel above the
  overlay.
- Define a clear z-index stack for header, overlay, sidebar, sheets, modals,
  toasts, and selection popovers.
- Make overlay tap and close button consistently dismiss the sidebar.
- Keep Directory and Recent tabs readable and touch-friendly.
- Avoid hiding the app in a blurred state without an available escape path.

Verification:

- Open sidebar from Notepad and Thoughts views.
- Switch Directory/Recent tabs.
- Close via overlay, close button, and Escape where supported.
- Confirm settings and other header buttons are not clickable while overlay is
  active, but become clickable after close.

### Slice 4: Notepad Mobile Reading And Editing

Intent:

Keep the Markdown surface calm, readable, and stable under mobile browser UI and
keyboard changes.

Planned changes:

- Tune mobile content gutters and line height for Chinese and mixed
  Chinese/English Markdown.
- Confirm `100dvh` behavior does not fight the current page-level scrolling
  model.
- Normalize source-mode and reading-mode controls so they feel like tools, not
  decorations.
- Reduce conflict between floating actions and long-form content near the
  bottom of the viewport.
- Preserve current editor behavior and note version conflict handling.

Verification:

- Load an existing long notepad.
- Toggle reading/editing/source mode.
- Scroll to bottom/top.
- Check that text is not hidden behind floating controls.
- Run `npm run test:note-sync` if editing/sync state is touched.

### Slice 5: Quick Thoughts List And Filters

Intent:

Make Thoughts feel like a focused capture/review stream: fast to scan, rich
when needed, not noisy by default.

Planned changes:

- Reduce default card chrome and clarify hierarchy between text, time, tags,
  AI status, relation count, and subtask controls.
- Consider progressive disclosure for secondary actions on mobile:
  relation/AI details stay available but quieter until the card is focused or
  expanded.
- Make status filters feel like an iOS segmented control.
- Keep tag chips readable, but reduce the visual weight of AI-suggested tags.
- Ensure copy and subtask actions are available on tap, not hover only.

Verification:

- Open `#thoughts` at `390x844`.
- Test search/filter expansion, status filters, date filter, tags, and card
  expansion.
- Run `npm run test:thought-modules` if Thought helper behavior or rendering is
  touched.

### Slice 6: Quick Add Sheet

Intent:

Make capture feel immediate, focused, and native-like.

Planned changes:

- Hide or visually suppress underlying FABs while Quick Add is open.
- Tune backdrop blur/scrim so the sheet has focus without making the app feel
  muddy.
- Keep input height, submit button, and tag chips comfortable for thumb use.
- Preserve Enter/Escape behavior and existing Quick Add data construction.
- Avoid adding extra steps before capture.

Verification:

- Open Quick Add, type text, choose tags, cancel, and submit.
- Confirm focus starts in the textarea.
- Run `npm run test:thought-quick-add` if data construction or event behavior
  is touched.

### Slice 7: Settings, Sync, And Data Surfaces

Intent:

Turn mobile settings into a layered utility surface instead of one overloaded
modal.

Planned changes:

- Keep top-level settings short: theme, sync status, data/cloud entry points,
  and core preferences.
- Move complex cloud/data-management details behind collapsible sections or
  sheet-like subpanels.
- Keep destructive actions visually separated and require explicit confirmation
  as they do today.
- Make sync/conflict status readable without exposing raw JSON by default.
- Preserve all backend data-management APIs and safety checks.

Verification:

- Open settings on mobile.
- Check theme toggle, sync status, data/cloud section, advanced section, and
  destructive action affordance.
- Run `npm run test:s3-prefix` or `npm run test:s3-storage` only if route or
  data-management behavior is touched. Pure CSS changes should not require S3
  tests.

### Slice 8: Final Mobile QA Pass

Intent:

Ensure the mobile slice is coherent and does not regress functionality.

Required checks:

- `npm run check`
- `npm run test:pwa-cache` if CSS/JS/PWA asset lists or service worker behavior
  are touched
- `npm run test:thought-modules` if Thoughts rendering or helpers are touched
- `npm run test:note-sync` if note editing, startup cache, or sync UI behavior
  is touched

Required browser checks:

- `390x844` iPhone-like viewport
- `375x812` small phone viewport
- Notepad view
- Thoughts view
- Quick Add sheet
- Sidebar open/close
- Settings modal
- Light and dark themes

## Documentation Update Rules

After each implemented change, append an entry to the log below with:

- Date and time.
- Files changed.
- What changed.
- Why it changed.
- Browser checks performed.
- Tests run.
- Known follow-up items.

Do not wait until the end of the whole UI/UX effort. The value of this document
is that it prevents design drift during incremental work and lets later agents
continue from the actual state instead of guessing from stale intent.

## Status Ledger

Use this section as the quick machine-readable handoff. Update it every time a
slice changes state.

- [DONE] MOBILE-001: Initial mobile audit and optimization plan created.
- [DONE] MOBILE-002: Mobile sidebar can open from Thoughts view; sidebar sheet,
  overlay, and Quick Add focus layering improved.
- [DONE] MOBILE-003: Mobile header/action refinement. Reduced visual crowding
  without removing existing actions.
- [DONE] MOBILE-004: Quick Thoughts card density reduction. Made text primary,
  lower the weight of tags, AI, relation, and subtask controls.
- [IN PROGRESS] MOBILE-005: Notepad mobile reading/editing polish.
  - [DONE] MOBILE-005A: Convert mobile Notepad floating actions into a bottom
    dock and reserve bottom reading space.
  - [DONE] MOBILE-005B: Move mobile toast feedback above bottom tools.
  - [DONE] MOBILE-005C: Polish mobile source mode and reading mode surfaces.
  - [DONE] MOBILE-005D: Verify mobile source focus and fix extra-small header
    title overflow at `375x812`.
- [DONE] MOBILE-006: Settings/sync/data surface layering for mobile visual
  hierarchy and confirmation UX.
  - [DONE] MOBILE-006A: Convert mobile Settings modal into a sheet-like
    grouped settings surface with sticky actions.
  - [DONE] MOBILE-006B: Mobile advanced cloud maintenance danger-action
    hierarchy reduced from primary red buttons to secondary destructive
    controls.
  - [DONE] MOBILE-006C: Mobile destructive confirmation dialog polished and
    cancel-only tested for cloud delete flow.
- [DONE] MOBILE-007: Final mobile QA across light/dark, `390x844`, and
  `375x812`.
  - [DONE] MOBILE-007A: Dark mobile visual parity pass for Notepad, Settings,
    and Quick Add accent hierarchy.
  - [DONE] MOBILE-007B: Small-phone Thoughts FAB placement pass at `375x812`.
  - [DONE] MOBILE-007C: Small-phone Sidebar, Settings, and Quick Add QA at
    `375x812`; Settings Reset demoted to secondary destructive action.
  - [DONE] MOBILE-007D: Automated final mobile QA matrix for Notepad, Source,
    Sidebar, Settings, Thoughts, and Quick Add at `390x844` and `375x812`.

## Current Open Items

This section is the current truth. Older changelog entries may include
follow-up notes that were later completed.

- [OPEN] MOBILE-005-KBD: Real iOS/Android virtual keyboard behavior still needs
  physical-device or high-fidelity mobile-browser verification.
- [OUT OF SCOPE] DATA-SAFETY-RUN: Real destructive cloud/data API execution was
  intentionally not tested during UI/UX visual QA. Test only in a dedicated
  safety/regression task with disposable prefixes.
- [DONE] MOBILE-006: Mobile Settings visual hierarchy, advanced danger-action
  styling, and cancel-only confirmation UX have been completed.
- [DONE] MOBILE-007: Final automated mobile visual QA matrix has been completed.

## Change Log

### [DONE] 2026-06-02: Final Mobile QA Matrix

Files changed:

- `docs/ui-ux-mobile-optimization-plan.md`
- `.playwright-cli/final-mobile-qa.js` as a local QA script/artifact

What changed:

- Ran a final automated mobile QA matrix for both key mobile sizes and both
  themes.
- Captured final screenshots for Notepad, Source, Sidebar, Settings, Thoughts,
  and Quick Add.
- Verified key visible surfaces and horizontal overflow metrics.

Why it changed:

- The mobile slice needed one consolidated pass after the incremental iOS-like
  polish work to catch regressions in layer stacking, sheet dimensions, and
  small-screen overflow.

Browser checks performed:

- Viewports:
  - `390x844`
  - `375x812`
- Themes:
  - light
  - dark
- States checked for each viewport/theme pair:
  - Notepad
  - Source mode
  - Sidebar open
  - Settings sheet
  - Thoughts list
  - Quick Add sheet
- Result:
  - 24 state checks completed.
  - All checks reported `horizontalOverflow: false`.
  - Sidebar panels remained visible at `326px` width.
  - Settings sheets remained visible and within viewport.
  - Quick Add sheets remained visible and centered.
  - Source editor remained visible with mobile-safe dimensions.
- Screenshot files use this pattern:
  - `.playwright-cli/final-390-light-notepad.png`
  - `.playwright-cli/final-390-dark-quickadd.png`
  - `.playwright-cli/final-375-light-settings.png`
  - `.playwright-cli/final-375-dark-source.png`

Tests run:

- `npm run check`
- `npm run test:pwa-cache`

Known follow-up items:

- Real iOS/Android virtual keyboard behavior still needs physical-device or
  high-fidelity mobile-browser verification.
- Real destructive cloud/data API execution remains intentionally out of scope
  for this visual QA pass.

### [DONE] 2026-06-02: Mobile Destructive Confirmation Dialog Pass

Files changed:

- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Added mobile-specific polish for the universal confirmation dialog.
- Set confirmation dialog width, radius, material, shadow, and 44px action
  targets for mobile.
- Made cancel and dangerous confirm buttons visually distinct in light and dark
  themes with neutral and red-tinted surfaces.
- Did not change confirmation logic, API calls, or data-management behavior.

Why it changed:

- Dangerous cloud actions already require confirmation, but the mobile dialog
  buttons inherited generic styling that made cancel/confirm hierarchy too weak.
- Destructive confirmation should feel deliberate, readable, and touch-safe
  without making the dangerous action look like the default path.

Browser checks performed:

- Read `runCloudAction()` and confirmed `*:run` cloud actions call
  `confirmationManager.show()` before API execution.
- Triggered `#settings-delete-run` only up to the confirmation dialog, then
  canceled. The confirm button was never clicked.
- Captured pre-polish confirmation audits:
  - `.playwright-cli/mobile-375-confirm-danger-audit.png`
  - `.playwright-cli/mobile-375-confirm-danger-light-audit.png`
- Captured post-polish confirmation screenshots:
  - `.playwright-cli/mobile-375-confirm-danger-light-after-polish-final.png`
  - `.playwright-cli/mobile-375-confirm-danger-dark-after-polish-final.png`
- Confirmed final light styles:
  - confirm background: `rgba(255, 59, 48, 0.1)`
  - confirm border: `rgba(255, 59, 48, 0.28)`
  - cancel background: `rgba(118, 118, 128, 0.1)`
  - action height: `44px`

Tests run:

- `npm run check`
- `npm run test:pwa-cache`

Known follow-up items:

- Real destructive API execution remains intentionally untested and is out of
  scope for this visual QA pass.
- Full data-management behavior should be tested in a dedicated safety/regression
  task with disposable prefixes only.

### [DONE] 2026-06-02: Mobile Source Focus And Extra-Small Header Pass

Files changed:

- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Reduced mobile header title spacing so controls and title have more room at
  small widths.
- Added an extra-small `<=380px` title font-size override so `DumbPad` and short
  note titles do not truncate into awkward ellipses when all header tools are
  visible.
- Verified source mode receives focus and keeps bottom padding for the mobile
  dock/source toggle.

Why it changed:

- Source-mode QA at `375x812` showed `DumbPad` truncating as `DumbP...` because
  the title container was only slightly narrower than the text.
- The source editor itself was stable, but the cramped header weakened the
  polished mobile app feel.

Browser checks performed:

- Captured reading bottom check:
  - `.playwright-cli/mobile-375-reading-bottom-light-qa.png`
- Captured source pre-fix check:
  - `.playwright-cli/mobile-375-source-focus-light-qa.png`
- Confirmed source mode state and metrics:
  - `.typora-editor-shell` includes `is-source-mode`.
  - `.typora-source-editor` is focused.
  - source rect is `343x744` at `375x812`.
  - source bottom padding is `124px`.
- Captured post-fix source screenshots:
  - `.playwright-cli/mobile-375-source-focus-light-after-header-final.png`
  - `.playwright-cli/mobile-375-source-focus-dark-after-header-final.png`
- Confirmed `#header-title h1` font size is `14px` at `375x812`, and
  `DumbPad` no longer overflows.

Tests run:

- `npm run check`
- `npm run test:pwa-cache`

Known follow-up items:

- Browser automation does not display the real iOS/Android virtual keyboard in
  this environment. A physical-device or high-fidelity mobile-browser pass is
  still needed before fully closing keyboard behavior.

### [DONE] 2026-06-02: Mobile Advanced Settings Danger Hierarchy Pass

Files changed:

- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Restyled mobile advanced cloud-maintenance actions inside Settings.
- Converted advanced dangerous action buttons from filled red primary buttons
  into red secondary/destructive outline controls.
- Added a calmer grouped surface around `.settings-cloud-advanced`.
- Preserved existing buttons, labels, APIs, confirmation requirements, and data
  management behavior.

Why it changed:

- `375x812` Settings audit showed multiple dangerous advanced actions competing
  visually as primary red calls to action.
- Advanced maintenance should feel available but deliberate, with Save remaining
  the only primary footer action.

Browser checks performed:

- Opened Settings at `375x812` light, expanded advanced maintenance, and
  scrolled to the bottom of the settings form.
- Captured pre-change audit:
  - `.playwright-cli/mobile-375-settings-advanced-light-audit.png`
- Confirmed first advanced danger button computed styles after change:
  - background: `rgba(255, 59, 48, 0.08)`
  - color: `rgb(255, 59, 48)`
  - border: `rgba(255, 59, 48, 0.26)`
- Captured post-change screenshots:
  - `.playwright-cli/mobile-375-settings-advanced-light-after-danger.png`
  - `.playwright-cli/mobile-375-settings-advanced-dark-after-danger.png`

Tests run:

- `npm run check`
- `npm run test:pwa-cache`

Known follow-up items:

- The deeper destructive-action confirmation flow still needs interaction
  testing before marking MOBILE-006 fully complete.
- Do not trigger real destructive S3/local overwrite actions during visual QA.

### [DONE] 2026-06-02: Small-Phone Sheet And Settings Action QA

Files changed:

- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Demoted mobile Settings Reset from a filled red button to a secondary
  destructive outline treatment in both light and dark themes.
- Kept Settings Save as the only visually primary action in the settings sheet.
- Verified 375px mobile Sidebar, Settings, and Quick Add sheet behavior after
  the previous shell and layering changes.

Why it changed:

- `375x812` light Settings QA showed Reset and Save still competed as two
  primary actions.
- The app should keep one dominant action per surface, especially in Settings
  where reset/destructive intent should be clear without feeling like the
  default path.

Browser checks performed:

- Sidebar at `375x812` light:
  - Confirmed `#sidebar-left.visible` is true.
  - Confirmed `body.mobile-sidebar-open` is set.
  - Confirmed sidebar rect is `326x720` at `x=12`, `y=76`.
  - Captured `.playwright-cli/mobile-375-sidebar-light-qa.png`.
- Settings at `375x812`:
  - Confirmed modal rect is `355x698.3125`.
  - Confirmed `.settings-form` uses `overflow-y: auto`.
  - Confirmed `.modal-buttons` remains `position: sticky`.
  - Captured `.playwright-cli/mobile-375-settings-light-qa.png`.
  - Captured `.playwright-cli/mobile-375-settings-light-after-reset.png`.
  - Captured `.playwright-cli/mobile-375-settings-dark-after-reset.png`.
- Quick Add at `375x812`:
  - Confirmed sheet rect is `335x243`.
  - Confirmed textarea receives focus when opened.
  - Confirmed `body.quick-add-open` is set.
  - Captured `.playwright-cli/mobile-375-quickadd-light-qa.png`.
  - Captured `.playwright-cli/mobile-375-quickadd-dark-qa.png`.

Tests run:

- `npm run check`
- `npm run test:pwa-cache`

Known follow-up items:

- MOBILE-005 still needs real mobile or higher-fidelity virtual-keyboard
  verification for editing/source input.
- MOBILE-006 still needs a deeper review of advanced cloud/destructive settings
  flows beyond visual sheet structure.

### [DONE] 2026-06-02: Small-Phone Thoughts FAB Placement Pass

Files changed:

- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Moved the mobile Thoughts Quick Add FAB from bottom-right to bottom-left only
  while `body.thoughts-mode` is active.
- Kept the FAB compact at `48px` with a circular iOS-like primary treatment.
- Added bottom padding to `.thoughts-scroll-area` so the end of the stream has
  breathing room around the fixed FAB.

Why it changed:

- `375x812` QA showed the bottom-right FAB could overlap Thought card footer
  controls, especially relation and AI-count buttons.
- The left-bottom placement avoids the card's right-side action cluster while
  keeping quick capture reachable by thumb.

Browser checks performed:

- Captured pre-fix `375x812` light Thoughts screenshot:
  - `.playwright-cli/mobile-375-thoughts-light-qa.png`
- Confirmed computed FAB position changed to `left: 18px`.
- Captured post-fix `375x812` screenshots:
  - `.playwright-cli/mobile-375-thoughts-light-after-fab.png`
  - `.playwright-cli/mobile-375-thoughts-dark-after-fab.png`
- Confirmed card footer controls remain visible and tappable in light and dark
  themes.

Tests run:

- `npm run check`
- `npm run test:pwa-cache`

Known follow-up items:

- Continue final mobile QA for Settings, Sidebar, Quick Add, and source/editing
  keyboard behavior at `375x812`.

### [DONE] 2026-06-02: Mobile Dark Accent Hierarchy Pass

Files changed:

- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Added mobile dark-theme overrides that reduce yellow dominance on header
  tools, Notepad bottom dock tools, source toggle, Thought tags, and secondary
  Thought controls.
- Kept primary creation/saving affordances visually primary by preserving a
  stronger yellow treatment for Quick Add submit and Settings Save.
- Downgraded Settings Reset from a full red primary-style button to a red
  secondary/destructive outline treatment on mobile dark theme.
- Tuned dark Quick Add sheet material, input focus, and shadow so focus remains
  clear without making the entire sheet feel neon.

Why it changed:

- Dark-mode audit showed that the warm yellow accent was being used too broadly
  across tools, tags, links, FABs, and settings actions.
- The intended iOS-like quality needs clear hierarchy: content first, tools
  quiet, one primary action per surface, and destructive actions visually
  distinct but not over-dominant.

Browser checks performed:

- Captured true Notepad dark audit at `390x844`:
  - `.playwright-cli/mobile-notepad-dark-true-audit.png`
- Captured Settings and Quick Add dark audits at `390x844`:
  - `.playwright-cli/mobile-settings-dark-audit.png`
  - `.playwright-cli/mobile-quickadd-dark-audit.png`
- Re-tested after CSS changes and captured final dark screenshots:
  - `.playwright-cli/mobile-notepad-dark-after-accent-final.png`
  - `.playwright-cli/mobile-settings-dark-after-accent-final.png`
  - `.playwright-cli/mobile-quickadd-dark-after-accent-final.png`
- Confirmed Settings Reset is now secondary/destructive while Save remains the
  primary action.
- Confirmed Quick Add backdrop intercepts duplicate FAB clicks while the sheet
  is open, which preserves modal focus.

Tests run:

- `npm run check`
- `npm run test:pwa-cache`

Known follow-up items:

- MOBILE-007 still needs full light/dark pass at both `390x844` and `375x812`.
- MOBILE-005 still needs virtual-keyboard behavior verification.
- MOBILE-006 still needs advanced cloud/destructive settings interaction
  review.

### [DONE] 2026-06-02: Mobile Source And Reading Surface Pass

Files changed:

- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Restyled mobile source mode as a rounded Markdown/code surface with softer
  material, clearer insets, code font, calmer text color, and larger bottom
  padding.
- Slightly tuned reading-mode line height for a calmer long-form reading feel.
- Kept source-mode toggle behavior and reading-mode behavior unchanged.

Why it changed:

- Source mode previously felt closer to a bare textarea than part of the same
  iOS-inspired mobile system.
- Reading and source surfaces should feel related while still making the active
  mode obvious.

Browser checks performed:

- Opened source mode at `390x844`.
- Confirmed `.typora-editor-shell` enters `is-source-mode`.
- Confirmed source editor radius is `18px` and padding is
  `18px 18px 124px`.
- Opened reading mode at `390x844`.
- Confirmed `.typora-editor-shell` enters `is-reading-mode` and source toggle
  is hidden.
- Captured updated screenshots:
  - `.playwright-cli/mobile-source-after-polish.png`
  - `.playwright-cli/mobile-reading-after-polish.png`

Tests run:

- `npm run check`

Known follow-up items:

- MOBILE-005 still needs keyboard behavior verification on an actual mobile or
  emulated virtual-keyboard flow.
- Continue with remaining MOBILE-006 interaction review for advanced settings
  and destructive cloud/data actions.

### [DONE] 2026-06-02: Mobile Settings Sheet Pass

Files changed:

- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Converted mobile Settings from a centered desktop-style modal into a
  bottom-aligned sheet-like surface.
- Made the settings content area scroll independently while keeping Cancel,
  Reset, and Save sticky at the bottom.
- Styled settings rows, sync status, and data/cloud sections as grouped mobile
  settings surfaces.
- Reduced the height and visual dominance of raw cloud/status output.
- Hid Notepad floating tools and source toggle while any modal is open, so
  modal actions are not visually polluted by background controls.

Why it changed:

- The audit showed Settings was too dense for mobile and bottom controls were
  competing with the Notepad floating dock.
- Settings contains high-risk data-management controls, so the first mobile
  improvement should clarify structure without changing backend APIs or safety
  behavior.

Browser checks performed:

- Opened Settings at `390x844`.
- Confirmed modal content max height is constrained and outer overflow is
  hidden.
- Confirmed `.settings-form` scrolls independently.
- Confirmed bottom actions are `position: sticky`.
- Confirmed background floating dock and source toggle have `opacity: 0` while
  Settings is open.
- Captured updated screenshot:
  - `.playwright-cli/mobile-settings-after-sheet.png`

Tests run:

- `npm run check`

Known follow-up items:

- MOBILE-006 still needs interaction review for advanced cloud sections and
  destructive action flows.
- Consider deeper progressive disclosure later, but do not alter data-management
  API behavior in a visual-only pass.

### [DONE] 2026-06-02: Mobile Toast Placement Pass

Files changed:

- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Moved mobile toast feedback above the bottom Notepad dock.
- Added lightweight blur/shadow polish to toast messages.
- Lowered toast position again while Quick Add or mobile sidebar is open, so
  modal/sheet focus remains primary.

Why it changed:

- After the mobile dock pass, the cached/offline toast could overlap the new
  bottom tool dock. Status feedback should be visible without competing with
  primary controls.

Browser checks performed:

- Re-tested Notepad view at `390x844`.
- Confirmed `.toast-container` uses `bottom: 82px`.
- Confirmed `.floating-actions` uses `bottom: 18px`.
- Captured updated screenshot:
  - `.playwright-cli/mobile-notepad-after-toast.png`

Tests run:

- `npm run check`

Known follow-up items:

- Test with a live visible toast during a later interaction pass.
- Continue remaining MOBILE-005 work: text measure, source-mode polish, and
  keyboard behavior.

### [DONE] 2026-06-02: Mobile Notepad Floating Dock Pass

Files changed:

- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Converted the mobile Notepad floating action stack from a right-side vertical
  rail into a bottom-left translucent tool dock.
- Moved the source-mode toggle into a separate bottom-right circular control.
- Added bottom padding to the mobile editor content/source view so bottom tools
  do not cover the final lines of long notes.

Why it changed:

- The audit showed the previous right-side vertical buttons overlapped Markdown
  headings and body text, reducing the calm reading quality.
- The new arrangement keeps tools reachable while making the text column feel
  less interrupted.

Browser checks performed:

- Re-tested Notepad view at `390x844`.
- Confirmed the floating dock is horizontal with `flex-direction: row`.
- Confirmed source toggle is separated at the bottom right.
- Confirmed editor bottom padding is `116px`.
- Captured updated screenshot:
  - `.playwright-cli/mobile-notepad-after-dock.png`

Tests run:

- `npm run check`

Known follow-up items:

- The cached/offline toast can overlap the new bottom dock. Handle toast
  placement in a later state/feedback pass.
- Continue the remaining MOBILE-005 polish for text measure, reading/source
  mode consistency, and keyboard behavior.

### [DONE] 2026-06-02: Mobile Header And Thought Card Density Pass

Files changed:

- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Added mobile-only header refinements so icon controls are visually quieter
  while keeping all existing actions available.
- Reduced Quick Thoughts card chrome by softening shadows, removing hover lift
  on mobile, tightening card padding, and making timestamps lighter.
- Lowered the visual weight of Thought tags, AI tag suggestions, AI status
  count pills, relation count pills, and footer tool buttons.
- Kept the main Thought text as the strongest element in each card.

Why it changed:

- The audit showed that mobile Thoughts had too many equally loud elements:
  text, tags, AI suggestions, relation buttons, copy actions, timestamps, and
  FAB all competed for attention.
- The desired direction is iOS-like restraint: content first, controls present
  but quieter.

Browser checks performed:

- Re-tested `390x844` Thoughts list after closing Quick Add.
- Confirmed `#thoughts` renders 29 `.thought-card` elements.
- Confirmed header title still renders as `DumbPad`.
- Captured updated screenshots:
  - `.playwright-cli/mobile-thoughts-after-density.png`
  - `.playwright-cli/mobile-notepad-after-density.png`

Tests run:

- `npm run check`

Known follow-up items:

- The Thoughts FAB can still sit close to card footers while scrolling. Handle
  this in a dedicated floating-action placement pass, not as part of card
  density.
- Continue with MOBILE-005: Notepad mobile reading/editing polish.

### [DONE] 2026-06-02: Mobile Shell Layer And Sidebar Fix

Files changed:

- `public/app.js`
- `public/Assets/ios-theme.css`
- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Added a mobile sidebar visibility helper in `app.js` so the sidebar can open
  from Thoughts view even when the main editor layout is hidden.
- Added mobile app-shell CSS overrides for the sidebar sheet, overlay scrim,
  z-index layering, sidebar tabs, and mobile body scroll locking.
- Tuned the mobile header after verification showed that larger hit areas
  squeezed the centered title at `390px` width.
- Suppressed underlying FAB/floating actions while Quick Add or the mobile
  sidebar is open, so modal/sheet focus is cleaner.
- Kept the change limited to mobile layer behavior and visual polish; no data,
  storage, AI, or API behavior was changed.

Why it changed:

- The initial audit found that opening the menu from Thoughts view produced a
  dimmed screen without a visible sidebar because the sidebar lived inside a
  hidden `main` element.
- Quick Add and sidebar overlays needed stronger focus discipline to approach
  the desired iOS-like quality.

Browser checks performed:

- Re-tested `390x844` Thoughts view.
- Confirmed the header title renders as `DumbPad` after resizing adjustments.
- Confirmed sidebar opens in Thoughts view with computed styles:
  `display:flex`, `visibility:visible`, and a visible `326x752` panel.
- Confirmed Quick Add sets underlying FAB to `opacity:0` and
  `pointer-events:none`.
- Captured updated screenshots:
  - `.playwright-cli/mobile-thoughts-after-header-fix.png`
  - `.playwright-cli/mobile-sidebar-after-header-fix.png`
  - `.playwright-cli/mobile-quickadd-after-shell.png`

Tests run:

- `npm run check`
- `npm run test:pwa-cache`

Known follow-up items:

- Continue with Slice 2 header/action refinement; the header is now stable but
  still has many actions in a tight mobile row.
- Review sidebar close behavior with both close button and tap-outside
  interaction on a physical/touch-like device. Playwright selector-clicking the
  overlay targets the center of the overlay, which can overlap the sidebar.
- Begin reducing Thought card visual density in a separate small slice.

### [DONE] 2026-06-02: Initial Mobile Audit And Plan

Files changed:

- `docs/ui-ux-mobile-optimization-plan.md`

What changed:

- Created the UI/UX optimization plan.
- Scoped the current implementation slice to mobile PWA UI/UX.
- Recorded future desktop and shared design-system work as out of scope for
  this slice.
- Captured current mobile audit findings from the running app.

Browser checks performed:

- Opened app at `http://localhost:10003`.
- Authenticated and inspected mobile viewport `390x844`.
- Captured Notepad, Thoughts, Quick Add, sidebar, and settings screenshots.

Tests run:

- None. This was documentation and audit only.

Known follow-up items:

- Start implementation with Slice 1 only.
- Re-test sidebar visibility first because the audit found overlay without a
  visible sidebar panel.
- Keep updating this log after every UI/UX change.
