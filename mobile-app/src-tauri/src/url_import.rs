use crate::{allow_request, validate_open_path};
use serde::Serialize;
use serde_json::{json, Value};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager};

const SIDECAR_NAME: &str = "lightpage-url-importer";
const TARGET_SIDECAR_NAME: &str = "lightpage-url-importer-x86_64-pc-windows-msvc.exe";

#[derive(Default)]
pub struct UrlImportState(Mutex<Option<ActiveImport>>);

struct ActiveImport {
    job_id: String,
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
}

struct StagingCleanup(PathBuf);

impl Drop for StagingCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UrlImportProgress {
    job_id: String,
    phase: String,
    message: String,
    progress: u8,
}

fn validate_job_id(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("URL 导入任务标识无效".to_string());
    }
    Ok(value)
}

fn validate_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value.trim()).map_err(|_| "请输入有效的网页 URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("仅支持 http:// 或 https:// URL".to_string());
    }
    Ok(url)
}

fn find_sidecar() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(executable) = env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join(format!("{SIDECAR_NAME}.exe")));
            candidates.push(directory.join(TARGET_SIDECAR_NAME));
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(TARGET_SIDECAR_NAME),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "URL importer 尚未构建，请先运行 npm run url-importer:build".to_string())
}

fn import_output_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .document_dir()
        .map(|path| path.join("LightPage").join("url-to-markdown"))
        .map_err(|error| format!("无法定位系统文档目录：{error}"))
}

fn import_staging_root(app: &tauri::AppHandle, job_id: &str) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("url-import").join(job_id))
        .map_err(|error| format!("无法定位应用缓存目录：{error}"))
}

fn import_profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("url-import").join("chrome-profile"))
        .map_err(|error| format!("无法定位应用数据目录：{error}"))
}

fn ensure_contained(path: &Path, root: &Path) -> Result<(), String> {
    let canonical_path = fs::canonicalize(path).map_err(|_| "URL 导入文件不存在".to_string())?;
    let canonical_root = fs::canonicalize(root).map_err(|_| "URL 导入目录不存在".to_string())?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err("URL importer 返回了输出目录之外的文件".to_string());
    }
    Ok(())
}

fn ensure_profile_cleanup_target(profile: &Path, app_data: &Path) -> Result<(), String> {
    let expected = app_data.join("url-import").join("chrome-profile");
    if profile != expected || profile == app_data {
        return Err("拒绝清理不安全的浏览器配置路径".to_string());
    }
    if profile.exists() {
        let canonical_profile = fs::canonicalize(profile)
            .map_err(|error| format!("无法验证浏览器配置路径：{error}"))?;
        let canonical_app_data =
            fs::canonicalize(app_data).map_err(|error| format!("无法验证应用数据路径：{error}"))?;
        if !canonical_profile.starts_with(canonical_app_data) {
            return Err("拒绝清理应用数据目录之外的浏览器配置".to_string());
        }
    }
    Ok(())
}

fn emit_progress(app: &tauri::AppHandle, job_id: &str, payload: &str) {
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return;
    };
    let progress = UrlImportProgress {
        job_id: job_id.to_string(),
        phase: value
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("working")
            .to_string(),
        message: value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("正在导入网页")
            .to_string(),
        progress: value
            .get("progress")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(100) as u8,
    };
    let _ = app.emit("url-import-progress", progress);
}

fn clear_active(state: &UrlImportState, job_id: &str) {
    if let Ok(mut active) = state.0.lock() {
        if active.as_ref().is_some_and(|item| item.job_id == job_id) {
            *active = None;
        }
    }
}

