use chardetng::EncodingDetector;
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use pulldown_cmark::{Event as MarkdownEvent, Parser, Tag, TagEnd};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use walkdir::{DirEntry, WalkDir};

use crate::{allow_request, validate_open_path, DesktopOpenRequest};

const DEFAULT_EXCLUSIONS: &[&str] = &[".git", ".svn", "node_modules", "target", "dist", "build"];
const SUPPORTED_DOCUMENT_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "html", "htm", "xhtml"];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRegistration {
    pub id: String,
    pub name: String,
    pub root_path: String,
    #[serde(default)]
    pub exclusions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub status: &'static str,
    pub exclusions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTreeNode {
    pub workspace_id: String,
    pub relative_path: String,
    pub name: String,
    pub kind: &'static str,
    pub has_children: bool,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchHit {
    pub workspace_id: String,
    pub relative_path: String,
    pub file_name: String,
    pub title: String,
    pub snippet: String,
    pub line: usize,
    pub column: usize,
    pub score: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndexProgress {
    pub workspace_id: String,
    pub phase: &'static str,
    pub scanned: usize,
    pub indexed: usize,
    pub total: Option<usize>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFileChange {
    pub document_id: String,
    pub kind: &'static str,
}

#[derive(Clone)]
struct RegisteredWorkspace {
    id: String,
    root: PathBuf,
    exclusions: HashSet<String>,
}

struct DocumentWatch {
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
pub struct DesktopWorkspaceState {
    workspaces: Mutex<HashMap<String, RegisteredWorkspace>>,
    workspace_watches: Mutex<HashMap<String, RecommendedWatcher>>,
    watches: Mutex<HashMap<String, DocumentWatch>>,
    index_cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn create_workspace_watch(
    app: tauri::AppHandle,
    workspace: &RegisteredWorkspace,
) -> Result<RecommendedWatcher, String> {
    let workspace_id = workspace.id.clone();
    let root = workspace.root.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            if result.is_ok() {
                let _ = app.emit("workspace-files-changed", workspace_id.clone());
            }
        },
        Config::default(),
    )
    .map_err(|error| format!("无法创建工作区监听器：{error}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| format!("无法监听工作区目录：{error}"))?;
    Ok(watcher)
}

fn normalized_exclusions(values: &[String]) -> HashSet<String> {
    DEFAULT_EXCLUSIONS
        .iter()
        .map(|value| value.to_string())
        .chain(values.iter().map(|value| value.trim().to_string()))
        .filter(|value| !value.is_empty() && !value.contains(['/', '\\']))
        .collect()
}

fn register_one(
    input: WorkspaceRegistration,
) -> Result<(RegisteredWorkspace, WorkspaceRecord), String> {
    if input.id.trim().is_empty() || input.name.trim().is_empty() {
        return Err("工作区 ID 和名称不能为空".to_string());
    }
    let root =
        fs::canonicalize(&input.root_path).map_err(|_| "工作区目录不存在或无法访问".to_string())?;
    let metadata = fs::metadata(&root).map_err(|_| "无法读取工作区目录".to_string())?;
    if !metadata.is_dir() {
        return Err("工作区根路径不是目录".to_string());
    }
    let exclusions = normalized_exclusions(&input.exclusions);
    let record = WorkspaceRecord {
        id: input.id.clone(),
        name: input.name.clone(),
        root_path: root.to_string_lossy().into_owned(),
        status: "online",
        exclusions: exclusions.iter().cloned().collect(),
    };
    Ok((
        RegisteredWorkspace {
            id: input.id,
            root,
            exclusions,
        },
        record,
    ))
}

#[tauri::command]
pub fn register_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopWorkspaceState>,
    input: WorkspaceRegistration,
) -> Result<WorkspaceRecord, String> {
    let (registered, record) = register_one(input)?;
    let watcher = create_workspace_watch(app, &registered)?;
    state
        .workspaces
        .lock()
        .map_err(|_| "工作区注册表不可用".to_string())?
        .insert(registered.id.clone(), registered);
    state
        .workspace_watches
        .lock()
        .map_err(|_| "工作区监听注册表不可用".to_string())?
        .insert(record.id.clone(), watcher);
    Ok(record)
}

#[tauri::command]
pub fn restore_workspaces(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopWorkspaceState>,
    inputs: Vec<WorkspaceRegistration>,
) -> Result<Vec<WorkspaceRecord>, String> {
    let mut records = Vec::with_capacity(inputs.len());
    let mut registry = state
        .workspaces
        .lock()
        .map_err(|_| "工作区注册表不可用".to_string())?;
    registry.clear();
    state
        .workspace_watches
        .lock()
        .map_err(|_| "工作区监听注册表不可用".to_string())?
        .clear();
    for input in inputs {
        let offline = WorkspaceRecord {
            id: input.id.clone(),
            name: input.name.clone(),
            root_path: input.root_path.clone(),
            status: "offline",
            exclusions: normalized_exclusions(&input.exclusions)
                .into_iter()
                .collect(),
        };
        match register_one(input) {
            Ok((registered, record)) => {
                if let Ok(watcher) = create_workspace_watch(app.clone(), &registered) {
                    state
                        .workspace_watches
                        .lock()
                        .map_err(|_| "工作区监听注册表不可用".to_string())?
                        .insert(registered.id.clone(), watcher);
                }
                registry.insert(registered.id.clone(), registered);
                records.push(record);
            }
            Err(_) => records.push(offline),
        }
    }
    Ok(records)
}

#[tauri::command]
pub fn remove_workspace(
    state: tauri::State<'_, DesktopWorkspaceState>,
    workspace_id: String,
) -> Result<(), String> {
    state
        .workspaces
        .lock()
        .map_err(|_| "工作区注册表不可用".to_string())?
        .remove(&workspace_id);
    state
        .workspace_watches
        .lock()
        .map_err(|_| "工作区监听注册表不可用".to_string())?
        .remove(&workspace_id);
    cancel_workspace_index(state, workspace_id)
}

fn relative_components(relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    if path.is_absolute() || relative_path.contains('\0') {
        return Err("工作区相对路径无效".to_string());
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => clean.push(value),
            Component::CurDir => {}
            _ => return Err("工作区相对路径越界".to_string()),
        }
    }
    Ok(clean)
}

fn resolve_workspace_path(
    workspace: &RegisteredWorkspace,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let clean = relative_components(relative_path)?;
    let candidate = fs::canonicalize(workspace.root.join(clean))
        .map_err(|_| "工作区项目不存在或无法访问".to_string())?;
    if !candidate.starts_with(&workspace.root) {
        return Err("工作区项目超出已授权目录".to_string());
    }
    Ok(candidate)
}

fn is_supported_document(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|value| SUPPORTED_DOCUMENT_EXTENSIONS.contains(&value.as_str()))
}

fn is_excluded(entry: &DirEntry, workspace: &RegisteredWorkspace) -> bool {
    entry
        .file_name()
        .to_str()
        .is_some_and(|name| workspace.exclusions.contains(name))
        || entry.path_is_symlink()
}

#[tauri::command]
pub fn list_workspace_children(
    state: tauri::State<'_, DesktopWorkspaceState>,
    workspace_id: String,
    relative_path: String,
) -> Result<Vec<WorkspaceTreeNode>, String> {
    let workspace = state
        .workspaces
        .lock()
        .map_err(|_| "工作区注册表不可用".to_string())?
        .get(&workspace_id)
        .cloned()
        .ok_or_else(|| "工作区未注册或当前离线".to_string())?;
    let directory = if relative_path.is_empty() {
        workspace.root.clone()
    } else {
        resolve_workspace_path(&workspace, &relative_path)?
    };
    if !directory.is_dir() {
        return Err("所选工作区项目不是目录".to_string());
    }
    let mut nodes = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| "无法枚举工作区目录".to_string())? {
        let entry = entry.map_err(|_| "无法读取工作区项目".to_string())?;
        let path = entry.path();
        let symlink_metadata =
            fs::symlink_metadata(&path).map_err(|_| "无法读取工作区项目属性".to_string())?;
        if symlink_metadata.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if workspace.exclusions.contains(&name) {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|_| "无法读取工作区项目属性".to_string())?;
        if !metadata.is_dir() && (!metadata.is_file() || !is_supported_document(&path)) {
            continue;
        }
        let relative = path
            .strip_prefix(&workspace.root)
            .map_err(|_| "工作区路径计算失败".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let has_children = metadata.is_dir()
            && fs::read_dir(&path).ok().is_some_and(|mut children| {
                children.any(|child| {
                    child.ok().is_some_and(|item| {
                        let child_path = item.path();
                        let child_name = item.file_name().to_string_lossy().into_owned();
                        !workspace.exclusions.contains(&child_name)
                            && fs::symlink_metadata(&child_path).ok().is_some_and(|meta| {
                                !meta.file_type().is_symlink()
                                    && (meta.is_dir()
                                        || (meta.is_file() && is_supported_document(&child_path)))
                            })
                    })
                })
            });
        nodes.push(WorkspaceTreeNode {
            workspace_id: workspace.id.clone(),
            relative_path: relative,
            name,
            kind: if metadata.is_dir() {
                "directory"
            } else {
                "file"
            },
            has_children,
            size: metadata.is_file().then_some(metadata.len()),
            modified_at: metadata.modified().ok().and_then(system_time_millis),
        });
    }
    nodes.sort_by(|left, right| {
        (left.kind != "directory", left.name.to_lowercase())
            .cmp(&(right.kind != "directory", right.name.to_lowercase()))
    });
    Ok(nodes)
}

#[tauri::command]
pub fn prepare_workspace_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopWorkspaceState>,
    workspace_id: String,
    relative_path: String,
) -> Result<DesktopOpenRequest, String> {
    let workspace = state
        .workspaces
        .lock()
        .map_err(|_| "工作区注册表不可用".to_string())?
        .get(&workspace_id)
        .cloned()
        .ok_or_else(|| "工作区未注册或当前离线".to_string())?;
    let path = resolve_workspace_path(&workspace, &relative_path)?;
    let (canonical, request) = validate_open_path(path, "workspace")?;
    allow_request(&app, &canonical)?;
    Ok(request)
}

#[tauri::command]
pub fn watch_document(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopWorkspaceState>,
    document_id: String,
    document_path: String,
    resource_paths: Vec<String>,
) -> Result<(), String> {
    let target =
        fs::canonicalize(&document_path).map_err(|_| "待监听文件不存在或无法访问".to_string())?;
    let mut targets = HashSet::from([target.clone()]);
    for path in resource_paths {
        if let Ok(canonical) = fs::canonicalize(path) {
            targets.insert(canonical);
        }
    }
    let watch_directories: HashSet<PathBuf> = targets
        .iter()
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect();
    let event_id = document_id.clone();
    let callback_targets = targets.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else {
                return;
            };
            let relevant = event.paths.iter().any(|path| {
                callback_targets.contains(path)
                    || fs::canonicalize(path)
                        .ok()
                        .is_some_and(|candidate| callback_targets.contains(&candidate))
            });
            if !relevant {
                return;
            }
            let kind = match event.kind {
                EventKind::Remove(_) => "removed",
                EventKind::Modify(_) => "modified",
                EventKind::Create(_) => "created",
                _ => "changed",
            };
            let _ = app.emit(
                "desktop-file-changed",
                DesktopFileChange {
                    document_id: event_id.clone(),
                    kind,
                },
            );
        },
        Config::default(),
    )
    .map_err(|error| format!("无法创建文件监听器：{error}"))?;
    for directory in watch_directories {
        watcher
            .watch(&directory, RecursiveMode::NonRecursive)
            .map_err(|error| format!("无法监听文件目录：{error}"))?;
    }
    state
        .watches
        .lock()
        .map_err(|_| "文件监听注册表不可用".to_string())?
        .insert(document_id, DocumentWatch { _watcher: watcher });
    Ok(())
}

