/**
 * Native bridge: thin, fully-typed layer over Tauri commands.
 *
 * This replaces the old Capacitor `ComiFlowBridge` window-injected object.
 * Every function resolves to a Tauri `invoke()` call when running inside
 * Tauri, and falls back to `null` / no-op on plain web (dev server).
 */
import { invoke, convertFileSrc } from '@tauri-apps/api/core';

// ── Types returned by the Rust backend ────────────────────────────────────

export interface LibraryFile {
  name: string;
  uri: string;
  size: number;
  shelfName: string;
}

export interface ComicMetadataNative {
  name: string;
  size: number;
  format?: 'cbz' | 'pdf';
  pages: string[];
  totalPages: number;
  coverBase64: string | null;
  error?: string;
}

// ── Environment ───────────────────────────────────────────────────────────

export const isTauri = (): boolean => {
  return !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;
};

// ── Folder selection ──────────────────────────────────────────────────────

/** Open a native folder picker and return the selected absolute path (or null). */
export async function selectLibraryFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>('select_library_folder');
  } catch (e) {
    console.error('Tauri selectLibraryFolder error:', e);
    return null;
  }
}

// ── Library listing ───────────────────────────────────────────────────────

/** Return the list of supported comic files inside a folder (1 level deep). */
export async function listLibraryFiles(folderPath: string): Promise<LibraryFile[]> {
  if (!isTauri()) return [];
  try {
    const json = await invoke<string>('list_library_files', { folderPath });
    return JSON.parse(json) as LibraryFile[];
  } catch (e) {
    console.error('Tauri listLibraryFiles error:', e);
    return [];
  }
}

// ── Comic metadata / covers ───────────────────────────────────────────────

/** Extract pages list + cover image from a cbz/pdf file (server-side, fast). */
export async function getComicMetadataNative(filePath: string): Promise<ComicMetadataNative> {
  if (!isTauri()) {
    return { name: '', size: 0, format: 'cbz', pages: [], totalPages: 0, coverBase64: null, error: 'Not in Tauri' };
  }
  try {
    const json = await invoke<string>('get_comic_metadata', { filePath });
    return JSON.parse(json) as ComicMetadataNative;
  } catch (e) {
    return { name: '', size: 0, format: 'cbz', pages: [], totalPages: 0, coverBase64: null, error: String(e) };
  }
}

/**
 * Extract a single page image from a CBZ archive by entry name.
 * Returns a data-URL ("data:image/jpeg;base64,...") or null on failure.
 * Reads only the requested entry — the whole archive never enters RAM.
 */
export async function getCbzPage(filePath: string, pageName: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>('get_cbz_page', { filePath, pageName });
  } catch (e) {
    console.error('Tauri getCbzPage error:', e);
    return null;
  }
}

// ── File operations ───────────────────────────────────────────────────────

/**
 * Delete a single file by its absolute path.
 * @param mode 'trash' = move to recycle bin (recoverable),
 *             'permanent' = delete forever (not recoverable)
 */
export async function deleteSAFFile(
  filePath: string,
  mode: 'trash' | 'permanent',
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>('delete_file', { filePath, mode });
  } catch (e) {
    console.error('Tauri deleteSAFFile error:', e);
    return false;
  }
}

/** Import (copy) a file into the library folder. */
export async function importFileToLibrary(
  sourcePath: string,
  cleanName: string,
  libraryFolderPath: string
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>('import_file', { sourcePath, cleanName, libraryFolderPath });
  } catch (e) {
    console.error('Tauri importFileToLibrary error:', e);
    return false;
  }
}

/** No-op on desktop; kept for API compatibility with the old bridge. */
export async function clearImportCache(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('clear_import_cache');
  } catch {
    /* ignore */
  }
}

// ── Desktop-only stubs ────────────────────────────────────────────────────

/** Volume-key override is Android-only; no-op on desktop. */
export async function setVolumeKeysEnabled(_enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('set_volume_keys_enabled', { enabled: _enabled });
  } catch {
    /* ignore */
  }
}

/** File-association pending URI — not used on desktop. */
export async function getPendingFileUri(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>('get_pending_file_uri');
  } catch {
    return null;
  }
}

// ── Native dialogs (replace unreliable window.confirm / window.alert) ─────

/**
 * Show a native Yes/No confirmation dialog. Falls back to window.confirm on
 * the web. window.confirm is unreliable inside the Tauri webview (it can
 * return false or true without showing any UI), so always prefer this.
 */
export async function confirmDialog(message: string, title?: string): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invoke<boolean>('confirm_dialog', { message, title: title ?? null });
    } catch {
      return false;
    }
  }
  return window.confirm(message);
}

/** Show a native OK message dialog (replaces window.alert). */
export async function messageDialog(message: string, title?: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('message_dialog', { message, title: title ?? null });
      return;
    } catch {
      /* fall through to alert */
    }
  }
  window.alert(message);
}

// ── File reading ──────────────────────────────────────────────────────────

/**
 * Convert an absolute file path into a URL the WebView can `fetch()` / use as
 * `<img src>` via the Tauri asset protocol. On plain web, returns the path as-is.
 */
export function getFileSrc(filePath: string): string {
  if (isTauri()) {
    return convertFileSrc(filePath);
  }
  return filePath;
}

// ── Chunked import (legacy Capacitor API, unused in Tauri) ────────────────
// Kept only so old call sites compile during migration; Tauri uses
// importFileToLibrary() directly. These can be removed once App.tsx is cleaned.

export async function copyContentUriToCache(uri: string): Promise<string | null> {
  // On desktop the path is already accessible; no cache copy needed.
  return uri;
}

export async function startChunkedImport(
  _fileName: string,
  _fileSize: number,
  _libraryFolderPath: string
): Promise<string | null> {
  return null;
}

export async function appendChunk(_importId: string, _base64: string): Promise<boolean> {
  return false;
}

export async function cancelChunkedImport(_importId: string): Promise<void> {}

export async function finishChunkedImport(_importId: string): Promise<boolean> {
  return false;
}
