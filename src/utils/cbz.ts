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

export interface ParsedCBZ {
  title: string;
  pages: string[];
  coverBlob: Blob;
}

/**
 * Parses a CBZ file Blob to extract its title, page list, and cover image
 */
export async function parseCBZ(file: File | Blob, originalName: string): Promise<ParsedCBZ> {
  const zip = await JSZip.loadAsync(file);
  
  // Collect all image files
  const filePaths: string[] = [];
  zip.forEach((relativePath, fileEntry) => {
    if (!fileEntry.dir && isImageFile(relativePath)) {
      filePaths.push(relativePath);
    }
  });

  if (filePaths.length === 0) {
    throw new Error('В CBZ файле не найдено изображений.');
  }

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
    title,
    pages: filePaths,
    coverBlob,
  };
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
