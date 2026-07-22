// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use zip::ZipArchive;

// ── Shared JSON shapes ────────────────────────────────────────────────────

#[derive(Serialize)]
struct LibraryFile {
    name: String,
    uri: String,
    size: u64,
    #[serde(rename = "shelfName")]
    shelf_name: String,
}

#[derive(Serialize)]
struct ComicMetadata {
    name: String,
    size: u64,
    format: String, // "cbz" | "pdf"
    pages: Vec<String>,
    #[serde(rename = "totalPages")]
    total_pages: usize,
    #[serde(rename = "coverBase64")]
    cover_base64: Option<String>,
    error: Option<String>,
}

impl ComicMetadata {
    fn error(name: String, size: u64, format: &str, msg: impl Into<String>) -> Self {
        Self {
            name,
            size,
            format: format.to_string(),
            pages: Vec::new(),
            total_pages: 0,
            cover_base64: None,
            error: Some(msg.into()),
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS: &[&str] = &[".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"];

/// True for ordinary image entries, excluding OS metadata / hidden files.
fn is_image_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower.starts_with('.')
        || lower.contains("__macosx")
        || lower.contains("thumbs.db")
        || lower.ends_with('/')
    {
        return false;
    }
    IMAGE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Natural-order comparator so "page2.jpg" sorts before "page10.jpg".
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.localecmp(b)
}

// localecmp shim: split into numeric / non-numeric chunks and compare.
trait NaturalCmp {
    fn localecmp(&self, other: &str) -> std::cmp::Ordering;
}
impl NaturalCmp for str {
    fn localecmp(&self, other: &str) -> std::cmp::Ordering {
        let mut ai = self.chars().peekable();
        let mut bi = other.chars().peekable();
        loop {
            match (ai.peek(), bi.peek()) {
                (None, None) => return std::cmp::Ordering::Equal,
                (None, _) => return std::cmp::Ordering::Less,
                (_, None) => return std::cmp::Ordering::Greater,
                (Some(&ac), Some(&bc)) => {
                    let ac_d = ac.is_ascii_digit();
                    let bc_d = bc.is_ascii_digit();
                    if ac_d && bc_d {
                        // consume whole number runs
                        let mut a_num = String::new();
                        let mut b_num = String::new();
                        while let Some(&c) = ai.peek() {
                            if c.is_ascii_digit() {
                                a_num.push(c);
                                ai.next();
                            } else {
                                break;
                            }
                        }
                        while let Some(&c) = bi.peek() {
                            if c.is_ascii_digit() {
                                b_num.push(c);
                                bi.next();
                            } else {
                                break;
                            }
                        }
                        let av: u64 = a_num.parse().unwrap_or(0);
                        let bv: u64 = b_num.parse().unwrap_or(0);
                        match av.cmp(&bv) {
                            std::cmp::Ordering::Equal => continue,
                            ord => return ord,
                        }
                    } else {
                        match ac.to_ascii_lowercase().cmp(&bc.to_ascii_lowercase()) {
                            std::cmp::Ordering::Equal => {
                                ai.next();
                                bi.next();
                                continue;
                            }
                            ord => return ord,
                        }
                    }
                }
            }
        }
    }
}

fn file_extension(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((_, ext)) => ext,
        None => "",
    }
}

/// Map a file name extension to a MIME type for the cover.
fn mime_for(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "image/jpeg",
    }
}

/// Collect supported comic files inside `dir` (1 level of subfolders → shelves).
fn collect_comic_files(dir: &Path, out: &mut Vec<LibraryFile>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(meta) = file_metadata(&path) {
                out.push(LibraryFile {
                    name: meta.name,
                    uri: path.to_string_lossy().to_string(),
                    size: meta.size,
                    shelf_name: String::new(),
                });
            }
        } else if path.is_dir() {
            let dir_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if let Ok(sub_entries) = fs::read_dir(&path) {
                for sub_entry in sub_entries.flatten() {
                    let sub_path = sub_entry.path();
                    if sub_path.is_file() {
                        if let Some(meta) = file_metadata(&sub_path) {
                            out.push(LibraryFile {
                                name: meta.name,
                                uri: sub_path.to_string_lossy().to_string(),
                                size: meta.size,
                                shelf_name: dir_name.clone(),
                            });
                        }
                    }
                }
            }
        }
    }
}

struct FileMeta {
    name: String,
    size: u64,
}

