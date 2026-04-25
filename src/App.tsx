import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { ExtensionInstallSyncResponse } from "@clipzy/shared";
import ClipForm from "./ClipForm";
import { ApiClient } from "./lib/api";
import type { AuthState } from "./lib/auth-state";
import { getAppInstallId } from "./lib/store";

const CONNECT_BASE = "https://auth.clipzy.tech/macos/connect";
const UPGRADE_BASE = "https://clipzy.tech/upgrade";
const POLL_INTERVAL_MS = 4_000;

function buildConnectUrl(installId: string): string {
  return `${CONNECT_BASE}?installId=${encodeURIComponent(installId)}`;
}

function buildUpgradeUrl(installId: string): string {
  return `${UPGRADE_BASE}?installId=${encodeURIComponent(installId)}`;
}

async function openExternalUrl(url: string): Promise<void> {
  try {
    await open(url);
    return;
  } catch {
    // Fallback for browser / tests.
  }

  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function App() {
  const installId = useRef(getAppInstallId()).current;
  const api = useRef(new ApiClient()).current;

  const [state, setState] = useState<AuthState>({
    phase: "loading",
    installId,
    entitlements: null,
    error: null,
  });
  const openedHandoffRef = useRef(false);

  const checkSync = useCallback(async () => {
    try {
      const entitlements: ExtensionInstallSyncResponse = await api.syncInstall(installId);
      setState({
        phase: entitlements.isLinked ? "linked" : "unlinked",
        installId,
        entitlements,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      setState((prev) => ({
        ...prev,
        phase: prev.phase === "loading" ? "error" : prev.phase,
        error: message,
      }));
    }
  }, [api, installId]);

  useEffect(() => {
    void checkSync();
  }, [checkSync]);

  useEffect(() => {
    if (state.phase !== "unlinked") {
      openedHandoffRef.current = false;
      return;
    }

    if (openedHandoffRef.current) {
      return;
    }

    openedHandoffRef.current = true;
    void openExternalUrl(buildConnectUrl(installId));
  }, [installId, state.phase]);

  useEffect(() => {
    if (state.phase !== "unlinked") return;
    const id = setInterval(() => void checkSync(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state.phase, checkSync]);

  const handleOpenBrowser = useCallback(() => {
    void openExternalUrl(buildConnectUrl(installId));
  }, [installId]);

  const handleOpenUpgrade = useCallback(() => {
    void openExternalUrl(buildUpgradeUrl(installId));
  }, [installId]);

  const handleRetry = useCallback(() => {
    setState((prev) => ({ ...prev, phase: "loading", error: null }));
    void checkSync();
  }, [checkSync]);

  return (
    <div className="clipzy-root">
      <div className="clipzy-orb clipzy-orb--a" />
      <div className="clipzy-orb clipzy-orb--b" />
      <div className="clipzy-shell">
        {state.phase === "loading" && (
          <ShellStatusScreen
            title="Checking your Clipzy membership"
            description="Syncing this Mac with your account before unlocking the local generator."
            mode="loading"
          />
        )}

        {state.phase === "error" && (
          <ShellStatusScreen
            title="Connection error"
            description={state.error || "Something went wrong while reaching Clipzy."}
            mode="error"
            primaryAction={{ label: "Retry sync", onClick: handleRetry }}
            secondaryAction={{ label: "Open upgrade options", onClick: handleOpenUpgrade }}
            installId={installId}
          />
        )}

        {state.phase === "unlinked" && (
          <ShellStatusScreen
            title="Sign in to Clipzy"
            description="Link this Mac to your Clipzy account so the local clip generator can check your membership and unlock the app."
            mode="unlinked"
            installId={installId}
            primaryAction={{ label: "Open sign-in", onClick: handleOpenBrowser }}
            secondaryAction={{ label: "Refresh status", onClick: handleRetry }}
            tertiaryAction={{ label: "See upgrade options", onClick: handleOpenUpgrade }}
            note={state.error}
          />
        )}

        {state.phase === "linked" && state.entitlements && (
          <ClipForm installId={installId} entitlements={state.entitlements} />
        )}
      </div>
    </div>
  );
}

type StatusMode = "loading" | "unlinked" | "error";

function ShellStatusScreen({
  title,
  description,
  mode,
  installId,
  primaryAction,
  secondaryAction,
  tertiaryAction,
  note,
}: {
  title: string;
  description: string;
  mode: StatusMode;
  installId?: string;
  primaryAction?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
  tertiaryAction?: { label: string; onClick: () => void };
  note?: string | null;
}) {
  return (
    <>
      <header className="clipzy-header">
        <div>
          <span className="clipzy-brand">Clipzy</span>
        </div>
        <span className="clipzy-top-chip">
          {mode === "loading" ? "SYNC" : mode === "error" ? "ERROR" : "CONNECT"}
        </span>
      </header>

      <div className="clipzy-status-wrap">
        <div className="clipzy-status-hero glass-card clipzy-auth-card">
          <div className={`clipzy-status-disc ${mode === "error" ? "clipzy-status-disc--error" : ""}`}>
            {mode === "loading" ? (
              <div className="clipzy-status-spinner clipzy-spin" />
            ) : mode === "error" ? (
              <WarningIcon />
            ) : (
              <ClapperboardIcon />
            )}
            {mode !== "error" && <div className="clipzy-status-ring clipzy-pulse" />}
          </div>

          <div className="clipzy-status-copy">
            <div className="clipzy-kicker">Clipzy for macOS</div>
            <h1 className="clipzy-screen-title">{title}</h1>
            <p className="clipzy-screen-description">{description}</p>
            {installId && (
              <p className="clipzy-install-id">
                Install ID <code>{installId.slice(0, 8)}...</code>
              </p>
            )}
          </div>
        </div>

        <div className="glass-card clipzy-note-card">
          <div className="clipzy-note-label">How this works</div>
          <p className="clipzy-note-copy">
            Clipzy opens the secure browser sign-in flow, syncs your install entitlement, and then
            runs every clip locally on this Mac.
          </p>
          {note && <Banner tone="error">{note}</Banner>}
        </div>

        <div className="clipzy-status-actions">
          {primaryAction && (
            <button className="jewel-button-primary" onClick={primaryAction.onClick}>
              {primaryAction.label}
            </button>
          )}
          {secondaryAction && (
            <button className="jewel-button-secondary" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </button>
          )}
          {tertiaryAction && (
            <button className="clipzy-ghost-action" onClick={tertiaryAction.onClick}>
              {tertiaryAction.label}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function Banner({ children, tone }: { children: string; tone: "info" | "error" }) {
  return <div className={`clipzy-banner ${tone === "error" ? "clipzy-banner--error" : ""}`}>{children}</div>;
}

function ClapperboardIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="42"
      height="42"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="clipzy-status-icon"
      aria-hidden="true"
    >
      <path d="M4 9.5h16v7.8A1.7 1.7 0 0 1 18.3 19H5.7A1.7 1.7 0 0 1 4 17.3z" />
      <path d="m4 9.5 2.8-4.2h4.3L8.3 9.5" />
      <path d="m11.1 5.3 2.8 4.2" />
      <path d="m15.2 5.3 2.8 4.2" />
      <path d="M9 13h6" />
      <path d="M9.8 16h4.4" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="42"
      height="42"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="clipzy-status-icon"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </svg>
  );
}

export default App;
