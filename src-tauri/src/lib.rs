use std::{fs, path::PathBuf, time::UNIX_EPOCH};
use tauri::{AppHandle, Manager};

// The phone's storage is a real folder on this PC: Documents/FakePhone.
// Every command takes a path relative to that folder ("Notes/todo.txt") and
// refuses anything that could climb out of it.

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("FakePhone");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn resolve(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    let mut p = root(app)?;
    for part in rel.split('/').filter(|s| !s.is_empty()) {
        if part == "."
            || part == ".."
            || part.contains(|c: char| matches!(c, '\\' | ':' | '\0' | '*' | '?' | '"' | '<' | '>' | '|'))
        {
            return Err("Invalid path".into());
        }
        p.push(part);
    }
    Ok(p)
}

fn pct_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or("Bad path encoding")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// Returns (name, is_dir, size_bytes, modified_ms), folders first.
#[tauri::command]
fn fs_list(app: AppHandle, rel: String) -> Result<Vec<(String, bool, u64, u64)>, String> {
    let p = resolve(&app, &rel)?;
    let mut v = Vec::new();
    for e in fs::read_dir(&p).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let m = e.metadata().map_err(|e| e.to_string())?;
        let ts = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        v.push((e.file_name().to_string_lossy().into_owned(), m.is_dir(), m.len(), ts));
    }
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    Ok(v)
}

#[tauri::command]
fn fs_mkdir(app: AppHandle, rel: String) -> Result<(), String> {
    let p = resolve(&app, &rel)?;
    if p.exists() {
        return Err("That name is already taken".into());
    }
    fs::create_dir_all(p).map_err(|e| e.to_string())
}

/// Raw-bytes upload: body = file contents, header `x-path` = percent-encoded relative path.
#[tauri::command]
fn fs_write(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("No data".into());
    };
    let enc = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing path")?;
    let p = resolve(&app, &pct_decode(enc)?)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(p, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_read(app: AppHandle, rel: String) -> Result<tauri::ipc::Response, String> {
    let p = resolve(&app, &rel)?;
    let len = fs::metadata(&p).map_err(|e| e.to_string())?.len();
    if len > 50 * 1024 * 1024 {
        return Err("File is too large to open (50 MB max)".into());
    }
    Ok(tauri::ipc::Response::new(fs::read(p).map_err(|e| e.to_string())?))
}

#[tauri::command]
fn fs_rename(app: AppHandle, from: String, to: String) -> Result<(), String> {
    let a = resolve(&app, &from)?;
    let b = resolve(&app, &to)?;
    if a == root(&app)? {
        return Err("Can't rename the phone's storage".into());
    }
    if b.exists() {
        return Err("That name is already taken".into());
    }
    fs::rename(a, b).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_delete(app: AppHandle, rel: String) -> Result<(), String> {
    let p = resolve(&app, &rel)?;
    if p == root(&app)? {
        return Err("Can't delete the phone's storage".into());
    }
    let res = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
    res.map_err(|e| e.to_string())
}

/// Absolute path on the PC, for "Show on PC".
#[tauri::command]
fn fs_abs(app: AppHandle, rel: String) -> Result<String, String> {
    Ok(resolve(&app, &rel)?.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fs_list, fs_mkdir, fs_write, fs_read, fs_rename, fs_delete, fs_abs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
