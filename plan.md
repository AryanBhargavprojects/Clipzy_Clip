
 ```md
   # Clipzy macOS Pivot Plan

   ## 1. Product Pivot Summary

   Clipzy is pivoting from a backend-driven, subscription-based clip generation product to an **open-source, local-first macOS
 app**.

   ### New direction
   - The macOS app will be distributed as a **DMG**.
   - The app will be **open-source**.
   - Clip generation will run **on the user’s machine**, not on our VPS/backend.
   - We are **dropping the subscription model**.
   - We still plan to enroll in the **Apple Developer Program** so we can sign, notarize, and distribute a polished DMG.

   ### Implications
   This is not just a packaging change. It is a major architecture pivot:
   - remove cloud job execution assumptions
   - remove account/auth requirements
   - remove backend polling as the primary execution model
   - replace remote clip jobs with a local job runner, local state, local storage, and local notifications

   ---

   ## 2. Current Architecture Snapshot

   As of the current codebase, `apps/clipzy-macos` already has a strong macOS shell and user experience foundation.

   ### What exists now
   - **Tauri 2 macOS tray/menu bar app**
   - compact popup UI aligned with extension design
   - multi-screen popup flow:
     - Generator
     - Loading
     - Result
     - Settings
     - Recent
   - backend-based clip submission flow:
     - `POST /api/clip-jobs`
     - `GET /api/clip-jobs/:id`
     - `GET /api/clip-jobs`
   - active job polling + resume-on-reopen
   - recent jobs list + notifications
   - packaging/signing/notarization readiness work in progress
   - release preflight / build scripts already added

   ### Current assumptions baked into the app
   - auth/account is required
   - app talks to `api.clipzy.tech`
   - job lifecycle is remote:
     - create remote job
     - poll remote job
     - open remote output URL
   - entitlements/limits/plan model still exists in frontend state and UX

   These assumptions must be removed or replaced.

   ---

   ## 3. What We Are Removing / Deprecating

   ## Product-level removals
   - subscription model
   - account linking/auth requirement
   - plan/entitlement model
   - cloud/VPS clip processing as the core execution path

   ## Technical removals or deprecations
   - install-linking / auth-gated shell in `src/App.tsx`
   - backend sync/install flow
   - remote job creation + polling as the primary architecture
   - dependency on VPS clip queue for clip generation
   - plan-based quality gating
   - any UI copy implying cloud generation or account requirements

   ## Backend scope change
   The old backend/VPS stack becomes optional or fully obsolete for this app release path.

   We should treat the current backend integration as:
   - deprecated for the macOS open-source local-first version
   - potentially removable after migration is complete

   ---

   ## 4. What We Are Keeping

   The pivot does **not** mean rewriting everything.

   ### Keep
   - Tauri tray/menu bar shell
   - popup window behavior and sizing
   - most of the popup UI structure
   - generator/recent/settings/result/loading screen architecture
   - notifications UX
   - recent jobs UX
   - release-readiness work:
     - DMG/app packaging
     - signing
     - notarization prep
   - local persistence patterns
   - job-oriented mental model

   ### Reuse with adaptation
   - current loading/result/recent screens
   - current local store patterns
   - current recent jobs persistence
   - notification plumbing
   - release scripts and docs

   The goal should be **replace remote execution**, not rebuild the entire app shell.

   ---

   ## 5. New Target Architecture for Local Processing

   ## Core principle
   The app should become a **local job runner**.

   ### Proposed local processing stack
   - **yt-dlp** for fetching/downloading source media
   - **ffmpeg** for clipping/transcoding
   - local job queue managed by Tauri/Rust or a local command orchestration layer
   - local metadata store for job history/status/output paths
   - local notifications for completion/failure

   ### Target architecture
   1. User pastes YouTube URL and clip settings
   2. App creates a **local clip job**
   3. Local runner downloads source media
   4. Local runner executes clipping via ffmpeg
   5. App updates local job state
   6. App shows result and recent history from local data
   7. Notifications fire on terminal states

   ### Likely local components
   - **Frontend (React)**:
     - form
     - recent jobs
     - loading/progress
     - result screen
   - **Native layer (Rust/Tauri)**:
     - local job queue / worker
     - filesystem access
     - child process orchestration
     - notifications
   - **Local storage**:
     - job metadata
     - recent jobs
     - output file paths
     - processing state

   ### Output model
   Instead of remote `outputUrl`, jobs should store:
   - local output path
   - file existence state
   - open/reveal behavior later if needed

   ---

   ## 6. Recommended Phased Implementation Roadmap

   ## Phase A — Product + architecture cleanup
   Goal: remove product assumptions that no longer apply.

   Tasks:
   - remove auth requirement from app boot flow
   - remove subscription/plan messaging
   - remove entitlement-based gating
   - simplify startup into direct local app usage
   - update copy across screens to local-first language

   Deliverable:
   - app opens directly into generator without account linking

   ---

   ## Phase B — Local job domain model
   Goal: replace remote `ClipJob` assumptions with local equivalents.

   Tasks:
   - define local job type:
     - id
     - source URL
     - start/end
     - quality
     - status
     - createdAt/updatedAt
     - outputPath
     - error
     - progress/logs (optional)
   - create local persistence for jobs
   - decide store location:
     - sqlite
     - json
     - tauri store
     - file-backed Rust persistence

   Recommendation:
   - prefer a **Rust-side job model + persistent local storage**
   - avoid keeping core job state only in browser `localStorage`

   Deliverable:
   - local job records independent of backend APIs

   ---

   ## Phase C — Local processing engine
   Goal: execute clips locally.

   Tasks:
   - decide whether to bundle or require:
     - `yt-dlp`
     - `ffmpeg`
   - implement Tauri command(s) to:
     - create job
     - start job
     - observe status/progress
     - cancel job (optional)
   - implement download + clip execution pipeline
   - write outputs to known app-managed folder

   Questions to resolve:
   - bundle binaries inside app vs detect installed binaries
   - auto-install helper tools vs manual prerequisites
   - licensing/distribution implications of bundled ffmpeg/yt-dlp

   Deliverable:
   - first successful local clip generated on-device

   ---

   ## Phase D — Frontend migration from remote polling to local status
   Goal: point existing popup UX at local job engine.

   Tasks:
   - replace API calls in `src/lib/api.ts` / `ClipForm.tsx`
   - introduce Tauri commands/events for job lifecycle
   - update loading screen to local processing states
   - update result screen to local output metadata
   - refresh recent jobs from local store, not backend

   Deliverable:
   - UI works with local jobs end-to-end

   ---

   ## Phase E — Notifications + recent jobs hardening
   Goal: keep the good UX from the current version.

   Tasks:
   - preserve notification behavior for completed/failed jobs
   - keep recent jobs screen
   - store recent jobs locally and robustly
   - make tray “Recent Jobs” navigation work with local history

   Deliverable:
   - local recent jobs + notifications fully working

   ---

   ## Phase F — Packaging and release
   Goal: ship open-source local-first macOS app.

   Tasks:
   - finalize unsigned local builds
   - sign + notarize with Apple Developer Program
   - produce DMG
   - publish GitHub release
   - write install instructions
   - document any bundled dependencies / local requirements

   Deliverable:
   - signed + notarized DMG release

   ---

   ## 7. Technical Questions / Risks

   ## A. How do we handle yt-dlp and ffmpeg?
   This is the biggest technical/product packaging question.

   Options:
   1. **Bundle both**
      - best UX
      - larger app
      - licensing/distribution work
   2. **Require user-installed dependencies**
      - simpler packaging
      - worse UX
   3. **Hybrid**
      - detect first
      - offer guided setup if missing

   This decision should be made early.

   ## B. Where should local jobs be stored?
   Current app uses `localStorage` patterns for some state.
   That is not ideal for core durable job management.

   Need decision:
   - Rust-side sqlite
   - file-backed JSON
   - tauri store plugin
   - hybrid model

   Recommendation:
   - keep critical job history/state outside browser `localStorage`

   ## C. How do we surface progress?
   Local processing allows richer progress than remote polling.
   Need to decide:
   - simple status only
   - log lines
   - progress percentage
   - staged progress (download → clip → finalize)

   ## D. What happens with app updates?
   As an open-source downloadable DMG, we need to decide whether:
   - manual GitHub Releases updates are enough
   - or we eventually add auto-update support

   ## E. Licensing and legal review
   If bundling ffmpeg/yt-dlp:
   - review redistribution terms
   - document licenses clearly

   ---

   ## 8. Distribution / Release Plan for Open-Source DMG

   ## Distribution model
   - GitHub repo is public
   - GitHub Releases hosts `.dmg`
   - website links to latest signed/notarized DMG
   - no subscription / no auth required to use app

   ## Release requirements
   - Apple Developer Program account
   - Developer ID Application certificate
   - notarization credentials
   - signed + notarized DMG

   ## Release artifacts
   - `.app`
   - `.dmg`
   - checksums
   - release notes
   - install instructions
   - dependency notes if local binaries are required externally

   ## Website/download UX
   Website should clearly say:
   - open-source
   - local processing on your machine
   - no subscription
   - macOS requirements
   - whether ffmpeg/yt-dlp are bundled or required separately

   ---

   ## 9. Suggested Immediate Next Steps

   ## Immediate next engineering steps
   1. **Decide dependency strategy**
      - bundle vs require local `yt-dlp` / `ffmpeg`
   2. **Remove auth/subscription assumptions**
      - simplify app boot flow
   3. **Define local job model**
      - replace remote `ClipJob` dependency
   4. **Implement local processing spike**
      - prove first local clip generation works on-device
   5. **Then migrate popup screens**
      - hook UI to local job engine

   ## Suggested first implementation slice
   The best first slice is:

   ### Slice 1
   - remove auth gate
   - land directly in generator
   - add a Rust command that creates/runs a local clip job
   - generate one clip locally with ffmpeg/yt-dlp
   - persist the local result

   That will validate the pivot before we spend time on broader cleanup.

   ---

   ## 10. Practical Notes for Future Sessions

   - Do not continue investing heavily in backend/VPS clip-job architecture for macOS.
   - Preserve the current popup UX shell; replace the execution engine underneath it.
   - Treat current remote polling implementation as a migration reference, not final architecture.
   - Packaging/signing/notarization work remains useful and should continue.
   - Finder handoff/reveal is not the priority right now.
   - The biggest blocking decision is **local dependency strategy** for `yt-dlp` and `ffmpeg`.

   ---

   ## 11. Definition of Success for the Pivot

   The pivot is successful when:

   1. User installs Clipzy from a DMG
   2. Opens menu bar popup
   3. Pastes YouTube URL
   4. App processes clip **locally**
   5. Recent jobs + notifications work
   6. No account/subscription/backend dependency is required
   7. App can be signed/notarized and distributed publicly
