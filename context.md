# Clipzy macOS App — Session Context

## Product Direction

- Clipzy has pivoted from a Chrome extension to a **macOS-only menu bar app**.
- V1 scope: manual paste of YouTube watch URLs, server-side clipping, no App Store listing, DMG distribution.
- Account is required from first launch.
- Auth remains **browser-only** via external browser handoff. No embedded auth webview.
- UX goal: the macOS app should feel like a **compact menu bar popup** that visually matches the extension popup, not a normal centered desktop app window.

## Current Status Snapshot

- **Phase 1:** done
- **Phase 2:** done end-to-end, including live auth handoff
- **Phase 3:** done (clip form UI + local form state + API submit flow)
- **UI parity pass:** done for the main macOS interface
- **Menu bar popup behavior pass:** implemented in Tauri and compiling cleanly
- Current focus for any next session should be:
  1. manual QA / polish of popup feel on real macOS
  2. then move to recent jobs / notifications / Finder handoff

---

## Phase Status

### Phase 1 — Done
- Tauri app scaffold exists at `apps/clipzy-macos`.
- Tray shell builds and runs.
- App boot path is established.

### Phase 2 — Done end-to-end
- Auth-gated shell replaced the placeholder UI.
- Browser handoff goes to:
  - `https://auth.clipzy.tech/macos/connect?installId=...`
- Polling flow works while install is unlinked.
- Sync/install typing is in place.
- The previously broken live auth handoff is now fixed and working.
- User confirmed the sign-in flow works.

### Phase 3 — Done
Implemented the core clip form flow in the macOS app:
- YouTube URL input
- Start/end time inputs
- Quality selection using entitlement limits
- Submit flow to `POST /api/clip-jobs`
- success state
- error state
- local form persistence between launches/reloads

### UI Parity Pass — Done
The macOS frontend was updated to feel much closer to the existing extension popup:
- tighter shell
- denser spacing
- more popup-like proportions
- improved visual parity with extension styles

### Menu Bar Popup Behavior Pass — Implemented
The Tauri window/tray behavior was updated so the app behaves far more like a menu bar popup:
- fixed compact size: `400x500`
- non-resizable
- non-maximizable
- non-minimizable
- not centered on launch
- undecorated window
- always on top
- hidden on startup
- skipped from taskbar/dock-style app list behavior
- tray click toggles show/hide
- popup is positioned near the tray icon using tray rect data
- popup hides on blur / focus loss
- macOS activation policy set to `Accessory`
- dock visibility disabled on macOS

**Important caveat:** this is still a **positioned Tauri window**, not a native `NSPopover`. It should feel much closer to a menu bar popup, but it is not a fully native popover implementation.

---

## Auth / Deployment Notes

### Key discovery
The earlier assumption that `auth.clipzy.tech` was primarily a Cloudflare/Wrangler deployment target was incorrect for the live auth handoff path.

### Actual live serving chain
- DNS: `auth.clipzy.tech` resolves to VPS `136.244.71.92`
- nginx site: `/etc/nginx/sites-enabled/auth.clipzy.tech`
- proxy target: `http://127.0.0.1:3002`
- systemd service: `clipzy-auth.service`
- app dir on VPS: `/root/Clipzy/landing_page`

### Fix applied
The VPS copy of `landing_page` was stale and missing the `/macos/connect` route/page. The fix was:
- sync local `landing_page/` to VPS
- run `bun install`
- run `bun run build`
- restart `clipzy-auth.service`

### Result
- `https://auth.clipzy.tech/macos/connect?...` no longer renders `Not Found`
- browser flow reaches the macOS linking page correctly
- auth handoff is now live and working

---

## Backend Deployment Notes

A separate backend deployment issue was also fixed earlier in this effort:

- **Issue:** live sync endpoint was not returning `isLinked`
- **Fix:** clean backend release deployed on VPS and systemd override pointed `clipzy-backend` at the clean release directory
- **Result:** `/api/extension-installs/sync` returns `isLinked` correctly

| Detail | Value |
|---|---|
| VPS host | `root@136.244.71.92` |
| Service | `clipzy-backend` |
| Old working dir | `/root/Clipzy` |
| New clean release | `/root/Clipzy-releases/20260417-islinked` |
| systemd override | `/etc/systemd/system/clipzy-backend.service.d/override.conf` |
| backend env file | `/etc/clipzy/backend.env` |

---

## Key Files Changed

