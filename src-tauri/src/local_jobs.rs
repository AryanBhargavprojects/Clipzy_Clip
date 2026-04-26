use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command as StdCommand,
    sync::{Arc, Mutex},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const JOB_UPDATED_EVENT: &str = "clipzy://local-job-updated";
const YTDLP_SIDECAR: &str = "yt-dlp";
const FFMPEG_SIDECAR: &str = "ffmpeg";
const FINAL_OUTPUT_FILE: &str = "output.mp4";
const CLIP_OUTPUT_FILE: &str = "clip.mp4";
const SOURCE_OUTPUT_PREFIX: &str = "source";

fn bundled_ffmpeg_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join("ffmpeg");
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LocalClipPlan {
    Free,
    Pro,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LocalClipJobStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalClipJob {
    pub id: String,
    pub install_id: String,
    pub youtube_url: String,
    pub youtube_title: Option<String>,
    pub video_id: Option<String>,
    pub start_time: f64,
    pub end_time: f64,
    pub quality: String,
    pub plan: LocalClipPlan,
    pub status: LocalClipJobStatus,
    pub stage: Option<String>,
    pub progress: Option<u8>,
    pub error: Option<String>,
    pub output_path: Option<String>,
    pub source_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub watermarked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLocalClipJobRequest {
    pub install_id: String,
    pub youtube_url: String,
    pub start_time: f64,
    pub end_time: f64,
    pub quality: String,
    pub plan: LocalClipPlan,
}

#[derive(Clone)]
pub struct LocalJobManager {
    inner: Arc<LocalJobStore>,
}

struct LocalJobStore {
    path: PathBuf,
    jobs: Mutex<HashMap<String, LocalClipJob>>,
    children: Mutex<HashMap<String, CommandChild>>,
}

impl LocalJobManager {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }

        let jobs = load_jobs_from_disk(&path)?;
        Ok(Self {
            inner: Arc::new(LocalJobStore {
                path,
                jobs: Mutex::new(jobs),
                children: Mutex::new(HashMap::new()),
            }),
        })
    }

    fn snapshot_jobs(&self) -> Result<HashMap<String, LocalClipJob>, String> {
        let guard = self.inner.jobs.lock().map_err(|_| "Local job store lock poisoned.".to_string())?;
        Ok(guard.clone())
    }

    fn persist_jobs(&self, jobs: &HashMap<String, LocalClipJob>) -> Result<(), String> {
        persist_jobs_to_disk(&self.inner.path, jobs)
    }

    pub fn job_dir(&self, job_id: &str) -> PathBuf {
        self.inner.path.with_file_name("jobs").join(job_id)
    }

    pub fn create_job(&self, request: &CreateLocalClipJobRequest) -> Result<LocalClipJob, String> {
        validate_quality(&request.quality)?;
        validate_clip_range(request.start_time, request.end_time)?;

        let job = LocalClipJob {
            id: new_job_id(),
            install_id: request.install_id.clone(),
            youtube_url: request.youtube_url.clone(),
            youtube_title: None,
            video_id: None,
            start_time: request.start_time,
            end_time: request.end_time,
            quality: request.quality.clone(),
            plan: request.plan,
            status: LocalClipJobStatus::Pending,
            stage: Some("Preparing local job".to_string()),
            progress: Some(0),
            error: None,
            output_path: None,
            source_path: None,
            created_at: timestamp(),
            updated_at: timestamp(),
            watermarked: matches!(request.plan, LocalClipPlan::Free),
        };

        let mut guard = self.inner.jobs.lock().map_err(|_| "Local job store lock poisoned.".to_string())?;
        guard.insert(job.id.clone(), job.clone());
        self.persist_jobs(&guard)?;
        Ok(job)
    }

    pub fn list_jobs(&self) -> Result<Vec<LocalClipJob>, String> {
        let mut jobs = self.snapshot_jobs()?.into_values().collect::<Vec<_>>();
        jobs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| b.created_at.cmp(&a.created_at)));
        Ok(jobs)
    }

    pub fn get_job(&self, job_id: &str) -> Result<LocalClipJob, String> {
        let guard = self.inner.jobs.lock().map_err(|_| "Local job store lock poisoned.".to_string())?;
        guard
            .get(job_id)
            .cloned()
            .ok_or_else(|| format!("Local clip job not found: {job_id}"))
    }

    pub fn update_job<F>(&self, job_id: &str, update: F) -> Result<LocalClipJob, String>
    where
        F: FnOnce(&mut LocalClipJob),
    {
        let mut guard = self.inner.jobs.lock().map_err(|_| "Local job store lock poisoned.".to_string())?;
        let job = guard
            .get_mut(job_id)
            .ok_or_else(|| format!("Local clip job not found: {job_id}"))?;
        update(job);
        job.updated_at = timestamp();
        let snapshot = job.clone();
        self.persist_jobs(&guard)?;
        Ok(snapshot)
    }

    pub fn register_child(&self, job_id: &str, child: CommandChild) -> Result<u32, String> {
        let pid = child.pid();
        let mut guard = self.inner.children.lock().map_err(|_| "Local process registry lock poisoned.".to_string())?;
        guard.insert(job_id.to_string(), child);
        Ok(pid)
    }

    pub fn unregister_child(&self, job_id: &str, pid: u32) -> Result<(), String> {
        let mut guard = self.inner.children.lock().map_err(|_| "Local process registry lock poisoned.".to_string())?;
        let should_remove = guard.get(job_id).map(|child| child.pid() == pid).unwrap_or(false);
        if should_remove {
            guard.remove(job_id);
        }
        Ok(())
    }

    pub fn is_canceled(&self, job_id: &str) -> bool {
        self.get_job(job_id)
            .map(|job| job.status == LocalClipJobStatus::Canceled)
            .unwrap_or(false)
    }

    pub fn cancel_job(&self, job_id: &str) -> Result<LocalClipJob, String> {
        let current = self.get_job(job_id)?;
        if !matches!(current.status, LocalClipJobStatus::Pending | LocalClipJobStatus::Running) {
            return Err("Only queued or processing clips can be canceled.".to_string());
        }

        let child = {
            let mut guard = self.inner.children.lock().map_err(|_| "Local process registry lock poisoned.".to_string())?;
            guard.remove(job_id)
        };

        if let Some(child) = child {
            let _ = child.kill();
        }

        remove_partial_job_files(&self.job_dir(job_id));

        self.update_job(job_id, |job| {
            job.status = LocalClipJobStatus::Canceled;
            job.stage = Some("Canceled".to_string());
            job.progress = None;
            job.error = Some("Canceled by user.".to_string());
            job.output_path = None;
            job.source_path = None;
        })
    }
}