/// Return Some(meta) if the path is a supported comic file (.cbz/.pdf).
/// Plain .zip is intentionally excluded: a generic zip is rarely a comic and
/// only clutters the library. CBZ *is* a zip and is still recognized.
fn file_metadata(path: &Path) -> Option<FileMeta> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let lower = name.to_lowercase();
    if !(lower.ends_with(".cbz") || lower.ends_with(".pdf")) {
        return None;
    }
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Some(FileMeta { name, size })
}

/// Parse a CBZ/CBZ-like zip: returns (sorted page names, cover bytes).
fn parse_cbz(path: &Path) -> Result<(Vec<String>, Option<Vec<u8>>), String> {
    let file = fs::File::open(path).map_err(|e| format!("Не удалось открыть файл: {e}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Не удалось прочитать архив: {e}"))?;

    let mut image_names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Ошибка чтения записи: {e}"))?;
        if entry.is_file() {
            let name = entry.name().to_string();
            if is_image_file(&name) {
                image_names.push(name);
            }
        }
    }

    if image_names.is_empty() {
        // Not a comic: zip has no images. Return an error so the web layer
        // can mark this file once and skip it, instead of retrying forever.
        return Err("В архиве нет изображений — это не комикс.".to_string());
    }
    image_names.sort_by(|a, b| natural_cmp(a, b));

    // Read the cover (first image after sorting).
    let cover_name = image_names[0].clone();
    let mut cover_bytes: Option<Vec<u8>> = None;
    if let Ok(mut entry) = archive.by_name(&cover_name) {
        let mut buf = Vec::with_capacity(256 * 1024);
        if entry.read_to_end(&mut buf).is_ok() {
            cover_bytes = Some(buf);
        }
    }

    Ok((image_names, cover_bytes))
}

// ── Tauri commands ────────────────────────────────────────────────────────

#[tauri::command]
fn list_library_files(folder_path: String) -> String {
    let path = Path::new(&folder_path);
    if !path.exists() || !path.is_dir() {
        return "[]".to_string();
    }
    let mut files = Vec::new();
    collect_comic_files(path, &mut files);
    serde_json::to_string(&files).unwrap_or_else(|_| "[]".to_string())
}

#[tauri::command]
fn get_comic_metadata(file_path: String) -> String {
    let path = Path::new(&file_path);
    if !path.exists() {
        return serde_json::to_string(&ComicMetadata::error(
            String::new(),
            0,
            "cbz",
            "File not found",
        ))
        .unwrap_or_else(|_| "{}".to_string());
    }

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let ext = file_extension(&name);
    let is_pdf = ext.eq_ignore_ascii_case("pdf");
    let format = if is_pdf { "pdf" } else { "cbz" };

    if is_pdf {
        // PDF parsing is handled client-side by pdf.js; expose page count = 0
        // so the web layer lazily renders the cover and counts pages.
        return serde_json::to_string(&ComicMetadata {
            name,
            size,
            format: format.to_string(),
            pages: Vec::new(),
            total_pages: 0,
            cover_base64: None,
            error: None,
        })
        .unwrap_or_else(|_| "{}".to_string());
    }

    // CBZ / ZIP: parse on the server for speed and to avoid shipping the
    // whole archive to JS just to read the cover.
    match parse_cbz(path) {
        Ok((pages, cover_bytes)) => {
            let cover_ext = pages.first().map(|p| file_extension(p)).unwrap_or("");
            let cover_base64 = cover_bytes.map(|bytes| {
                let b64 = general_purpose::STANDARD.encode(&bytes);
                format!("data:{};base64,{}", mime_for(cover_ext), b64)
            });
            serde_json::to_string(&ComicMetadata {
                name,
                size,
                format: format.to_string(),
                total_pages: pages.len(),
                pages,
                cover_base64,
                error: None,
            })
            .unwrap_or_else(|_| "{}".to_string())
        }
        Err(e) => serde_json::to_string(&ComicMetadata::error(name, size, format, e))
            .unwrap_or_else(|_| "{}".to_string()),
    }
}

