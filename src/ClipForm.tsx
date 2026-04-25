import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import type { ExtensionInstallSyncResponse } from "@clipzy/shared";
import {
  loadActiveClipJob,
  loadFormState,
  saveActiveClipJob,
  saveFormState,
  type ClipFormState,
  type LocalClipJob,
  type LocalClipJobStatus,
  type LocalClipPlan,
  type TerminalLocalClipJobStatus,
} from "./lib/store";
import {
  acknowledgeDesktopNotifications,
  notifyTerminalJobTransition,
} from "./lib/job-notifications";

const RECENT_JOBS_EVENT = "clipzy://local-job-updated";
const TRAY_NAVIGATE_EVENT = "clipzy://navigate";
const DEFAULT_SCREEN: ScreenName = "FORM";
const QUALITY_ORDER = ["360p", "480p", "720p", "1080p", "best"] as const;
const QUALITY_LABELS: Record<string, string> = {
  "360p": "360p — Low",
  "480p": "480p — Medium",
  "720p": "720p — HD",
  "1080p": "1080p — Full HD",
  best: "Highest quality",
};

const PRICING_BASE = "https://clipzy.tech/pricing";
const UPGRADE_BASE = "https://clipzy.tech/upgrade";

type ScreenName = "FORM" | "LOADING" | "RESULT" | "SETTINGS" | "RECENT";
type BannerTone = "info" | "error";

type ScreenBanner = {
  tone: BannerTone;
  message: string;
} | null;

type LocalJobCommand =
  | "list_local_clip_jobs"
  | "create_local_clip_job"
  | "get_local_clip_job"
  | "cancel_local_clip_job"
  | "open_local_clip_output"
  | "reveal_local_clip_output";

interface ClipFormProps {
  installId: string;
  entitlements: ExtensionInstallSyncResponse;
}

interface CreateLocalClipJobRequest {
  installId: string;
  youtubeUrl: string;
  startTime: number;
  endTime: number;
  quality: string;
  plan: LocalClipPlan;
}

interface TrayNavigatePayload {
  screen?: "form" | "recent";
}

function parseTimeLabelToSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part) || part < 0)) return null;

  if (parts.length === 1) return parts[0] ?? null;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if ((seconds ?? 0) > 59) return null;
    return (minutes ?? 0) * 60 + (seconds ?? 0);
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if ((minutes ?? 0) > 59 || (seconds ?? 0) > 59) return null;
    return (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
  }

  return null;
}

