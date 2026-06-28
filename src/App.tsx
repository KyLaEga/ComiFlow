import { useState, useEffect, useCallback } from 'react';
import { Library } from './components/Library';
import { Reader } from './components/Reader';
import { Settings } from './components/Settings';
import type { ReaderSettings } from './components/Settings';
import { 
  getAllComics, 
  getComicFile, 
  deleteComic, 
  saveComic, 
  initDb,
  getAllShelves,
  saveShelf,
  deleteShelf,
  assignComicToShelf
} from './utils/db';
import type { ComicMetadata, Shelf } from './utils/db';
import { parseCBZ } from './utils/cbz';
import { parsePDF } from './utils/pdf';
import { BookOpen, Settings as SettingsIcon } from 'lucide-react';
import './App.css';


const LOCAL_STORAGE_KEY = 'comiflow_settings';

const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'dark',
  direction: 'ltr',
  mode: 'paged',
  fitMode: 'contain',
  splitDoublePages: true,
  zoomLock: false,
  volumeKeysEnabled: false,
  brightness: 100,
  contrast: 100,
};

function App() {
  const [comics, setComics] = useState<ComicMetadata[]>([]);
  const [activeComicId, setActiveComicId] = useState<string | null>(null);
  const [activeComicFile, setActiveComicFile] = useState<Blob | null>(null);
  
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState('');
  
  const [pendingFiles, setPendingFiles] = useState<FileList | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importTargetShelfId, setImportTargetShelfId] = useState<string | null>(null);
  
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [shelves, setShelves] = useState<Shelf[]>([]);

  // Initialize DB and Load Settings, Comics & Shelves
  useEffect(() => {
    initDb();
    
    // Load settings from localStorage
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSettings({ ...DEFAULT_SETTINGS, ...parsed });
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
  }, []);

  // Apply Theme Attribute to HTML Element
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  // Update Settings
  const handleUpdateSettings = useCallback((newSettings: Partial<ReaderSettings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Start the import flow by opening the target shelf selector modal
  const handleStartImportFlow = (files: FileList) => {
    setPendingFiles(files);
    setImportTargetShelfId(null);
    setIsImportModalOpen(true);
  };

  // Import files
  const handleImportFiles = async (files: FileList, shelfId: string | null = null) => {
    setIsImporting(true);
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const lowerName = file.name.toLowerCase();
      
      const isPdf = lowerName.endsWith('.pdf');
      const isCbz = lowerName.endsWith('.cbz') || lowerName.endsWith('.zip');
      
      if (!isPdf && !isCbz) {
        alert(`Файл "${file.name}" имеет неподдерживаемый формат. Используйте файлы .cbz, .zip или .pdf.`);
        continue;
      }

      try {
        const id = `comic_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        
        if (isPdf) {
          setImportProgress(`Файл ${i + 1} из ${files.length}: Чтение PDF "${file.name}"...`);
          const parsed = await parsePDF(file, file.name);

          setImportProgress(`Файл ${i + 1} из ${files.length}: Сохранение обложки и страниц...`);
          const pages = Array.from({ length: parsed.totalPages }, (_, index) => String(index + 1));
          await saveComic(id, parsed.title, file.size, pages, parsed.coverBlob, file, 'pdf');
          if (shelfId) {
            await assignComicToShelf(id, shelfId);
          }
        } else {
          setImportProgress(`Файл ${i + 1} из ${files.length}: Распаковка "${file.name}"...`);
          const parsed = await parseCBZ(file, file.name);

          setImportProgress(`Файл ${i + 1} из ${files.length}: Сохранение обложки и страниц...`);
          await saveComic(id, parsed.title, file.size, parsed.pages, parsed.coverBlob, file, 'cbz');
          if (shelfId) {
            await assignComicToShelf(id, shelfId);
          }
        }
      } catch (err) {
        console.error('Error importing file:', err);
        alert(`Не удалось загрузить "${file.name}": ${err instanceof Error ? err.message : 'Неизвестная ошибка'}`);
      }
    }

    // Refresh Library List
    setImportProgress('Обновление библиотеки...');
    try {
      const list = await getAllComics();
      // Revoke old object URLs first to prevent memory leak
      comics.forEach((c) => {
        if (c.coverUrl) URL.revokeObjectURL(c.coverUrl);
      });
      setComics(list);
    } catch (err) {
      console.error('Failed to refresh library:', err);
    } finally {
      setIsImporting(false);
      setImportProgress('');
    }
  };

  // Select a comic for reading
  const handleSelectComic = async (id: string) => {
    setIsImporting(true);
    setImportProgress('Загрузка комикса из памяти устройства...');
    try {
      const file = await getComicFile(id);
      if (!file) {
        throw new Error('Файл комикса не найден в локальной базе данных.');
      }
      setActiveComicFile(file);
      setActiveComicId(id);
    } catch (err) {
      console.error('Error loading comic file:', err);
      alert(`Не удалось открыть комикс: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}`);
    } finally {
      setIsImporting(false);
      setImportProgress('');
    }
  };

  // Close reader
  const handleCloseReader = useCallback(() => {
    setActiveComicId(null);
    setActiveComicFile(null);
    
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

  // Delete shelf (comics remain intact but lose reference)
  const handleDeleteShelf = async (id: string) => {
    await deleteShelf(id);
    const sList = await getAllShelves();
    setShelves(sList);
    // Refresh comics listing since shelfIds were set to null
    const cList = await getAllComics();
    setComics(cList);
  };

  // Assign comic to shelf
  const handleAssignComicToShelf = async (comicId: string, shelfId: string | null) => {
    await assignComicToShelf(comicId, shelfId);
    const list = await getAllComics();
    setComics(list);
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
      {!activeComicId && (
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
        />
      )}

      {/* Reader View */}
      {activeComicId && activeComic && activeComicFile && (
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
      )}

      {/* Settings Panel */}
      <Settings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        onClearLibrary={handleClearLibrary}
      />

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
                  handleImportFiles(pendingFiles, importTargetShelfId);
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