#[tauri::command]
pub async fn import_url(
    app: tauri::AppHandle,
    state: tauri::State<'_, UrlImportState>,
    job_id: String,
    url: String,
    interactive: bool,
) -> Result<Value, String> {
    validate_job_id(&job_id)?;
    let normalized_url = match validate_url(&url) {
        Ok(value) => value.to_string(),
        Err(message) => {
            return Ok(json!({
                "status": "failed",
                "code": "INVALID_URL",
                "message": message,
                "retryable": false
            }));
        }
    };
    let output_root = import_output_root(&app)?;
    let staging_root = import_staging_root(&app, &job_id)?;
    let profile_dir = import_profile_dir(&app)?;
    fs::create_dir_all(&output_root).map_err(|error| format!("无法创建 URL 导入目录：{error}"))?;
    let _ = fs::remove_dir_all(&staging_root);
    fs::create_dir_all(&staging_root).map_err(|error| format!("无法创建 URL 导入缓存：{error}"))?;
    let _staging_cleanup = StagingCleanup(staging_root.clone());
    fs::create_dir_all(&profile_dir).map_err(|error| format!("无法创建浏览器配置目录：{error}"))?;

    let (child, stdout, stderr, cancelled) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "URL 导入任务状态不可用".to_string())?;
        if guard.is_some() {
            return Ok(json!({
                "status": "failed",
                "code": "BUSY",
                "message": "已有 URL 正在导入，请等待当前任务完成",
                "retryable": true
            }));
        }

        let mut command = Command::new(find_sidecar()?);
        command
            .arg("--url")
            .arg(&normalized_url)
            .arg("--output-root")
            .arg(&output_root)
            .arg("--staging-root")
            .arg(&staging_root)
            .arg("--profile-dir")
            .arg(&profile_dir)
            .arg("--timeout")
            .arg("30000")
            .arg("--interaction-timeout")
            .arg("600000")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        if interactive {
            command.arg("--interactive");
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 URL importer：{error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取 URL importer 输出".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法读取 URL importer 进度".to_string())?;
        let child = Arc::new(Mutex::new(child));
        let cancelled = Arc::new(AtomicBool::new(false));
        *guard = Some(ActiveImport {
            job_id: job_id.clone(),
            child: Arc::clone(&child),
            cancelled: Arc::clone(&cancelled),
        });
        (child, stdout, stderr, cancelled)
    };

    let progress_app = app.clone();
    let progress_job_id = job_id.clone();
    let stderr_thread = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(payload) = line.strip_prefix("EVENT\t") {
                emit_progress(&progress_app, &progress_job_id, payload);
            }
        }
    });
    let stdout_thread = thread::spawn(move || {
        let mut content = String::new();
        let mut reader = BufReader::new(stdout);
        let _ = reader.read_to_string(&mut content);
        content
    });

    let wait_child = Arc::clone(&child);
    let wait_result = tauri::async_runtime::spawn_blocking(
        move || -> Result<std::process::ExitStatus, String> {
            loop {
                let result = wait_child
                    .lock()
                    .map_err(|_| "URL importer 进程状态不可用".to_string())?
                    .try_wait()
                    .map_err(|error| format!("无法等待 URL importer：{error}"))?;
                if let Some(status) = result {
                    return Ok(status);
                }
                thread::sleep(Duration::from_millis(100));
            }
        },
    )
    .await
    .map_err(|error| format!("URL importer 等待任务失败：{error}"))?;

    let _ = stderr_thread.join();
    let stdout = stdout_thread.join().unwrap_or_default();
    clear_active(&state, &job_id);
    if cancelled.load(Ordering::SeqCst) {
        return Ok(json!({ "status": "cancelled" }));
    }
    wait_result?;
    let mut outcome: Value = serde_json::from_str(stdout.trim())
        .map_err(|_| "URL importer 返回了无法识别的结果".to_string())?;
    if outcome.get("status").and_then(Value::as_str) == Some("ok") {
        let output_path = outcome
            .get("outputPath")
            .and_then(Value::as_str)
            .ok_or_else(|| "URL importer 未返回 Markdown 路径".to_string())?;
        ensure_contained(Path::new(output_path), &output_root)?;
        let (canonical, request) = validate_open_path(output_path, "url")?;
        allow_request(&app, &canonical)?;
        outcome["openRequest"] =
            serde_json::to_value(request).map_err(|error| format!("无法生成打开请求：{error}"))?;
    }
    Ok(outcome)
}

