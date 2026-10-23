use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Mutex};
use tauri::Manager;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExternalOpenMode {
    #[default]
    CurrentWindow,
    NewWindow,
}

#[derive(Default)]
pub struct OpenPreferences(pub Mutex<ExternalOpenMode>);

pub fn load_mode(path: &Path) -> ExternalOpenMode {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_mode(path: &Path, mode: ExternalOpenMode) -> Result<(), String> {
    let parent = path.parent().ok_or("无法确定配置目录")?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec(&mode).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| format!("无法保存打开方式：{error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("无法保存打开方式：{error}"))
}

#[tauri::command]
pub fn get_external_open_mode(
    state: tauri::State<'_, OpenPreferences>,
) -> Result<ExternalOpenMode, String> {
    state
        .0
        .lock()
        .map(|mode| *mode)
        .map_err(|_| "打开方式配置不可用".to_string())
}

#[tauri::command]
pub fn set_external_open_mode(app: tauri::AppHandle, mode: ExternalOpenMode) -> Result<(), String> {
    let state = app.state::<OpenPreferences>();
    let mut current = state.0.lock().map_err(|_| "打开方式配置不可用")?;
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("external-open-mode.json");
    save_mode(&path, mode)?;
    *current = mode;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_current_window_and_survives_restart_and_changes() {
        let root = std::env::temp_dir().join(format!(
            "lightpage-open-mode-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = root.join("external-open-mode.json");
        assert_eq!(load_mode(&path), ExternalOpenMode::CurrentWindow);
        save_mode(&path, ExternalOpenMode::NewWindow).unwrap();
        assert_eq!(load_mode(&path), ExternalOpenMode::NewWindow);
        save_mode(&path, ExternalOpenMode::CurrentWindow).unwrap();
        assert_eq!(load_mode(&path), ExternalOpenMode::CurrentWindow);
        fs::write(&path, b"invalid").unwrap();
        assert_eq!(load_mode(&path), ExternalOpenMode::CurrentWindow);
        fs::remove_dir_all(root).unwrap();
    }
}