fn load_jobs_from_disk(path: &Path) -> Result<HashMap<String, LocalClipJob>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(err) => return Err(err.to_string()),
    };

    if raw.trim().is_empty() {
        return Ok(HashMap::new());
    }

    let jobs: Vec<LocalClipJob> = serde_json::from_str(&raw).map_err(|err| err.to_string())?;
    Ok(jobs.into_iter().map(|job| (job.id.clone(), job)).collect())
}

fn persist_jobs_to_disk(path: &Path, jobs: &HashMap<String, LocalClipJob>) -> Result<(), String> {
    let mut sorted_jobs = jobs.values().cloned().collect::<Vec<_>>();
    sorted_jobs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| b.created_at.cmp(&a.created_at)));

    let data = serde_json::to_string_pretty(&sorted_jobs).map_err(|err| err.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, data).map_err(|err| err.to_string())?;
    fs::rename(&tmp_path, path).map_err(|err| err.to_string())?;
    Ok(())
}

fn new_job_id() -> String {
    format!("lcj-{}", uuid::Uuid::new_v4())
}

fn timestamp() -> String {
    Utc::now().to_rfc3339()
}

fn validate_quality(quality: &str) -> Result<(), String> {
    match quality {
        "360p" | "480p" | "720p" | "1080p" | "best" => Ok(()),
        _ => Err(format!("Unsupported clip quality: {quality}")),
    }
}

fn validate_clip_range(start: f64, end: f64) -> Result<(), String> {
    if !start.is_finite() || !end.is_finite() {
        return Err("Clip times must be finite numbers.".to_string());
    }

    if start < 0.0 || end <= start {
        return Err("The clip end time must be greater than the start time.".to_string());
    }

    Ok(())
}

