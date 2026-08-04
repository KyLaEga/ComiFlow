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

/** True inside the Tauri Android app (SAF content:// URIs, chunked import). */
export const isAndroid = (): boolean => {
  const ua = navigator.userAgent.toLowerCase();
  return isTauri() && (ua.includes('android') || ua.includes('linux;'));
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

/**
 * Import (copy) a file into the library folder.
 *
 * - Desktop: the file's absolute path (`file.path`, injected by Tauri for
 *   drag&drop / file inputs when available) is copied natively via Rust.
 * - Android: `<input type=file>` exposes only a Blob, so the file is read in
 *   ~1 MiB slices and streamed as base64 chunks to the Kotlin bridge, which
 *   writes them to a temp file and copies it into the SAF library folder.
 *
 * `source` may also be an absolute path string (desktop-only callers, e.g.
 * file-association intents) — then it is copied directly.
 */
export async function importFileToLibrary(
  source: File | string,
  cleanName: string,
  libraryFolder: string,
): Promise<boolean> {
  if (!isTauri()) return false;

  // Android: chunked upload via the Kotlin bridge.
  if (isAndroid() && source instanceof File) {
    const CHUNK_SIZE = 1024 * 1024; // 1 MiB raw → ~1.37 MiB base64 per chunk
    let importId: string | null = null;
    try {
      importId = await invoke<string | null>('start_chunked_import', {
        fileName: cleanName,
        fileSize: source.size,
        libraryFolder,
      });
      if (!importId) return false;

      for (let offset = 0; offset < source.size; offset += CHUNK_SIZE) {
        const slice = source.slice(offset, offset + CHUNK_SIZE);
        const bytes = new Uint8Array(await slice.arrayBuffer());
        let binary = '';
        // btoa() работает с бинарной строкой; 1 MiB — безопасный размер.
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const ok = await invoke<boolean>('append_chunk', {
          importId,
          base64Data: btoa(binary),
        });
        if (!ok) return false;
      }

      return await invoke<boolean>('finish_chunked_import', { importId });
    } catch (e) {
      console.error('Tauri chunked import error:', e);
      if (importId) {
        invoke('cancel_chunked_import', { importId }).catch(() => {});
      }
      return false;
    }
  }

  // Desktop / path-based import: native copy in Rust.
  try {
    const sourcePath =
      source instanceof File
        ? (source as any).path || (source as any).webkitRelativePath || source.name
        : source;
    return await invoke<boolean>('import_file', {
      sourcePath,
      cleanName,
      libraryFolderPath: libraryFolder,
    });
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

/** Режим листания клавишами громкости (Android; на desktop — no-op). */
export type VolumeKeyMode = 'off' | 'single' | 'auto';

export async function setVolumeKeyMode(mode: VolumeKeyMode): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('set_volume_key_mode', { mode });
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
