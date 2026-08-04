// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Read;
use std::path::Path;
#[cfg(not(target_os = "android"))]
use std::path::PathBuf;

#[cfg_attr(target_os = "android", allow(unused_imports))]
use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use zip::ZipArchive;
// ── Mobile (Android) bridge plugin ────────────────────────────────────────
// On Android, file operations go through the Storage Access Framework via a
// Kotlin plugin (`ComiFlowBridge`). On desktop we keep the fs-based impls.
// The bridge handle is stored in Tauri's managed state and looked up by the
// cfg-gated commands below.

#[cfg(target_os = "android")]
use serde::Deserialize;

#[cfg(target_os = "android")]
mod comiflow_mobile {
    use serde::de::DeserializeOwned;
    use tauri::{
        plugin::{PluginApi, PluginHandle},
        AppHandle, Runtime,
    };

    const PLUGIN_IDENTIFIER: &str = "com.kylaega.comiflow";

    pub fn init<R: Runtime, C: DeserializeOwned>(
        _app: &AppHandle<R>,
        api: PluginApi<R, C>,
    ) -> tauri::Result<ComiFlowBridge<R>> {
        let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "ComiFlowBridge")?;
        Ok(ComiFlowBridge(handle))
    }

    pub struct ComiFlowBridge<R: Runtime>(pub PluginHandle<R>);

    impl<R: Runtime> ComiFlowBridge<R> {
        /// Invoke a Kotlin `@Command` method by name and deserialize its
        /// resolved payload into T.
        pub fn call<T: DeserializeOwned>(&self, method: &str, payload: serde_json::Value) -> Option<T> {
            self.0.run_mobile_plugin::<T>(method, payload).ok()
        }
    }
}

/// Initialize the ComiFlow Android bridge plugin (no-op on desktop).
pub fn init_comiflow_bridge<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("comiflow-bridge")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let bridge = comiflow_mobile::init(app, api)?;
                app.manage(bridge);
            }
            // On desktop the fs-based commands are used directly; the state is
            // not needed, so just silence the unused-closure-param warnings.
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}

/// Shared helper: on Android return a reference to the managed ComiFlowBridge.
/// Borrows from Tauri's state table for the lifetime of `app`.
#[cfg(target_os = "android")]
fn android_bridge<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<&comiflow_mobile::ComiFlowBridge<R>> {
    use tauri::Manager;
    app.try_state::<comiflow_mobile::ComiFlowBridge<R>>().map(|s| s.inner())
}

// ── Android plugin response shapes (Kotlin → Rust) ───────────────────────
// Defined at module scope (not inline in commands) because tauri::command's
// macro expansion conflicts with locally-defined derive types.
#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct AndroidFilesResp { files: String }
#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct AndroidMetadataResp { metadata: String }
#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct AndroidFolderResp { uri: Option<String> }
#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct AndroidOkResp { ok: bool }
#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct AndroidPageResp { data: Option<String> }
#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct AndroidChunkResp {
    #[serde(rename = "importId")]
    import_id: String,
}

// ── Shared JSON shapes ────────────────────────────────────────────────────
// Десктопные структуры/функции не используются на Android-таргете (там всё
// идёт через Kotlin-мост), поэтому помечаем их allow(dead_code) для Android.

#[cfg_attr(target_os = "android", allow(dead_code))]
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
// Reused utilities (MIME detection, natural-order sort) live in the shared
// `core_base` workspace crate to avoid duplication across projects.
#[cfg_attr(target_os = "android", allow(unused_imports))]
use core_base::mime_utils::{file_extension, is_image_file, mime_for};
use core_base::natural_cmp;

/// Collect supported comic files inside `dir` (1 level of subfolders → shelves).
#[cfg_attr(target_os = "android", allow(dead_code))]
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

#[cfg_attr(target_os = "android", allow(dead_code))]
struct FileMeta {
    name: String,
    size: u64,
}

/// Return Some(meta) if the path is a supported comic file (.cbz/.pdf).
/// Plain .zip is intentionally excluded: a generic zip is rarely a comic and
/// only clutters the library. CBZ *is* a zip and is still recognized.
#[cfg_attr(target_os = "android", allow(dead_code))]
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
#[cfg_attr(target_os = "android", allow(dead_code))]
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
//
// Commands that touch the filesystem are cfg-gated: on desktop they use the
// std::fs implementation above; on Android they delegate to the ComiFlowBridge
// Kotlin plugin (Storage Access Framework), which is the only way to read
// content:// URIs and present the system folder picker.

