import JSZip from 'jszip';

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
 * Parses a CBZ file Blob to extract its title, page list, and cover image
 * Or returns a collection of nested archives if no images are found
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
        if (lower.endsWith('.cbz') || lower.endsWith('.zip')) {
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

    const coverBlob = await coverZipFile.async('blob');
    
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

// In-memory cache for the currently reading zip file to optimize performance
let cachedZipId: string | null = null;
let cachedZip: JSZip | null = null;

/**
 * Loads and caches the JSZip instance for reading pages
 */
async function getZipInstance(id: string, fileBlob: Blob): Promise<JSZip> {
  if (cachedZipId === id && cachedZip) {
    return cachedZip;
  }
  
  // Clear previous cache
  cachedZipId = null;
  cachedZip = null;

  const zip = await JSZip.loadAsync(fileBlob);
  cachedZipId = id;
  cachedZip = zip;
  return zip;
}

/**
 * Clear current active zip cache when closing reader
 */
export function clearCBZCache() {
  cachedZipId = null;
  cachedZip = null;
}

/**
 * Extracts a specific page from the CBZ blob
 */
export async function getPageBlob(
  id: string,
  fileBlob: Blob,
  pagePath: string
): Promise<Blob> {
  const zip = await getZipInstance(id, fileBlob);
  const fileEntry = zip.file(pagePath);
  if (!fileEntry) {
    throw new Error(`Страница не найдена в архиве: ${pagePath}`);
  }
  return await fileEntry.async('blob');
}
