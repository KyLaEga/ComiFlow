import { isTauri, getCbzPage } from './nativeBridge';
import { base64ToBlob } from './pageUtils';

/**
 * Extract a single page as a Blob.
 *
 * In Tauri: reads ONLY the requested entry from disk via the Rust
 * `get_cbz_page` command — the whole archive never enters RAM. Returns a
 * Blob built from the data-URL (correct MIME preserved).
 *
 * (Старый JSZip web-fallback удалён: приложение работает только в Tauri —
 * десктоп и Android. На «голом» вебе читать CBZ нечем.)
 */
export async function getPageBlob(
  id: string,
  _fileBlob: Blob | null,
  pagePath: string
): Promise<Blob> {
  if (!isTauri()) {
    throw new Error('Чтение CBZ доступно только в приложении.');
  }
  const dataUrl = await getCbzPage(id, pagePath);
  if (!dataUrl) {
    throw new Error(`Страница не найдена в архиве: ${pagePath}`);
  }
  return base64ToBlob(dataUrl);
}