#[tauri::command]
fn list_library_files(
    #[allow(unused_variables)] app: tauri::AppHandle,
    folder_path: String,
) -> String {
    #[cfg(target_os = "android")]
    {
        if let Some(bridge) = android_bridge(&app) {
            let payload = serde_json::json!({ "folderUri": folder_path });
            let resp: Option<AndroidFilesResp> = bridge.call("listLibraryFiles", payload);
            if let Some(resp) = resp {
                return resp.files;
            }
            return "[]".to_string();
        }
        return "[]".to_string();
    }

    #[cfg(not(target_os = "android"))]
    {
        let path = Path::new(&folder_path);
        if !path.exists() || !path.is_dir() {
            return "[]".to_string();
        }
        let mut files = Vec::new();
        collect_comic_files(path, &mut files);
        serde_json::to_string(&files).unwrap_or_else(|_| "[]".to_string())
    }
}

#[tauri::command]
fn get_comic_metadata(
    #[allow(unused_variables)] app: tauri::AppHandle,
    file_path: String,
) -> String {
    #[cfg(target_os = "android")]
    {
        if let Some(bridge) = android_bridge(&app) {
            let payload = serde_json::json!({ "uri": file_path });
            let resp: Option<AndroidMetadataResp> = bridge.call("getComicMetadataNative", payload);
            if let Some(resp) = resp {
                return resp.metadata;
            }
        }
        metadata_error_json("Android bridge unavailable")
    }

    #[cfg(not(target_os = "android"))]
    {
        get_comic_metadata_desktop(file_path)
    }
}

/// JSON-метка ошибки метаданных (общая для Android-веток, чтобы не дублировать).
#[cfg(target_os = "android")]
fn metadata_error_json(msg: &str) -> String {
    serde_json::to_string(&ComicMetadata::error(String::new(), 0, "cbz", msg))
        .unwrap_or_else(|_| "{}".to_string())
}

#[cfg(not(target_os = "android"))]
#[cfg_attr(target_os = "android", allow(dead_code))]
fn get_comic_metadata_desktop(file_path: String) -> String {
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
fn get_cbz_page(
    #[allow(unused_variables)] app: tauri::AppHandle,
    file_path: String,
    page_name: String,
) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        // On Android, file_path is a SAF content:// URI that std::fs cannot
        // open. Delegate to the Kotlin bridge, which reads the zip entry via
        // ContentResolver + ZipFile and returns the page as a data-URL.
        let bridge = android_bridge(&app)?;
        let payload = serde_json::json!({ "uri": file_path, "pageName": page_name });
        let resp: Option<AndroidPageResp> = bridge.call("getCbzPage", payload);
        resp.and_then(|r| r.data)
    }

    #[cfg(not(target_os = "android"))]
    {
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
}

#[tauri::command]
fn delete_file(
    #[allow(unused_variables)] app: tauri::AppHandle,
    file_path: String,
    #[allow(unused_variables)] mode: Option<String>,
) -> bool {
    // mode = "trash"    → move to system recycle bin (recoverable)
    // mode = "permanent"/None → remove permanently (not recoverable)
    //
    // On desktop, move-to-trash is available via the `trash` crate. On Android
    // there is no system Trash API, so we delete via SAF (DocumentsContract),
    // which is permanent — there is no safer option on that platform.
    #[cfg(target_os = "android")]
    {
        if let Some(bridge) = android_bridge(&app) {
            let payload = serde_json::json!({ "uri": file_path });
            let resp: Option<AndroidOkResp> = bridge.call("deleteSAFFile", payload);
            if let Some(resp) = resp {
                return resp.ok;
            }
            return false;
        }
        return false;
    }

    #[cfg(not(target_os = "android"))]
    {
        match mode.as_deref() {
            Some("trash") => move_to_trash(&file_path),
            _ => fs::remove_file(&file_path).is_ok(),
        }
    }
}

/// Move a file to the system recycle bin. On Android this is a no-op that
/// returns false (no trash backend exists), so the caller can fall back.
#[cfg_attr(target_os = "android", allow(dead_code))]
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn move_to_trash(file_path: &str) -> bool {
    trash::delete(file_path).is_ok()
}

#[cfg_attr(target_os = "android", allow(dead_code))]
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

/// Включить/выключить перехват клавиш громкости.
/// Android: флаг сохраняется в SharedPreferences, его читает MainActivity
/// (диспетчеризует `nativeVolumeKey`-события в WebView). Desktop: no-op.
#[tauri::command]
fn set_volume_keys_enabled(
    #[allow(unused_variables)] app: tauri::AppHandle,
    enabled: bool,
) -> bool {
    #[cfg(target_os = "android")]
    {
        if let Some(bridge) = android_bridge(&app) {
            let payload = serde_json::json!({ "enabled": enabled });
            let resp: Option<AndroidOkResp> = bridge.call("setVolumeKeysEnabled", payload);
            return resp.map(|r| r.ok).unwrap_or(false);
        }
        return false;
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, enabled);
        true
    }
}

