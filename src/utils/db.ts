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
  /** Пропорции страниц (w/h) в том же порядке, что pages — webtoon-лента
   *  резервирует реальную высоту ДО загрузки изображений (без «прыжков»). */
  aspectRatios?: (number | null)[];
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
 *  3. Drop the redundant `coverBlob` once `coverDataUrl` exists — хранение
 *     обложки в двух форматах удваивает расход IndexedDB (для 1000 комиксов
 *     это сотни МБ). Blob нужен только как временный носитель при импорте.
 *  4. Re-encode oversized data-URL covers (старые версии хранили полные
 *     обложки в base64 — это и есть основные сотни МБ). Работа идёт с
 *     лимитом времени на запуск (COMPRESS_BUDGET_MS), продолжается при
 *     следующих запусках, пока не кончатся «толстые» обложки.
 */
export async function migrateCovers(): Promise<void> {
  try {
    const keys = await metadataStore.keys();
    let budget = COMPRESS_BUDGET_MS;
    for (const key of keys) {
      const value = await metadataStore.getItem<ComicMetadata>(key);
      if (!value) continue;

      let changed = false;

      // 4. Re-encode oversized data-URL covers (only while budget remains).
      if (budget > 0 && value.coverDataUrl && value.coverDataUrl.length > COVER_DATAURL_TOO_BIG) {
        const t0 = performance.now();
        const shrunk = await shrinkDataUrl(value.coverDataUrl);
        if (shrunk && shrunk.length < value.coverDataUrl.length) {
          value.coverDataUrl = shrunk;
          changed = true;
        }
        budget -= performance.now() - t0;
      }

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

      // 3. Drop the redundant Blob copy (data-URL is the source of truth).
      if (value.coverDataUrl && value.coverBlob) {
        value.coverBlob = null;
        changed = true;
      }

      if (changed) {
        await metadataStore.setItem(key, value);
      }
    }
  } catch (err) {
    console.error('Failed to run cover migration:', err);
  }
}

/** Бюджет на перекодировку старых «толстых» обложек за один запуск (мс). */
const COMPRESS_BUDGET_MS = 3000;
/** data-URL длиннее этого (≈120 КБ бинарных) считается «толстой» обложкой. */
const COVER_DATAURL_TOO_BIG = 160 * 1024;

/** Перекодирует data-URL обложки через canvas в WebP ≤480px; null при сбое. */
async function shrinkDataUrl(dataUrl: string): Promise<string | null> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode failed'));
    });
    const maxDim = 480;
    let { width, height } = img;
    if (width <= 0 || height <= 0) return null;
    if (width > height && width > maxDim) {
      height = Math.round((height * maxDim) / width);
      width = maxDim;
    } else if (height > maxDim) {
      width = Math.round((width * maxDim) / height);
      height = maxDim;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
    if (!blob) return null;
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}


/**
 * Get all comics metadata from database
 */
export async function getAllComics(): Promise<ComicMetadata[]> {
  const comics: ComicMetadata[] = [];
  await metadataStore.iterate<ComicMetadata, void>((value) => {
    // Защита от битых записей (старые версии/оборванные миграции):
    // мусор не должен ронять всю библиотеку или вешать синхронизацию.
    if (!value || typeof value !== 'object' || typeof (value as any).id !== 'string') {
      return;
    }
    comics.push(value);
  });
  // Sort by addedAt descending (записи без addedAt — в конец)
  return comics.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
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
  metadataError: string | null = null,
  aspectRatios?: (number | null)[]
): Promise<ComicMetadata> {
  // Preserve immutable identity/progress fields when updating an existing comic
  // (otherwise re-saving metadata during lazy-load would wipe reading progress
  // and reset the sort order).
  const existing = await metadataStore.getItem<ComicMetadata>(id).catch(() => null);

  // Compress and resize the cover image to prevent DB storage bloat.
  // Сжимаем ТОЛЬКО новый cover: если вызывающий не передал обложку
  // (например, обновление прогресса чтения), существующую не трогаем —
  // раньше она пересжималась и перекодировалась в data-URL при каждом
  // перелистывании страницы, что было очень дорого для больших библиотек.
  const compressedCover = coverBlob ? await resizeCover(coverBlob) : null;

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
    aspectRatios: aspectRatios && aspectRatios.length > 0 ? aspectRatios : (existing?.aspectRatios ?? undefined),
    // Blob не храним: обложка живёт как coverDataUrl (см. migrateCovers).
    coverBlob: null,
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
 * Обновить обложку комикса (data-URL) без перезаписи остальных полей —
 * используется библиотекой для «обложки на лету», когда карточка попадает
 * в окно просмотра, а фоновая очередь ещё не обработала файл.
 */
export async function updateComicCover(id: string, coverDataUrl: string): Promise<ComicMetadata | null> {
  const metadata = await metadataStore.getItem<ComicMetadata>(id).catch(() => null);
  if (!metadata) return null;
  metadata.coverDataUrl = coverDataUrl;
  metadata.coverBlob = null;
  await metadataStore.setItem(id, metadata);
  return metadata;
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

