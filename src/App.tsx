import { useState, useEffect, useCallback, useRef } from 'react';
import { Library } from './components/Library';
import type { ReaderSettings } from './components/Settings';
import {
  getAllComics,
  deleteComic,
  saveComic,
  initDb,
  getAllShelves,
  saveShelf,
  deleteShelf,
  assignComicToShelf,
  migrateCovers
} from './utils/db';
import type { ComicMetadata, Shelf } from './utils/db';
import { BookOpen, Settings as SettingsIcon } from 'lucide-react';
import {
  isTauri,
  selectLibraryFolder as bridgeSelectLibraryFolder,
  listLibraryFiles,
  getComicMetadataNative,
  deleteSAFFile,
  importFileToLibrary,
  clearImportCache,
  setVolumeKeysEnabled,
  getPendingFileUri,
  getFileSrc,
  confirmDialog,
  messageDialog,
} from './utils/nativeBridge';
import { base64ToBlob } from './utils/pageUtils';

import { Reader } from './components/Reader';
import { Settings } from './components/Settings';
import './App.css';


const LOCAL_STORAGE_KEY = 'comiflow_settings';

/** All valid Universal UI theme ids (kept in sync with universal-themes.css). */
const VALID_THEMES = new Set<ReaderSettings['theme']>([
  'system',
  'light-slate', 'dark-slate', 'oled-slate',
  'light-nord', 'dark-nord', 'oled-nord',
  'light-midnight', 'dark-midnight', 'oled-midnight',
  'light-dracula', 'dark-dracula', 'oled-dracula',
  'light-sepia', 'dark-sepia', 'oled-sepia',
  'light-evergreen', 'dark-evergreen', 'oled-evergreen',
  'light-amber', 'dark-amber', 'oled-amber',
  'light-sakura', 'dark-sakura', 'oled-sakura',
  'light-cyberpunk', 'dark-cyberpunk', 'oled-cyberpunk',
]);

/** Map legacy (pre-Universal-UI) theme names to current ones. */
const LEGACY_THEME_MAP: Record<string, ReaderSettings['theme']> = {
  light: 'light-slate',
  dark: 'dark-slate',
  purple: 'dark-midnight',
  'light-purple': 'light-midnight',
  midnight: 'dark-midnight',
  oled: 'oled-slate',
};

/** Validate / migrate a stored theme value; falls back to 'system'. */
function normalizeTheme(raw: unknown): ReaderSettings['theme'] {
  if (typeof raw !== 'string') return 'system';
  if (VALID_THEMES.has(raw as ReaderSettings['theme'])) return raw as ReaderSettings['theme'];
  if (LEGACY_THEME_MAP[raw]) return LEGACY_THEME_MAP[raw];
  return 'system';
}

const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'system',
  direction: 'ltr',
  mode: 'paged',
  fitMode: 'contain',
  splitDoublePages: true,
  zoomLock: false,
  volumeKeysEnabled: false,
  brightness: 100,
  contrast: 100,
  deleteMode: 'off',
  fastScrollPosition: 'right',
};

// Persisted library folder (Tauri desktop) so it survives restarts.
const FOLDER_STORAGE_KEY = 'comiflow_library_folder';

const getStoredFolder = (): string | null => localStorage.getItem(FOLDER_STORAGE_KEY);
const setStoredFolder = (uri: string) => localStorage.setItem(FOLDER_STORAGE_KEY, uri);

