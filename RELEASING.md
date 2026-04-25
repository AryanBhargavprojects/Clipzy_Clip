# Clipzy macOS Releasing

This document covers the in-repo release flow for `apps/clipzy-macos`.

> Scope: packaging/signing/notarization readiness only. No Apple secrets/certs are committed.

## 1) Unsigned local build (no Apple credentials)

```bash
cd apps/clipzy-macos
bun run release:build:unsigned
```

What this does:
- runs release preflight in `unsigned` mode
- builds Tauri bundles for `app` + `dmg`
- explicitly skips signing (`--no-sign`)

Output location (default Tauri path):
- `src-tauri/target/release/bundle/` (contains `.app` + `.dmg` artifacts)

## 2) Signed build prerequisites

Required local setup:
- macOS with Xcode Command Line Tools installed
- Apple Developer ID Application certificate imported into local keychain
- signing identity available via:
  ```bash
  security find-identity -v -p codesigning
  ```

Required environment variable:
- `APPLE_SIGNING_IDENTITY` (example: `Developer ID Application: Your Company (TEAMID)`)

Run signed build:

```bash
cd apps/clipzy-macos
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Company (TEAMID)"
bun run release:build:signed
```

## 3) Notarization prerequisites

In addition to signed prerequisites, provide notarization credentials:
- `APPLE_ID`
- `APPLE_PASSWORD` (app-specific password)
- `APPLE_TEAM_ID`

Optional (only needed for some account setups):
- `APPLE_PROVIDER_SHORT_NAME`

Run notarized build:

```bash
cd apps/clipzy-macos
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Company (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID1234"
# optional
# export APPLE_PROVIDER_SHORT_NAME="YourProvider"

bun run release:build:notarized
```

## 4) Preflight-only checks

Unsigned/signed/notarized readiness checks without building:

```bash
cd apps/clipzy-macos
bun run release:preflight
bun run release:preflight:signed
bun run release:preflight:notarized
```

Preflight validates:
- required macOS toolchain commands
- Tauri bundle target coherence (`app` + `dmg`)
- referenced icon files and `.icns` presence
- entitlements file exists
- required env vars for selected mode
- local keychain contains the configured signing identity (signed/notarized)

## 5) Verification commands after build

Locate your built app first:

```bash
find src-tauri/target/release/bundle -name "*.app"
```

Then replace paths with the discovered `.app` path.

### Verify codesign

```bash
codesign --verify --deep --strict --verbose=2 \
  "src-tauri/target/release/bundle/<platform>/Clipzy.app"

codesign --display --entitlements :- \
  "src-tauri/target/release/bundle/<platform>/Clipzy.app"
```

### Gatekeeper assessment

```bash
spctl --assess --type execute --verbose \
  "src-tauri/target/release/bundle/<platform>/Clipzy.app"
```

### Notarization staple check (after notarized flow)

```bash
xcrun stapler validate \
  "src-tauri/target/release/bundle/<platform>/Clipzy.app"
```

## 6) What remains manual / external

These cannot be fully automated in-repo:
- issuing and managing Apple Developer certificates
- installing certs into CI/local keychain securely
- Apple account credential provisioning/rotation for notarization
- final release QA on a clean macOS machine
- distribution/upload steps outside this repo
