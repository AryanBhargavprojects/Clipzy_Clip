#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

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

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
}

const mode = parseMode(process.argv.slice(2));
const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");

run("bun", ["run", "scripts/release-preflight.mjs", `--mode=${mode}`], appRoot);

const tauriArgs = ["run", "tauri", "build", "--bundles", mode === "unsigned" ? "app" : "app,dmg", "--ci"];

if (mode === "unsigned") {
  tauriArgs.push("--no-sign");
} else {
  const macOsConfigOverride = {};
  if (process.env.APPLE_SIGNING_IDENTITY) {
    macOsConfigOverride.signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
  }
  if (process.env.APPLE_PROVIDER_SHORT_NAME) {
    macOsConfigOverride.providerShortName = process.env.APPLE_PROVIDER_SHORT_NAME;
  }

  if (Object.keys(macOsConfigOverride).length > 0) {
    tauriArgs.push(
      "--config",
      JSON.stringify({
        bundle: {
          macOS: macOsConfigOverride,
        },
      }),
    );
  }
}

console.log(`🚀 Running Tauri release build (${mode})`);
run("bun", tauriArgs, appRoot);

if (mode === "unsigned" && process.platform === "darwin") {
  const tauriConfigPath = resolve(appRoot, "src-tauri/tauri.conf.json");
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const productName = tauriConfig.productName ?? "Clipzy";
  const version = tauriConfig.version ?? "0.1.0";
  const arch = process.arch === "arm64" ? "aarch64" : process.arch;
  const bundleRoot = resolve(appRoot, "src-tauri/target/release/bundle");
  const appPath = resolve(bundleRoot, "macos", `${productName}.app`);
  const dmgDir = resolve(bundleRoot, "dmg");
  const dmgPath = resolve(dmgDir, `${productName}_${version}_${arch}.dmg`);
  const dmgScriptPath = resolve(dmgDir, "bundle_dmg.sh");
  const entitlementsPath = resolve(appRoot, "src-tauri/entitlements.mac.plist");

  if (existsSync(appPath)) {
    console.log("🔏 Ad-hoc signing unsigned app bundle for local distribution");
    const codesignArgs = ["--force", "--deep", "--sign", "-", "--options", "runtime"];
    if (existsSync(entitlementsPath)) {
      codesignArgs.push("--entitlements", entitlementsPath);
    }
    codesignArgs.push(appPath);

    run("codesign", codesignArgs, appRoot);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], appRoot);
    run("codesign", ["-d", "--entitlements", "-", resolve(appPath, "Contents/MacOS/clipzy-macos")], appRoot);
  }

  if (existsSync(dmgScriptPath) && existsSync(appPath)) {
    console.log("💿 Rebuilding DMG with ad-hoc signed app bundle");
    rmSync(dmgPath, { force: true });
    run(
      dmgScriptPath,
      [
        "--volname",
        productName,
        "--window-size",
        "660",
        "400",
        "--icon",
        `${productName}.app`,
        "180",
        "170",
        "--app-drop-link",
        "480",
        "170",
        "--disk-image-size",
        "256",
        "--no-internet-enable",
        dmgPath,
        resolve(bundleRoot, "macos"),
      ],
      dmgDir,
    );
  }
}
