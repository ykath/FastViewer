use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use zip::ZipArchive;
#[cfg(test)]
use std::io;
#[cfg(test)]
use std::path::PathBuf;
#[cfg(test)]
use zip::ZipWriter;
use tauri::Manager;

pub const MAX_ARCHIVE_ENTRIES: usize = 1000;
pub const MAX_ARCHIVE_DEPTH: usize = 20;
pub const MAX_ARCHIVE_ENTRY_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_ARCHIVE_TOTAL_BYTES: u64 = 200 * 1024 * 1024;
pub const MAX_ARCHIVE_RATIO: u64 = 100;
const COMPLETE_MARKER: &str = ".complete";
const VIEWABLE_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "html", "htm", "xhtml"];

#[derive(Clone, Debug)]
pub struct ArchiveLimits {
    pub max_entries: usize,
    pub max_depth: usize,
    pub max_entry_bytes: u64,
    pub max_total_bytes: u64,
    pub max_ratio: u64,
}

impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_ARCHIVE_ENTRIES,
            max_depth: MAX_ARCHIVE_DEPTH,
            max_entry_bytes: MAX_ARCHIVE_ENTRY_BYTES,
            max_total_bytes: MAX_ARCHIVE_TOTAL_BYTES,
            max_ratio: MAX_ARCHIVE_RATIO,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedZipDocument {
    pub relative_path: String,
    pub file_name: String,
    pub size: u64,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedZip {
    pub storage_id: String,
    pub file_name: String,
    pub size: u64,
    pub documents: Vec<ImportedZipDocument>,
}

pub struct ArchiveImportState {
    pub cancel: AtomicBool,
}

impl Default for ArchiveImportState {
    fn default() -> Self {
        Self { cancel: AtomicBool::new(false) }
    }
}

#[tauri::command]
pub fn import_zip_archive(
    app: tauri::AppHandle,
    state: tauri::State<'_, ArchiveImportState>,
    path: String,
) -> Result<ImportedZip, String> {
    state.cancel.store(false, Ordering::Relaxed);
    let cache = app.path().app_cache_dir().map_err(|error| error.to_string())?;
    let archives = cache.join("archives");
    fs::create_dir_all(&archives).map_err(|_| "无法创建压缩包缓存目录".to_string())?;
    import_zip_into(Path::new(&path), &archives, &ArchiveLimits::default(), &state.cancel)
}

#[tauri::command]
pub fn cancel_zip_import(state: tauri::State<'_, ArchiveImportState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn remove_zip_archive(app: tauri::AppHandle, storage_id: String) -> Result<(), String> {
    let cache = app.path().app_cache_dir().map_err(|error| error.to_string())?;
    remove_archive_dir(&cache.join("archives"), &storage_id)
}

pub fn import_zip_into(
    zip_path: &Path,
    archives_root: &Path,
    limits: &ArchiveLimits,
    cancel: &AtomicBool,
) -> Result<ImportedZip, String> {
    let file_name = zip_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "文件名无法识别".to_string())?
        .to_string();
    if extension_of(&file_name).as_deref() == Some("rar") {
        return Err("请转换为 ZIP".to_string());
    }
    if extension_of(&file_name).as_deref() != Some("zip") {
        return Err("当前仅支持 ZIP 文档包".to_string());
    }
    let storage_id = sha256_file(zip_path)?;
    let destination = archives_root.join(&storage_id);
    if !destination.starts_with(archives_root) {
        return Err("压缩包目录越界".to_string());
    }
    let marker = destination.join(COMPLETE_MARKER);
    if !marker.is_file() {
        if destination.exists() {
            fs::remove_dir_all(&destination).map_err(|_| "无法清理未完成的解压目录".to_string())?;
        }
        fs::create_dir_all(&destination).map_err(|_| "无法创建压缩包缓存目录".to_string())?;
        if let Err(error) = extract_zip(zip_path, &destination, limits, cancel) {
            let _ = fs::remove_dir_all(&destination);
            return Err(error);
        }
        File::create(&marker).map_err(|_| "无法完成压缩包导入".to_string())?;
    }
    let mut documents = collect_viewable(&destination)?;
    if documents.is_empty() {
        let _ = fs::remove_dir_all(&destination);
        return Err("压缩包中没有可读取的 Markdown 或 HTML 文件。".to_string());
    }
    documents.sort_by(|left, right| document_rank(&left.relative_path).cmp(&document_rank(&right.relative_path))
        .then_with(|| left.relative_path.cmp(&right.relative_path)));
    let size = fs::metadata(zip_path).map(|item| item.len()).unwrap_or(0);
    Ok(ImportedZip { storage_id, file_name, size, documents })
}