#[tauri::command]
pub fn resume_url_import(
    state: tauri::State<'_, UrlImportState>,
    job_id: String,
) -> Result<(), String> {
    validate_job_id(&job_id)?;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "URL 导入任务状态不可用".to_string())?;
    let active = guard
        .as_mut()
        .filter(|item| item.job_id == job_id)
        .ok_or_else(|| "URL 导入任务已结束".to_string())?;
    let child = Arc::clone(&active.child);
    drop(guard);
    let mut child = child
        .lock()
        .map_err(|_| "URL importer 进程状态不可用".to_string())?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "URL importer 无法接收继续指令".to_string())?
        .write_all(b"\n")
        .map_err(|error| format!("无法继续 URL 导入：{error}"))
}

#[tauri::command]
pub fn cancel_url_import(
    state: tauri::State<'_, UrlImportState>,
    job_id: String,
) -> Result<(), String> {
    validate_job_id(&job_id)?;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "URL 导入任务状态不可用".to_string())?;
    let active = guard
        .as_mut()
        .filter(|item| item.job_id == job_id)
        .ok_or_else(|| "URL 导入任务已结束".to_string())?;
    active.cancelled.store(true, Ordering::SeqCst);
    let child = Arc::clone(&active.child);
    drop(guard);
    let result = child
        .lock()
        .map_err(|_| "URL importer 进程状态不可用".to_string())?
        .kill()
        .map_err(|error| format!("无法取消 URL 导入：{error}"));
    result
}

#[tauri::command]
pub fn clear_url_import_profile(
    app: tauri::AppHandle,
    state: tauri::State<'_, UrlImportState>,
) -> Result<(), String> {
    if state
        .0
        .lock()
        .map_err(|_| "URL 导入任务状态不可用".to_string())?
        .is_some()
    {
        return Err("请先结束当前 URL 导入任务".to_string());
    }
    let profile = import_profile_dir(&app)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    ensure_profile_cleanup_target(&profile, &app_data)?;
    if profile.exists() {
        fs::remove_dir_all(profile).map_err(|error| format!("无法清除网页登录数据：{error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_safe_job_ids_only() {
        assert!(validate_job_id("url-123_ab").is_ok());
        assert!(validate_job_id("../escape").is_err());
        assert!(validate_job_id("").is_err());
    }

    #[test]
    fn accepts_http_urls_only() {
        assert!(validate_url("https://example.com/article").is_ok());
        assert!(validate_url("http://localhost:3000").is_ok());
        assert!(validate_url("file:///c:/secret").is_err());
    }

    #[test]
    fn containment_rejects_sibling_files() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("lightpage-url-root-{suffix}"));
        let sibling = env::temp_dir().join(format!("lightpage-url-outside-{suffix}.md"));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("inside.md"), b"# inside").unwrap();
        fs::write(&sibling, b"# outside").unwrap();
        assert!(ensure_contained(&root.join("inside.md"), &root).is_ok());
        assert!(ensure_contained(&sibling, &root).is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_file(sibling).unwrap();
    }

    #[test]
    fn profile_cleanup_accepts_only_the_exact_isolated_directory() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let app_data = env::temp_dir().join(format!("lightpage-app-data-{suffix}"));
        let profile = app_data.join("url-import").join("chrome-profile");
        fs::create_dir_all(&profile).unwrap();
        assert!(ensure_profile_cleanup_target(&profile, &app_data).is_ok());
        assert!(ensure_profile_cleanup_target(&app_data.join("documents"), &app_data).is_err());
        assert!(ensure_profile_cleanup_target(&app_data, &app_data).is_err());
        fs::remove_dir_all(app_data).unwrap();
    }
}
