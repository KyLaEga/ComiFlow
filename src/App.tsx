import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
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

const Reader = lazy(() => import('./components/Reader').then(m => ({ default: m.Reader })));
const Settings = lazy(() => import('./components/Settings').then(m => ({ default: m.Settings })));
import './App.css';


const LOCAL_STORAGE_KEY = 'comiflow_settings';

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
};

const base64ToBlob = (base64: string, mimeType: string): Blob => {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
};

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
  deletePhysicalFile: false,
};

const updateNativeVolumeKeysState = (enabled: boolean) => {
  const bridge = (window as any).ComiFlowBridge;
  if (bridge && typeof bridge.setVolumeKeysEnabled === 'function') {
    try {
      bridge.setVolumeKeysEnabled(enabled);
    } catch (e) {
      console.error('Failed to communicate volume key setting to native bridge:', e);
    }
  }
};

function App() {
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

  // Keep refs for the backButton listener to avoid re-binding it
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

  // Handle hardware back button
  useEffect(() => {
    let backSub: any = null;
    CapacitorApp.addListener('backButton', () => {
      if (activeComicIdRef.current) {
        // If comic is open, close it
        setActiveComicId(null);
        setActiveComicFile(null);
        
        requestAnimationFrame(() => {
          window.scrollTo(0, libraryScrollYRef.current);
        });

        // Clear import cache immediately
        const bridge = (window as any).ComiFlowBridge;
        if (bridge && typeof bridge.clearImportCache === 'function') {
          bridge.clearImportCache();
        }

        // Refresh progress state in library listing
        getAllComics().then((list) => {
          setComics(list);
        });
      } else if (isSettingsOpenRef.current) {
        // If settings panel is open, close it
        setIsSettingsOpen(false);
      } else if (isSelectModeRef.current) {
        // If items selection mode is active, exit select mode
        setIsSelectMode(false);
      } else {
        // Otherwise exit app
        CapacitorApp.exitApp();
      }
    }).then(sub => {
      backSub = sub;
    });

    return () => {
      if (backSub) {
        backSub.remove();
      }
    };
  }, []);

  // Open file from Android content:// URI
  const handleOpenFileFromUri = async (uri: string) => {
    const bridge = (window as any).ComiFlowBridge;
    if (bridge && typeof bridge.copyContentUriToCache === 'function') {
      const nativePath = bridge.copyContentUriToCache(uri);
      if (nativePath) {
        await handleOpenFileFromNativePath(nativePath);
      } else {
        alert('Не удалось получить доступ к файлу на устройстве.');
      }
    }
  };

  // Open file from native path (Capacitor local file URL)
  const handleOpenFileFromNativePath = async (nativePath: string) => {
    if (!libraryFolderUri) {
      alert('Сначала выберите папку библиотеки, чтобы открывать файлы извне.');
      return;
    }
    
    setIsImporting(true);
    setImportProgress('Добавление файла в библиотеку...');
    try {
      const baseName = nativePath.split('/').pop() || 'imported_file';
      const cleanName = baseName.replace(/^open_\d+_/, '');
      
      const bridge = (window as any).ComiFlowBridge;
      if (bridge && typeof bridge.importFileToLibrary === 'function') {
         bridge.importFileToLibrary(nativePath, cleanName, libraryFolderUri);
         await syncLibrary(libraryFolderUri);
         
         const list = await getAllComics();
         setComics(list);
         
         // Find the newly added comic
         const newComic = list.find(c => c.title === cleanName || c.uri.includes(cleanName));
         if (newComic) {
           await handleSelectComic(newComic.id);
         }
      }
    } catch (err) {
      console.error('Failed to open file from native path:', err);
      alert(`Не удалось открыть файл: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}`);
    } finally {
      setIsImporting(false);
      setImportProgress('');
    }
  };

  // Helper to parse and save a single file during sync
  const parseAndSaveNewComic = async (
    file: File | Blob, 
    originalName: string, 
    isPdf: boolean, 
    uri: string,
    shelfId: string | null
  ) => {
    try {
      const id = `comic_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      
      if (isPdf) {
        setImportProgress(`Обработка PDF "${originalName}"...`);
        const { parsePDF } = await import('./utils/pdf');
        const parsed = await parsePDF(file as File, originalName);
        const pages = Array.from({ length: parsed.totalPages }, (_, index) => String(index + 1));
        await saveComic(id, parsed.title, file.size, pages, parsed.coverBlob, uri, 'pdf', shelfId);
      } else {
        setImportProgress(`Распаковка "${originalName}"...`);
        const { parseCBZ } = await import('./utils/cbz');
        const parsed = await parseCBZ(file, originalName);

        if (parsed.type === 'collection') {
          setImportProgress(`Вложенные архивы временно не поддерживаются в SAF-режиме.`);
          await new Promise(r => setTimeout(r, 2000));
        } else {
          setImportProgress(`Сохранение "${originalName}"...`);
          await saveComic(id, parsed.title, file.size, parsed.pages, parsed.coverBlob, uri, 'cbz', shelfId);
        }
      }
    } catch (err) {
      console.error(`Error importing file ${originalName}:`, err);
      const errMsg = err instanceof Error ? err.message : 'Неизвестная ошибка';
      const isCorruptedZip = errMsg.toLowerCase().includes("can't find end of central directory");
      const userFriendlyMsg = isCorruptedZip 
        ? `Архив повреждён или имеет неподдерживаемый формат.`
        : errMsg;
      setImportProgress(`Ошибка: ${originalName} - ${userFriendlyMsg}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  };

  // Sync SAF library
  const syncLibrary = async (folderUri: string, silent: boolean = false) => {
    if (!silent) {
      setIsImporting(true);
      setImportProgress('Синхронизация библиотеки...');
    }
    try {
      const bridge = (window as any).ComiFlowBridge;
      if (bridge && typeof bridge.listLibraryFiles === 'function') {
        const filesJson = bridge.listLibraryFiles(folderUri);
        const safFiles = JSON.parse(filesJson);
        
        const existingComics = await getAllComics();
        const existingUris = new Set(existingComics.map(c => c.uri));
        
        // Find deleted files
        const safUris = new Set(safFiles.map((f: any) => f.uri));
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
             if (typeof bridge.getComicMetadataNative === 'function') {
                if (!silent) setImportProgress(`Добавление ${file.name}...`);
                const id = `comic_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
                const isPdf = file.name.toLowerCase().endsWith('.pdf');
                const format = isPdf ? 'pdf' : 'cbz';
                const title = file.name.replace(/\.[^/.]+$/, "");
                await saveComic(id, title, file.size, [], null, file.uri, format, targetShelfId);
                importedCount++;
             } else {
               if (!silent) setImportProgress(`Чтение нового файла: ${file.name}...`);
               // Copy to cache to parse (Legacy fallback)
               const nativePath = bridge.copyContentUriToCache(file.uri);
               if (nativePath) {
                 const capUrl = (window as any).Capacitor 
                   ? (window as any).Capacitor.convertFileSrc(nativePath)
                   : `http://localhost/_capacitor_file_${nativePath}`;
                 
                 const res = await fetch(capUrl);
                 if (res.ok) {
                   const blob = await res.blob();
                   const fObj = new File([blob], file.name, { type: blob.type });
                   const lowerName = file.name.toLowerCase();
                   const isPdf = lowerName.endsWith('.pdf');
                   await parseAndSaveNewComic(fObj, file.name, isPdf, file.uri, targetShelfId);
                   importedCount++;
                 }
               }
             }
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
      }
    } catch (err) {
      console.error(err);
      if (!silent) alert('Ошибка при синхронизации папки библиотеки.');
    } finally {
      const bridge = (window as any).ComiFlowBridge;
      if (bridge && typeof bridge.clearImportCache === 'function') {
        bridge.clearImportCache();
      }
      if (!silent) {
        setIsImporting(false);
        setImportProgress('');
      }
    }
  };

  const selectLibraryFolder = () => {
    const bridge = (window as any).ComiFlowBridge;
    if (bridge && typeof bridge.selectLibraryFolder === 'function') {
      bridge.selectLibraryFolder();
    } else {
      alert('Выбор папки библиотеки поддерживается только на Android.');
    }
  };

  // Initialize DB and Load Settings, Comics & Shelves
  useEffect(() => {
    initDb();
    migrateCovers().catch(err => console.error('Failed to migrate covers:', err));
    
    const handleFolderSelected = (e: any) => {
      const uri = e.detail?.uri;
      if (uri) {
        setLibraryFolderUri(uri);
        syncLibrary(uri);
      }
    };
    window.addEventListener('libraryFolderSelected', handleFolderSelected);
    
    // Clear any leftover import caches from previous sessions
    const bridge = (window as any).ComiFlowBridge;
    if (bridge) {
      if (typeof bridge.clearImportCache === 'function') {
        bridge.clearImportCache();
      }
      if (typeof bridge.getLibraryFolderUri === 'function') {
        const uri = bridge.getLibraryFolderUri();
        if (uri) {
          setLibraryFolderUri(uri);
          syncLibrary(uri, true);
        }
      }
    }
    
    // Load settings from localStorage
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSettings({ ...DEFAULT_SETTINGS, ...parsed });
        if (parsed.volumeKeysEnabled !== undefined) {
          updateNativeVolumeKeysState(parsed.volumeKeysEnabled);
        }
      } catch (e) {
        console.warn('Failed to parse saved settings', e);
      }
    }

    // Load comics from DB
    const loadComics = async () => {
      try {
        const list = await getAllComics();
        setComics(list);
      } catch (err) {
        console.error('Failed to load library:', err);
      }
    };
    
    // Load shelves from DB
    const loadShelves = async () => {
      try {
        const list = await getAllShelves();
        setShelves(list);
      } catch (err) {
        console.error('Failed to load shelves:', err);
      }
    };

    loadComics();
    loadShelves();

    // Check for file association intent opening on launch
    setTimeout(() => {
      const bridge = (window as any).ComiFlowBridge;
      if (bridge && typeof bridge.getPendingFileUri === 'function') {
        const uri = bridge.getPendingFileUri();
        if (uri) {
          handleOpenFileFromUri(uri);
        }
      }
    }, 1000);
  }, []);

  // Listen to new file open intents while app is running
  useEffect(() => {
    const handleNativeFile = (e: Event) => {
      const customEvent = e as CustomEvent<{ uri: string }>;
      if (customEvent.detail && customEvent.detail.uri) {
        handleOpenFileFromUri(customEvent.detail.uri);
      }
    };
    
    window.addEventListener('nativeOpenFile', handleNativeFile);
    return () => {
      window.removeEventListener('nativeOpenFile', handleNativeFile);
    };
  }, [comics]);

  // Apply Theme Attribute to HTML Element
  useEffect(() => {
    const applyTheme = () => {
      let resolvedTheme = settings.theme;
      if (settings.theme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        resolvedTheme = isDark ? 'dark' : 'light';
      }
      document.documentElement.setAttribute('data-theme', resolvedTheme);
    };

    applyTheme();

    if (settings.theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = (e: MediaQueryListEvent) => {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
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
        updateNativeVolumeKeysState(newSettings.volumeKeysEnabled);
      }
      return updated;
    });
  }, []);

  // Background metadata loader worker
  useEffect(() => {
    if (isImporting || isProcessingQueue) return;

    const runQueue = async () => {
      // Find one comic without metadata (empty pages)
      const pending = comics.find((c) => !c.pages || c.pages.length === 0);
      if (!pending) return;

      setIsProcessingQueue(true);
      try {
        const bridge = (window as any).ComiFlowBridge;
        if (bridge && typeof bridge.getComicMetadataNative === 'function') {
          const metaJson = bridge.getComicMetadataNative(pending.uri);
          const metadata = JSON.parse(metaJson);
          if (!metadata.error) {
            const coverBlob = base64ToBlob(metadata.coverBase64, 'image/jpeg');
            const pages = metadata.format === 'pdf'
              ? Array.from({ length: metadata.totalPages }, (_, index) => String(index + 1))
              : metadata.pages;
            
            await saveComic(pending.id, pending.title, pending.size, pages, coverBlob, pending.uri, metadata.format, pending.shelfId || null);
            
            const updatedList = await getAllComics();
            setComics(updatedList);
          }
        }
      } catch (err) {
        console.error('Queue processing error:', err);
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
      alert('Сначала выберите папку библиотеки.');
      return;
    }
    
    setIsImporting(true);
    setImportProgress('Копирование файлов в библиотеку...');
    
    try {
      const bridge = (window as any).ComiFlowBridge;
      if (bridge) {
        const CHUNK_SIZE = 1024 * 1024; // 1MB chunk size
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const fileAny = file as any;
          
          if (fileAny.path && typeof bridge.importFileToLibrary === 'function') { // Capacitor injects path on Android
             setImportProgress(`Копирование ${file.name}...`);
             bridge.importFileToLibrary(fileAny.path, file.name, libraryFolderUri);
          } else if (typeof bridge.startChunkedImport === 'function') {
             setImportProgress(`Подготовка к копированию ${file.name}...`);
             const importId = bridge.startChunkedImport(file.name, file.size, libraryFolderUri);
             if (!importId) throw new Error(`Не удалось начать импорт ${file.name}`);
             
             let offset = 0;
             const totalSize = file.size;
             
             while (offset < totalSize) {
               const chunk = file.slice(offset, offset + CHUNK_SIZE);
               const arrayBuffer = await chunk.arrayBuffer();
               const base64 = arrayBufferToBase64(arrayBuffer);
               
               const success = bridge.appendChunk(importId, base64);
               if (!success) {
                 bridge.cancelChunkedImport(importId);
                 throw new Error(`Ошибка передачи данных для ${file.name}`);
               }
               
               offset += CHUNK_SIZE;
               const progress = Math.min(100, Math.round((offset / totalSize) * 100));
               setImportProgress(`Копирование ${file.name}: ${progress}%`);
             }
             
             const finished = bridge.finishChunkedImport(importId);
             if (!finished) {
               throw new Error(`Не удалось завершить копирование ${file.name}`);
             }
          } else {
             alert('Прямое добавление файлов поддерживается только в Android приложении.');
          }
        }
      }
    } catch (err) {
      console.error(err);
      alert('Ошибка при импорте.');
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
        const bridge = (window as any).ComiFlowBridge;
        if (bridge && typeof bridge.getComicMetadataNative === 'function') {
          const metaJson = bridge.getComicMetadataNative(comic.uri);
          const metadata = JSON.parse(metaJson);
          if (metadata.error) throw new Error(metadata.error);

          const coverBlob = base64ToBlob(metadata.coverBase64, 'image/jpeg');
          const pages = metadata.format === 'pdf'
            ? Array.from({ length: metadata.totalPages }, (_, index) => String(index + 1))
            : metadata.pages;

          comic = await saveComic(comic.id, comic.title, comic.size, pages, coverBlob, comic.uri, metadata.format, comic.shelfId || null);
          
          // Refresh state list
          const list = await getAllComics();
          setComics(list);
        }
      }
      
      const capUrl = (window as any).Capacitor 
        ? (window as any).Capacitor.convertFileSrc(comic.uri)
        : comic.uri;
        
      const res = await fetch(capUrl);
      if (!res.ok) throw new Error('Не удалось прочитать локальный файл.');
      const blob = await res.blob();
      const file = new File([blob], comic.title, { type: blob.type });
      
      libraryScrollYRef.current = window.scrollY;
      setActiveComicFile(file);
      setActiveComicId(id);
    } catch (err) {
      console.error('Error loading comic file:', err);
      alert(`Не удалось открыть комикс: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}`);
      handleDeleteComic(id);
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
    
    const bridge = (window as any).ComiFlowBridge;
    if (bridge && typeof bridge.clearImportCache === 'function') {
      bridge.clearImportCache();
    }
    
    // Refresh progress state in library listing
    getAllComics().then((list) => {
      setComics(list);
    });
  }, []);

  // Delete a comic
  const handleDeleteComic = async (id: string) => {
    try {
      const comic = comics.find((c) => c.id === id);
      if (comic?.coverUrl) {
        URL.revokeObjectURL(comic.coverUrl);
      }
      await deleteComic(id);
      
      if (settings.deletePhysicalFile && comic) {
        const bridge = (window as any).ComiFlowBridge;
        if (bridge && typeof bridge.deleteSAFFile === 'function') {
          bridge.deleteSAFFile(comic.uri);
        }
      }

      setComics((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      console.error('Failed to delete comic:', err);
      alert('Ошибка при удалении комикса.');
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
      alert('Ошибка при очистке библиотеки.');
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

  // Delete shelf and optionally its comics
  const handleDeleteShelf = async (id: string) => {
    try {
      const bridge = (window as any).ComiFlowBridge;
      const shelfComics = comics.filter((c) => c.shelfId === id);
      
      for (const comic of shelfComics) {
        if (comic.coverUrl) URL.revokeObjectURL(comic.coverUrl);
        await deleteComic(comic.id);
        
        if (settings.deletePhysicalFile && bridge && typeof bridge.deleteSAFFile === 'function') {
          bridge.deleteSAFFile(comic.uri);
        }
      }
    } catch (e) {
      console.error('Failed to delete comics for shelf:', e);
    }
    
    await deleteShelf(id);
    const sList = await getAllShelves();
    setShelves(sList);
    // Refresh comics listing
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
    if (window.confirm(`Удалить выбранные файлы (${ids.length})?`)) {
      setIsImporting(true);
      setImportProgress('Удаление файлов...');
      try {
        const bridge = (window as any).ComiFlowBridge;
        for (const id of ids) {
          const comic = comics.find((c) => c.id === id);
          if (comic?.coverUrl) URL.revokeObjectURL(comic.coverUrl);
          await deleteComic(id);
          
          if (settings.deletePhysicalFile && comic && bridge && typeof bridge.deleteSAFFile === 'function') {
            bridge.deleteSAFFile(comic.uri);
          }
        }
        const list = await getAllComics();
        setComics(list);
      } catch (err) {
        console.error('Failed bulk delete:', err);
        alert('Ошибка при пакетном удалении.');
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
      alert('Ошибка при перемещении файлов.');
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
              <li>Выберите любое расположение (например, папку <b>Документы</b>).</li>
              <li>Создайте новую папку для ваших комиксов (назовите её, например, <b>ComiFlow</b>) или выберите существующую.</li>
              <li>Нажмите <b>«Использовать эту папку»</b>.</li>
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
      {activeComicId && activeComic && activeComicFile ? (
        <Suspense fallback={<div className="flex h-screen items-center justify-center text-white"><div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#ff3366]"></div></div>}>
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
        </Suspense>
      ) : null}

      {/* Settings Panel */}
      {isSettingsOpen && (
        <Suspense fallback={<div className="flex h-screen items-center justify-center text-white"><div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#ff3366]"></div></div>}>
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
        </Suspense>
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