pub fn remove_archive_dir(archives_root: &Path, storage_id: &str) -> Result<(), String> {
    if storage_id.len() != 64 || !storage_id.chars().all(|item| item.is_ascii_hexdigit()) {
        return Err("压缩包存储标识无效".to_string());
    }
    let destination = archives_root.join(storage_id);
    if !destination.starts_with(archives_root) {
        return Err("压缩包目录越界".to_string());
    }
    if destination.exists() {
        fs::remove_dir_all(destination).map_err(|_| "无法删除压缩包缓存".to_string())?;
    }
    Ok(())
}

fn extract_zip(zip_path: &Path, destination: &Path, limits: &ArchiveLimits, cancel: &AtomicBool) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|_| "压缩包无法打开".to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|_| "压缩包内容处理失败，请确认文件未损坏。".to_string())?;
    if archive.len() > limits.max_entries {
        return Err("压缩包条目数量超过安全上限".to_string());
    }
    let mut total = 0u64;
    for index in 0..archive.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消导入".to_string());
        }
        let mut entry = archive.by_index(index).map_err(|_| "压缩包条目无法读取".to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.enclosed_name().ok_or_else(|| "压缩包路径不安全".to_string())?;
        let depth = name.components().count();
        if depth > limits.max_depth {
            return Err("压缩包目录层级超过安全上限".to_string());
        }
        let declared = entry.size();
        let compressed = entry.compressed_size();
        if declared > limits.max_entry_bytes {
            return Err("压缩包单文件超过安全上限".to_string());
        }
        if declared > 0 && compressed > 0 && declared / compressed.max(1) > limits.max_ratio {
            return Err("压缩比超过安全上限".to_string());
        }
        if total.saturating_add(declared) > limits.max_total_bytes {
            return Err("压缩包展开总量超过安全上限".to_string());
        }
        let target = destination.join(&name);
        if !target.starts_with(destination) {
            return Err("压缩包路径不安全".to_string());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| "无法创建压缩包目录".to_string())?;
        }
        let mut output = File::create(&target).map_err(|_| "无法写入解压文件".to_string())?;
        let written = copy_limited(&mut entry, &mut output, limits.max_entry_bytes, cancel)?;
        if compressed > 0 && written / compressed.max(1) > limits.max_ratio {
            return Err("压缩比超过安全上限".to_string());
        }
        total = total.saturating_add(written);
        if total > limits.max_total_bytes {
            return Err("压缩包展开总量超过安全上限".to_string());
        }
    }
    Ok(())
}

fn copy_limited(input: &mut impl Read, output: &mut impl Write, max_bytes: u64, cancel: &AtomicBool) -> Result<u64, String> {
    let mut buffer = [0u8; 8192];
    let mut written = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消导入".to_string());
        }
        let read = input.read(&mut buffer).map_err(|_| "压缩包条目无法读取".to_string())?;
        if read == 0 {
            return Ok(written);
        }
        written = written.saturating_add(read as u64);
        if written > max_bytes {
            return Err("压缩包单文件超过安全上限".to_string());
        }
        output.write_all(&buffer[..read]).map_err(|_| "无法写入解压文件".to_string())?;
    }
}

fn collect_viewable(root: &Path) -> Result<Vec<ImportedZipDocument>, String> {
    let mut documents = Vec::new();
    walk_viewable(root, root, &mut documents)?;
    Ok(documents)
}