function App() {
  const [isInitializing, setIsInitializing] = useState(true);
  const [libraryFolderUri, setLibraryFolderUri] = useState<string | null>(null);
  const [comics, setComics] = useState<ComicMetadata[]>([]);
  const [activeComicId, setActiveComicId] = useState<string | null>(null);
  const [activeComicFile, setActiveComicFile] = useState<Blob | null>(null);

  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState('');
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);

  const [pendingFiles, setPendingFiles] = useState<FileList | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importTargetShelfId, setImportTargetShelfId] = useState<string | null>(null);

  const [isSelectMode, setIsSelectMode] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [activeShelfId, setActiveShelfId] = useState<string | null>(null);

  const libraryScrollYRef = useRef<number>(0);

  // Keep refs for the hardware back handler to avoid re-binding it
  const activeComicIdRef = useRef<string | null>(null);
  const isSettingsOpenRef = useRef<boolean>(false);
  const isSelectModeRef = useRef<boolean>(false);

  useEffect(() => {
    activeComicIdRef.current = activeComicId;
  }, [activeComicId]);

  useEffect(() => {
    isSettingsOpenRef.current = isSettingsOpen;
  }, [isSettingsOpen]);

  useEffect(() => {
    isSelectModeRef.current = isSelectMode;
  }, [isSelectMode]);

  // Hardware back button (Tauri Android). Handled via the app event plugin if available.
  useEffect(() => {
    const onBackButton = () => {
      if (activeComicIdRef.current) {
        setActiveComicId(null);
        setActiveComicFile(null);
        requestAnimationFrame(() => {
          window.scrollTo(0, libraryScrollYRef.current);
        });
        clearImportCache();
        getAllComics().then((list) => setComics(list));
      } else if (isSettingsOpenRef.current) {
        setIsSettingsOpen(false);
      } else if (isSelectModeRef.current) {
        setIsSelectMode(false);
      } else if (isTauri()) {
        // Exit only on native; on web do nothing.
        window.close();
      }
    };
    window.addEventListener('comiflow:backbutton', onBackButton);
    return () => window.removeEventListener('comiflow:backbutton', onBackButton);
  }, []);

  // Open file from a path (Tauri) — used for file-association intents.
  const handleOpenFileFromPath = async (filePath: string) => {
    if (!libraryFolderUri) {
      await messageDialog('Сначала выберите папку библиотеки, чтобы открывать файлы извне.');
      return;
    }

    setIsImporting(true);
    setImportProgress('Добавление файла в библиотеку...');
    try {
      const cleanName = filePath.split(/[/\\]/).pop() || 'imported_file';

      const ok = await importFileToLibrary(filePath, cleanName, libraryFolderUri);
      if (ok) {
        await syncLibrary(libraryFolderUri);

        const list = await getAllComics();
        setComics(list);

        // Find the newly added comic
        const newComic = list.find(c => c.title === cleanName || c.uri.includes(cleanName));
        if (newComic) {
          await handleSelectComic(newComic.id);
        }
      } else {
        await messageDialog('Не удалось скопировать файл в библиотеку.');
      }
    } catch (err) {
      console.error('Failed to open file from path:', err);
      await messageDialog(`Не удалось открыть файл: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}`);
    } finally {
      setIsImporting(false);
      setImportProgress('');
    }
  };

  // Sync library folder (Tauri: native metadata extraction)
  const syncLibrary = async (folderUri: string, silent: boolean = false) => {
    if (!silent) {
      setIsImporting(true);
      setImportProgress('Синхронизация библиотеки...');
    }
    try {
      console.log('[sync] start, folder:', folderUri);
      const safFiles = await listLibraryFiles(folderUri);
      console.log('[sync] files found:', safFiles.length);

      const existingComics = await getAllComics();
      const existingUris = new Set(existingComics.map(c => c.uri));

      // Find deleted files
      const safUris = new Set(safFiles.map(f => f.uri));
      let deletedCount = 0;
      for (const comic of existingComics) {
        if (!safUris.has(comic.uri)) {
          await deleteComic(comic.id);
          deletedCount++;
        }
      }

      // Find new files
      let importedCount = 0;
      let currentShelves = [...shelves];
      let shelvesUpdated = false;

      for (const file of safFiles) {
        if (!existingUris.has(file.uri)) {
          let targetShelfId = null;

          // Auto-create shelf if file is in a subfolder
          if (file.shelfName && file.shelfName.trim() !== '') {
            const shelfName = file.shelfName.trim();
            let existingShelf = currentShelves.find(s => s.name === shelfName);
            if (!existingShelf) {
              if (!silent) setImportProgress(`Создание полки "${shelfName}"...`);
              const newShelfId = `shelf_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
              existingShelf = await saveShelf(newShelfId, shelfName);
              currentShelves.push(existingShelf);
              shelvesUpdated = true;
            }
            targetShelfId = existingShelf.id;
          }

          // Save a lightweight record; metadata (pages + cover) is filled
          // lazily by the background queue (see useEffect below).
          if (!silent) setImportProgress(`Добавление ${file.name}...`);
          const id = `comic_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
          const isPdf = file.name.toLowerCase().endsWith('.pdf');
          const format = isPdf ? 'pdf' : 'cbz';
          const title = file.name.replace(/\.[^/.]+$/, "");
          await saveComic(id, title, file.size, [], null, file.uri, format, targetShelfId);
          importedCount++;
        }
      }

      // Clean up empty shelves
      const finalComics = await getAllComics();
      const usedShelfIds = new Set(finalComics.map(c => c.shelfId).filter(id => id));
      let shelvesDeleted = false;
      for (const shelf of currentShelves) {
        if (!usedShelfIds.has(shelf.id)) {
          await deleteShelf(shelf.id);
          shelvesDeleted = true;
        }
      }

      if (shelvesUpdated || shelvesDeleted) {
        const updatedShelvesList = await getAllShelves();
        setShelves(updatedShelvesList);
      }

      if (deletedCount > 0 || importedCount > 0) {
        setComics(finalComics);
      }
    } catch (err) {
      console.error(err);
      if (!silent) await messageDialog('Ошибка при синхронизации папки библиотеки.');
    } finally {
      await clearImportCache();
      if (!silent) {
        setIsImporting(false);
        setImportProgress('');
      }
    }
  };

  const selectLibraryFolder = useCallback(async () => {
    const uri = await bridgeSelectLibraryFolder();
    if (uri) {
      setStoredFolder(uri);
      setLibraryFolderUri(uri);
      await syncLibrary(uri);
    } else if (!isTauri()) {
      await messageDialog('Выбор папки библиотеки поддерживается только в приложении.');
    }
  }, []);

  // Initialize DB, Load Settings, Comics, Shelves & saved folder
  useEffect(() => {
    let cancelled = false;
    (async () => {
      initDb();
      migrateCovers().catch(err => console.error('Failed to migrate covers:', err));

      // Load settings from localStorage
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          // Migrate legacy theme names and drop invalid values so a stale
          // 'light'/'dark' from the old app never breaks light themes.
          const normalizedTheme = normalizeTheme(parsed.theme);
          // Migrate legacy deletePhysicalFile: boolean → deleteMode enum.
          // Old "true" becomes 'permanent' (preserves previous behaviour);
          // anything else falls back to the safe default 'off'.
          if (parsed.deleteMode === undefined) {
            parsed.deleteMode = parsed.deletePhysicalFile === true ? 'permanent' : 'off';
          }
          delete parsed.deletePhysicalFile;
          setSettings({ ...DEFAULT_SETTINGS, ...parsed, theme: normalizedTheme });
          if (parsed.volumeKeysEnabled !== undefined) {
            setVolumeKeysEnabled(parsed.volumeKeysEnabled);
          }
          // Persist the migration so we don't re-normalize every launch.
          if (parsed.theme !== normalizedTheme || parsed.deletePhysicalFile !== undefined) {
            localStorage.setItem(
              LOCAL_STORAGE_KEY,
              JSON.stringify({ ...DEFAULT_SETTINGS, ...parsed, theme: normalizedTheme })
            );
          }
        } catch (e) {
          console.warn('Failed to parse saved settings', e);
        }
      }

      // Restore previously selected library folder BEFORE showing any UI,
      // so the "choose folder" screen never flashes for returning users.
      const storedFolder = getStoredFolder();
      if (storedFolder) {
        setLibraryFolderUri(storedFolder);
        // Kick off sync in the background; do not block first paint.
        syncLibrary(storedFolder, true).catch(err => console.error('bg sync failed', err));
      }

      try {
        const [comicList, shelfList] = await Promise.all([getAllComics(), getAllShelves()]);
        if (cancelled) return;
        setComics(comicList);
        setShelves(shelfList);
      } catch (err) {
        console.error('Failed to load library/shelves:', err);
      }

      if (cancelled) return;
      setIsInitializing(false);

      // Check for file-association intent opening shortly after launch
      const pending = await getPendingFileUri();
      if (pending) {
        handleOpenFileFromPath(pending);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply Theme Attribute to HTML Element
  useEffect(() => {
    const applyTheme = () => {
      let resolvedTheme = settings.theme;
      if (settings.theme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        resolvedTheme = isDark ? 'dark-slate' : 'light-slate';
      }
      document.documentElement.setAttribute('data-theme', resolvedTheme);
    };

    applyTheme();

    if (settings.theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = (e: MediaQueryListEvent) => {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark-slate' : 'light-slate');
      };
      mediaQuery.addEventListener('change', listener);
      return () => {
        mediaQuery.removeEventListener('change', listener);
      };
    }
  }, [settings.theme]);

  // Update Settings
  const handleUpdateSettings = useCallback((newSettings: Partial<ReaderSettings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(updated));
      if (newSettings.volumeKeysEnabled !== undefined) {
        setVolumeKeysEnabled(newSettings.volumeKeysEnabled);
      }
      return updated;
    });
  }, []);

  // Background metadata loader worker — extracts pages + cover for comics
  // that were saved as lightweight records during sync.
  //
  // INVARIANT (prevents UI freeze): after processing, a comic MUST end up with
  // either non-empty pages OR a metadataError. The `pending` selector requires
  // both empty pages AND no metadataError, so any comic that fails to produce
  // pages gets marked once and is never retried — breaking the infinite loop.
  //
  // PDF is excluded: Rust returns 0 pages for PDF (parsed by pdf.js on open),
  // so the queue would otherwise spin on every PDF forever.
  useEffect(() => {
    if (isImporting || isProcessingQueue) return;

    const runQueue = async () => {
      const pending = comics.find(
        (c) =>
          (!c.pages || c.pages.length === 0) &&
          !c.metadataError
      );
      if (!pending) return;

      setIsProcessingQueue(true);
      try {
        let pages: string[];
        let coverBlob: Blob | null = null;
        let errorMsg: string | null = null;

        if (pending.format === 'pdf') {
          // PDF: Rust doesn't parse PDFs, so we render the cover + count pages
          // here via pdf.js, fetching the file straight from disk.
          try {
            const res = await fetch(getFileSrc(pending.uri));
            if (!res.ok) throw new Error('Не удалось прочитать PDF.');
            const pdfBlob = await res.blob();
            const pdfFile = new File([pdfBlob], pending.title, { type: 'application/pdf' });
            const { parsePDF } = await import('./utils/pdf');
            const parsed = await parsePDF(pdfFile, pending.title);
            pages = Array.from({ length: parsed.totalPages }, (_, i) => String(i + 1));
            coverBlob = parsed.coverBlob;
          } catch (err) {
            errorMsg = err instanceof Error ? err.message : 'Ошибка обработки PDF.';
            pages = [];
          }
        } else {
          // CBZ: Rust parses pages + cover natively (fast).
          const metadata = await getComicMetadataNative(pending.uri);

          if (metadata.error) {
            errorMsg = metadata.error;
            pages = [];
          } else if (metadata.pages.length === 0) {
            // Valid archive, but no images → not a comic.
            errorMsg = 'В файле нет изображений.';
            pages = [];
          } else {
            pages = metadata.pages;
            if (metadata.coverBase64) {
              coverBlob = base64ToBlob(metadata.coverBase64);
            }
          }
        }

        // FAIL-SAFE: if processing produced no pages, record metadataError so
        // this comic is never picked up again (otherwise → infinite loop).
        if (pages.length === 0 && !errorMsg) {
          errorMsg = 'Не удалось извлечь страницы.';
        }

        await saveComic(
          pending.id, pending.title, pending.size, pages, coverBlob,
          pending.uri, pending.format || 'cbz', pending.shelfId || null,
          errorMsg
        );

        const updatedList = await getAllComics();
        setComics(updatedList);
      } catch (err) {
        console.error('Queue processing error:', err);
        try {
          await saveComic(
            pending.id, pending.title, pending.size, [], null,
            pending.uri, 'cbz', pending.shelfId || null,
            err instanceof Error ? err.message : 'Неизвестная ошибка обработки'
          );
          const updatedList = await getAllComics();
          setComics(updatedList);
        } catch {
          /* ignore */
        }
      } finally {
        setIsProcessingQueue(false);
      }
    };

    const timer = setTimeout(runQueue, 1500); // 1.5s delay to keep UI snappy
    return () => clearTimeout(timer);
  }, [comics, isImporting, isProcessingQueue]);

  // Start the import flow by opening the target shelf selector modal
  const handleStartImportFlow = (files: FileList) => {
    setPendingFiles(files);
    setImportTargetShelfId(null);
    setIsImportModalOpen(true);
  };

  // Import files
  const handleImportFiles = async (files: FileList) => {
    if (!libraryFolderUri) {
      await messageDialog('Сначала выберите папку библиотеки.');
      return;
    }

    setIsImporting(true);
    setImportProgress('Копирование файлов в библиотеку...');

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // Tauri web File objects expose `name`; the absolute path is copied
        // by the Rust `import_file` command directly from the source path.
        // For desktop we rely on the File's name + the drag/drop path injected
        // by Tauri as `file.path` when available.
        const fileAny = file as any;
        const sourcePath = fileAny.path || fileAny.webkitRelativePath || file.name;

        setImportProgress(`Копирование ${file.name}...`);
        const ok = await importFileToLibrary(sourcePath, file.name, libraryFolderUri);
        if (!ok) {
          throw new Error(`Не удалось скопировать ${file.name}`);
        }
      }
    } catch (err) {
      console.error(err);
      await messageDialog('Ошибка при импорте.');
    } finally {
      setIsImporting(false);
      setImportProgress('');

      // Resync library after files are copied
      await syncLibrary(libraryFolderUri);
    }
  };

  // Select a comic for reading
  const handleSelectComic = async (id: string) => {
    setIsImporting(true);
    setImportProgress('Загрузка комикса из памяти устройства...');
    try {
      let comic = comics.find((c) => c.id === id);
      if (!comic) throw new Error('Комикс не найден.');

      // Lazy load metadata if it was not processed yet
      if (!comic.pages || comic.pages.length === 0) {
        setImportProgress('Анализ комикса...');

        if (comic.format === 'pdf') {
          // PDF is parsed entirely on the web layer via pdf.js (Rust doesn't
          // read PDFs). We fetch the file, extract the page count + cover.
          setImportProgress('Анализ PDF...');
          const fileUrl = getFileSrc(comic.uri);
          const res = await fetch(fileUrl);
          if (!res.ok) throw new Error('Не удалось прочитать PDF-файл.');
          const pdfBlob = await res.blob();
          const pdfFile = new File([pdfBlob], comic.title, { type: 'application/pdf' });

          const { parsePDF } = await import('./utils/pdf');
          const parsed = await parsePDF(pdfFile, comic.title);
          const pages = Array.from({ length: parsed.totalPages }, (_, index) => String(index + 1));
          comic = await saveComic(
            comic.id, comic.title, comic.size, pages, parsed.coverBlob,
            comic.uri, 'pdf', comic.shelfId || null
          );
          const list = await getAllComics();
          setComics(list);

          // Already have the file — open directly without re-fetching below.
          libraryScrollYRef.current = window.scrollY;
          setActiveComicFile(pdfFile);
          setActiveComicId(id);
          return;
        }

        // CBZ: Rust parses pages + cover natively (fast).
        const metadata = await getComicMetadataNative(comic.uri);
        if (metadata.error) {
          await saveComic(
            comic.id, comic.title, comic.size, [], null,
            comic.uri, metadata.format || 'cbz', comic.shelfId || null,
            metadata.error
          );
          const refreshed = await getAllComics();
          setComics(refreshed);
          throw new Error(metadata.error);
        }

        let coverBlob: Blob | null = null;
        if (metadata.coverBase64) {
          coverBlob = base64ToBlob(metadata.coverBase64);
        }
        comic = await saveComic(
          comic.id, comic.title, comic.size, metadata.pages, coverBlob,
          comic.uri, metadata.format || 'cbz', comic.shelfId || null
        );

        const list = await getAllComics();
        setComics(list);
      }

      // CBZ in Tauri: pages are streamed from disk one-by-one via Rust, so we
      // do NOT load the whole archive into RAM. PDF still needs the full file
      // because pdf.js parses the document structure in-memory.
      let file: File | null = null;
      if (comic.format === 'pdf') {
        const fileUrl = getFileSrc(comic.uri);
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error('Не удалось прочитать локальный файл.');
        const blob = await res.blob();
        file = new File([blob], comic.title, { type: blob.type });
      }

      libraryScrollYRef.current = window.scrollY;
      setActiveComicFile(file);
      setActiveComicId(id);
    } catch (err) {
      console.error('Error loading comic file:', err);
      await messageDialog(`Не удалось открыть комикс: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}`);
    } finally {
      setIsImporting(false);
      setImportProgress('');
    }
  };

  // Close reader
  const handleCloseReader = useCallback(() => {
    setActiveComicId(null);
    setActiveComicFile(null);

    requestAnimationFrame(() => {
      window.scrollTo(0, libraryScrollYRef.current);
    });

    clearImportCache();

    // Refresh progress state in library listing
    getAllComics().then((list) => {
      setComics(list);
    });
  }, []);

  // Resolve the physical-file deletion mode from settings.
  // Returns 'trash' | 'permanent' when physical deletion is enabled, or null
  // to mean "remove from library only, keep the file on disk".
  const physicalDeleteMode = (): 'trash' | 'permanent' | null => {
    const m = settings.deleteMode;
    return m === 'trash' || m === 'permanent' ? m : null;
  };

  // Delete a comic
  const handleDeleteComic = async (id: string) => {
    try {
      const comic = comics.find((c) => c.id === id);
      if (comic?.coverUrl) {
        URL.revokeObjectURL(comic.coverUrl);
      }
      await deleteComic(id);

      const delMode = physicalDeleteMode();
      if (delMode && comic) {
        await deleteSAFFile(comic.uri, delMode);
      }

      setComics((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      console.error('Failed to delete comic:', err);
      await messageDialog('Ошибка при удалении комикса.');
    }
  };

  // Clear library database
  const handleClearLibrary = async () => {
    try {
      setIsImporting(true);
      setImportProgress('Очистка библиотеки...');

      // Revoke all cover object URLs
      comics.forEach((c) => {
        if (c.coverUrl) URL.revokeObjectURL(c.coverUrl);
      });

      // Delete each comic
      for (const comic of comics) {
        await deleteComic(comic.id);
      }

      setComics([]);
    } catch (err) {
      console.error('Failed to clear database:', err);
      await messageDialog('Ошибка при очистке библиотеки.');
    } finally {
      setIsImporting(false);
      setImportProgress('');
    }
  };

  // Add new shelf
  const handleAddShelf = async (name: string) => {
    const id = `shelf_${Date.now()}`;
    await saveShelf(id, name);
    const list = await getAllShelves();
    setShelves(list);
    return id;
  };

  // Delete a shelf only — comics on it are unassigned (shelfId = null) by
  // deleteShelf(), but their DB records and physical files stay intact.
  // (The confirmation dialog promises "Книги не будут удалены".)
  const handleDeleteShelf = async (id: string) => {
    await deleteShelf(id);
    const sList = await getAllShelves();
    setShelves(sList);
    // Refresh comics listing so unassigned comics reappear in "All".
    const cList = await getAllComics();
    setComics(cList);
  };

  // Assign comic to shelf
  const handleAssignComicToShelf = async (comicId: string, shelfId: string | null) => {
    await assignComicToShelf(comicId, shelfId);
    const list = await getAllComics();
    setComics(list);
  };

  // Bulk delete comics
  const handleBulkDeleteComics = async (ids: string[]) => {
    if (await confirmDialog(`Удалить выбранные файлы (${ids.length})?`, 'Удаление')) {
      setIsImporting(true);
      setImportProgress('Удаление файлов...');
      try {
        const delMode = physicalDeleteMode();
        for (const id of ids) {
          const comic = comics.find((c) => c.id === id);
          if (comic?.coverUrl) URL.revokeObjectURL(comic.coverUrl);
          await deleteComic(id);

          if (delMode && comic) {
            await deleteSAFFile(comic.uri, delMode);
          }
        }
        const list = await getAllComics();
        setComics(list);
      } catch (err) {
        console.error('Failed bulk delete:', err);
        await messageDialog('Ошибка при пакетном удалении.');
      } finally {
        setIsImporting(false);
        setImportProgress('');
      }
    }
  };

  // Bulk assign comics to shelf
  const handleBulkAssignComicsToShelf = async (ids: string[], shelfId: string | null) => {
    setIsImporting(true);
    setImportProgress('Перемещение файлов...');
    try {
      for (const id of ids) {
        await assignComicToShelf(id, shelfId);
      }
      const list = await getAllComics();
      setComics(list);
    } catch (err) {
      console.error('Failed bulk shelf assignment:', err);
      await messageDialog('Ошибка при перемещении файлов.');
    } finally {
      setIsImporting(false);
      setImportProgress('');
    }
  };

  // Active comic metadata helper
  const activeComic = comics.find((c) => c.id === activeComicId);
  const shelfComics = activeComic
    ? comics.filter(c => c.shelfId === activeComic.shelfId)
    : [];

  // Splash screen while initializing (prevents "choose folder" flash)
  if (isInitializing) {
    return (
      <div className="app-splash">
        <span className="spinner" />
      </div>
    );
  }

  return (
    <>
      {/* Header */}
      {!activeComicId && (
        <header className="app-header">
          <div className="logo-container">
            <span className="logo-icon">
              <BookOpen size={28} strokeWidth={2.5} />
            </span>
            <h1 className="logo-text">ComiFlow</h1>
          </div>
          <div className="header-actions">
            <button
              className="btn-icon"
              onClick={() => setIsSettingsOpen(true)}
              aria-label="Настройки"
            >
              <SettingsIcon size={20} />
            </button>
          </div>
        </header>
      )}

      {/* Library View */}
      {!activeComicId && !libraryFolderUri && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center', backgroundColor: 'var(--bg-primary)' }}>
          <BookOpen style={{ width: '80px', height: '80px', marginBottom: '16px', color: 'var(--accent)', opacity: 0.5 }} />
          <h2 style={{ fontSize: '28px', fontWeight: 'bold', marginBottom: '16px', color: 'var(--text-primary)' }}>Добро пожаловать!</h2>

          <div style={{ maxWidth: '400px', width: '100%', backgroundColor: 'var(--bg-secondary)', borderRadius: '16px', boxShadow: 'var(--card-shadow)', border: '1px solid var(--border-color)', padding: '24px', marginBottom: '32px', textAlign: 'left' }}>
            <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '12px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>Инструкция по настройке:</h3>
            <ol style={{ paddingLeft: '20px', margin: 0, color: 'var(--text-secondary)', lineHeight: '1.5', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <li>Нажмите на кнопку ниже.</li>
              <li>Выберите папку, в которой хранятся ваши комиксы (например, создайте папку <b>ComiFlow</b>).</li>
              <li>Подтвердите выбор папки.</li>
            </ol>
          </div>

          <button
            onClick={selectLibraryFolder}
            className="btn btn-primary"
            style={{ width: '100%', maxWidth: '400px', padding: '16px', fontSize: '18px', fontWeight: 'bold', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}
          >
            <BookOpen size={24} />
            Выбрать папку библиотеки
          </button>
        </div>
      )}

      {!activeComicId && libraryFolderUri && (
        <Library
          comics={comics}
          onSelectComic={handleSelectComic}
          onDeleteComic={handleDeleteComic}
          onImportFiles={handleStartImportFlow}
          isImporting={isImporting}
          importProgress={importProgress}
          shelves={shelves}
          onAddShelf={handleAddShelf}
          onDeleteShelf={handleDeleteShelf}
          onAssignComicToShelf={handleAssignComicToShelf}
          onBulkDeleteComics={handleBulkDeleteComics}
          onBulkAssignComicsToShelf={handleBulkAssignComicsToShelf}
          activeShelfId={activeShelfId}
          setActiveShelfId={setActiveShelfId}
          onSyncLibrary={() => syncLibrary(libraryFolderUri)}
          isSelectMode={isSelectMode}
          setIsSelectMode={setIsSelectMode}
          initialScrollTop={libraryScrollYRef.current}
        />
      )}

      {/* Reader View */}
      {activeComicId && activeComic ? (
        <Reader
          key={activeComic.id}
          comic={activeComic}
          fileBlob={activeComicFile}
          settings={settings}
          onClose={handleCloseReader}
          onOpenSettings={() => setIsSettingsOpen(true)}
          shelfComics={shelfComics}
          onSelectComic={handleSelectComic}
        />
      ) : null}

      {/* Settings Panel */}
      {isSettingsOpen && (
        <Settings
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          onClearLibrary={handleClearLibrary}
          onChangeLibraryFolder={selectLibraryFolder}
          onSyncLibrary={() => libraryFolderUri && syncLibrary(libraryFolderUri)}
          libraryFolderUri={libraryFolderUri}
        />
      )}

      {/* Import Shelf Selection Modal */}
      {isImportModalOpen && pendingFiles && (
        <div className="settings-overlay active" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="settings-backdrop" onClick={() => setIsImportModalOpen(false)} />
          <div className="settings-panel" style={{ transform: 'none', position: 'relative', width: '90%', maxWidth: '400px', height: 'auto', borderRadius: '24px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px', overflow: 'hidden' }}>
            <div className="settings-header">
              <h3 className="settings-title">Импорт файлов</h3>
            </div>

            <div className="settings-section">
              <span className="settings-section-title">Выбранные файлы</span>
              <p style={{ fontSize: '14px', margin: 0, color: 'var(--text-secondary)' }}>
                Будет добавлено файлов: <strong>{pendingFiles.length}</strong>
              </p>
            </div>

            <div className="settings-section">
              <span className="settings-section-title">Выберите полку</span>
              <select
                className="card-shelf-select"
                style={{ fontSize: '13px', padding: '10px 32px 10px 12px' }}
                value={importTargetShelfId || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setImportTargetShelfId(val === '' ? null : val);
                }}
              >
                <option value="">Без полки (Главная)</option>
                {shelves.map((shelf) => (
                  <option key={shelf.id} value={shelf.id}>
                    Полка: {shelf.name}
                  </option>
                ))}
              </select>

              <button
                className="shelf-tab-btn shelf-tab-btn-add"
                style={{ width: '100%', marginTop: '4px', justifyContent: 'center', borderRadius: '12px' }}
                onClick={() => {
                  const name = prompt('Введите название новой полки:');
                  if (name && name.trim()) {
                    handleAddShelf(name.trim()).then((newId) => {
                      setImportTargetShelfId(newId);
                    });
                  }
                }}
              >
                + Создать новую полку
              </button>
            </div>

            <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={() => {
                  setIsImportModalOpen(false);
                  handleImportFiles(pendingFiles);
                  setPendingFiles(null);
                }}
              >
                Импортировать
              </button>
              <button
                className="btn"
                style={{ flex: 1, backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}
                onClick={() => {
                  setIsImportModalOpen(false);
                  setPendingFiles(null);
                }}
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
