#!/usr/bin/env bun

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const vendorDir = resolve(appRoot, "vendor", "sidecars", "darwin-arm64");
const sidecarDir = resolve(appRoot, "src-tauri", "binaries");

const sidecars = [
  {
    name: "yt-dlp",
    url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
    cachePath: resolve(vendorDir, "yt-dlp_macos"),
    destination: resolve(sidecarDir, "yt-dlp-aarch64-apple-darwin"),
    smokeArgs: ["--version"],
  },
  {
    name: "ffmpeg",
    url: "https://raw.githubusercontent.com/imageio/imageio-binaries/master/ffmpeg/ffmpeg-macos-aarch64-v7.1",
    cachePath: resolve(vendorDir, "ffmpeg-macos-aarch64-v7.1"),
    destination: resolve(sidecarDir, "ffmpeg-aarch64-apple-darwin"),
    smokeArgs: ["-version"],
  },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function download(url, destination) {
  console.log(`↓ Downloading ${url}`);
  const tmp = `${destination}.download`;
  rmSync(tmp, { force: true });

  const result = spawnSync(
    "curl",
    [
      "--fail",
      "--location",
      "--show-error",
      "--silent",
      "--connect-timeout",
      "30",
      "--max-time",
      "600",
      "--retry",
      "3",
      "--retry-delay",
      "2",
      "--user-agent",
      "Clipzy macOS release build",
      "--output",
      tmp,
      url,
    ],
    { stdio: "inherit", env: process.env },
  );

  if (result.status !== 0) {
    rmSync(tmp, { force: true });
    fail(`Failed to download ${url}.`);
  }

  const size = statSync(tmp).size;
  if (size < 1024 * 1024) {
    rmSync(tmp, { force: true });
    fail(`Downloaded file from ${url} is unexpectedly small (${size} bytes).`);
  }

  rmSync(destination, { force: true });
  copyFileSync(tmp, destination);
  rmSync(tmp, { force: true });
  chmodSync(destination, 0o755);
}

function smokeTest(binary, args, name) {
  const result = spawnSync(binary, args, {
    stdio: "pipe",
    env: process.env,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    const stdout = result.stdout?.toString() ?? "";
    fail(`Downloaded ${name} failed smoke test.\n${stderr || stdout}`);
  }
}

function assertNoHomebrewLinkage(binary, name) {
  if (name !== "ffmpeg") return;

  const result = spawnSync("otool", ["-L", binary], {
    stdio: "pipe",
    env: process.env,
  });

  if (result.status !== 0) {
    fail(`Could not inspect ${name} dynamic library dependencies with otool.`);
  }

  const output = result.stdout.toString();
  if (output.includes("/opt/homebrew") || output.includes("/usr/local/Cellar") || output.includes("/opt/local")) {
    fail(`${name} still links to package-manager libraries:\n${output}`);
  }
}

if (process.platform !== "darwin") {
  console.log("↷ Skipping sidecar sync: macOS binaries are only bundled on darwin.");
  process.exit(0);
}

if (process.arch !== "arm64") {
  fail(`Clipzy currently bundles Apple Silicon sidecars only. Current arch: ${process.arch}`);
}

mkdirSync(vendorDir, { recursive: true });
mkdirSync(sidecarDir, { recursive: true });

const refresh = process.env.CLIPZY_REFRESH_SIDECARS === "1";

for (const sidecar of sidecars) {
  if (refresh && existsSync(sidecar.cachePath)) {
    rmSync(sidecar.cachePath, { force: true });
  }

  if (!existsSync(sidecar.cachePath)) {
    await download(sidecar.url, sidecar.cachePath);
  } else {
    const size = statSync(sidecar.cachePath).size;
    if (size < 1024 * 1024) {
      rmSync(sidecar.cachePath, { force: true });
      await download(sidecar.url, sidecar.cachePath);
    }
  }

  chmodSync(sidecar.cachePath, 0o755);
  smokeTest(sidecar.cachePath, sidecar.smokeArgs, sidecar.name);
  assertNoHomebrewLinkage(sidecar.cachePath, sidecar.name);

  rmSync(sidecar.destination, { force: true });
  copyFileSync(sidecar.cachePath, sidecar.destination);
  chmodSync(sidecar.destination, 0o755);

  console.log(`✓ Bundled standalone ${sidecar.name} → ${sidecar.destination}`);
}