fn walk_viewable(root: &Path, current: &Path, documents: &mut Vec<ImportedZipDocument>) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|_| "无法读取解压目录".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "无法读取解压目录".to_string())?;
        let path = entry.path();
        if path.file_name().and_then(|value| value.to_str()) == Some(COMPLETE_MARKER) {
            continue;
        }
        if path.is_dir() {
            walk_viewable(root, &path, documents)?;
            continue;
        }
        let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
        if !VIEWABLE_EXTENSIONS.contains(&extension_of(name).as_deref().unwrap_or("")) {
            continue;
        }
        let relative = path.strip_prefix(root).map_err(|_| "压缩包路径不安全".to_string())?;
        let size = fs::metadata(&path).map(|item| item.len()).unwrap_or(0);
        documents.push(ImportedZipDocument {
            relative_path: relative.to_string_lossy().replace('\\', "/"),
            file_name: name.to_string(),
            size,
            path: path.to_string_lossy().into_owned(),
        });
    }
    Ok(())
}

fn document_rank(path: &str) -> u8 {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    if name == "readme.md" { 0 } else if name.starts_with("index.") { 1 } else { 2 }
}

fn extension_of(file_name: &str) -> Option<String> {
    Path::new(file_name).extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "压缩包无法打开".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| "压缩包无法读取".to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
pub fn write_test_zip(path: &Path, files: &[(&str, &[u8])]) -> io::Result<()> {
    let file = File::create(path)?;
    let mut writer = ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in files {
        writer.start_file(*name, options)?;
        writer.write_all(bytes)?;
    }
    writer.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("lightpage-zip-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn extracts_viewable_files_and_reuses_completed_cache() {
        let root = temp_root();
        let zip_path = root.join("docs.zip");
        write_test_zip(&zip_path, &[("notes/chapter.md", b"# chapter"), ("readme.md", b"# readme"), ("pic.png", b"png")]).unwrap();
        let archives = root.join("archives");
        fs::create_dir_all(&archives).unwrap();
        let cancel = AtomicBool::new(false);
        let imported = import_zip_into(&zip_path, &archives, &ArchiveLimits::default(), &cancel).unwrap();
        assert_eq!(imported.documents[0].relative_path, "readme.md");
        assert!(imported.documents.iter().any(|item| item.relative_path == "notes/chapter.md"));
        assert!(!imported.documents.iter().any(|item| item.relative_path.ends_with(".png")));
        let again = import_zip_into(&zip_path, &archives, &ArchiveLimits::default(), &cancel).unwrap();
        assert_eq!(imported.storage_id, again.storage_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_path_traversal_and_oversized_entries() {
        let root = temp_root();
        let zip_path = root.join("bad.zip");
        write_test_zip(&zip_path, &[("../outside.md", b"# no")]).unwrap();
        let archives = root.join("archives");
        fs::create_dir_all(&archives).unwrap();
        let error = import_zip_into(&zip_path, &archives, &ArchiveLimits::default(), &AtomicBool::new(false)).unwrap_err();
        assert!(error.contains("路径") || error.contains("没有可读取"));

        let large = root.join("large.zip");
        write_test_zip(&large, &[("big.md", b"0123456789abcdef")]).unwrap();
        let limits = ArchiveLimits { max_entry_bytes: 8, ..ArchiveLimits::default() };
        let error = import_zip_into(&large, &archives, &limits, &AtomicBool::new(false)).unwrap_err();
        assert!(error.contains("单文件"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rar_and_cancel_stop_before_a_usable_cache() {
        let root = temp_root();
        let rar = root.join("notes.rar");
        fs::write(&rar, b"not a zip").unwrap();
        let archives = root.join("archives");
        fs::create_dir_all(&archives).unwrap();
        assert_eq!(import_zip_into(&rar, &archives, &ArchiveLimits::default(), &AtomicBool::new(false)).unwrap_err(), "请转换为 ZIP");
        let zip_path = root.join("docs.zip");
        write_test_zip(&zip_path, &[("readme.md", b"# readme")]).unwrap();
        let error = import_zip_into(&zip_path, &archives, &ArchiveLimits::default(), &AtomicBool::new(true)).unwrap_err();
        assert_eq!(error, "已取消导入");
        fs::remove_dir_all(root).unwrap();
    }
}
