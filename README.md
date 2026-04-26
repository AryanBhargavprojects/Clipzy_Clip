<div align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Clipzy" width="128" height="128" />

  # Clipzy

  **Clip YouTube videos at the speed of thought.**

  A native macOS app for turning YouTube videos into polished clips — fast, private, and processed entirely on your machine.

  [Download for Mac (Apple Silicon)](https://github.com/AryanBhargavprojects/Clipzy_Clip/releases/latest) · [Website](https://clipzy.tech) · [Report a Bug](https://github.com/AryanBhargavprojects/Clipzy_Clip/issues)
</div>

---

## Features

- **Local processing** — Clips are generated on your Mac using bundled `yt-dlp` and `ffmpeg`. No uploads, no server processing, no cloud dependency.
- **Fast & private** — Your YouTube URLs and clip data never leave your machine.
- **Free tier** — Unlimited clips with a watermark. No sign-up required to start.
- **Lifetime unlock** — One-time purchase removes the watermark forever. No subscriptions.
- **Compact UI** — A focused 400×600 window that stays out of your way.
- **Recent jobs** — Browse, retry, or reveal completed clips in Finder.

## Screenshots

> _Add screenshots here if desired — the app has a glass-morphism dark UI with a form, processing spinner, and result screen._

## Getting Started

### Prerequisites

- **macOS** (Apple Silicon / aarch64)
- [Bun](https://bun.sh) ≥ 1.0
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Xcode Command Line Tools](https://developer.apple.com/xcode/resources/) (`xcode-select --install`)

### Install

```bash
git clone https://github.com/AryanBhargavprojects/Clipzy_Clip.git
cd Clipzy_Clip
bun install
```

### Development

```bash
# Download standalone sidecars (yt-dlp + ffmpeg)
bun run sync:sidecars

# Start the dev server + Tauri window
bun run tauri dev
```

### Build a DMG

```bash
# Unsigned / ad-hoc signed DMG (no Apple Developer Program needed)
bun run release:build:unsigned
```

The DMG appears at:
```
src-tauri/target/release/bundle/dmg/Clipzy_<version>_aarch64.dmg
```

> **Note:** Unsigned macOS apps will trigger Gatekeeper warnings. Users can bypass this via _System Settings → Privacy & Security → Open Anyway_, or by running:
> ```bash
> xattr -dr com.apple.quarantine /Applications/Clipzy.app
> ```

## How It Works

Clipzy is a [Tauri 2](https://v2.tauri.app/) app — a Rust backend with a React frontend rendered in a native macOS webview.

```
┌─────────────────────────────────────────┐
│              Clipzy App                  │
│  ┌───────────┐  ┌────────────────────┐  │
│  │  React UI  │  │   Rust (Tauri)     │  │
│  │  (webview) │◄─►│  - Local jobs      │  │
│  │            │  │  - yt-dlp sidecar  │  │
│  └───────────┘  │  - ffmpeg sidecar  │  │
│                  └────────────────────┘  │
│                         │                │
│                    Local files           │
│                  ~/Library/Application   │
│                  Support/tech.clipzy/    │
└─────────────────────────────────────────┘
```

1. **Paste a YouTube URL** and select start/end timestamps.
2. **yt-dlp** downloads the source video segment locally.
3. **ffmpeg** trims, encodes, and optionally overlays a watermark.
4. The finished clip is saved to `~/Library/Application Support/tech.clipzy.macos/jobs/`.

### Sidecars

Clipzy bundles standalone `yt-dlp` and `ffmpeg` binaries — no Homebrew or system dependencies required. The `sync-sidecars.mjs` script downloads them:

| Tool     | Source                                                                                      |
| -------- | ------------------------------------------------------------------------------------------- |
| yt-dlp   | [yt-dlp/yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases)                        |
| ffmpeg   | [imageio/imageio-binaries](https://github.com/imageio/imageio-binaries) (GPL, static build) |

Sidecars are placed in `src-tauri/binaries/` and embedded in the app bundle at build time.

## Project Structure

```
├── src/                    # React frontend (webview UI)
│   ├── App.tsx             # Auth gate + routing
│   ├── ClipForm.tsx        # Main form + job management UI
│   ├── clipzy-ui.css       # Glass-morphism styles
│   └── lib/
│       ├── api.ts          # Backend API client
│       ├── auth-state.ts   # Auth state types
│       └── store.ts        # localStorage persistence
├── src-tauri/              # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs         # App setup, Dock, Reopen handler
│   │   └── local_jobs.rs   # Local job create/run/list/cancel
│   ├── capabilities/       # Tauri permission config
│   ├── entitlements.mac.plist
│   └── tauri.conf.json
├── scripts/
│   ├── sync-sidecars.mjs   # Download standalone sidecars
│   └── release-build.mjs   # Build unsigned DMG
└── vendor/sidecars/        # Cached sidecar downloads (gitignored)
```

## Tech Stack

| Layer     | Technology                                              |
| --------- | ------------------------------------------------------- |
| Frontend  | React 19, TypeScript, Vite                              |
| Backend   | Rust, [Tauri 2](https://v2.tauri.app/)                  |
| Video     | [yt-dlp](https://github.com/yt-dlp/yt-dlp), [ffmpeg](https://ffmpeg.org/) (bundled sidecars) |
| Auth      | [Better Auth](https://www.better-auth.com/) (hosted separately) |
| Payments  | [Polar](https://polar.sh/)                              |

## Contributing

Contributions are welcome! Here's how you can help:

1. **Fork** the repository.
2. **Create a feature branch:** `git checkout -b my-feature`
3. **Make your changes** and test with `bun run tauri dev`.
4. **Commit:** `git commit -m "Add my feature"`
5. **Push:** `git push origin my-feature`
6. **Open a Pull Request** against `main`.

### Ideas for Contributions

- Intel (x86_64) macOS support
- Real-time yt-dlp download progress
- Real-time ffmpeg encoding progress
- Source video caching / reuse
- Adjustable output format (MP4, MOV, GIF, etc.)
- Keyboard shortcuts
- Localization / i18n
- Dark / light mode toggle

## License

This project is licensed under the **MIT License** — see [LICENSE](LICENSE) for details.

### Third-Party Licenses

- **yt-dlp** — [Unlicense License](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE)
- **ffmpeg** — [GPL v2+](https://ffmpeg.org/legal.html) (static build from imageio-binaries)

The bundled ffmpeg binary is GPL-licensed. If you redistribute modified versions of this app, ensure compliance with GPL terms for the ffmpeg component.

---

<div align="center">
  Built with ❤️ by <a href="https://github.com/AryanBhargavprojects">Aryan Bhargav</a>
</div>
