import React, { useState, useRef } from 'react';
import type { ComicMetadata, Shelf } from '../utils/db';
import { BookOpen, Plus, Search, Trash2, FolderOpen, AlertTriangle } from 'lucide-react';


interface LibraryProps {
  comics: ComicMetadata[];
  onSelectComic: (id: string) => void;
  onDeleteComic: (id: string) => void;
  onImportFiles: (files: FileList) => void;
  isImporting: boolean;
  importProgress: string;
  shelves: Shelf[];
  onAddShelf: (name: string) => void;
  onDeleteShelf: (id: string) => void;
  onAssignComicToShelf: (comicId: string, shelfId: string | null) => void;
}

export const Library: React.FC<LibraryProps> = ({
  comics,
  onSelectComic,
  onDeleteComic,
  onImportFiles,
  isImporting,
  importProgress,
  shelves,
  onAddShelf,
  onDeleteShelf,
  onAssignComicToShelf,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'added' | 'title' | 'recent'>('added');
  const [isDragActive, setIsDragActive] = useState(false);
  const [activeShelfId, setActiveShelfId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragActive(true);
    } else if (e.type === 'dragleave') {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      // Filter out non-cbz files (though we can accept standard zip as well since cbz is zip)
      onImportFiles(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onImportFiles(e.target.files);
    }
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  // Format bytes to readable size
  const formatBytes = (bytes: number, decimals = 1) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  };

  // Filter and Sort comics
  const filteredComics = comics.filter((comic) => {
    const matchesSearch = comic.title.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;
    
    if (activeShelfId === 'uncategorized') {
      return !comic.shelfId;
    }
    if (activeShelfId !== null) {
      return comic.shelfId === activeShelfId;
    }
    return true;
  });

  const sortedComics = [...filteredComics].sort((a, b) => {
    if (sortBy === 'title') {
      return a.title.localeCompare(b.title);
    }
    if (sortBy === 'recent') {
      const timeA = a.lastReadAt || 0;
      const timeB = b.lastReadAt || 0;
      // Put read items first, sorted by last read time
      return timeB - timeA;
    }
    // Default: 'added' (newest first)
    return b.addedAt - a.addedAt;
  });

  return (
    <div className="library-container">
      {/* Dropzone / Upload area */}
      <div
        className={`dropzone ${isDragActive ? 'drag-active' : ''}`}
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={triggerFileSelect}
      >
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".cbz,.zip,.pdf"
          multiple
          style={{ display: 'none' }}
        />
        <div className="dropzone-icon">
          <Plus size={32} />
        </div>
        <div className="dropzone-text">Загрузите файлы (.cbz, .zip, .pdf)</div>
        <div className="dropzone-subtext">
          Перетащите файлы сюда или нажмите для выбора на устройстве
        </div>
      </div>

      {/* Shelves/Folders Tabs */}
      <div className="shelves-tab-container">
        <button
          className={`shelf-tab-btn ${activeShelfId === null ? 'active' : ''}`}
          onClick={() => setActiveShelfId(null)}
        >
          Все файлы
        </button>
        <button
          className={`shelf-tab-btn ${activeShelfId === 'uncategorized' ? 'active' : ''}`}
          onClick={() => setActiveShelfId('uncategorized')}
        >
          Без полки
        </button>
        {shelves.map((shelf) => (
          <button
            key={shelf.id}
            className={`shelf-tab-btn ${activeShelfId === shelf.id ? 'active' : ''}`}
            onClick={() => setActiveShelfId(shelf.id)}
          >
            {shelf.name}
            <span
              className="btn-delete-shelf"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Удалить полку "${shelf.name}"? Книги не будут удалены.`)) {
                  onDeleteShelf(shelf.id);
                  if (activeShelfId === shelf.id) {
                    setActiveShelfId(null);
                  }
                }
              }}
              title="Удалить полку"
            >
              ×
            </span>
          </button>
        ))}
        <button
          className="shelf-tab-btn shelf-tab-btn-add"
          onClick={() => {
            const name = prompt('Введите название новой полки:');
            if (name && name.trim()) {
              onAddShelf(name.trim());
            }
          }}
        >
          <Plus size={14} /> Новая полка
        </button>
      </div>

      {/* Library Controls */}
      {comics.length > 0 && (
        <div className="library-controls">
          <div className="search-bar">
            <Search className="search-icon" size={18} />
            <input
              type="text"
              placeholder="Поиск в библиотеке..."
              className="search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="filter-options">
            <select
              className="select-input"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
            >
              <option value="added">Сначала новые</option>
              <option value="recent">Недавно прочитанные</option>
              <option value="title">По названию</option>
            </select>
          </div>
        </div>
      )}

      {/* Comics Grid */}
      {sortedComics.length > 0 ? (
        <div className="comic-grid">
          {sortedComics.map((comic) => {
            const progressPercent = Math.round((comic.currentPage / (comic.totalPages - 1 || 1)) * 100);
            
            return (
              <div className="comic-card" key={comic.id}>
                {/* Actions overlay */}
                <div className="card-actions-overlay">
                  <button
                    className="card-btn-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`Удалить комикс "${comic.title}"?`)) {
                        onDeleteComic(comic.id);
                      }
                    }}
                    title="Удалить"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>

                {/* Cover Image Wrapper */}
                <div className="card-cover-wrapper" onClick={() => onSelectComic(comic.id)}>
                  {comic.coverUrl ? (
                    <img
                      src={comic.coverUrl}
                      alt={comic.title}
                      className="card-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="empty-cover-placeholder">
                      <BookOpen size={48} />
                    </div>
                  )}

                  {/* Reading Progress Indicator */}
                  {comic.currentPage > 0 && (
                    <>
                      <div
                        className="card-progress-bar"
                        style={{ width: `${progressPercent}%` }}
                      />
                      <span className="card-progress-badge">
                        {progressPercent}%
                      </span>
                    </>
                  )}
                </div>

                {/* Details Section */}
                <div className="card-details">
                  <h4 
                    className="card-title" 
                    onClick={() => onSelectComic(comic.id)}
                    title={comic.title}
                  >
                    {comic.title}
                  </h4>
                  <div className="card-meta">
                    <span>{comic.totalPages} стр.</span>
                    <span>{formatBytes(comic.size)}</span>
                  </div>
                  
                  {/* Shelf select dropdown */}
                  <div className="card-shelf-select-container">
                    <select
                      className="card-shelf-select"
                      value={comic.shelfId || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        onAssignComicToShelf(comic.id, val === '' ? null : val);
                      }}
                      onClick={(e) => e.stopPropagation()} // Prevent card opening reader
                    >
                      <option value="">Без полки</option>
                      {shelves.map((shelf) => (
                        <option key={shelf.id} value={shelf.id}>
                          Полка: {shelf.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        comics.length > 0 && (
          <div className="empty-state">
            <AlertTriangle className="empty-icon" size={48} />
            <h2>Ничего не найдено</h2>
            <p>Попробуйте изменить поисковый запрос</p>
          </div>
        )
      )}

      {/* Big Initial Empty State */}
      {comics.length === 0 && !isImporting && (
        <div className="empty-state" style={{ padding: '80px 24px' }}>
          <FolderOpen className="empty-icon" size={64} style={{ color: 'var(--accent)', opacity: 0.8 }} />
          <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '24px', marginTop: '16px' }}>
            Ваша библиотека пуста
          </h2>
          <p style={{ maxWidth: '400px', margin: '0 auto', fontSize: '15px' }}>
            Загрузите свои любимые комиксы, мангу или книги в формате .cbz, .zip или .pdf, чтобы начать чтение.
          </p>
        </div>
      )}

      {/* Loading Overlay for Imports */}
      {isImporting && (
        <div className="loading-overlay">
          <div className="spinner"></div>
          <div className="loading-text">Импорт комиксов...</div>
          <div style={{ fontSize: '14px', opacity: 0.8 }}>{importProgress}</div>
        </div>
      )}
    </div>
  );
};
