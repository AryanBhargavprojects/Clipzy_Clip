import type { ClipDownloadQuality } from "@clipzy/shared";

/**
 * Local persistence for the Clipzy macOS app.
 * Stores appInstallId, draft form state, the active local job snapshot,
 * and desktop notification state in localStorage for the webview shell.
 */

const STORE_KEY = "clipzy-settings";
const FORM_STORE_KEY = "clipzy-form-state";
const ACTIVE_CLIP_JOB_KEY = "clipzy-active-clip-job";
const JOB_NOTIFICATION_STATE_KEY = "clipzy-job-notification-state";

export interface AppSettings {
  appInstallId: string;
  defaultQuality: string;
}

export type LocalClipPlan = "free" | "pro";
export type LocalClipJobStatus = "pending" | "running" | "completed" | "failed" | "canceled";
export type TerminalLocalClipJobStatus = Extract<LocalClipJobStatus, "completed" | "failed" | "canceled">;

export interface LocalClipJob {
  id: string;
  installId: string;
  youtubeUrl: string;
  youtubeTitle: string | null;
  videoId: string | null;
  startTime: number;
  endTime: number;
  quality: ClipDownloadQuality;
  plan: LocalClipPlan;
  status: LocalClipJobStatus;
  stage: string | null;
  progress: number | null;
  error: string | null;
  outputPath: string | null;
  sourcePath: string | null;
  createdAt: string;
  updatedAt: string;
  watermarked: boolean;
}

function generateId(): string {
  return crypto.randomUUID();
}

function loadFromLocalStorage(): Partial<AppSettings> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveToLocalStorage(settings: Partial<AppSettings>): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(settings));
}

/** Get or create the persistent app install ID. */
export function getAppInstallId(): string {
  const existing = loadFromLocalStorage();
  if (existing.appInstallId) return existing.appInstallId;
  const id = generateId();
  saveToLocalStorage({ ...existing, appInstallId: id });
  return id;
}

/** Load all persisted settings. */
export function loadSettings(): AppSettings {
  const stored = loadFromLocalStorage();
  return {
    appInstallId: stored.appInstallId ?? generateId(),
    defaultQuality: stored.defaultQuality ?? "360p",
  };
}

/** Persist settings (partial update). */
export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  const merged = { ...current, ...partial };
  saveToLocalStorage(merged);
  return merged;
}

/* ---------- Clip Form State ---------- */

export interface ClipFormState {
  youtubeUrl: string;
  startTime: string;
  endTime: string;
  quality: string;
}

const DEFAULT_FORM_STATE: ClipFormState = {
  youtubeUrl: "",
  startTime: "0:00",
  endTime: "0:30",
  quality: "360p",
};

/** Load persisted clip form state. Falls back to defaults. */
export function loadFormState(): ClipFormState {
  try {
    const raw = localStorage.getItem(FORM_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ClipFormState>;
      return { ...DEFAULT_FORM_STATE, ...parsed };
    }
  } catch {
    // ignore corrupt data
  }
  return { ...DEFAULT_FORM_STATE };
}

/** Persist clip form state (partial update). */
export function saveFormState(partial: Partial<ClipFormState>): ClipFormState {
  const current = loadFormState();
  const merged = { ...current, ...partial };
  localStorage.setItem(FORM_STORE_KEY, JSON.stringify(merged));
  return merged;
}

/** Clear persisted form state (e.g. after successful submission). */
export function clearFormState(): void {
  localStorage.removeItem(FORM_STORE_KEY);
}

/* ---------- Active Local Clip Job State ---------- */

function isClipDownloadQuality(value: unknown): value is ClipDownloadQuality {
  return value === "360p" || value === "480p" || value === "720p" || value === "1080p" || value === "best";
}

function isLocalClipPlan(value: unknown): value is LocalClipPlan {
  return value === "free" || value === "pro";
}

function isLocalClipJobStatus(value: unknown): value is LocalClipJobStatus {
  return value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "canceled";
}

function isTerminalLocalClipJobStatus(value: unknown): value is TerminalLocalClipJobStatus {
  return value === "completed" || value === "failed" || value === "canceled";
}

function normalizeIsoString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeActiveClipJob(raw: unknown): LocalClipJob | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const data = raw as Record<string, unknown>;
  const id = typeof data.id === "string" ? data.id : typeof data.jobId === "string" ? data.jobId : "";
  const installId = typeof data.installId === "string" ? data.installId : "";
  const youtubeUrl = typeof data.youtubeUrl === "string" ? data.youtubeUrl : "";
  const startTime = typeof data.startTime === "number" ? data.startTime : Number(data.startTime ?? NaN);
  const endTime = typeof data.endTime === "number" ? data.endTime : Number(data.endTime ?? NaN);

  if (!id || !installId || !youtubeUrl || Number.isNaN(startTime) || Number.isNaN(endTime)) {
    return null;
  }

  const createdAt = normalizeIsoString(data.createdAt, new Date().toISOString());
  const updatedAt = normalizeIsoString(data.updatedAt, createdAt);
  const plan = isLocalClipPlan(data.plan) ? data.plan : "free";

  return {
    id,
    installId,
    youtubeUrl,
    youtubeTitle: typeof data.youtubeTitle === "string" ? data.youtubeTitle : null,
    videoId: typeof data.videoId === "string" ? data.videoId : null,
    startTime,
    endTime,
    quality: isClipDownloadQuality(data.quality) ? data.quality : "360p",
    plan,
    status: isLocalClipJobStatus(data.status) ? data.status : "pending",
    stage: typeof data.stage === "string" ? data.stage : null,
    progress: typeof data.progress === "number" ? data.progress : null,
    error: typeof data.error === "string" ? data.error : null,
    outputPath: typeof data.outputPath === "string" ? data.outputPath : null,
    sourcePath: typeof data.sourcePath === "string" ? data.sourcePath : null,
    createdAt,
    updatedAt,
    watermarked: typeof data.watermarked === "boolean" ? data.watermarked : plan === "free",
  };
}