// ── Chunked import (Android) ───────────────────────────────────────────────
// `<input type=file>` на Android даёт только Blob — нет пути к файлу, поэтому
// веб-слой читает File по частям и отправляет base64-чанки в Kotlin, который
// пишет их во временный файл и в конце копирует в SAF-папку библиотеки.
// На desktop импорт идёт нативно через `import_file` (fs::copy), эти команды
// возвращают None/false.

#[tauri::command]
fn start_chunked_import(
    #[allow(unused_variables)] app: tauri::AppHandle,
    file_name: String,
    #[allow(unused_variables)] file_size: u64,
    library_folder: String,
) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        let bridge = android_bridge(&app)?;
        let payload = serde_json::json!({
            "fileName": file_name,
            "totalSize": file_size,
            "folderUri": library_folder,
        });
        let resp: Option<AndroidChunkResp> = bridge.call("startChunkedImport", payload);
        resp.map(|r| r.import_id)
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (file_name, file_size, library_folder);
        None
    }
}

#[tauri::command]
fn append_chunk(
    #[allow(unused_variables)] app: tauri::AppHandle,
    import_id: String,
    base64_data: String,
) -> bool {
    #[cfg(target_os = "android")]
    {
        if let Some(bridge) = android_bridge(&app) {
            let payload = serde_json::json!({ "importId": import_id, "base64Data": base64_data });
            let resp: Option<AndroidOkResp> = bridge.call("appendChunk", payload);
            return resp.map(|r| r.ok).unwrap_or(false);
        }
        return false;
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (import_id, base64_data);
        false
    }
}

#[tauri::command]
fn finish_chunked_import(
    #[allow(unused_variables)] app: tauri::AppHandle,
    import_id: String,
) -> bool {
    #[cfg(target_os = "android")]
    {
        if let Some(bridge) = android_bridge(&app) {
            let payload = serde_json::json!({ "importId": import_id });
            let resp: Option<AndroidOkResp> = bridge.call("finishChunkedImport", payload);
            return resp.map(|r| r.ok).unwrap_or(false);
        }
        return false;
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = import_id;
        false
    }
}

#[tauri::command]
fn cancel_chunked_import(
    #[allow(unused_variables)] app: tauri::AppHandle,
    import_id: String,
) {
    #[cfg(target_os = "android")]
    {
        if let Some(bridge) = android_bridge(&app) {
            let payload = serde_json::json!({ "importId": import_id });
            let _: Option<AndroidOkResp> = bridge.call("cancelChunkedImport", payload);
        }
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = import_id;
    }
}

#[tauri::command]
fn get_pending_file_uri() -> Option<String> {
    None
}

#[tauri::command]
async fn select_library_folder(app: tauri::AppHandle) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        // The Kotlin plugin resolves only from its @ActivityCallback (after the
        // user picks a folder), so run_mobile_plugin blocks until then. Run it
        // on a blocking thread to avoid stalling the async runtime.
        let app2 = app.clone();
        tokio::task::spawn_blocking(move || {
            let bridge = android_bridge(&app2)?;
            let payload = serde_json::json!({});
            let resp: Option<AndroidFolderResp> = bridge.call("selectLibraryFolder", payload);
            resp.and_then(|r| r.uri)
        })
        .await
        .ok()
        .flatten()
    }

    #[cfg(not(target_os = "android"))]
    {
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
}

#[tauri::command]
fn import_file(
    #[allow(unused_variables)] app: tauri::AppHandle,
    source_path: String,
    clean_name: String,
    library_folder: String,
) -> bool {
    #[cfg(target_os = "android")]
    {
        if let Some(bridge) = android_bridge(&app) {
            let payload = serde_json::json!({
                "sourcePath": source_path,
                "destFileName": clean_name,
                "folderUri": library_folder,
            });
            let resp: Option<AndroidOkResp> = bridge.call("importFileToLibrary", payload);
            if let Some(resp) = resp {
                return resp.ok;
            }            return false;
        }
        return false;
    }

    #[cfg(not(target_os = "android"))]
    {
        import_file_desktop(source_path, clean_name, library_folder)
    }
}

#[cfg(not(target_os = "android"))]
#[cfg_attr(target_os = "android", allow(dead_code))]
fn import_file_desktop(source_path: String, clean_name: String, library_folder: String) -> bool {
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
        .plugin(init_comiflow_bridge())
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
            start_chunked_import,
            append_chunk,
            finish_chunked_import,
            cancel_chunked_import,
            confirm_dialog,
            message_dialog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