function formatSecondsToHhMmSs(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDurationLabel(startSeconds: number | null, endSeconds: number | null): string {
  if (startSeconds === null || endSeconds === null) {
    return "Enter start and end times";
  }

  if (endSeconds <= startSeconds) {
    return "Choose a valid range";
  }

  const total = endSeconds - startSeconds;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function isTerminalStatus(status: LocalClipJobStatus): status is TerminalLocalClipJobStatus {
  return status === "completed" || status === "failed" || status === "canceled";
}

function isRunningStatus(status: LocalClipJobStatus): boolean {
  return status === "pending" || status === "running";
}

function formatRecentTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Updated recently";

  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Updated just now";
  if (mins < 60) return `Updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days}d ago`;
}

function statusTag(status: LocalClipJobStatus): string {
  if (status === "completed") return "Ready";
  if (status === "failed") return "Failed";
  if (status === "canceled") return "Canceled";
  if (status === "running") return "Processing";
  return "Queued";
}

function stageLabel(job: LocalClipJob): string {
  if (job.status === "pending") return job.stage ?? "Queued locally";
  if (job.status === "running") return job.stage ?? "Processing";
  if (job.status === "completed") return job.watermarked ? "Watermarked export" : "Unlocked export";
  if (job.status === "canceled") return "Canceled by user";
  return job.error ?? "Processing failed";
}

function planLabel(plan: LocalClipPlan): string {
  return plan === "pro" ? "Lifetime" : "Free";
}

function planBadgeClass(plan: LocalClipPlan): string {
  return plan === "pro" ? "clipzy-plan-pill--lifetime" : "clipzy-plan-pill--free";
}

function buildPricingUrl(installId: string): string {
  return `${PRICING_BASE}?installId=${encodeURIComponent(installId)}`;
}

function buildUpgradeUrl(installId: string): string {
  return `${UPGRADE_BASE}?installId=${encodeURIComponent(installId)}`;
}

async function openExternalUrl(url: string): Promise<void> {
  try {
    await open(url);
    return;
  } catch {
    // fallback below
  }

  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function clipJobToFormState(job: LocalClipJob): ClipFormState {
  return {
    youtubeUrl: job.youtubeUrl,
    startTime: formatSecondsToHhMmSs(job.startTime),
    endTime: formatSecondsToHhMmSs(job.endTime),
    quality: job.quality,
  };
}

function normalizeQuality(value: string): string {
  return QUALITY_ORDER.includes(value as (typeof QUALITY_ORDER)[number]) ? value : "720p";
}

function isSupportedYouTubeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

async function invokeLocalJobs<T>(command: LocalJobCommand, payload?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, payload);
}

export default function ClipForm({ installId, entitlements }: ClipFormProps) {
  const persisted = useRef(loadFormState()).current;
  const restoredActiveJobRef = useRef(false);
  const previousStatusRef = useRef<Record<string, LocalClipJobStatus>>({});
  const selectedJobIdRef = useRef<string | null>(null);
  const activeJobIdRef = useRef<string | null>(null);

  const [screen, setScreen] = useState<ScreenName>(DEFAULT_SCREEN);
  const [banner, setBanner] = useState<ScreenBanner>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<LocalClipJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [loadingJobId, setLoadingJobId] = useState<string | null>(null);
  const [cancelingJobId, setCancelingJobId] = useState<string | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [form, setForm] = useState<ClipFormState>({
    youtubeUrl: persisted.youtubeUrl,
    startTime: persisted.startTime,
    endTime: persisted.endTime,
    quality: normalizeQuality(persisted.quality),
  });
  const [settingsDraft, setSettingsDraft] = useState<string>(normalizeQuality(persisted.quality));

  const plan = entitlements.plan;
  const planText = planLabel(plan);
  const planPricingUrl = useMemo(() => buildPricingUrl(installId), [installId]);
  const currentJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId],
  );
  const activeJob = useMemo(() => {
    if (loadingJobId) {
      return jobs.find((job) => job.id === loadingJobId) ?? null;
    }

    if (currentJob && isRunningStatus(currentJob.status)) {
      return currentJob;
    }

    return jobs.find((job) => isRunningStatus(job.status)) ?? currentJob;
  }, [currentJob, jobs, loadingJobId]);

  useEffect(() => {
    selectedJobIdRef.current = selectedJobId;
  }, [selectedJobId]);

  useEffect(() => {
    activeJobIdRef.current = loadingJobId;
  }, [loadingJobId]);

  const refreshJobs = useCallback(async () => {
    const list = await invokeLocalJobs<LocalClipJob[]>("list_local_clip_jobs");
    setJobs(list);
    return list;
  }, []);

  const syncActiveSnapshot = useCallback((job: LocalClipJob) => {
    saveActiveClipJob(job);
    activeJobIdRef.current = job.id;
  }, []);

  const upsertJob = useCallback((job: LocalClipJob) => {
    setJobs((previous) => {
      const next = [job, ...previous.filter((entry) => entry.id !== job.id)].sort((a, b) => {
        return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt);
      });
      return next;
    });
  }, []);

  const selectJob = useCallback((job: LocalClipJob) => {
    setSelectedJobId(job.id);
    setFormError(null);
    setBanner(null);
    if (isRunningStatus(job.status)) {
      setLoadingJobId(job.id);
      setScreen("LOADING");
    } else if (isTerminalStatus(job.status)) {
      setLoadingJobId(null);
      setScreen("RESULT");
    } else {
      setLoadingJobId(job.id);
      setScreen("LOADING");
    }
    syncActiveSnapshot(job);
  }, [syncActiveSnapshot]);

  const switchToForm = useCallback(() => {
    setScreen("FORM");
    setFormError(null);
    setBanner(null);
  }, []);

  const switchToRecent = useCallback(() => {
    setScreen("RECENT");
    setFormError(null);
    setBanner(null);
  }, []);

  const switchToSettings = useCallback(() => {
    setScreen("SETTINGS");
    setFormError(null);
    setBanner(null);
  }, []);

  useEffect(() => {
    acknowledgeDesktopNotifications();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void listen<LocalClipJob>(RECENT_JOBS_EVENT, (event) => {
      const job = event.payload;
      const previousStatus = previousStatusRef.current[job.id] ?? null;
      previousStatusRef.current[job.id] = job.status;
      upsertJob(job);
      void notifyTerminalJobTransition(job, previousStatus);

      if (selectedJobIdRef.current === job.id || activeJobIdRef.current === job.id) {
        syncActiveSnapshot(job);
        setSelectedJobId(job.id);
        if (isTerminalStatus(job.status)) {
          setLoadingJobId(null);
          setScreen("RESULT");
        } else {
          setLoadingJobId(job.id);
          setScreen("LOADING");
        }
      }
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [syncActiveSnapshot, upsertJob]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void listen<TrayNavigatePayload>(TRAY_NAVIGATE_EVENT, (event) => {
      if (event.payload.screen === "recent") {
        setScreen("RECENT");
      } else {
        setScreen("FORM");
      }
      setBanner(null);
      setFormError(null);
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [list, activeSnapshot] = await Promise.all([refreshJobs(), Promise.resolve(loadActiveClipJob())]);
        if (cancelled) return;

        const snapshotJob = activeSnapshot ? list.find((job) => job.id === activeSnapshot.id) ?? activeSnapshot : null;
        const selected = snapshotJob ?? list.find((job) => isRunningStatus(job.status)) ?? list[0] ?? null;

        if (snapshotJob) {
          if (!list.some((job) => job.id === snapshotJob.id)) {
            setJobs((previous) => [snapshotJob, ...previous.filter((job) => job.id !== snapshotJob.id)]);
          }
          setSelectedJobId(snapshotJob.id);
          setLoadingJobId(isRunningStatus(snapshotJob.status) ? snapshotJob.id : null);
          setScreen(isRunningStatus(snapshotJob.status) ? "LOADING" : "RESULT");
        } else if (selected) {
          setSelectedJobId(selected.id);
          setLoadingJobId(isRunningStatus(selected.status) ? selected.id : null);
          setScreen(isRunningStatus(selected.status) ? "LOADING" : "FORM");
        }
      } catch (err) {
        if (cancelled) return;
        setBanner({
          tone: "error",
          message: err instanceof Error ? err.message : "Failed to load local jobs.",
        });
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshJobs]);

  useEffect(() => {
    saveFormState(form);
  }, [form]);

  useEffect(() => {
    if (restoredActiveJobRef.current) {
      return;
    }
    if (!currentJob) {
      return;
    }
    if (isTerminalStatus(currentJob.status)) {
      restoredActiveJobRef.current = true;
      setSelectedJobId(currentJob.id);
      setScreen("RESULT");
    }
  }, [currentJob]);

  const handleFieldChange = useCallback((field: keyof ClipFormState, value: string) => {
    if (field === "quality") {
      setSettingsDraft(normalizeQuality(value));
    }

    setForm((current) => ({ ...current, [field]: value }));
    setFormError(null);
  }, []);

  const handleSettingsQuality = useCallback((value: string) => {
    const normalized = normalizeQuality(value);
    setSettingsDraft(normalized);
    setForm((current) => ({ ...current, quality: normalized }));
    setBanner(null);
  }, []);

  const handleUseCurrentQuality = useCallback(() => {
    setForm((current) => ({ ...current, quality: settingsDraft }));
    setScreen("FORM");
  }, [settingsDraft]);

  const handleUpgrade = useCallback(() => {
    void openExternalUrl(plan === "pro" ? planPricingUrl : planPricingUrl);
  }, [plan, planPricingUrl]);

  const handleRetrySelected = useCallback(() => {
    if (!currentJob) return;
    setForm(clipJobToFormState(currentJob));
    setScreen("FORM");
  }, [currentJob]);

  const handleCreateJob = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const youtubeUrl = form.youtubeUrl.trim();
    let startSeconds = parseTimeLabelToSeconds(form.startTime);
    let endSeconds = parseTimeLabelToSeconds(form.endTime);

    if (!youtubeUrl) {
      setFormError("Enter a YouTube URL.");
      return;
    }

    if (!isSupportedYouTubeUrl(youtubeUrl)) {
      setFormError("Enter a valid YouTube or youtu.be link.");
      return;
    }

    if (startSeconds === null || endSeconds === null) {
      setFormError("Enter valid start and end times.");
      return;
    }

    if (endSeconds <= startSeconds) {
      setFormError("The end time must be after the start time.");
      return;
    }

    const request: CreateLocalClipJobRequest = {
      installId,
      youtubeUrl,
      startTime: startSeconds,
      endTime: endSeconds,
      quality: normalizeQuality(form.quality),
      plan,
    };

    setFormError(null);
    setBanner({ tone: "info", message: "Creating a local clip job..." });
    setScreen("LOADING");
    setLoadingJobId(null);

    try {
      const created = await invokeLocalJobs<LocalClipJob>("create_local_clip_job", { request });
      setJobs((previous) => [created, ...previous.filter((job) => job.id !== created.id)]);
      setSelectedJobId(created.id);
      setLoadingJobId(created.id);
      previousStatusRef.current[created.id] = created.status;
      saveActiveClipJob(created);
      if (isTerminalStatus(created.status)) {
        setLoadingJobId(null);
        setScreen("RESULT");
      }
    } catch (err) {
      setLoadingJobId(null);
      setScreen("FORM");
      setBanner({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to create the local clip job.",
      });
    }
  }, [form.endTime, form.quality, form.startTime, form.youtubeUrl, installId, plan]);

  const selectedResultJob = currentJob ?? activeJob ?? null;
  const canShowResult = selectedResultJob != null && isTerminalStatus(selectedResultJob.status);
  const currentPlanIsFree = plan === "free";

  const handleOpenOutput = useCallback(async () => {
    if (!selectedResultJob) return;
    try {
      await invokeLocalJobs<void>("open_local_clip_output", { jobId: selectedResultJob.id });
      setBanner({ tone: "info", message: "Opened the finished clip." });
    } catch (err) {
      setBanner({
        tone: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [selectedResultJob]);

  const handleRevealOutput = useCallback(async () => {
    if (!selectedResultJob) return;
    try {
      await invokeLocalJobs<void>("reveal_local_clip_output", { jobId: selectedResultJob.id });
      setBanner({ tone: "info", message: "Revealed the clip in Finder." });
    } catch (err) {
      setBanner({
        tone: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [selectedResultJob]);

  const handleCancelJob = useCallback(async (job: LocalClipJob) => {
    if (!isRunningStatus(job.status)) return;

    setCancelingJobId(job.id);
    setBanner({ tone: "info", message: "Canceling the local clip job..." });

    try {
      const canceled = await invokeLocalJobs<LocalClipJob>("cancel_local_clip_job", { jobId: job.id });
      upsertJob(canceled);
      saveActiveClipJob(canceled);
      setSelectedJobId(canceled.id);
      setLoadingJobId(null);
      setScreen("RESULT");
      setBanner({ tone: "info", message: "Clip job canceled." });
    } catch (err) {
      setBanner({
        tone: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCancelingJobId(null);
    }
  }, [upsertJob]);

  const emptyRecentJobs = jobs.length === 0;
  const activeLoadMessage = selectedResultJob ? stageLabel(selectedResultJob) : "Working locally...";
  const loadingDisplayJob = activeJob ?? selectedResultJob;

  return (
    <div className="clipzy-form-shell">
      <header className="clipzy-header clipzy-header--form">
        <div className="clipzy-brand-lockup">
          <span className="clipzy-brand">Clipzy</span>
          <span className={`clipzy-plan-pill ${planBadgeClass(plan)}`}>{planText}</span>
        </div>
      </header>

      <div className="clipzy-form-divider" />

      <div className="clipzy-form-body">
        <div className="clipzy-form-scroll">
          {banner && <Banner tone={banner.tone}>{banner.message}</Banner>}
          {formError && <Banner tone="error">{formError}</Banner>}

          {screen === "FORM" && (
            <form className="clipzy-body" onSubmit={handleCreateJob}>
              <div className="glass-card clipzy-settings-card">
                <div>
                  <div className="clipzy-note-label">Local generation</div>
                  <h2 className="clipzy-screen-title">Create a new clip</h2>
                  <p className="clipzy-screen-description">
                    {currentPlanIsFree
                      ? "Free clips are generated locally and exported with a watermark. Upgrade to Lifetime for clean exports."
                      : "Lifetime exports run locally with no watermark."}
                  </p>
                </div>

                {currentPlanIsFree ? (
                  <button className="jewel-button-secondary" type="button" onClick={handleUpgrade}>
                    Upgrade to Lifetime
                  </button>
                ) : (
                  <div className="clipzy-plan-note">Unlocked Lifetime export</div>
                )}
              </div>

              <div className="clipzy-field-group">
                <label className="clipzy-field-label" htmlFor="youtube-url">
                  YouTube URL
                </label>
                <input
                  id="youtube-url"
                  className="liquid-input"
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={form.youtubeUrl}
                  onChange={(event) => handleFieldChange("youtubeUrl", event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="clipzy-two-col">
                <div className="clipzy-field-group">
                  <label className="clipzy-field-label" htmlFor="start-time">
                    Start
                  </label>
                  <input
                    id="start-time"
                    className="liquid-input clipzy-time-input"
                    placeholder="0:00"
                    value={form.startTime}
                    onChange={(event) => handleFieldChange("startTime", event.target.value)}
                  />
                </div>
                <div className="clipzy-field-group">
                  <label className="clipzy-field-label" htmlFor="end-time">
                    End
                  </label>
                  <input
                    id="end-time"
                    className="liquid-input clipzy-time-input"
                    placeholder="0:30"
                    value={form.endTime}
                    onChange={(event) => handleFieldChange("endTime", event.target.value)}
                  />
                </div>
              </div>

              <div className="glass-card clipzy-stat-card">
                <div className="clipzy-quality-copy">
                  <div className="clipzy-stat-label">Clip length</div>
                  <div className="clipzy-stat-value">
                    {formatDurationLabel(parseTimeLabelToSeconds(form.startTime), parseTimeLabelToSeconds(form.endTime))}
                  </div>
                  <div className="clipzy-quality-note">Runs entirely on this Mac.</div>
                </div>
                <div className="clipzy-select-wrap">
                  <select
                    className="liquid-input clipzy-select"
                    value={form.quality}
                    onChange={(event) => handleFieldChange("quality", normalizeQuality(event.target.value))}
                  >
                    {QUALITY_ORDER.map((quality) => (
                      <option key={quality} value={quality}>
                        {QUALITY_LABELS[quality]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <button className="jewel-button-primary clipzy-primary-button" type="submit">
                Generate local clip
              </button>
            </form>
          )}

          {screen === "LOADING" && (
            <LoadingScreen
              job={loadingDisplayJob}
              planText={planText}
              freeUser={currentPlanIsFree}
              banner={banner}
              onOpenRecent={switchToRecent}
              onOpenForm={switchToForm}
              onUpgrade={handleUpgrade}
              title={isBootstrapping ? "Loading your local jobs" : "Generating your clip locally"}
              description={isBootstrapping
                ? "Restoring recent jobs from this Mac."
                : "yt-dlp and ffmpeg are processing the clip on your machine."}
              activeLoadMessage={activeLoadMessage}
              onCancelJob={handleCancelJob}
              cancelingJobId={cancelingJobId}
            />
          )}

          {screen === "RESULT" && canShowResult && (
            <ResultScreen
              job={selectedResultJob}
              planText={planText}
              freeUser={currentPlanIsFree}
              onOpenOutput={handleOpenOutput}
              onRevealOutput={handleRevealOutput}
              onOpenRecent={switchToRecent}
              onNewClip={switchToForm}
              onRetryJob={handleRetrySelected}
              onUpgrade={handleUpgrade}
            />
          )}

          {screen === "SETTINGS" && (
            <SettingsScreen
              planText={planText}
              freeUser={currentPlanIsFree}
              quality={settingsDraft}
              onChangeQuality={handleSettingsQuality}
              onUseQuality={handleUseCurrentQuality}
              onUpgrade={handleUpgrade}
            />
          )}

          {screen === "RECENT" && (
            <RecentScreen
              jobs={jobs}
              emptyRecentJobs={emptyRecentJobs}
              onSelectJob={selectJob}
              onOpenForm={switchToForm}
              onOpenRecent={switchToRecent}
              onCancelJob={handleCancelJob}
              cancelingJobId={cancelingJobId}
            />
          )}
        </div>
      </div>

      <footer className="clipzy-form-footer">
        <div className="clipzy-ribbon" />
        <BottomNav screen={screen} onSelectForm={switchToForm} onSelectRecent={switchToRecent} onSelectSettings={switchToSettings} />
      </footer>
    </div>
  );
}

function LoadingScreen({
  job,
  title,
  description,
  planText,
  freeUser,
  banner,
  activeLoadMessage,
  onOpenRecent,
  onOpenForm,
  onUpgrade,
  onCancelJob,
  cancelingJobId,
}: {
  job: LocalClipJob | null;
  title: string;
  description: string;
  planText: string;
  freeUser: boolean;
  banner: ScreenBanner;
  activeLoadMessage: string;
  onOpenRecent: () => void;
  onOpenForm: () => void;
  onUpgrade: () => void;
  onCancelJob: (job: LocalClipJob) => void;
  cancelingJobId: string | null;
}) {
  return (
    <div className="clipzy-loading-screen clipzy-processing-layout">
      <div className="clipzy-processing-disc glass-card">
        <div className="clipzy-processing-ring clipzy-pulse" />
        <div className="clipzy-processing-ring clipzy-processing-ring--spin clipzy-spin" />
        <div className="clipzy-status-spinner clipzy-spin" />
      </div>

      <div className="clipzy-processing-copy">
        <div className="clipzy-kicker">{planText}</div>
        <h1 className="clipzy-screen-title">{title}</h1>
        <p className="clipzy-screen-description">{description}</p>
        <div className="clipzy-loading-status-card glass-card">
          <div>
            <div className="clipzy-note-label">Current stage</div>
            <div className="clipzy-stat-value">{activeLoadMessage}</div>
            {job && (
              <div className="clipzy-quality-note">
                {formatSecondsToHhMmSs(job.startTime)} → {formatSecondsToHhMmSs(job.endTime)} · {QUALITY_LABELS[job.quality] ?? job.quality}
              </div>
            )}
            {freeUser && <div className="clipzy-quality-note">Free exports will be watermarked.</div>}
          </div>
          <div className="clipzy-stat-icon-wrap">
            <ClockCircleIcon />
          </div>
        </div>
        {banner && <Banner tone={banner.tone}>{banner.message}</Banner>}
      </div>

      <div className="clipzy-status-actions">
        {job && isRunningStatus(job.status) && (
          <button
            className="clipzy-danger-action"
            onClick={() => onCancelJob(job)}
            disabled={cancelingJobId === job.id}
          >
            {cancelingJobId === job.id ? "Canceling..." : "Cancel processing"}
          </button>
        )}
        <button className="jewel-button-secondary" onClick={onOpenRecent}>Recent jobs</button>
        <button className="clipzy-ghost-action" onClick={onOpenForm}>Back to form</button>
        {freeUser && <button className="clipzy-ghost-action" onClick={onUpgrade}>Upgrade to Lifetime</button>}
      </div>
    </div>
  );
}

function ResultScreen({
  job,
  planText,
  freeUser,
  onOpenOutput,
  onRevealOutput,
  onOpenRecent,
  onNewClip,
  onRetryJob,
  onUpgrade,
}: {
  job: LocalClipJob;
  planText: string;
  freeUser: boolean;
  onOpenOutput: () => void;
  onRevealOutput: () => void;
  onOpenRecent: () => void;
  onNewClip: () => void;
  onRetryJob: () => void;
  onUpgrade: () => void;
}) {
  const resultLabel = job.status === "completed" ? "Clip ready" : job.status === "canceled" ? "Clip canceled" : "Clip failed";
  const badgeClass = job.status === "completed"
    ? "clipzy-status-badge--completed"
    : job.status === "canceled"
      ? "clipzy-status-badge--canceled"
      : "clipzy-status-badge--failed";

  return (
    <div className="clipzy-success-layout clipzy-processing-layout">
      <div className="clipzy-success-disc glass-card">
        <div className="clipzy-success-glow" />
        {job.status === "completed" ? <CheckCircleIcon /> : <WarningIcon />}
      </div>

      <div className="clipzy-processing-copy">
        <div className="clipzy-kicker">{planText}</div>
        <h1 className="clipzy-screen-title">{resultLabel}</h1>
        <p className="clipzy-screen-description">
          {job.status === "completed"
            ? freeUser
              ? "This export was processed locally and watermarked for the Free plan."
              : "This export was processed locally with Lifetime unlocked."
            : job.status === "canceled"
              ? "This local clip job was canceled and partial downloads were removed."
              : job.error ?? "The local clip could not be completed."}
        </p>
        <div className="clipzy-result-card glass-card">
          <div className="clipzy-result-row">
            <div className="clipzy-result-label">Status</div>
            <div className={`clipzy-status-badge ${badgeClass}`}>{statusTag(job.status)}</div>
          </div>
          <div className="clipzy-result-row">
            <div className="clipzy-result-label">Range</div>
            <div className="clipzy-result-value clipzy-result-value--mono">
              {formatSecondsToHhMmSs(job.startTime)} → {formatSecondsToHhMmSs(job.endTime)}
            </div>
          </div>
          <div className="clipzy-result-row">
            <div className="clipzy-result-label">Quality</div>
            <div className="clipzy-result-value">{QUALITY_LABELS[job.quality] ?? job.quality}</div>
          </div>
          <div className="clipzy-result-row">
            <div className="clipzy-result-label">Export</div>
            <div className="clipzy-result-value">{job.watermarked ? "Watermarked" : "Unlocked"}</div>
          </div>
          <div className="clipzy-result-row">
            <div className="clipzy-result-label">Stage</div>
            <div className="clipzy-result-value">{stageLabel(job)}</div>
          </div>
          {job.outputPath && (
            <div className="clipzy-result-row">
              <div className="clipzy-result-label">File</div>
              <div className="clipzy-result-value clipzy-result-value--mono">{job.outputPath}</div>
            </div>
          )}
          {job.error && (
            <div className="clipzy-banner clipzy-banner--error">{job.error}</div>
          )}
        </div>
        {freeUser ? (
          <button className="jewel-button-secondary" onClick={onUpgrade}>
            Upgrade to Lifetime
          </button>
        ) : null}
      </div>

      <div className="clipzy-status-actions">
        {job.status === "completed" ? (
          <>
            <button className="jewel-button-primary" onClick={onOpenOutput}>Open output</button>
            <button className="jewel-button-secondary" onClick={onRevealOutput}>Reveal in Finder</button>
          </>
        ) : (
          <button className="jewel-button-secondary" onClick={onRetryJob}>{job.status === "canceled" ? "Start again" : "Try again"}</button>
        )}
        <button className="clipzy-ghost-action" onClick={onOpenRecent}>Recent jobs</button>
        <button className="clipzy-ghost-action" onClick={onNewClip}>New clip</button>
      </div>
    </div>
  );
}

function SettingsScreen({
  planText,
  freeUser,
  quality,
  onChangeQuality,
  onUseQuality,
  onUpgrade,
}: {
  planText: string;
  freeUser: boolean;
  quality: string;
  onChangeQuality: (quality: string) => void;
  onUseQuality: () => void;
  onUpgrade: () => void;
}) {
  return (
    <div className="clipzy-body">
      <div className="glass-card clipzy-settings-card">
        <div>
          <div className="clipzy-note-label">Membership</div>
          <h2 className="clipzy-screen-title">{planText}</h2>
          <p className="clipzy-screen-description">
            {freeUser
              ? "Free clips are watermarked. Upgrade for Lifetime access and clean exports."
              : "Lifetime unlocks clean local exports on this Mac."}
          </p>
        </div>
        {freeUser ? (
          <button className="jewel-button-secondary" onClick={onUpgrade}>
            Upgrade to Lifetime
          </button>
        ) : null}
      </div>

      <div className="glass-card clipzy-settings-card">
        <div className="clipzy-field-label">Export quality</div>
        <select className="liquid-input clipzy-select" value={quality} onChange={(event) => onChangeQuality(event.target.value)}>
          {QUALITY_ORDER.map((qualityOption) => (
            <option key={qualityOption} value={qualityOption}>
              {QUALITY_LABELS[qualityOption]}
            </option>
          ))}
        </select>
        <div className="clipzy-quality-note">This setting applies to new local jobs only.</div>
      </div>

      <button className="jewel-button-primary clipzy-primary-button" onClick={onUseQuality}>
        Use selected quality
      </button>
    </div>
  );
}

function RecentScreen({
  jobs,
  emptyRecentJobs,
  onSelectJob,
  onOpenForm,
  onOpenRecent,
  onCancelJob,
  cancelingJobId,
}: {
  jobs: LocalClipJob[];
  emptyRecentJobs: boolean;
  onSelectJob: (job: LocalClipJob) => void;
  onOpenForm: () => void;
  onOpenRecent: () => void;
  onCancelJob: (job: LocalClipJob) => void;
  cancelingJobId: string | null;
}) {
  return (
    <div className="clipzy-body clipzy-recent-scroll">
      {emptyRecentJobs ? (
        <div className="clipzy-recent-empty glass-card">
          <HistoryIcon />
          <div>
            <h2 className="clipzy-screen-title">No local jobs yet</h2>
            <p className="clipzy-screen-description">Create a clip to see its status, result, and output here.</p>
          </div>
          <button className="jewel-button-primary" onClick={onOpenForm}>Create a clip</button>
        </div>
      ) : (
        jobs.map((job) => (
          <div key={job.id} className="glass-card clipzy-recent-row">
            <button className="clipzy-recent-select" onClick={() => onSelectJob(job)}>
              <div className="clipzy-recent-main">
                <div className="clipzy-recent-top">
                  <span>{job.youtubeTitle?.trim() || job.youtubeUrl}</span>
                  <span className={`clipzy-status-badge clipzy-status-badge--${job.status}`}>{statusTag(job.status)}</span>
                </div>
                <div className="clipzy-recent-meta">
                  {formatSecondsToHhMmSs(job.startTime)} → {formatSecondsToHhMmSs(job.endTime)} · {QUALITY_LABELS[job.quality] ?? job.quality}
                </div>
                <div className="clipzy-recent-meta clipzy-recent-meta--muted">
                  {stageLabel(job)} · {formatRecentTime(job.updatedAt)}
                </div>
              </div>
            </button>
            <div className="clipzy-job-actions">
              {isRunningStatus(job.status) && (
                <button
                  className="clipzy-danger-action clipzy-danger-action--compact"
                  onClick={() => onCancelJob(job)}
                  disabled={cancelingJobId === job.id}
                >
                  {cancelingJobId === job.id ? "Canceling" : "Cancel"}
                </button>
              )}
              <button className="clipzy-ghost-action" onClick={() => onSelectJob(job)}>
                View
              </button>
            </div>
          </div>
        ))
      )}
      <div className="clipzy-status-actions">
        <button className="jewel-button-secondary" onClick={onOpenForm}>New clip</button>
        <button className="clipzy-ghost-action" onClick={onOpenRecent}>Recent jobs</button>
      </div>
    </div>
  );
}

function BottomNav({
  screen,
  onSelectForm,
  onSelectRecent,
  onSelectSettings,
}: {
  screen: ScreenName;
  onSelectForm: () => void;
  onSelectRecent: () => void;
  onSelectSettings: () => void;
}) {
  return (
    <nav className="clipzy-nav">
      <button className={`clipzy-nav-item ${screen === "FORM" ? "is-active" : ""}`} onClick={onSelectForm}>
        Create
      </button>
      <button className={`clipzy-nav-item ${screen === "RECENT" ? "is-active" : ""}`} onClick={onSelectRecent}>
        Recent
      </button>
      <button className={`clipzy-nav-item ${screen === "SETTINGS" ? "is-active" : ""}`} onClick={onSelectSettings}>
        Settings
      </button>
    </nav>
  );
}

function Banner({ children, tone }: { children: string; tone: BannerTone }) {
  return <div className={`clipzy-banner ${tone === "error" ? "clipzy-banner--error" : ""}`}>{children}</div>;
}

function ClockCircleIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function CheckCircleIcon() {
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
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5 10.5 15 16 9" />
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
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="34"
      height="34"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
