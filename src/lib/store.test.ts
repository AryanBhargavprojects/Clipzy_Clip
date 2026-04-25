import { test, expect, beforeEach } from "bun:test";

// localStorage is not available in Bun's test runner — shim it.
const store: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
  get length() {
    return Object.keys(store).length;
  },
  key: (_index: number) => null,
} as Storage;

const {
  getAppInstallId,
  loadSettings,
  saveSettings,
  loadFormState,
  saveFormState,
  clearFormState,
  loadActiveClipJob,
  saveActiveClipJob,
  clearActiveClipJob,
  hasTerminalJobNotificationBeenSent,
  rememberTerminalJobNotification,
  acknowledgeTerminalJobNotifications,
  getPendingTerminalJobNotificationCount,
} = await import("./store");

beforeEach(() => {
  localStorage.clear();
});

test("getAppInstallId creates and persists a UUID", () => {
  const id = getAppInstallId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  expect(getAppInstallId()).toBe(id);
});

test("loadSettings returns defaults when nothing is stored", () => {
  const settings = loadSettings();
  expect(settings.defaultQuality).toBe("360p");
  expect(settings.appInstallId).toMatch(/^[0-9a-f-]{36}$/i);
});

test("saveSettings merges partial updates", () => {
  saveSettings({ defaultQuality: "1080p" });
  const settings = loadSettings();
  expect(settings.defaultQuality).toBe("1080p");
});

test("saveSettings returns merged result", () => {
  const result = saveSettings({ defaultQuality: "1080p" });
  expect(result.defaultQuality).toBe("1080p");
});

test("loadFormState returns defaults when nothing is stored", () => {
  const form = loadFormState();
  expect(form.youtubeUrl).toBe("");
  expect(form.startTime).toBe("0:00");
  expect(form.endTime).toBe("0:30");
  expect(form.quality).toBe("360p");
});

test("saveFormState persists partial updates", () => {
  saveFormState({ youtubeUrl: "https://youtube.com/watch?v=abc" });
  const form = loadFormState();
  expect(form.youtubeUrl).toBe("https://youtube.com/watch?v=abc");
  expect(form.startTime).toBe("0:00");
  expect(form.endTime).toBe("0:30");
  expect(form.quality).toBe("360p");
});

test("saveFormState merges multiple partial updates", () => {
  saveFormState({ youtubeUrl: "https://youtube.com/watch?v=abc" });
  saveFormState({ quality: "720p" });
  const form = loadFormState();
  expect(form.youtubeUrl).toBe("https://youtube.com/watch?v=abc");
  expect(form.quality).toBe("720p");
});

test("clearFormState resets to defaults", () => {
  saveFormState({ youtubeUrl: "https://youtube.com/watch?v=test", quality: "best" });
  clearFormState();
  const form = loadFormState();
  expect(form.youtubeUrl).toBe("");
  expect(form.quality).toBe("360p");
});

test("loadFormState handles corrupt localStorage gracefully", () => {
  localStorage.setItem("clipzy-form-state", "{invalid json");
  const form = loadFormState();
  expect(form.youtubeUrl).toBe("");
  expect(form.quality).toBe("360p");
});

test("saveActiveClipJob persists and loadActiveClipJob restores job state", () => {
  saveActiveClipJob({
    id: "job-1",
    installId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    youtubeUrl: "https://youtube.com/watch?v=test",
    youtubeTitle: "Test clip",
    videoId: "abc123",
    startTime: 10,
    endTime: 20,
    quality: "720p",
    plan: "free",
    status: "running",
    stage: "Downloading source media",
    progress: 20,
    error: null,
    outputPath: null,
    sourcePath: null,
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:05.000Z",
    watermarked: true,
  });

  const job = loadActiveClipJob();
  expect(job).not.toBeNull();
  expect(job?.id).toBe("job-1");
  expect(job?.status).toBe("running");
  expect(job?.quality).toBe("720p");
});

test("clearActiveClipJob removes persisted active job", () => {
  saveActiveClipJob({
    id: "job-2",
    installId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    youtubeUrl: "https://youtube.com/watch?v=test2",
    youtubeTitle: null,
    videoId: null,
    startTime: 0,
    endTime: 30,
    quality: "360p",
    plan: "free",
    status: "pending",
    stage: "Queued locally",
    progress: 0,
    error: null,
    outputPath: null,
    sourcePath: null,
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:00.000Z",
    watermarked: true,
  });

  clearActiveClipJob();
  expect(loadActiveClipJob()).toBeNull();
});

test("loadActiveClipJob discards invalid payloads", () => {
  localStorage.setItem(
    "clipzy-active-clip-job",
    JSON.stringify({
      id: "job-3",
      installId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      youtubeUrl: "https://youtube.com/watch?v=test3",
      startTime: 0,
      endTime: 10,
      quality: "not-a-quality",
      status: "not-a-status",
    }),
  );

  const job = loadActiveClipJob();
  expect(job).not.toBeNull();
  expect(job?.quality).toBe("360p");
  expect(job?.status).toBe("pending");
});

test("rememberTerminalJobNotification de-dupes by job/status", () => {
  expect(hasTerminalJobNotificationBeenSent("job-a", "completed")).toBe(false);

  rememberTerminalJobNotification("job-a", "completed", { pending: true });

  expect(hasTerminalJobNotificationBeenSent("job-a", "completed")).toBe(true);
  expect(getPendingTerminalJobNotificationCount()).toBe(1);

  rememberTerminalJobNotification("job-a", "completed", { pending: true });
  expect(getPendingTerminalJobNotificationCount()).toBe(1);
});

test("acknowledgeTerminalJobNotifications clears pending notifications", () => {
  rememberTerminalJobNotification("job-b", "failed", { pending: true });
  rememberTerminalJobNotification("job-c", "completed", { pending: true });

  expect(getPendingTerminalJobNotificationCount()).toBe(2);

  acknowledgeTerminalJobNotifications();

  expect(getPendingTerminalJobNotificationCount()).toBe(0);
  expect(hasTerminalJobNotificationBeenSent("job-b", "failed")).toBe(true);
  expect(hasTerminalJobNotificationBeenSent("job-c", "completed")).toBe(true);
});