fn sanitize_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "clipzy".to_string()
    } else {
        trimmed
    }
}

fn quality_selector(quality: &str) -> String {
    match quality {
        "360p" => "bestvideo[height<=360]+bestaudio/best[height<=360]".to_string(),
        "480p" => "bestvideo[height<=480]+bestaudio/best[height<=480]".to_string(),
        "720p" => "bestvideo[height<=720]+bestaudio/best[height<=720]".to_string(),
        "1080p" => "bestvideo[height<=1080]+bestaudio/best[height<=1080]".to_string(),
        _ => "bestvideo+bestaudio/best".to_string(),
    }
}

const WATERMARK_TEXT: &str = "CLIPZY FREE";

fn watermark_image_path(job_dir: &Path) -> PathBuf {
    job_dir.join("watermark.ppm")
}

fn put_pixel(pixels: &mut [u8], width: usize, x: usize, y: usize, rgb: [u8; 3]) {
    let idx = (y * width + x) * 3;
    pixels[idx] = rgb[0];
    pixels[idx + 1] = rgb[1];
    pixels[idx + 2] = rgb[2];
}

fn glyph_rows(ch: char) -> Option<[u8; 7]> {
    match ch {
        'C' => Some([
            0b01110,
            0b10001,
            0b10000,
            0b10000,
            0b10000,
            0b10001,
            0b01110,
        ]),
        'L' => Some([
            0b10000,
            0b10000,
            0b10000,
            0b10000,
            0b10000,
            0b10000,
            0b11111,
        ]),
        'I' => Some([
            0b11111,
            0b00100,
            0b00100,
            0b00100,
            0b00100,
            0b00100,
            0b11111,
        ]),
        'P' => Some([
            0b11110,
            0b10001,
            0b10001,
            0b11110,
            0b10000,
            0b10000,
            0b10000,
        ]),
        'Z' => Some([
            0b11111,
            0b00001,
            0b00010,
            0b00100,
            0b01000,
            0b10000,
            0b11111,
        ]),
        'Y' => Some([
            0b10001,
            0b01010,
            0b00100,
            0b00100,
            0b00100,
            0b00100,
            0b00100,
        ]),
        'F' => Some([
            0b11111,
            0b10000,
            0b10000,
            0b11110,
            0b10000,
            0b10000,
            0b10000,
        ]),
        'R' => Some([
            0b11110,
            0b10001,
            0b10001,
            0b11110,
            0b10100,
            0b10010,
            0b10001,
        ]),
        'E' => Some([
            0b11111,
            0b10000,
            0b10000,
            0b11110,
            0b10000,
            0b10000,
            0b11111,
        ]),
        ' ' => Some([0, 0, 0, 0, 0, 0, 0]),
        _ => None,
    }
}

fn write_watermark_asset(path: &Path) -> Result<(), String> {
    let scale = 3usize;
    let padding_x = 16usize;
    let padding_y = 10usize;
    let glyph_width = 5usize;
    let glyph_height = 7usize;
    let spacing = 1usize;

    let text_width = WATERMARK_TEXT.chars().count() * (glyph_width + spacing) - spacing;
    let width = padding_x * 2 + text_width * scale;
    let height = padding_y * 2 + glyph_height * scale;

    let mut pixels = vec![0u8; width * height * 3];
    let background = [26, 26, 30];
    let border = [248, 133, 42];
    let foreground = [255, 255, 255];
    let border_size = 2usize;

    for y in 0..height {
        for x in 0..width {
            let is_border = x < border_size
                || y < border_size
                || x >= width.saturating_sub(border_size)
                || y >= height.saturating_sub(border_size);
            put_pixel(&mut pixels, width, x, y, if is_border { border } else { background });
        }
    }

    let mut cursor_x = padding_x;
    let cursor_y = padding_y;

    for ch in WATERMARK_TEXT.chars() {
        let rows = glyph_rows(ch).ok_or_else(|| format!("Unsupported watermark character: {ch}"))?;

        for (row_idx, row_bits) in rows.iter().enumerate() {
            for col in 0..glyph_width {
                let mask = 1u8 << (glyph_width - 1 - col);
                if *row_bits & mask == 0 {
                    continue;
                }

                for sy in 0..scale {
                    for sx in 0..scale {
                        let x = cursor_x + col * scale + sx;
                        let y = cursor_y + row_idx * scale + sy;
                        put_pixel(&mut pixels, width, x, y, foreground);
                    }
                }
            }
        }

        cursor_x += (glyph_width + spacing) * scale;
    }

    let mut ppm = format!("P6\n{} {}\n255\n", width, height).into_bytes();
    ppm.extend_from_slice(&pixels);
    fs::write(path, ppm).map_err(|err| err.to_string())
}