#[tauri::command]
pub fn unwatch_document(
    state: tauri::State<'_, DesktopWorkspaceState>,
    document_id: String,
) -> Result<(), String> {
    state
        .watches
        .lock()
        .map_err(|_| "文件监听注册表不可用".to_string())?
        .remove(&document_id);
    Ok(())
}

fn index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(directory.join("workspace-index.sqlite3"))
}

fn open_index(path: &Path) -> Result<Connection, String> {
    let connection =
        Connection::open(path).map_err(|error| format!("无法打开工作区索引：{error}"))?;
    connection.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS documents (
           id INTEGER PRIMARY KEY,
           workspace_id TEXT NOT NULL,
           relative_path TEXT NOT NULL,
           file_name TEXT NOT NULL,
           title TEXT NOT NULL,
           text_content TEXT NOT NULL,
           modified_at INTEGER NOT NULL,
           size INTEGER NOT NULL,
           fingerprint TEXT NOT NULL,
           scan_generation INTEGER NOT NULL DEFAULT 0,
           UNIQUE(workspace_id, relative_path)
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
           file_name, title, text_content,
           content='documents', content_rowid='id', tokenize='trigram'
         );
         CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
           INSERT INTO documents_fts(rowid, file_name, title, text_content) VALUES (new.id, new.file_name, new.title, new.text_content);
         END;
         CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
           INSERT INTO documents_fts(documents_fts, rowid, file_name, title, text_content) VALUES ('delete', old.id, old.file_name, old.title, old.text_content);
         END;
         CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
           INSERT INTO documents_fts(documents_fts, rowid, file_name, title, text_content) VALUES ('delete', old.id, old.file_name, old.title, old.text_content);
           INSERT INTO documents_fts(rowid, file_name, title, text_content) VALUES (new.id, new.file_name, new.title, new.text_content);
         END;"
    ).map_err(|error| format!("无法初始化工作区索引：{error}"))?;
    Ok(connection)
}