### `apps/clipzy-macos/`
| File | Change |
|---|---|
| `src/App.tsx` | Auth-gated shell, linked/unlinked/loading/error states, later updated for UI parity with extension-style shell |
| `src/ClipForm.tsx` | Core clip form UI, local state wiring, submit flow, success/error handling |
| `src/clipzy-ui.css` | Main visual parity pass plus compact popup-style spacing/proportion refinements |
| `src/main.tsx` | Frontend boot cleanup, CSS import cleanup |
| `src/lib/api.ts` | Typed API client plus `createClipJob(req)` for clip creation |
| `src/lib/store.ts` | Added `loadFormState`, `saveFormState`, `clearFormState` for persisted form values |
| `src/lib/api.test.ts` | Tests for sync + clip creation API behavior |
| `src/lib/store.test.ts` | Tests for install/settings/form persistence helpers |
| `src-tauri/tauri.conf.json` | Popup-style window config: fixed size, no resize, no maximize/minimize, hidden by default, no decorations, always on top |
| `src-tauri/src/main.rs` | Registered plugins and implemented tray toggle, popup positioning, blur-to-hide, macOS accessory behavior |
| `src-tauri/Cargo.toml` | Tauri plugins / tray support wiring |
| `src-tauri/capabilities/default.json` | Scoped HTTP capability config |
| `package.json` | Tauri plugin dependencies |

### `landing_page/`
| File | Change |
|---|---|
| `src/App.tsx` | Added `/macos/connect` route |
| `src/pages/MacosConnectPage.tsx` | Browser-based Mac linking page with install claim flow, success/conflict/error handling |

### Repo workflow/context files
| File | Change |
|---|---|
| `AGENT.md` | Updated orchestration / delegation model for cmux + sub-agent workflow |
| `CLAUDE.md` | Updated local project guidance and Bun-oriented workflow notes |

---

## Bugs Fixed Across This Work

| Bug | Root Cause | Fix |
|---|---|---|
| Network error in macOS app | `http:default` permission had no allowed origins | Scoped Tauri HTTP permission with explicit URL patterns |
| API 400 validation on sync | `extensionVersion: null` rejected by backend schema | Omit field when undefined |
| Mac linking page side effects during render | Async/status mutation in render path | Moved logic into `useEffect` with guard |
| Live `/macos/connect` rendered `Not Found` | VPS auth deployment was stale and missing route/page | Synced local `landing_page`, rebuilt, restarted `clipzy-auth.service` |
| macOS app looked too much like a normal app window | Default Tauri window config + simple tray show/focus logic | Implemented popup-style window config and tray toggle/position/hide behavior |

---

## Validation Results

### Frontend / app validation
| Check | Status |
|---|---|
| `bun run --filter clipzy-macos typecheck` | Pass |
| `bun test apps/clipzy-macos/src` | Pass (`14` tests) |
| `bun run --filter clipzy-macos build` | Pass |

### Tauri / Rust validation
| Check | Status |
|---|---|
| `cd apps/clipzy-macos/src-tauri && cargo check` | Pass |

### Live/manual validation already completed
| Check | Status |
|---|---|
| Live auth route `/macos/connect` | Working |
| Browser auth handoff | Working |
| App sign-in/link flow | Working |

---

## Current Implementation Notes

### Current popup/window configuration
The app window is now configured with:
- width: `400`
- height: `500`
- `minWidth` / `maxWidth`: `400`
- `minHeight` / `maxHeight`: `500`
- `resizable: false`
- `maximizable: false`
- `minimizable: false`
- `center: false`
- `decorations: false`
- `alwaysOnTop: true`
- `skipTaskbar: true`
- `visible: false`

### Current tray behavior
On tray interaction:
- left click toggles the popup
- when shown, the window is positioned relative to the tray icon rect when available
- focus loss hides the window
- close requests are intercepted and converted to hide behavior

---

## Next Session Checklist

### Highest-priority manual QA
1. Test the tray/menu bar behavior on real macOS:
   - click tray icon → popup opens
   - click again → popup hides
   - click elsewhere → popup hides on blur
   - confirm it opens in a compact popup style rather than like a normal desktop app
   - confirm it is not resizable / maximizable

### If popup feel still needs polish
2. Refine tray anchoring or sizing if needed after seeing a fresh screenshot/video.
3. If Tauri window behavior is still not good enough, evaluate whether a deeper native macOS approach is required.

### After popup QA/polish
4. Move to the next product features:
   - recent jobs list
   - notifications
   - Finder/output handoff improvements

---

## Practical Reminder For Future Sessions

- The auth handoff is **already fixed live**.
- Phase 3 clip form work is **already implemented and validated**.
- The main unresolved area is no longer auth or form submission — it is **manual UX verification / polish** of the menu bar popup behavior on macOS and then continuing with post-submit product features.
