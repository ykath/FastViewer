use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::UNIX_EPOCH,
};
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

mod archive;
mod system_integration;
mod workspace;

use archive::{cancel_zip_import, import_zip_archive, remove_zip_archive, ArchiveImportState};
use system_integration::{add_recent_document, get_html_open_with, set_html_open_with};
use workspace::{
    cancel_workspace_index, get_document_revision, list_workspace_children, prepare_workspace_open,
    register_workspace, remove_workspace, restore_workspaces, search_workspace,
    start_workspace_index, unwatch_document, watch_document, DesktopWorkspaceState,
};

const SUPPORTED_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "html", "htm", "xhtml", "zip"];
const SUPPORTED_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
const SUPPORTED_VIDEO_EXTENSIONS: &[&str] = &["mp4", "webm", "ogg", "ogv", "mov", "m4v"];
const MAX_RELATIVE_RESOURCES: usize = 64;
const MAX_RELATIVE_VIDEOS: usize = 16;
const MAX_RELATIVE_RESOURCE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_RELATIVE_VIDEO_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RELATIVE_RESOURCES_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOpenRequest {
    path: String,
    file_name: String,
    size: u64,
    source: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDropClassification {
    files: Vec<DesktopOpenRequest>,
    directories: Vec<String>,
    rejected: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDirectoryDocument {
    path: String,
    file_name: String,
    size: u64,
    modified_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDirectoryListing {
    path: String,
    name: String,
    files: Vec<DesktopDirectoryDocument>,
}

#[derive(Default)]
struct PendingOpenRequests(Mutex<VecDeque<DesktopOpenRequest>>);

#[derive(Default)]
struct WindowDocuments(Mutex<HashMap<String, String>>);

static READER_WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

fn normalize_document_key(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum AssociationAction {
    Focus(String),
    OpenNew,
}

fn association_action(documents: &HashMap<String, String>, path: &str) -> AssociationAction {
    let key = normalize_document_key(path);
    documents
        .iter()
        .find_map(|(label, open_path)| {
            (!open_path.is_empty() && normalize_document_key(open_path) == key).then(|| label.clone())
        })
        .map_or(AssociationAction::OpenNew, AssociationAction::Focus)
}

fn split_launch_requests<T>(mut requests: Vec<T>) -> (Vec<T>, Vec<T>) {
    if requests.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let extras = requests.split_off(1);
    (requests, extras)
}

fn focus_webview_window(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn enqueue_open_request(app: &tauri::AppHandle, request: DesktopOpenRequest) -> bool {
    let state = app.state::<PendingOpenRequests>();
    let Ok(mut queue) = state.0.lock() else {
        return false;
    };
    queue.push_back(request);
    true
}

fn open_reader_window_impl(
    app: &tauri::AppHandle,
    path: &Path,
    request: &DesktopOpenRequest,
) -> Result<(), String> {
    allow_request(app, path)?;
    let documents = app.state::<WindowDocuments>();
    let existing_label = {
        let guard = documents
            .0
            .lock()
            .map_err(|_| "窗口文档映射不可用".to_string())?;
        match association_action(&guard, &request.path) {
            AssociationAction::Focus(label) => Some(label),
            AssociationAction::OpenNew => None,
        }
    };
    if let Some(label) = existing_label {
        if let Some(window) = app.get_webview_window(&label) {
            focus_webview_window(&window);
            return Ok(());
        }
        if let Ok(mut guard) = documents.0.lock() {
            guard.remove(&label);
        }
    }

    let label = {
        let windows = app.webview_windows();
        loop {
            let candidate = format!("reader-{}", READER_WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
            if !windows.contains_key(&candidate) {
                break candidate;
            }
        }
    };
    let script = format!(
        "globalThis.__LIGHTPAGE_DOCUMENT_PATH__ = {};",
        serde_json::to_string(&request.path).map_err(|error| format!("无法编码文件路径：{error}"))?
    );
    let reader_count = app
        .webview_windows()
        .keys()
        .filter(|existing| existing.starts_with("reader-"))
        .count()
        + 1;
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(&request.file_name)
        .inner_size(1100.0, 760.0)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        .initialization_script(script)
        .build()
        .map_err(|error| format!("无法创建阅读窗口：{error}"))?;
    if let Ok(mut guard) = documents.0.lock() {
        guard.insert(label.clone(), request.path.clone());
    }
    if let Some(anchor) = app.get_webview_window("main").or_else(|| {
        app.webview_windows()
            .into_values()
            .find(|candidate| candidate.label() != label)
    }) {
        if let Ok(position) = anchor.outer_position() {
            let offset = 28 * reader_count as i32;
            let _ = window.set_position(PhysicalPosition::new(position.x + offset, position.y + offset));
        }
    }
    focus_webview_window(&window);
    Ok(())
}

fn open_association_requests(app: tauri::AppHandle, requests: Vec<(PathBuf, DesktopOpenRequest)>) {
    // WebView2 deadlocks if a window is created on the single-instance callback thread.
    std::thread::spawn(move || {
        let mut queued = false;
        for (path, request) in requests {
            if allow_request(&app, &path).is_err() {
                continue;
            }
            if open_reader_window_impl(&app, &path, &request).is_err() && enqueue_open_request(&app, request)
            {
                queued = true;
            }
        }
        if queued {
            if let Some(window) = app.get_webview_window("main") {
                focus_webview_window(&window);
            }
            let _ = app.emit("desktop-open-requested", ());
        }
    });
}

fn validate_source(source: &str) -> Result<&str, String> {
    match source {
        "launch" | "association" | "picker" | "workspace" | "drop" => Ok(source),
        _ => Err("不支持的文件来源".to_string()),
    }
}

pub(crate) fn validate_open_path(
    path: impl AsRef<Path>,
    source: &str,
) -> Result<(PathBuf, DesktopOpenRequest), String> {
    validate_source(source)?;
    let canonical =
        fs::canonicalize(path.as_ref()).map_err(|_| "文件不存在或无法访问".to_string())?;
    let metadata = fs::metadata(&canonical).map_err(|_| "无法读取文件信息".to_string())?;
    if !metadata.is_file() {
        return Err("所选路径不是普通文件".to_string());
    }

    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "文件缺少受支持的扩展名".to_string())?;
    if extension == "rar" {
        return Err("请转换为 ZIP".to_string());
    }
    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("当前仅支持 Markdown 和 HTML 文件".to_string());
    }

    let file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "文件名无法识别".to_string())?
        .to_string();
    let path_string = canonical.to_string_lossy().into_owned();
    Ok((
        canonical,
        DesktopOpenRequest {
            path: path_string,
            file_name,
            size: metadata.len(),
            source: source.to_string(),
        },
    ))
}

fn requests_from_args<I, S>(args: I, source: &str) -> Vec<(PathBuf, DesktopOpenRequest)>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen = HashSet::new();
    args.into_iter()
        .filter_map(|arg| validate_open_path(arg.as_ref(), source).ok())
        .filter(|(path, _)| seen.insert(path.clone()))
        .collect()
}

pub(crate) fn allow_request(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    app.fs_scope()
        .allow_file(path)
        .map_err(|error| format!("无法授权文件访问：{error}"))
}

fn resolve_relative_resource_paths(
    document_path: impl AsRef<Path>,
    relative_paths: Vec<String>,
) -> Result<HashMap<String, PathBuf>, String> {
    let document = fs::canonicalize(document_path.as_ref())
        .map_err(|_| "Markdown 文件不存在或无法访问".to_string())?;
    let document_dir = document
        .parent()
        .ok_or_else(|| "无法确定 Markdown 文件所在目录".to_string())?;
    let mut total_bytes = 0_u64;
    let mut resolved = HashMap::new();
    let mut video_count = 0_usize;

    for relative_path in relative_paths.into_iter().take(MAX_RELATIVE_RESOURCES) {
        let candidate = Path::new(&relative_path);
        if candidate.is_absolute() || relative_path.contains('\0') {
            continue;
        }
        let Ok(canonical) = fs::canonicalize(document_dir.join(candidate)) else {
            continue;
        };
        if !canonical.starts_with(document_dir) {
            continue;
        }
        let extension = canonical
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        let extension = extension.as_deref();
        let is_image = extension
            .is_some_and(|value| SUPPORTED_IMAGE_EXTENSIONS.contains(&value));
        let is_video = extension
            .is_some_and(|value| SUPPORTED_VIDEO_EXTENSIONS.contains(&value));
        if !is_image && !is_video {
            continue;
        }
        if is_video && video_count >= MAX_RELATIVE_VIDEOS {
            continue;
        }
        let Ok(metadata) = fs::metadata(&canonical) else {
            continue;
        };
        let max_bytes = if is_video {
            MAX_RELATIVE_VIDEO_BYTES
        } else {
            MAX_RELATIVE_RESOURCE_BYTES
        };
        if !metadata.is_file() || metadata.len() > max_bytes {
            continue;
        }
        if is_image {
            if total_bytes.saturating_add(metadata.len()) > MAX_RELATIVE_RESOURCES_TOTAL_BYTES {
                break;
            }
            total_bytes += metadata.len();
        }
        if is_video {
            video_count += 1;
        }
        resolved.insert(relative_path, canonical);
    }

    Ok(resolved)
}

#[tauri::command]
fn prepare_open_request(
    app: tauri::AppHandle,
    path: String,
    source: String,
) -> Result<DesktopOpenRequest, String> {
    let (canonical, request) = validate_open_path(path, &source)?;
    allow_request(&app, &canonical)?;
    Ok(request)
}

#[tauri::command]
fn resolve_relative_resources(
    app: tauri::AppHandle,
    document_path: String,
    relative_paths: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let resources = resolve_relative_resource_paths(document_path, relative_paths)?;
    let mut allowed = HashMap::new();
    for (source, path) in resources {
        allow_request(&app, &path)?;
        let is_video = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .is_some_and(|value| SUPPORTED_VIDEO_EXTENSIONS.contains(&value.as_str()));
        if is_video {
            app.asset_protocol_scope()
                .allow_file(&path)
                .map_err(|error| format!("无法授权视频资源访问：{error}"))?;
        }
        allowed.insert(source, path.to_string_lossy().into_owned());
    }
    Ok(allowed)
}

#[tauri::command]
fn take_pending_open_requests(
    state: tauri::State<'_, PendingOpenRequests>,
) -> Result<Vec<DesktopOpenRequest>, String> {
    let mut queue = state
        .0
        .lock()
        .map_err(|_| "打开文件队列不可用".to_string())?;
    Ok(queue.drain(..).collect())
}

#[tauri::command]
fn classify_drop_paths(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<DesktopDropClassification, String> {
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut rejected = 0usize;
    let mut message = None;
    for path in paths.into_iter().take(100) {
        let Ok(canonical) = fs::canonicalize(path) else {
            rejected += 1;
            continue;
        };
        if !seen.insert(canonical.clone()) {
            continue;
        }
        if canonical.is_dir() {
            directories.push(canonical.to_string_lossy().into_owned());
            continue;
        }
        match validate_open_path(&canonical, "drop") {
            Ok((approved, request)) if allow_request(&app, &approved).is_ok() => {
                files.push(request)
            }
            Err(error) if error == "请转换为 ZIP" => {
                rejected += 1;
                message = Some(error);
            }
            _ => rejected += 1,
        }
    }
    Ok(DesktopDropClassification {
        files,
        directories,
        rejected,
        message,
    })
}

fn list_directory_documents_impl(
    path: impl AsRef<Path>,
) -> Result<DesktopDirectoryListing, String> {
    let canonical =
        fs::canonicalize(path.as_ref()).map_err(|_| "目录不存在或无法访问".to_string())?;
    let directory = if canonical.is_file() {
        canonical
            .parent()
            .ok_or_else(|| "无法确定文件所在目录".to_string())?
            .to_path_buf()
    } else if canonical.is_dir() {
        canonical
    } else {
        return Err("所选路径不是目录或普通文件".to_string());
    };

    let mut files = Vec::new();
    let entries = fs::read_dir(&directory).map_err(|_| "无法读取当前目录".to_string())?;
    for entry in entries.flatten().take(2_000) {
        if entry.file_type().is_ok_and(|kind| kind.is_symlink()) {
            continue;
        }
        let Ok((canonical_file, request)) = validate_open_path(entry.path(), "picker") else {
            continue;
        };
        if canonical_file.parent() != Some(directory.as_path()) {
            continue;
        }
        files.push(DesktopDirectoryDocument {
            path: request.path,
            file_name: request.file_name,
            size: request.size,
            modified_at: fs::metadata(&canonical_file)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64),
        });
    }
    files.sort_by(|left, right| {
        left.file_name
            .to_lowercase()
            .cmp(&right.file_name.to_lowercase())
    });
    let name = directory
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("目录")
        .to_string();
    Ok(DesktopDirectoryListing {
        path: directory.to_string_lossy().into_owned(),
        name,
        files,
    })
}

#[tauri::command]
fn list_directory_documents(path: String) -> Result<DesktopDirectoryListing, String> {
    list_directory_documents_impl(path)
}

#[tauri::command]
async fn open_reader_window(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let (canonical, request) = validate_open_path(path, "picker")?;
    open_reader_window_impl(&app, &canonical, &request)
}

#[tauri::command]
fn set_window_document(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WindowDocuments>,
    path: Option<String>,
    title: String,
) -> Result<(), String> {
    let _ = window.set_title(&title);
    let mut documents = state
        .0
        .lock()
        .map_err(|_| "窗口文档映射不可用".to_string())?;
    let label = window.label().to_string();
    match path {
        Some(path) if !path.is_empty() => {
            documents.insert(label, path);
        }
        _ => {
            documents.insert(label, String::new());
        }
    }
    Ok(())
}

#[tauri::command]
fn current_window_document(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WindowDocuments>,
) -> Result<Option<String>, String> {
    let documents = state
        .0
        .lock()
        .map_err(|_| "窗口文档映射不可用".to_string())?;
    Ok(documents.get(window.label()).cloned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let requests = requests_from_args(args.into_iter().skip(1), "association");
            if requests.is_empty() {
                if let Some(window) = app.get_webview_window("main") {
                    focus_webview_window(&window);
                }
                return;
            }
            open_association_requests(app.clone(), requests);
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| label == "main")
                .build(),
        )
        .manage(PendingOpenRequests::default())
        .manage(WindowDocuments::default())
        .manage(DesktopWorkspaceState::default())
        .manage(ArchiveImportState::default())
        .setup(|app| {
            let requests = requests_from_args(
                env::args_os()
                    .skip(1)
                    .map(|value| value.to_string_lossy().into_owned()),
                "launch",
            );
            let allowed = requests
                .into_iter()
                .filter(|(path, _)| allow_request(app.handle(), path).is_ok())
                .collect::<Vec<_>>();
            let (main_requests, extra_requests) = split_launch_requests(allowed);
            {
                let state = app.state::<PendingOpenRequests>();
                let mut queue = state.0.lock().map_err(|_| "打开文件队列不可用")?;
                queue.extend(main_requests.into_iter().map(|(_, request)| request));
            }
            for (path, request) in extra_requests {
                if open_reader_window_impl(app.handle(), &path, &request).is_err() {
                    let _ = enqueue_open_request(app.handle(), request);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            prepare_open_request,
            resolve_relative_resources,
            take_pending_open_requests,
            classify_drop_paths,
            list_directory_documents,
            open_reader_window,
            set_window_document,
            current_window_document,
            register_workspace,
            restore_workspaces,
            remove_workspace,
            list_workspace_children,
            prepare_workspace_open,
            get_document_revision,
            watch_document,
            unwatch_document,
            start_workspace_index,
            cancel_workspace_index,
            search_workspace,
            set_html_open_with,
            get_html_open_with,
            add_recent_document,
            import_zip_archive,
            cancel_zip_import,
            remove_zip_archive
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("LightPage failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("lightpage-tests-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn accepts_supported_extensions_case_insensitively_and_unicode_paths() {
        let root = temp_root();
        let markdown = root.join("中文 文件.MD");
        let html = root.join("report.HTML");
        fs::write(&markdown, b"# test").unwrap();
        fs::write(&html, b"<h1>test</h1>").unwrap();

        let (_, md_request) = validate_open_path(&markdown, "picker").unwrap();
        let (_, html_request) = validate_open_path(&html, "launch").unwrap();
        assert_eq!(md_request.file_name, "中文 文件.MD");
        assert_eq!(html_request.file_name, "report.HTML");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_missing_directories_and_unsupported_files() {
        let root = temp_root();
        let unsupported = root.join("notes.txt");
        fs::write(&unsupported, b"test").unwrap();

        assert!(validate_open_path(root.join("missing.md"), "picker").is_err());
        assert!(validate_open_path(&root, "picker").is_err());
        assert!(validate_open_path(&unsupported, "picker").is_err());
        assert!(validate_open_path(&unsupported, "unknown").is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn argument_requests_are_deduplicated_and_ignore_invalid_entries() {
        let root = temp_root();
        let markdown = root.join("notes.markdown");
        let unsupported = root.join("notes.txt");
        fs::write(&markdown, b"# test").unwrap();
        fs::write(&unsupported, b"test").unwrap();

        let args = vec![
            markdown.to_string_lossy().into_owned(),
            markdown.to_string_lossy().into_owned(),
            unsupported.to_string_lossy().into_owned(),
        ];
        let requests = requests_from_args(args, "association");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].1.source, "association");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_only_safe_relative_images_below_the_document_directory() {
        let root = temp_root();
        let article_dir = root.join("article");
        let image_dir = article_dir.join("windows");
        fs::create_dir_all(&image_dir).unwrap();
        let markdown = article_dir.join("guide.md");
        let cover = article_dir.join("首页.jpg");
        let screenshot = image_dir.join("Windows-首页.png");
        let unsupported = article_dir.join("notes.txt");
        let outside = root.join("outside.png");
        fs::write(&markdown, b"# guide").unwrap();
        fs::write(&cover, b"jpg").unwrap();
        fs::write(&screenshot, b"png").unwrap();
        fs::write(&unsupported, b"text").unwrap();
        fs::write(&outside, b"outside").unwrap();

        let resources = resolve_relative_resource_paths(
            &markdown,
            vec![
                "首页.jpg".to_string(),
                "windows/Windows-首页.png".to_string(),
                "notes.txt".to_string(),
                "../outside.png".to_string(),
                "missing.png".to_string(),
            ],
        )
        .unwrap();

        assert_eq!(resources.len(), 2);
        assert_eq!(resources["首页.jpg"], fs::canonicalize(cover).unwrap());
        assert_eq!(
            resources["windows/Windows-首页.png"],
            fs::canonicalize(screenshot).unwrap()
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_only_safe_relative_videos_below_the_document_directory() {
        let root = temp_root();
        let article_dir = root.join("renders");
        fs::create_dir_all(&article_dir).unwrap();
        let markdown = article_dir.join("article.md");
        let promo = article_dir.join("LightPage-v1.5.2-promo.mp4");
        fs::write(&markdown, b"# article").unwrap();
        fs::write(&promo, b"mp4").unwrap();

        let resources = resolve_relative_resource_paths(
            &markdown,
            vec!["./LightPage-v1.5.2-promo.mp4".to_string()],
        )
        .unwrap();

        assert_eq!(resources.len(), 1);
        assert_eq!(
            resources["./LightPage-v1.5.2-promo.mp4"],
            fs::canonicalize(promo).unwrap()
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_only_supported_documents_in_the_current_directory() {
        let root = temp_root();
        fs::write(root.join("B.html"), b"<p>b</p>").unwrap();
        fs::write(root.join("a.md"), b"# a").unwrap();
        fs::write(root.join("ignored.txt"), b"ignored").unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested").join("nested.md"), b"# nested").unwrap();

        let listing = list_directory_documents_impl(root.join("a.md")).unwrap();
        let names = listing
            .files
            .iter()
            .map(|item| item.file_name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["a.md", "B.html"]);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_path_focuses_the_existing_window() {
        let mut documents = HashMap::new();
        documents.insert("main".to_string(), r"C:\Docs\Notes.MD".to_string());
        documents.insert("reader-1".to_string(), String::new());
        assert_eq!(
            association_action(&documents, "C:/docs/notes.md"),
            AssociationAction::Focus("main".to_string())
        );
        assert_eq!(
            association_action(&documents, "C:/docs/other.md"),
            AssociationAction::OpenNew
        );
    }

    #[test]
    fn launch_keeps_only_the_first_file_on_the_main_window() {
        let (main, extras) = split_launch_requests(vec!["a.md", "b.md", "c.md"]);
        assert_eq!(main, vec!["a.md"]);
        assert_eq!(extras, vec!["b.md", "c.md"]);
        let (empty_main, empty_extras) = split_launch_requests::<String>(Vec::new());
        assert!(empty_main.is_empty());
        assert!(empty_extras.is_empty());
    }
}
