import type { LocalClipJob, LocalClipJobStatus } from "./store";
import {
  acknowledgeTerminalJobNotifications,
  hasTerminalJobNotificationBeenSent,
  rememberTerminalJobNotification,
  type TerminalLocalClipJobStatus,
} from "./store";

type NotificationPlugin = typeof import("@tauri-apps/plugin-notification");

type NotificationPermissionState = "unknown" | "granted" | "denied";

const APP_NAME = "Clipzy";

let permissionState: NotificationPermissionState = "unknown";

export interface NotifyTerminalTransitionOptions {
  source?: "polling" | "recent-refresh" | "bootstrap";
}

function isTerminalStatus(status: LocalClipJobStatus): status is TerminalLocalClipJobStatus {
  return status === "completed" || status === "failed";
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function loadNotificationPlugin(): Promise<NotificationPlugin | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  try {
    return await import("@tauri-apps/plugin-notification");
  } catch {
    return null;
  }
}

async function ensureNotificationPermission(plugin: NotificationPlugin): Promise<boolean> {
  if (permissionState === "granted") {
    return true;
  }

  if (permissionState === "denied") {
    return false;
  }

  try {
    const granted = await plugin.isPermissionGranted();
    if (granted) {
      permissionState = "granted";
      return true;
    }

    const requested = await plugin.requestPermission();
    permissionState = requested === "granted" ? "granted" : "denied";
    return permissionState === "granted";
  } catch {
    permissionState = "denied";
    return false;
  }
}

function notificationTitle(status: TerminalLocalClipJobStatus): string {
  return status === "completed" ? `${APP_NAME}: Clip ready` : `${APP_NAME}: Clip failed`;
}

function notificationBody(job: LocalClipJob): string {
  if (job.status === "completed") {
    return job.watermarked
      ? "Your local clip finished processing with a watermark. Open Clipzy to view it."
      : "Your local clip finished processing. Open Clipzy to view it.";
  }

  return job.error?.trim() || "A local clip job failed. Open Clipzy to review the error.";
}

export async function notifyTerminalJobTransition(
  job: LocalClipJob,
  previousStatus: LocalClipJobStatus | null | undefined,
  options: NotifyTerminalTransitionOptions = {},
): Promise<boolean> {
  if (!isTerminalStatus(job.status)) {
    return false;
  }

  if (hasTerminalJobNotificationBeenSent(job.id, job.status)) {
    return false;
  }

  if (previousStatus === job.status) {
    rememberTerminalJobNotification(job.id, job.status, { pending: false });
    return false;
  }

  if (previousStatus === "completed" || previousStatus === "failed") {
    rememberTerminalJobNotification(job.id, job.status, { pending: false });
    return false;
  }

  if (options.source === "bootstrap" && previousStatus == null) {
    rememberTerminalJobNotification(job.id, job.status, { pending: false });
    return false;
  }

  const plugin = await loadNotificationPlugin();

  if (!plugin) {
    rememberTerminalJobNotification(job.id, job.status, { pending: false });
    return false;
  }

  const hasPermission = await ensureNotificationPermission(plugin);

  if (!hasPermission) {
    rememberTerminalJobNotification(job.id, job.status, { pending: false });
    return false;
  }

  try {
    await plugin.sendNotification({
      title: notificationTitle(job.status),
      body: notificationBody(job),
    });

    rememberTerminalJobNotification(job.id, job.status, { pending: true });
    return true;
  } catch {
    rememberTerminalJobNotification(job.id, job.status, { pending: false });
    return false;
  }
}

export function acknowledgeDesktopNotifications(): void {
  acknowledgeTerminalJobNotifications();
}