fn last_non_empty_line(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn json_string_field(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|entry| entry.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn summarize_stderr(stderr: &str, limit: usize) -> String {
    let mut lines = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();

    if lines.is_empty() {
        return String::new();
    }

    if lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }

    lines.join("\n")
}

fn remove_partial_job_files(job_dir: &Path) {
    if !job_dir.exists() {
        return;
    }

    let _ = fs::remove_dir_all(job_dir);
}

async fn run_sidecar_output(
    app: &AppHandle,
    manager: &LocalJobManager,
    job_id: &str,
    program: &str,
    args: Vec<String>,
    cwd: &Path,
) -> Result<String, String> {
    let command = app
        .shell()
        .sidecar(program)
        .map_err(|err| err.to_string())?
        .current_dir(cwd)
        .args(args)
        .set_raw_out(false);

    let (mut rx, child) = command.spawn().map_err(|err| err.to_string())?;
    let pid = manager.register_child(job_id, child)?;
    let mut code: Option<i32> = None;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Terminated(payload) => {
                code = payload.code;
            }
            CommandEvent::Stdout(line) => {
                stdout.extend(line);
                stdout.push(b'\n');
            }
            CommandEvent::Stderr(line) => {
                stderr.extend(line);
                stderr.push(b'\n');
            }
            CommandEvent::Error(err) => {
                stderr.extend(err.as_bytes());
                stderr.push(b'\n');
            }
            _ => {}
        }
    }

    let _ = manager.unregister_child(job_id, pid);

    if manager.is_canceled(job_id) {
        return Err("Canceled by user.".to_string());
    }

    let stdout = String::from_utf8(stdout).map_err(|err| err.to_string())?;
    let stderr = String::from_utf8(stderr).unwrap_or_default();

    if code != Some(0) {
        let stderr_tail = summarize_stderr(&stderr, 12);
        return Err(if stderr_tail.is_empty() {
            format!("{program} exited with a non-zero status.")
        } else {
            format!("{program} exited with a non-zero status.\n{stderr_tail}")
        });
    }

    Ok(stdout)
}

fn emit_job_update(app: &AppHandle, job: &LocalClipJob) {
    let _ = app.emit(JOB_UPDATED_EVENT, job.clone());
}

fn stage_update(job: &mut LocalClipJob, stage: &str, progress: u8, status: LocalClipJobStatus) {
    job.status = status;
    job.stage = Some(stage.to_string());
    job.progress = Some(progress);
    job.updated_at = timestamp();
}

fn emit_if_canceled(app: &AppHandle, manager: &LocalJobManager, job_id: &str) -> bool {
    if !manager.is_canceled(job_id) {
        return false;
    }

    if let Ok(job) = manager.get_job(job_id) {
        emit_job_update(app, &job);
    }
    true
}

