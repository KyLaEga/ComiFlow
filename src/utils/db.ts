import localforage from 'localforage';
import { resizeCover } from './image';

/** Convert a Blob to a data-URL string via FileReader. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Define the structure of comic metadata
export interface ComicMetadata {
  id: string;
  title: string;
  size: number;
  addedAt: number;
  lastReadAt: number | null;
  currentPage: number;
  totalPages: number;
  pages: string[]; // List of file names inside the zip (sorted)
  coverUrl?: string; // Temporarily created Object URL for rendering
  coverBlob: Blob | null; // Saved Blob of the first page (used by Reader)
  /**
   * Same cover as a data URL string. IndexedDB reliably round-trips strings
   * (unlike Blobs in some webviews), so the library grid uses this directly
   * as <img src> — no createObjectURL / revocation timing issues.
   */
  coverDataUrl?: string | null;
  format?: 'cbz' | 'pdf'; // File format
  uri: string; // Native SAF URI pointing to the file
  shelfId?: string | null; // Shelf ID this comic belongs to
  /**
   * Set when metadata extraction failed or the file is empty/not a comic.
   * Prevents the background loader from retrying the same broken file
   * forever (which would spin-loop and freeze the UI).
   */
  metadataError?: string | null;
}

// Stores
let metadataStore: LocalForage;
let shelvesStore: LocalForage;

export const initDb = () => {
  if (metadataStore && shelvesStore) return;

  metadataStore = localforage.createInstance({
    name: 'ComiFlow',
    storeName: 'comics_metadata',
    description: 'Metadata for comic books and covers',
  });

  shelvesStore = localforage.createInstance({
    name: 'ComiFlow',
    storeName: 'comics_shelves',
    description: 'User shelves / folders to organize comics',
  });
};

// Initialize on import
initDb();

/**
 * Background migration:
 *  1. Compress previously saved bloated covers.
 *  2. Backfill `coverDataUrl` for records that only have a `coverBlob`, so the
 *     library grid can render reliably (Blobs can come back broken from
 *     IndexedDB after a structured clone in some webviews — strings cannot).
 */
export async function migrateCovers(): Promise<void> {
  try {
    const keys = await metadataStore.keys();
    for (const key of keys) {
      const value = await metadataStore.getItem<ComicMetadata>(key);
      if (!value) continue;

      let changed = false;

      // 1. Compress oversized covers.
      if (value.coverBlob && value.coverBlob.size > 120 * 1024) {
        const compressed = await resizeCover(value.coverBlob);
        if (compressed.size < value.coverBlob.size) {
          value.coverBlob = compressed;
          changed = true;
        }
      }

      // 2. Backfill coverDataUrl if missing but a cover Blob exists.
      if (!value.coverDataUrl && value.coverBlob) {
        try {
          value.coverDataUrl = await blobToDataUrl(value.coverBlob);
          changed = true;
        } catch {
          /* ignore single-record failure */
        }
      }

      if (changed) {
        await metadataStore.setItem(key, value);
      }
    }
  } catch (err) {
    console.error('Failed to run cover migration:', err);
  }
}


/**
 * Get all comics metadata from database
 */
export async function getAllComics(): Promise<ComicMetadata[]> {
  const comics: ComicMetadata[] = [];
  await metadataStore.iterate<ComicMetadata, void>((value) => {
    comics.push(value);
  });
  // Sort by addedAt descending
  return comics.sort((a, b) => b.addedAt - a.addedAt);
}

/**
 * Save new comic to database
 */
export async function saveComic(
  id: string,
  title: string,
  size: number,
  pages: string[],
  coverBlob: Blob | null,
  uri: string,
  format: 'cbz' | 'pdf',
  shelfId: string | null = null,
  metadataError: string | null = null
): Promise<ComicMetadata> {
  // Preserve immutable identity/progress fields when updating an existing comic
  // (otherwise re-saving metadata during lazy-load would wipe reading progress
  // and reset the sort order).
  const existing = await metadataStore.getItem<ComicMetadata>(id).catch(() => null);

  // Compress and resize the cover image to prevent DB storage bloat.
  // Keep the existing cover if the caller passed null but we already had one
  // (e.g. a progress-only update should not erase the cover).
  const incomingCover = coverBlob ?? existing?.coverBlob ?? null;
  const compressedCover = incomingCover ? await resizeCover(incomingCover) : null;

  // Persist the cover also as a data-URL string. IndexedDB round-trips strings
  // reliably across webviews (Blobs can come back null/broken after a clone),
  // so the library grid renders directly from this string.
  let coverDataUrl: string | null = existing?.coverDataUrl ?? null;
  if (compressedCover) {
    try {
      coverDataUrl = await blobToDataUrl(compressedCover);
    } catch {
      // keep previous data url if conversion fails
    }
  }

  const metadata: ComicMetadata = {
    id,
    title,
    size,
    addedAt: existing?.addedAt ?? Date.now(),
    lastReadAt: existing?.lastReadAt ?? null,
    currentPage: existing?.currentPage ?? 0,
    totalPages: pages.length > 0 ? pages.length : (existing?.totalPages ?? 0),
    pages: pages.length > 0 ? pages : (existing?.pages ?? []),
    coverBlob: compressedCover,
    coverDataUrl,
    format,
    uri,
    shelfId,
    metadataError,
  };

  // Save metadata
  await metadataStore.setItem(id, metadata);

  return metadata;
}

/**
 * Update reading progress (current page) and last read time
 */
export async function updateComicProgress(
  id: string,
  currentPage: number
): Promise<void> {
  const metadata = await metadataStore.getItem<ComicMetadata>(id);
  if (metadata) {
    metadata.currentPage = currentPage;
    metadata.lastReadAt = Date.now();
    await metadataStore.setItem(id, metadata);
  }
}

/**
 * Delete comic metadata and file
 */
export async function deleteComic(id: string): Promise<void> {
  await metadataStore.removeItem(id);
}

// Shelves API
export interface Shelf {
  id: string;
  name: string;
  addedAt: number;
}

/**
 * Get all shelves in the database
 */
export async function getAllShelves(): Promise<Shelf[]> {
  const list: Shelf[] = [];
  await shelvesStore.iterate<Shelf, void>((value) => {
    list.push(value);
  });
  return list.sort((a, b) => b.addedAt - a.addedAt);
}

/**
 * Create or rename a shelf
 */
export async function saveShelf(id: string, name: string): Promise<Shelf> {
  const shelf: Shelf = {
    id,
    name,
    addedAt: Date.now(),
  };
  await shelvesStore.setItem(id, shelf);
  return shelf;
}

/**
 * Delete a shelf and set all comics on it to uncategorized (null)
 */
export async function deleteShelf(id: string): Promise<void> {
  await shelvesStore.removeItem(id);
  
  const comicsToUpdate: ComicMetadata[] = [];
  await metadataStore.iterate<ComicMetadata, void>((value) => {
    if (value.shelfId === id) {
      value.shelfId = null;
      comicsToUpdate.push(value);
    }
  });

  for (const comic of comicsToUpdate) {
    await metadataStore.setItem(comic.id, comic);
  }
}

/**
 * Assign a comic to a shelf
 */
export async function assignComicToShelf(comicId: string, shelfId: string | null): Promise<void> {
  const metadata = await metadataStore.getItem<ComicMetadata>(comicId);
  if (metadata) {
    metadata.shelfId = shelfId;
    await metadataStore.setItem(comicId, metadata);
  }
}

