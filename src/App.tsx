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
  initDb 
} from './utils/db';
import type { ComicMetadata } from './utils/db';
import { parseCBZ } from './utils/cbz';
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
  
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);

  // Initialize DB and Load Settings & Comics
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
    loadComics();
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

  // Import files
  const handleImportFiles = async (files: FileList) => {
    setIsImporting(true);
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const lowerName = file.name.toLowerCase();
      
      if (!lowerName.endsWith('.cbz') && !lowerName.endsWith('.zip')) {
        alert(`Файл "${file.name}" имеет неподдерживаемый формат. Используйте файлы .cbz или .zip.`);
        continue;
      }

      try {
        setImportProgress(`Файл ${i + 1} из ${files.length}: Распаковка "${file.name}"...`);
        const parsed = await parseCBZ(file, file.name);

        setImportProgress(`Файл ${i + 1} из ${files.length}: Сохранение обложки и страниц...`);
        const id = `comic_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        
        await saveComic(id, parsed.title, file.size, parsed.pages, parsed.coverBlob, file);
      } catch (err) {
        console.error('Error importing comic:', err);
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

  // Active comic metadata helper
  const activeComic = comics.find((c) => c.id === activeComicId);

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
          onImportFiles={handleImportFiles}
          isImporting={isImporting}
          importProgress={importProgress}
        />
      )}

      {/* Reader View */}
      {activeComicId && activeComic && activeComicFile && (
        <Reader
          comic={activeComic}
          fileBlob={activeComicFile}
          settings={settings}
          onClose={handleCloseReader}
          onOpenSettings={() => setIsSettingsOpen(true)}
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
    </>
  );
}

export default App;