/** Load persisted active clip job state. */
export function loadActiveClipJob(): LocalClipJob | null {
  try {
    const raw = localStorage.getItem(ACTIVE_CLIP_JOB_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeActiveClipJob(parsed);

    if (!normalized) {
      localStorage.removeItem(ACTIVE_CLIP_JOB_KEY);
      return null;
    }

    return normalized;
  } catch {
    localStorage.removeItem(ACTIVE_CLIP_JOB_KEY);
    return null;
  }
}

/** Persist active clip job state for polling resume. */
export function saveActiveClipJob(job: LocalClipJob): LocalClipJob {
  const normalized = normalizeActiveClipJob(job);
  if (!normalized) {
    throw new Error("Invalid active clip job state.");
  }

  localStorage.setItem(ACTIVE_CLIP_JOB_KEY, JSON.stringify(normalized));
  return normalized;
}

/** Clear persisted active clip job state. */
export function clearActiveClipJob(): void {
  localStorage.removeItem(ACTIVE_CLIP_JOB_KEY);
}

/* ---------- Job Notification State ---------- */

interface JobNotificationState {
  sentByJobId: Record<string, TerminalLocalClipJobStatus>;
  pendingKeys: string[];
}

const DEFAULT_JOB_NOTIFICATION_STATE: JobNotificationState = {
  sentByJobId: {},
  pendingKeys: [],
};

function notificationKey(jobId: string, status: TerminalLocalClipJobStatus): string {
  return `${jobId}:${status}`;
}

function normalizeJobNotificationState(raw: unknown): JobNotificationState {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_JOB_NOTIFICATION_STATE };
  }

  const data = raw as Record<string, unknown>;
  const sentByJobId: Record<string, TerminalLocalClipJobStatus> = {};
  const pendingKeys = new Set<string>();

  if (data.sentByJobId && typeof data.sentByJobId === "object") {
    for (const [jobId, status] of Object.entries(data.sentByJobId as Record<string, unknown>)) {
      if (typeof jobId === "string" && jobId.trim() && isTerminalLocalClipJobStatus(status)) {
        sentByJobId[jobId] = status;
      }
    }
  }

  if (Array.isArray(data.pendingKeys)) {
    for (const entry of data.pendingKeys) {
      if (typeof entry === "string" && entry.trim()) {
        pendingKeys.add(entry);
      }
    }
  }

  return {
    sentByJobId,
    pendingKeys: [...pendingKeys],
  };
}

function loadJobNotificationState(): JobNotificationState {
  try {
    const raw = localStorage.getItem(JOB_NOTIFICATION_STATE_KEY);
    if (!raw) {
      return { ...DEFAULT_JOB_NOTIFICATION_STATE };
    }

    return normalizeJobNotificationState(JSON.parse(raw) as unknown);
  } catch {
    localStorage.removeItem(JOB_NOTIFICATION_STATE_KEY);
    return { ...DEFAULT_JOB_NOTIFICATION_STATE };
  }
}

function saveJobNotificationState(state: JobNotificationState): void {
  localStorage.setItem(JOB_NOTIFICATION_STATE_KEY, JSON.stringify(state));
}

export function hasTerminalJobNotificationBeenSent(
  jobId: string,
  status: TerminalLocalClipJobStatus,
): boolean {
  const state = loadJobNotificationState();
  return state.sentByJobId[jobId] === status;
}

export function rememberTerminalJobNotification(
  jobId: string,
  status: TerminalLocalClipJobStatus,
  options: { pending?: boolean } = {},
): void {
  const state = loadJobNotificationState();
  const key = notificationKey(jobId, status);
  const pending = new Set(state.pendingKeys);

  state.sentByJobId[jobId] = status;

  if (options.pending === false) {
    pending.delete(key);
  } else {
    pending.add(key);
  }

  saveJobNotificationState({
    sentByJobId: state.sentByJobId,
    pendingKeys: [...pending],
  });
}

/** Lightweight acknowledgement when the app is opened / user reviews jobs. */
export function acknowledgeTerminalJobNotifications(): void {
  const state = loadJobNotificationState();
  if (state.pendingKeys.length === 0) {
    return;
  }

  saveJobNotificationState({
    sentByJobId: state.sentByJobId,
    pendingKeys: [],
  });
}

export function getPendingTerminalJobNotificationCount(): number {
  return loadJobNotificationState().pendingKeys.length;
}