async fn process_local_clip_job(app: AppHandle, manager: LocalJobManager, job_id: String) {
    let initial = match manager.update_job(&job_id, |job| {
        stage_update(job, "Starting local processing", 1, LocalClipJobStatus::Running);
    }) {
        Ok(job) => job,
        Err(err) => {
            let _ = manager.update_job(&job_id, |job| {
                job.status = LocalClipJobStatus::Failed;
                job.stage = Some("Failed to start".to_string());
                job.progress = None;
                job.error = Some(err.clone());
            });
            if let Ok(job) = manager.get_job(&job_id) {
                emit_job_update(&app, &job);
            }
            return;
        }
    };
    emit_job_update(&app, &initial);

    let job_dir = manager.job_dir(&job_id);
    if let Err(err) = fs::create_dir_all(&job_dir) {
        if let Ok(job) = manager.update_job(&job_id, |job| {
            job.status = LocalClipJobStatus::Failed;
            job.stage = Some("Failed to create job folder".to_string());
            job.error = Some(err.to_string());
            job.progress = None;
        }) {
            emit_job_update(&app, &job);
        }
        return;
    }

    let metadata_output = match run_sidecar_output(
        &app,
        &manager,
        &job_id,
        YTDLP_SIDECAR,
        {
            let mut args = vec![
                "--no-playlist".to_string(),
                "--dump-single-json".to_string(),
                "--quiet".to_string(),
                "--no-warnings".to_string(),
                "--cookies-from-browser".to_string(),
                "chrome".to_string(),
            ];
            if let Some(ffmpeg) = bundled_ffmpeg_path() {
                args.push("--ffmpeg-location".to_string());
                args.push(ffmpeg.to_string_lossy().to_string());
            }
            args.push(initial.youtube_url.clone());
            args
        },
        &job_dir,
    )
    .await
    {
        Ok(output) => output,
        Err(err) => {
            if emit_if_canceled(&app, &manager, &job_id) {
                return;
            }
            if let Ok(job) = manager.update_job(&job_id, |job| {
                job.status = LocalClipJobStatus::Failed;
                job.stage = Some("Could not fetch metadata".to_string());
                job.error = Some(err);
                job.progress = None;
            }) {
                emit_job_update(&app, &job);
            }
            return;
        }
    };

    if emit_if_canceled(&app, &manager, &job_id) {
        return;
    }

    let metadata: serde_json::Value = match serde_json::from_str(&metadata_output) {
        Ok(value) => value,
        Err(err) => {
            if let Ok(job) = manager.update_job(&job_id, |job| {
                job.status = LocalClipJobStatus::Failed;
                job.stage = Some("Could not parse metadata".to_string());
                job.error = Some(err.to_string());
                job.progress = None;
            }) {
                emit_job_update(&app, &job);
            }
            return;
        }
    };

    let youtube_title = json_string_field(&metadata, &["title"]).or_else(|| Some("Untitled video".to_string()));
    let video_id = json_string_field(&metadata, &["id", "video_id"]);
    let title_slug = sanitize_slug(youtube_title.as_deref().unwrap_or("clipzy"));
    let video_slug = sanitize_slug(video_id.as_deref().unwrap_or(&job_id));
    let source_template = format!("{title_slug}-{video_slug}-{SOURCE_OUTPUT_PREFIX}.%(ext)s");
    let _source_path = job_dir.join(&source_template.replace(".%(ext)s", ".mp4"));

    if let Ok(job) = manager.update_job(&job_id, |job| {
        job.stage = Some("Downloading source media".to_string());
        job.progress = Some(20);
        job.youtube_title = youtube_title.clone();
        job.video_id = video_id.clone();
    }) {
        emit_job_update(&app, &job);
    }

    let selector = quality_selector(&initial.quality);
    let download_output = match run_sidecar_output(
        &app,
        &manager,
        &job_id,
        YTDLP_SIDECAR,
        {
            let mut args = vec![
                "--no-playlist".to_string(),
                "--quiet".to_string(),
                "--no-warnings".to_string(),
                "--cookies-from-browser".to_string(),
                "chrome".to_string(),
                "-f".to_string(),
                selector,
                "--merge-output-format".to_string(),
                "mp4".to_string(),
            ];
            if let Some(ffmpeg) = bundled_ffmpeg_path() {
                args.push("--ffmpeg-location".to_string());
                args.push(ffmpeg.to_string_lossy().to_string());
            }
            args.extend_from_slice(&[
                "-o".to_string(),
                job_dir.join(&source_template).to_string_lossy().to_string(),
                "--print".to_string(),
                "after_move:filepath".to_string(),
                initial.youtube_url.clone(),
            ]);
            args
        },
        &job_dir,
    )
    .await
    {
        Ok(output) => output,
        Err(err) => {
            if emit_if_canceled(&app, &manager, &job_id) {
                return;
            }
            if let Ok(job) = manager.update_job(&job_id, |job| {
                job.status = LocalClipJobStatus::Failed;
                job.stage = Some("Source download failed".to_string());
                job.error = Some(err);
                job.progress = None;
            }) {
                emit_job_update(&app, &job);
            }
            return;
        }
    };

    if emit_if_canceled(&app, &manager, &job_id) {
        return;
    }

    let downloaded_source = match last_non_empty_line(&download_output) {
        Some(path) => path,
        None => {
            // yt-dlp didn't report a path; scan job_dir for the actual source file
            let source_prefix = format!("{title_slug}-{video_slug}-{SOURCE_OUTPUT_PREFIX}.");
            let mut found: Option<String> = None;
            if let Ok(entries) = fs::read_dir(&job_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if name_str.starts_with(&source_prefix)
                        && !name_str.ends_with(".part")
                        && entry.path().is_file()
                    {
                        found = Some(entry.path().to_string_lossy().to_string());
                        break;
                    }
                }
            }
            match found {
                Some(path) => path,
                None => {
                    if let Ok(job) = manager.update_job(&job_id, |job| {
                        job.status = LocalClipJobStatus::Failed;
                        job.stage = Some("Source file not found after download".to_string());
                        job.error = Some(format!(
                            "yt-dlp completed but no source file was produced. The bundled ffmpeg may not be accessible."
                        ));
                        job.progress = None;
                    }) {
                        emit_job_update(&app, &job);
                    }
                    return;
                }
            }
        }
    };
    let downloaded_source_path = PathBuf::from(&downloaded_source);
    let clip_path = job_dir.join(CLIP_OUTPUT_FILE);
    let final_path = job_dir.join(FINAL_OUTPUT_FILE);
    let duration = (initial.end_time - initial.start_time).max(0.0);

    if let Ok(job) = manager.update_job(&job_id, |job| {
        job.stage = Some("Clipping the requested range".to_string());
        job.progress = Some(55);
        job.source_path = Some(downloaded_source.clone());
    }) {
        emit_job_update(&app, &job);
    }

    let clip_args = vec![
        "-y".to_string(),
        "-ss".to_string(),
        initial.start_time.to_string(),
        "-i".to_string(),
        downloaded_source.clone(),
        "-t".to_string(),
        duration.to_string(),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        clip_path.to_string_lossy().to_string(),
    ];

    if let Err(err) = run_sidecar_output(&app, &manager, &job_id, FFMPEG_SIDECAR, clip_args, &job_dir).await {
        if emit_if_canceled(&app, &manager, &job_id) {
            return;
        }
        if let Ok(job) = manager.update_job(&job_id, |job| {
            job.status = LocalClipJobStatus::Failed;
            job.stage = Some("ffmpeg clipping failed".to_string());
            job.error = Some(err);
            job.progress = None;
        }) {
            emit_job_update(&app, &job);
        }
        return;
    }

    if emit_if_canceled(&app, &manager, &job_id) {
        return;
    }

    if matches!(initial.plan, LocalClipPlan::Free) {
        if let Ok(job) = manager.update_job(&job_id, |job| {
            job.stage = Some("Adding Free-plan watermark".to_string());
            job.progress = Some(80);
            job.watermarked = true;
        }) {
            emit_job_update(&app, &job);
        }

        let watermark_path = watermark_image_path(&job_dir);
        if let Err(err) = write_watermark_asset(&watermark_path) {
            if let Ok(job) = manager.update_job(&job_id, |job| {
                job.status = LocalClipJobStatus::Failed;
                job.stage = Some("Watermark asset generation failed".to_string());
                job.error = Some(err);
                job.progress = None;
            }) {
                emit_job_update(&app, &job);
            }
            return;
        }

        let watermark_args = vec![
            "-y".to_string(),
            "-i".to_string(),
            clip_path.to_string_lossy().to_string(),
            "-i".to_string(),
            watermark_path.to_string_lossy().to_string(),
            "-filter_complex".to_string(),
            "[0:v][1:v]overlay=W-w-18:H-h-18[v]".to_string(),
            "-map".to_string(),
            "[v]".to_string(),
            "-map".to_string(),
            "0:a?".to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
            final_path.to_string_lossy().to_string(),
        ];

        if let Err(err) = run_sidecar_output(&app, &manager, &job_id, FFMPEG_SIDECAR, watermark_args, &job_dir).await {
            if emit_if_canceled(&app, &manager, &job_id) {
                return;
            }
            if let Ok(job) = manager.update_job(&job_id, |job| {
                job.status = LocalClipJobStatus::Failed;
                job.stage = Some("Watermarking failed".to_string());
                job.error = Some(err);
                job.progress = None;
            }) {
                emit_job_update(&app, &job);
            }
            return;
        }

        if emit_if_canceled(&app, &manager, &job_id) {
            return;
        }

        let _ = fs::remove_file(&watermark_path);
        let _ = fs::remove_file(&clip_path);
    } else if let Err(err) = fs::rename(&clip_path, &final_path) {
        if let Ok(job) = manager.update_job(&job_id, |job| {
            job.status = LocalClipJobStatus::Failed;
            job.stage = Some("Finalizing export failed".to_string());
            job.error = Some(err.to_string());
            job.progress = None;
        }) {
            emit_job_update(&app, &job);
        }
        return;
    }

    let _ = fs::remove_file(&downloaded_source_path);

    if let Ok(job) = manager.update_job(&job_id, |job| {
        job.status = LocalClipJobStatus::Completed;
        job.stage = Some("Clip ready".to_string());
        job.progress = Some(100);
        job.error = None;
        job.output_path = Some(final_path.to_string_lossy().to_string());
        job.source_path = Some(downloaded_source);
        job.watermarked = matches!(job.plan, LocalClipPlan::Free);
    }) {
        emit_job_update(&app, &job);
    }
}