fn open_index_resilient(path: &Path) -> Result<Connection, String> {
    match open_index(path) {
        Ok(connection) => Ok(connection),
        Err(_) => {
            let _ = fs::remove_file(path);
            for suffix in ["-wal", "-shm"] {
                let _ = fs::remove_file(format!("{}{}", path.to_string_lossy(), suffix));
            }
            open_index(path)
        }
    }
}

fn decode_text(bytes: &[u8]) -> String {
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

fn markdown_plain_text(content: &str) -> (String, String) {
    let mut title = String::new();
    let mut text = String::new();
    let mut in_heading = false;
    for event in Parser::new(content) {
        match event {
            MarkdownEvent::Start(Tag::Heading { .. }) => in_heading = true,
            MarkdownEvent::End(TagEnd::Heading(_)) => {
                in_heading = false;
                text.push('\n');
            }
            MarkdownEvent::Text(value) | MarkdownEvent::Code(value) => {
                if in_heading && title.is_empty() {
                    title.push_str(&value);
                }
                text.push_str(&value);
                text.push(' ');
            }
            MarkdownEvent::SoftBreak | MarkdownEvent::HardBreak => text.push('\n'),
            _ => {}
        }
    }
    (title, text)
}

fn html_plain_text(content: &str) -> (String, String) {
    let lower = content.to_lowercase();
    let title = lower
        .find("<title")
        .and_then(|start| lower[start..].find('>').map(|offset| start + offset + 1))
        .and_then(|start| {
            lower[start..]
                .find("</title>")
                .map(|offset| content[start..start + offset].trim().to_string())
        })
        .unwrap_or_default();
    let mut text = String::with_capacity(content.len());
    let mut in_tag = false;
    for character in content.chars() {
        match character {
            '<' => {
                in_tag = true;
                text.push(' ');
            }
            '>' => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(character),
            _ => {}
        }
    }
    (title, text)
}

fn file_fingerprint(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn scan_workspace(
    app: tauri::AppHandle,
    workspace: RegisteredWorkspace,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let path = index_path(&app)?;
    let mut connection = open_index_resilient(&path)?;
    let generation = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间无效".to_string())?
        .as_millis() as i64;
    let mut scanned = 0usize;
    let mut indexed = 0usize;
    let walker = WalkDir::new(&workspace.root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_excluded(entry, &workspace));
    for entry in walker {
        if cancel.load(Ordering::Relaxed) {
            let _ = app.emit(
                "workspace-index-progress",
                WorkspaceIndexProgress {
                    workspace_id: workspace.id.clone(),
                    phase: "cancelled",
                    scanned,
                    indexed,
                    total: None,
                    error: None,
                },
            );
            return Ok(());
        }
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() || !is_supported_document(entry.path()) {
            continue;
        }
        scanned += 1;
        let metadata = match entry.metadata() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(system_time_millis)
            .unwrap_or(0) as i64;
        let size = metadata.len() as i64;
        let relative_path = match entry.path().strip_prefix(&workspace.root) {
            Ok(value) => value.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let unchanged = connection.query_row(
            "SELECT 1 FROM documents WHERE workspace_id=?1 AND relative_path=?2 AND modified_at=?3 AND size=?4",
            params![workspace.id, relative_path, modified_at, size], |_| Ok(())
        ).is_ok();
        if unchanged {
            connection.execute("UPDATE documents SET scan_generation=?1 WHERE workspace_id=?2 AND relative_path=?3", params![generation, workspace.id, relative_path])
                .map_err(|error| format!("无法更新索引扫描状态：{error}"))?;
            continue;
        }
        let bytes = match fs::read(entry.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let content = decode_text(&bytes);
        let extension = entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let (mut title, text_content) = if ["html", "htm", "xhtml"].contains(&extension.as_str()) {
            html_plain_text(&content)
        } else {
            markdown_plain_text(&content)
        };
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if title.trim().is_empty() {
            title = file_name.clone();
        }
        connection.execute(
            "INSERT INTO documents(workspace_id, relative_path, file_name, title, text_content, modified_at, size, fingerprint, scan_generation)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(workspace_id, relative_path) DO UPDATE SET file_name=excluded.file_name,title=excluded.title,text_content=excluded.text_content,modified_at=excluded.modified_at,size=excluded.size,fingerprint=excluded.fingerprint,scan_generation=excluded.scan_generation",
            params![workspace.id, relative_path, file_name, title, text_content, modified_at, size, file_fingerprint(&bytes), generation]
        ).map_err(|error| format!("无法写入工作区索引：{error}"))?;
        indexed += 1;
        if scanned % 50 == 0 {
            let _ = app.emit(
                "workspace-index-progress",
                WorkspaceIndexProgress {
                    workspace_id: workspace.id.clone(),
                    phase: "indexing",
                    scanned,
                    indexed,
                    total: None,
                    error: None,
                },
            );
        }
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始索引清理事务：{error}"))?;
    transaction
        .execute(
            "DELETE FROM documents WHERE workspace_id=?1 AND scan_generation<>?2",
            params![workspace.id, generation],
        )
        .map_err(|error| format!("无法清理过期索引：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交索引清理事务：{error}"))?;
    let _ = app.emit(
        "workspace-index-progress",
        WorkspaceIndexProgress {
            workspace_id: workspace.id,
            phase: "complete",
            scanned,
            indexed,
            total: Some(scanned),
            error: None,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn start_workspace_index(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopWorkspaceState>,
    workspace_id: String,
) -> Result<(), String> {
    let workspace = state
        .workspaces
        .lock()
        .map_err(|_| "工作区注册表不可用".to_string())?
        .get(&workspace_id)
        .cloned()
        .ok_or_else(|| "工作区未注册或当前离线".to_string())?;
    let cancel = Arc::new(AtomicBool::new(false));
    let mut cancellations = state
        .index_cancellations
        .lock()
        .map_err(|_| "索引任务注册表不可用".to_string())?;
    if let Some(previous) = cancellations.insert(workspace_id.clone(), cancel.clone()) {
        previous.store(true, Ordering::Relaxed);
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = scan_workspace(app.clone(), workspace.clone(), cancel) {
            let _ = app.emit(
                "workspace-index-progress",
                WorkspaceIndexProgress {
                    workspace_id: workspace.id,
                    phase: "failed",
                    scanned: 0,
                    indexed: 0,
                    total: None,
                    error: Some(error),
                },
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_workspace_index(
    state: tauri::State<'_, DesktopWorkspaceState>,
    workspace_id: String,
) -> Result<(), String> {
    if let Some(cancel) = state
        .index_cancellations
        .lock()
        .map_err(|_| "索引任务注册表不可用".to_string())?
        .remove(&workspace_id)
    {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn locate_query(text: &str, query: &str) -> (usize, usize) {
    let lower = text.to_lowercase();
    let Some(offset) = lower.find(&query.to_lowercase()) else {
        return (1, 1);
    };
    let prefix = &text[..offset];
    let line = prefix.chars().filter(|value| *value == '\n').count() + 1;
    let column = prefix
        .rsplit('\n')
        .next()
        .map(|value| value.chars().count() + 1)
        .unwrap_or(1);
    (line, column)
}

#[tauri::command]
pub async fn search_workspace(
    app: tauri::AppHandle,
    query: String,
    workspace_ids: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<WorkspaceSearchHit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() || workspace_ids.is_empty() {
        return Ok(Vec::new());
    }
    let path = index_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_index_resilient(&path)?;
        let limit = limit.unwrap_or(50).clamp(1, 200);
        let placeholders = (0..workspace_ids.len()).map(|index| format!("?{}", index + 2)).collect::<Vec<_>>().join(",");
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(workspace_ids.len() + 2);
        values.push(Box::new(format!("\"{}\"", query.replace('"', "\"\""))));
        values.extend(workspace_ids.iter().cloned().map(|value| Box::new(value) as Box<dyn rusqlite::ToSql>));
        values.push(Box::new(limit as i64));
        let sql = if query.chars().count() >= 3 {
            format!("SELECT d.workspace_id,d.relative_path,d.file_name,d.title,d.text_content,snippet(documents_fts,2,'','','…',24),bm25(documents_fts) FROM documents_fts JOIN documents d ON d.id=documents_fts.rowid WHERE documents_fts MATCH ?1 AND d.workspace_id IN ({placeholders}) ORDER BY bm25(documents_fts) LIMIT ?{}", workspace_ids.len() + 2)
        } else {
            values[0] = Box::new(format!("%{}%", query));
            format!("SELECT workspace_id,relative_path,file_name,title,text_content,substr(text_content,1,240),0.0 FROM documents WHERE (file_name LIKE ?1 OR title LIKE ?1 OR text_content LIKE ?1) AND workspace_id IN ({placeholders}) LIMIT ?{}", workspace_ids.len() + 2)
        };
        let references = values.iter().map(|value| value.as_ref()).collect::<Vec<_>>();
        let mut statement = connection.prepare(&sql).map_err(|error| format!("无法准备工作区搜索：{error}"))?;
        let rows = statement.query_map(references.as_slice(), |row| {
            let text: String = row.get(4)?;
            let (line, column) = locate_query(&text, &query);
            Ok(WorkspaceSearchHit {
                workspace_id: row.get(0)?, relative_path: row.get(1)?, file_name: row.get(2)?, title: row.get(3)?,
                snippet: row.get(5)?, line, column, score: row.get(6)?,
            })
        }).map_err(|error| format!("工作区搜索失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("无法读取工作区搜索结果：{error}"))
    }).await.map_err(|error| format!("工作区搜索任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lightpage-workspace-{name}-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn rejects_parent_components_and_paths_outside_workspace() {
        assert!(relative_components("../secret.md").is_err());
        assert!(relative_components("docs/../../secret.md").is_err());
        assert_eq!(
            relative_components("docs/guide.md").unwrap(),
            PathBuf::from("docs/guide.md")
        );
    }

    #[test]
    fn indexes_markdown_and_supports_short_queries() {
        let root = temp_root("index");
        let index = root.join("index.sqlite3");
        let connection = open_index(&index).unwrap();
        connection.execute(
            "INSERT INTO documents(workspace_id,relative_path,file_name,title,text_content,modified_at,size,fingerprint,scan_generation) VALUES('w','guide.md','guide.md','中文指南','这是本地工作区正文',1,10,'x',1)", []
        ).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM documents WHERE text_content LIKE '%本地%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extracts_markdown_title_and_plain_text() {
        let (title, text) = markdown_plain_text("# 标题\n\n正文 **内容**");
        assert_eq!(title, "标题");
        assert!(text.contains("正文"));
        assert!(text.contains("内容"));
    }

    #[test]
    fn rebuilds_a_corrupt_generated_index() {
        let root = temp_root("corrupt");
        let index = root.join("index.sqlite3");
        fs::write(&index, b"not a sqlite database").unwrap();
        let connection = open_index_resilient(&index).unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM documents", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }
}
