#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const VALID_MODES = new Set(["unsigned", "signed", "notarized"]);

function parseMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg ? modeArg.slice("--mode=".length) : "unsigned";
  if (!VALID_MODES.has(mode)) {
    console.error(
      `Invalid --mode value \"${mode}\". Expected one of: ${Array.from(VALID_MODES).join(", ")}`,
    );
    process.exit(1);
  }
  return mode;
}

function run(command, args = []) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandExists(command) {
  const result = run("bash", ["-lc", `command -v ${command}`]);
  return result.status === 0;
}

function normalizeTargets(value) {
  if (!value) return new Set();
  if (Array.isArray(value)) return new Set(value.map((v) => String(v).toLowerCase()));
  return new Set([String(value).toLowerCase()]);
}

const mode = parseMode(process.argv.slice(2));
const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const tauriRoot = resolve(appRoot, "src-tauri");
const tauriConfigPath = resolve(tauriRoot, "tauri.conf.json");

const failures = [];
const warnings = [];

console.log(`🔎 Clipzy macOS release preflight (${mode})`);

if (process.platform !== "darwin") {
  failures.push(
    `Release packaging is macOS-only. Current platform is \"${process.platform}\". Run this on macOS.`,
  );
}

for (const command of ["bun", "cargo", "rustc", "xcodebuild", "xcrun", "codesign", "spctl", "security"]) {
  if (!commandExists(command)) {
    failures.push(`Missing required command: ${command}`);
  }
}

const xcodeSelect = run("xcode-select", ["-p"]);
if (xcodeSelect.status !== 0) {
  failures.push("Xcode Command Line Tools are not configured (`xcode-select -p` failed).");
}

let tauriConfig;
try {
  tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
} catch (error) {
  failures.push(`Could not read/parse ${tauriConfigPath}: ${String(error)}`);
}

if (tauriConfig) {
  const bundle = tauriConfig.bundle ?? {};
  const macOS = bundle.macOS ?? {};
  const targets = normalizeTargets(bundle.targets);
  const icons = Array.isArray(bundle.icon) ? bundle.icon : [];

  if (bundle.active !== true) {
    failures.push("`bundle.active` must be true in src-tauri/tauri.conf.json.");
  }

  if (!(targets.has("all") || (targets.has("app") && targets.has("dmg")))) {
    failures.push(
      "`bundle.targets` should include macOS release outputs (`app` and `dmg`, or `all`).",
    );
  }

  if (icons.length === 0) {
    failures.push("`bundle.icon` is empty in tauri.conf.json.");
  }

  let hasIcns = false;
  for (const iconRelPath of icons) {
    const iconPath = resolve(tauriRoot, iconRelPath);
    if (!existsSync(iconPath)) {
      failures.push(`Missing icon asset referenced in tauri.conf.json: ${iconRelPath}`);
      continue;
    }

    if (iconRelPath.toLowerCase().endsWith(".icns")) {
      hasIcns = true;
    }

    const stats = statSync(iconPath);
    if (stats.size === 0) {
      failures.push(`Icon asset is empty: ${iconRelPath}`);
    }
  }

  if ((targets.has("all") || targets.has("app") || targets.has("dmg")) && !hasIcns) {
    failures.push("macOS packaging requires an .icns icon in `bundle.icon`.");
  }

  if (typeof macOS.entitlements !== "string" || macOS.entitlements.length === 0) {
    failures.push("`bundle.macOS.entitlements` must point to a committed entitlements plist.");
  } else {
    const entitlementsPath = resolve(tauriRoot, macOS.entitlements);
    if (!existsSync(entitlementsPath)) {
      failures.push(
        `Entitlements file configured at \"bundle.macOS.entitlements\" was not found: ${macOS.entitlements}`,
      );
    }
  }

  const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || macOS.signingIdentity;

  if (mode === "signed" || mode === "notarized") {
    if (!signingIdentity) {
      failures.push(
        "Signing flow requires APPLE_SIGNING_IDENTITY (or bundle.macOS.signingIdentity) to be set.",
      );
    } else {
      const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
      if (identities.status !== 0) {
        failures.push("Unable to query code-signing identities via `security find-identity`.");
      } else if (!identities.stdout.toLowerCase().includes(String(signingIdentity).toLowerCase())) {
        failures.push(
          `Configured signing identity \"${signingIdentity}\" was not found in local keychain identities.`,
        );
      }
    }
  }

  if (mode === "notarized") {
    for (const envName of ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) {
      if (!process.env[envName]) {
        failures.push(`Missing required environment variable for notarization: ${envName}`);
      }
    }

    const notarytool = run("xcrun", ["notarytool", "--version"]);
    if (notarytool.status !== 0) {
      failures.push("`xcrun notarytool` is unavailable. Install/update Xcode Command Line Tools.");
    }

    if (!process.env.APPLE_PROVIDER_SHORT_NAME && !macOS.providerShortName) {
      warnings.push(
        "APPLE_PROVIDER_SHORT_NAME is not set. This is optional for modern notarytool flow but may be needed in some Apple account setups.",
      );
    }
  }
}

if (warnings.length > 0) {
  console.warn("\n⚠️  Warnings:");
  for (const warning of warnings) {
    console.warn(`  - ${warning}`);
  }
}

if (failures.length > 0) {
  console.error("\n❌ Preflight failed:");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("✅ Preflight checks passed.");
