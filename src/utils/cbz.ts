import JSZip from 'jszip';
import { isTauri, getCbzPage } from './nativeBridge';
import { base64ToBlob } from './pageUtils';

// Allowed image extensions
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'];

/**
 * Natural sort helper to ensure "page2.jpg" comes before "page10.jpg"
 */
export const naturalSort = (a: string, b: string) => {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
};

/**
 * Checks if a filename corresponds to an image file and is not system-hidden
 */
export const isImageFile = (filename: string): boolean => {
  const lower = filename.toLowerCase();

  // Exclude hidden files or OS metadata directories
  if (
    lower.startsWith('.') ||
    lower.includes('__macosx') ||
    lower.includes('thumbs.db') ||
    lower.endsWith('/')
  ) {
    return false;
  }

  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

export interface ParsedComic {
  type: 'comic';
  title: string;
  pages: string[];
  coverBlob: Blob;
}

export interface ParsedCollection {
  type: 'collection';
  archives: { name: string; blob: Blob }[];
}

export type ParseResult = ParsedComic | ParsedCollection;

/**
 * Parses a CBZ file Blob to extract its title, page list, and cover image.
 * NOTE: This is the WEB fallback path (used only when NOT in Tauri).
 * In Tauri, metadata extraction happens server-side via getComicMetadataNative.
 */
export async function parseCBZ(file: File | Blob, originalName: string): Promise<ParseResult> {
  const zip = await JSZip.loadAsync(file);

  // Collect all image files and nested archives
  const filePaths: string[] = [];
  const archivePaths: string[] = [];

  zip.forEach((relativePath, fileEntry) => {
    if (!fileEntry.dir) {
      if (isImageFile(relativePath)) {
        filePaths.push(relativePath);
      } else {
        const lower = relativePath.toLowerCase();
        const filename = relativePath.split('/').pop() || relativePath;
        if (
          (lower.endsWith('.cbz') || lower.endsWith('.zip')) &&
          !filename.startsWith('.') &&
          !filename.startsWith('._')
        ) {
          archivePaths.push(relativePath);
        }
      }
    }
  });

  // If there are images, treat this as a comic
  if (filePaths.length > 0) {
    // Sort pages naturally
    filePaths.sort(naturalSort);

    // Extract cover page (first page)
    const coverPath = filePaths[0];
    const coverZipFile = zip.file(coverPath);
    if (!coverZipFile) {
      throw new Error('Не удалось прочитать обложку комикса.');
    }

    const rawCoverBlob = await coverZipFile.async('blob');

    // Assign proper MIME type based on file extension
    const ext = coverPath.split('.').pop()?.toLowerCase() || 'jpg';
    let mimeType = 'image/jpeg';
    if (ext === 'png') mimeType = 'image/png';
    else if (ext === 'webp') mimeType = 'image/webp';
    else if (ext === 'gif') mimeType = 'image/gif';
    else if (ext === 'bmp') mimeType = 'image/bmp';

    const coverBlob = new Blob([rawCoverBlob], { type: mimeType });

    // Remove extension for title
    const title = originalName.replace(/\.[^/.]+$/, "");

    return {
      type: 'comic',
      title,
      pages: filePaths,
      coverBlob,
    };
  }

  // If no images but nested archives exist, treat as collection
  if (archivePaths.length > 0) {
    const archives = [];
    for (const path of archivePaths) {
      const entry = zip.file(path);
      if (entry) {
        const blob = await entry.async('blob');
        const name = path.split('/').pop() || path;
        archives.push({ name, blob });
      }
    }

    return {
      type: 'collection',
      archives,
    };
  }

  throw new Error('В файле не найдено изображений или вложенных комиксов.');
}

// In-memory cache for the currently reading zip file (web fallback only).
// In Tauri we read pages straight from disk, so this cache stays unused.
let cachedZipId: string | null = null;
let cachedZip: JSZip | null = null;

/**
 * Clear current active zip cache when closing reader
 */
export function clearCBZCache() {
  cachedZipId = null;
  cachedZip = null;
}

/**
 * Extract a single page as a Blob.
 *
 * In Tauri: reads ONLY the requested entry from disk via the Rust
 * `get_cbz_page` command — the whole archive never enters RAM. Returns a
 * Blob built from the data-URL (correct MIME preserved).
 *
 * Web fallback: uses the cached JSZip instance (legacy path).
 */
export async function getPageBlob(
  id: string,
  fileBlob: Blob | null,
  pagePath: string
): Promise<Blob> {
  // Tauri fast path: read one entry from disk.
  if (isTauri()) {
    const dataUrl = await getCbzPage(id, pagePath);
    if (!dataUrl) {
      throw new Error(`Страница не найдена в архиве: ${pagePath}`);
    }
    return base64ToBlob(dataUrl);
  }

  // Web fallback: parse the blob with JSZip.
  if (!fileBlob) {
    throw new Error('Нет данных файла для чтения страницы.');
  }
  if (cachedZipId !== id || !cachedZip) {
    cachedZipId = null;
    cachedZip = null;
    cachedZip = await JSZip.loadAsync(fileBlob);
    cachedZipId = id;
  }
  const fileEntry = cachedZip.file(pagePath);
  if (!fileEntry) {
    throw new Error(`Страница не найдена в архиве: ${pagePath}`);
  }
  return await fileEntry.async('blob');
}