#[tauri::command]
pub async fn create_local_clip_job(
    app: AppHandle,
    manager: State<'_, LocalJobManager>,
    request: CreateLocalClipJobRequest,
) -> Result<LocalClipJob, String> {
    let job = manager.create_job(&request)?;
    let job_id = job.id.clone();
    let background_app = app.clone();
    let background_manager = manager.inner().clone();

    tauri::async_runtime::spawn(async move {
        process_local_clip_job(background_app, background_manager, job_id).await;
    });

    Ok(job)
}

#[tauri::command]
pub async fn list_local_clip_jobs(manager: State<'_, LocalJobManager>) -> Result<Vec<LocalClipJob>, String> {
    manager.list_jobs()
}

#[tauri::command]
pub async fn get_local_clip_job(
    manager: State<'_, LocalJobManager>,
    job_id: String,
) -> Result<LocalClipJob, String> {
    manager.get_job(&job_id)
}

#[tauri::command]
pub async fn cancel_local_clip_job(
    app: AppHandle,
    manager: State<'_, LocalJobManager>,
    job_id: String,
) -> Result<LocalClipJob, String> {
    let job = manager.cancel_job(&job_id)?;
    emit_job_update(&app, &job);
    Ok(job)
}

async fn open_job_output(job: &LocalClipJob, reveal: bool) -> Result<(), String> {
    let output_path = job
        .output_path
        .as_ref()
        .ok_or_else(|| "This clip does not have an output file yet.".to_string())?;
    let path = PathBuf::from(output_path);

    if !path.exists() {
        return Err("The output file is missing on disk.".to_string());
    }

    let mut command = StdCommand::new("open");
    if reveal {
        command.arg("-R");
    }
    command.arg(&path);

    let output = command.output().map_err(|err| format!("Could not open the clip output: {err}"))?;
    if !output.status.success() {
        let status = output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "terminated by signal".to_string());
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stderr = if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        };
        return Err(format!("Could not open the clip output (exit {status}){stderr}"));
    }

    Ok(())
}

#[tauri::command]
pub async fn open_local_clip_output(_app: AppHandle, manager: State<'_, LocalJobManager>, job_id: String) -> Result<(), String> {
    let job = manager.get_job(&job_id)?;
    open_job_output(&job, false).await
}

#[tauri::command]
pub async fn reveal_local_clip_output(_app: AppHandle, manager: State<'_, LocalJobManager>, job_id: String) -> Result<(), String> {
    let job = manager.get_job(&job_id)?;
    open_job_output(&job, true).await
}
