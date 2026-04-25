import { test, expect } from "bun:test";
import { type LocalClipJob } from "./store";

test("local clip job contract stays camelCase", () => {
  const job: LocalClipJob = {
    id: "job-1",
    installId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    youtubeUrl: "https://youtube.com/watch?v=test",
    youtubeTitle: "Test",
    videoId: "abc123",
    startTime: 0,
    endTime: 30,
    quality: "720p",
    plan: "free",
    status: "completed",
    stage: "Clip ready",
    progress: 100,
    error: null,
    outputPath: "/tmp/output.mp4",
    sourcePath: "/tmp/source.mp4",
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:01.000Z",
    watermarked: true,
  };

  expect(job.id).toBe("job-1");
  expect(job.outputPath).toContain("output.mp4");
});