/// Extract a single page image from a CBZ archive by its entry name.
/// Returns the raw bytes as a data-URL so the web layer can use it directly
/// as an `<img src>`. This avoids loading the whole archive into RAM — only
/// the requested entry is decompressed.
#[tauri::command]
fn get_cbz_page(file_path: String, page_name: String) -> Option<String> {
    let path = Path::new(&file_path);
    let file = fs::File::open(path).ok()?;
    let mut archive = ZipArchive::new(file).ok()?;

    let mut entry = archive.by_name(&page_name).ok()?;
    let mut buf = Vec::with_capacity(512 * 1024);
    entry.read_to_end(&mut buf).ok()?;

    let mime = mime_for(file_extension(&page_name));
    let b64 = general_purpose::STANDARD.encode(&buf);
    Some(format!("data:{mime};base64,{b64}"))
}

#[tauri::command]
fn delete_file(file_path: String, mode: Option<String>) -> bool {
    // mode = "trash"    → move to system recycle bin (recoverable)
    // mode = "permanent"/None → remove permanently (not recoverable)
    //
    // Note: move-to-trash is only available on desktop (macOS/Windows/Linux).
    // Android has no system Trash API, so on Android "trash" falls through to
    // permanent removal — there is no safer option available on that platform.
    match mode.as_deref() {
        Some("trash") => move_to_trash(&file_path),
        _ => fs::remove_file(&file_path).is_ok(),
    }
}

/// Move a file to the system recycle bin. On Android this is a no-op that
/// returns false (no trash backend exists), so the caller can fall back.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn move_to_trash(file_path: &str) -> bool {
    trash::delete(file_path).is_ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn move_to_trash(_file_path: &str) -> bool {
    false
}

/// Native yes/no confirmation dialog (replaces window.confirm, which is
/// unreliable in the Tauri webview). Returns true when the user picks "Yes".
#[tauri::command]
async fn confirm_dialog(app: tauri::AppHandle, message: String, title: Option<String>) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    app.dialog()
        .message(message)
        .title(title.unwrap_or_else(|| "Подтверждение".to_string()))
        .buttons(MessageDialogButtons::YesNo)
        .show(move |yes| {
            let _ = tx.send(yes);
        });
    rx.await.unwrap_or(false)
}

/// Native info dialog (replaces window.alert).
#[tauri::command]
async fn message_dialog(app: tauri::AppHandle, message: String, title: Option<String>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    app.dialog()
        .message(message)
        .title(title.unwrap_or_else(|| "Сообщение".to_string()))
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| {
            let _ = tx.send(());
        });
    let _ = rx.await;
}

#[tauri::command]
fn clear_import_cache() {
    // No-op on desktop — caches are managed by the web layer.
}

#[tauri::command]
fn set_volume_keys_enabled(_enabled: bool) {
    // No-op on desktop.
}

#[tauri::command]
fn get_pending_file_uri() -> Option<String> {
    None
}

#[tauri::command]
async fn select_library_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;

    // IMPORTANT: blocking_pick_folder() deadlocks when called from a
    // #[tauri::command] because the command runs on the main thread, which
    // also owns the dialog event loop. We use the async callback variant
    // + a oneshot channel so the command can `.await` the user's choice
    // without blocking the event loop.
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();

    app.dialog().file().pick_folder(move |file_path: Option<tauri_plugin_fs::FilePath>| {
        let result = file_path
            .and_then(|fp| fp.into_path().ok())
            .map(|p| p.to_string_lossy().to_string());
        let _ = tx.send(result);
    });

    // Await the user's selection. If the sender is dropped (dialog cancelled),
    // default to None.
    rx.await.unwrap_or(None)
}

#[tauri::command]
fn import_file(source_path: String, clean_name: String, library_folder: String) -> bool {
    let src = PathBuf::from(&source_path);
    let dst_dir = PathBuf::from(&library_folder);
    if !dst_dir.is_dir() {
        return false;
    }
    // Determine a safe destination name: prefer clean_name, fall back to source.
    let base = if clean_name.is_empty() {
        src.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "imported_file".to_string())
    } else {
        clean_name
    };
    let dst = dst_dir.join(&base);

    // If the file is already inside the library folder, treat as success.
    if let (Ok(src_canon), Ok(dst_canon)) = (src.canonicalize(), dst.canonicalize()) {
        if src_canon == dst_canon {
            return true;
        }
    }

    match fs::copy(&src, &dst) {
        Ok(_) => true,
        Err(e) => {
            log::error!("import_file failed ({src:?} -> {dst:?}): {e}");
            false
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_library_files,
            get_comic_metadata,
            get_cbz_page,
            delete_file,
            clear_import_cache,
            set_volume_keys_enabled,
            get_pending_file_uri,
            select_library_folder,
            import_file,
            confirm_dialog,
            message_dialog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
