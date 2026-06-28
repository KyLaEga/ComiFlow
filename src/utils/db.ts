import localforage from 'localforage';

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
  coverBlob: Blob; // Saved Blob of the first page
  format?: 'cbz' | 'pdf'; // File format
}

// Stores
let metadataStore: LocalForage;
let fileStore: LocalForage;

export const initDb = () => {
  if (metadataStore && fileStore) return;

  metadataStore = localforage.createInstance({
    name: 'ComiFlow',
    storeName: 'comics_metadata',
    description: 'Metadata for comic books and covers',
  });

  fileStore = localforage.createInstance({
    name: 'ComiFlow',
    storeName: 'comics_files',
    description: 'Raw binary CBZ files',
  });
};

// Initialize on import
initDb();

/**
 * Get all comics metadata from database
 */
export async function getAllComics(): Promise<ComicMetadata[]> {
  const comics: ComicMetadata[] = [];
  await metadataStore.iterate<ComicMetadata, void>((value) => {
    // Generate object URL for the cover blob so React can display it
    if (value.coverBlob) {
      value.coverUrl = URL.createObjectURL(value.coverBlob);
    }
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
  coverBlob: Blob,
  fileBlob: Blob,
  format: 'cbz' | 'pdf'
): Promise<ComicMetadata> {
  const metadata: ComicMetadata = {
    id,
    title,
    size,
    addedAt: Date.now(),
    lastReadAt: null,
    currentPage: 0,
    totalPages: pages.length,
    pages,
    coverBlob,
    format,
  };

  // Save metadata
  await metadataStore.setItem(id, metadata);
  // Save file content
  await fileStore.setItem(id, fileBlob);

  // Add cover URL for runtime display
  metadata.coverUrl = URL.createObjectURL(coverBlob);
  return metadata;
}

/**
 * Get the CBZ file Blob for a comic
 */
export async function getComicFile(id: string): Promise<Blob | null> {
  return await fileStore.getItem<Blob>(id);
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
  await fileStore.removeItem(id);
}
