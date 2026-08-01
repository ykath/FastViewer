use std::{fs, path::Path};

#[cfg(windows)]
use std::{ffi::c_void, os::windows::ffi::OsStrExt};
#[cfg(windows)]
use windows::Win32::UI::Shell::{SHAddToRecentDocs, SHARD_PATHW};
#[cfg(windows)]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

use crate::validate_open_path;

const HTML_PROG_ID: &str = "LightPage.HTML";

#[tauri::command]
pub fn set_html_open_with(enabled: bool) -> Result<bool, String> {
    set_html_open_with_impl(enabled)?;
    Ok(enabled)
}

#[tauri::command]
pub fn get_html_open_with() -> Result<bool, String> {
    get_html_open_with_impl()
}

#[tauri::command]
pub fn add_recent_document(path: String) -> Result<(), String> {
    let (canonical, _) = validate_open_path(path, "workspace")?;
    add_recent_document_impl(&canonical)
}

#[cfg(windows)]
fn set_html_open_with_impl(enabled: bool) -> Result<(), String> {
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let classes = current_user
        .create_subkey("Software\\Classes")
        .map_err(|error| format!("无法打开当前用户文件关联：{error}"))?
        .0;
    if enabled {
        let executable = std::env::current_exe()
            .map_err(|error| format!("无法确定 LightPage 程序路径：{error}"))?;
        let prog_id = classes
            .create_subkey(HTML_PROG_ID)
            .map_err(|error| format!("无法注册 HTML 打开方式：{error}"))?
            .0;
        prog_id
            .set_value("", &"LightPage HTML Document")
            .map_err(|error| format!("无法写入 HTML 打开方式：{error}"))?;
        let icon = prog_id
            .create_subkey("DefaultIcon")
            .map_err(|error| format!("无法注册 HTML 图标：{error}"))?
            .0;
        icon.set_value("", &format!("\"{}\",0", executable.display()))
            .map_err(|error| format!("无法写入 HTML 图标：{error}"))?;
        let command = prog_id
            .create_subkey("shell\\open\\command")
            .map_err(|error| format!("无法注册 HTML 打开命令：{error}"))?
            .0;
        command
            .set_value("", &format!("\"{}\" \"%1\"", executable.display()))
            .map_err(|error| format!("无法写入 HTML 打开命令：{error}"))?;
        for extension in [".html", ".htm", ".xhtml"] {
            let open_with = classes
                .create_subkey(format!("{extension}\\OpenWithProgids"))
                .map_err(|error| format!("无法注册 {extension} 打开方式：{error}"))?
                .0;
            open_with
                .set_raw_value(
                    HTML_PROG_ID,
                    &winreg::RegValue {
                        vtype: winreg::enums::RegType::REG_NONE,
                        bytes: Vec::new(),
                    },
                )
                .map_err(|error| format!("无法写入 {extension} 打开方式：{error}"))?;
        }
    } else {
        for extension in [".html", ".htm", ".xhtml"] {
            if let Ok(open_with) = classes.open_subkey_with_flags(
                format!("{extension}\\OpenWithProgids"),
                winreg::enums::KEY_WRITE,
            ) {
                let _ = open_with.delete_value(HTML_PROG_ID);
            }
        }
        let _ = classes.delete_subkey_all(HTML_PROG_ID);
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_html_open_with_impl(_enabled: bool) -> Result<(), String> {
    Err("HTML 打开方式仅在 Windows 上可用".to_string())
}

#[cfg(windows)]
fn get_html_open_with_impl() -> Result<bool, String> {
    let classes = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Classes")
        .map_err(|error| format!("无法读取当前用户文件关联：{error}"))?;
    Ok(classes.open_subkey(HTML_PROG_ID).is_ok())
}

#[cfg(not(windows))]
fn get_html_open_with_impl() -> Result<bool, String> {
    Ok(false)
}

#[cfg(windows)]
fn add_recent_document_impl(path: &Path) -> Result<(), String> {
    if !fs::metadata(path).is_ok_and(|metadata| metadata.is_file()) {
        return Err("最近文档不存在或无法访问".to_string());
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        SHAddToRecentDocs(SHARD_PATHW.0 as u32, Some(wide.as_ptr() as *const c_void));
    }
    Ok(())
}

#[cfg(not(windows))]
fn add_recent_document_impl(_path: &Path) -> Result<(), String> {
    Ok(())
}
