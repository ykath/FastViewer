use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager};
use tauri_plugin_fs::FsExt;

const SUPPORTED_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "html", "htm", "xhtml"];
const SUPPORTED_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
const MAX_RELATIVE_RESOURCES: usize = 64;
const MAX_RELATIVE_RESOURCE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_RELATIVE_RESOURCES_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOpenRequest {
    path: String,
    file_name: String,
    size: u64,
    source: String,
}

#[derive(Default)]
struct PendingOpenRequests(Mutex<VecDeque<DesktopOpenRequest>>);

fn validate_source(source: &str) -> Result<&str, String> {
    match source {
        "launch" | "association" | "picker" => Ok(source),
        _ => Err("不支持的文件来源".to_string()),
    }
}

fn validate_open_path(path: impl AsRef<Path>, source: &str) -> Result<(PathBuf, DesktopOpenRequest), String> {
    validate_source(source)?;
    let canonical = fs::canonicalize(path.as_ref()).map_err(|_| "文件不存在或无法访问".to_string())?;
    let metadata = fs::metadata(&canonical).map_err(|_| "无法读取文件信息".to_string())?;
    if !metadata.is_file() {
        return Err("所选路径不是普通文件".to_string());
    }

    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "文件缺少受支持的扩展名".to_string())?;
    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("当前仅支持 Markdown 和 HTML 文件".to_string());
    }

    let file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "文件名无法识别".to_string())?
        .to_string();
    let path_string = canonical.to_string_lossy().into_owned();
    Ok((canonical, DesktopOpenRequest {
        path: path_string,
        file_name,
        size: metadata.len(),
        source: source.to_string(),
    }))
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

fn allow_request(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
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
        if !extension
            .as_deref()
            .is_some_and(|value| SUPPORTED_IMAGE_EXTENSIONS.contains(&value))
        {
            continue;
        }
        let Ok(metadata) = fs::metadata(&canonical) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_RELATIVE_RESOURCE_BYTES {
            continue;
        }
        if total_bytes.saturating_add(metadata.len()) > MAX_RELATIVE_RESOURCES_TOTAL_BYTES {
            break;
        }
        total_bytes += metadata.len();
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
        allowed.insert(source, path.to_string_lossy().into_owned());
    }
    Ok(allowed)
}

#[tauri::command]
fn take_pending_open_requests(
    state: tauri::State<'_, PendingOpenRequests>,
) -> Result<Vec<DesktopOpenRequest>, String> {
    let mut queue = state.0.lock().map_err(|_| "打开文件队列不可用".to_string())?;
    Ok(queue.drain(..).collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            for (path, request) in requests_from_args(args.into_iter().skip(1), "association") {
                if allow_request(app, &path).is_ok() {
                    let _ = app.emit("desktop-file-open", request);
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingOpenRequests::default())
        .setup(|app| {
            let requests = requests_from_args(
                env::args_os().skip(1).map(|value| value.to_string_lossy().into_owned()),
                "launch",
            );
            let state = app.state::<PendingOpenRequests>();
            let mut queue = state.0.lock().map_err(|_| "打开文件队列不可用")?;
            for (path, request) in requests {
                if allow_request(app.handle(), &path).is_ok() {
                    queue.push_back(request);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            prepare_open_request,
            resolve_relative_resources,
            take_pending_open_requests
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
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
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
}
