import React, { useState, useEffect } from 'react';
import { X, Sun, Eye, Contrast, Layout, ArrowRightLeft, BookOpen, Volume2, Trash2, Gauge } from 'lucide-react';
import { confirmDialog } from '../utils/nativeBridge';

export interface ReaderSettings {
  theme: 'light-slate' | 'dark-slate' | 'oled-slate' | 
         'light-nord' | 'dark-nord' | 'oled-nord' | 
         'light-midnight' | 'dark-midnight' | 'oled-midnight' | 
         'light-dracula' | 'dark-dracula' | 'oled-dracula' | 
         'light-sepia' | 'dark-sepia' | 'oled-sepia' | 
         'light-evergreen' | 'dark-evergreen' | 'oled-evergreen' | 
         'light-amber' | 'dark-amber' | 'oled-amber' | 
         'light-sakura' | 'dark-sakura' | 'oled-sakura' | 
         'light-cyberpunk' | 'dark-cyberpunk' | 'oled-cyberpunk' | 
         'system';
  direction: 'ltr' | 'rtl';
  mode: 'paged' | 'webtoon';
  fitMode: 'contain' | 'width' | 'height';
  splitDoublePages: boolean;
  zoomLock: boolean;
  /** Режим листания клавишами громкости: off — выкл, single — по одной
   *  странице на нажатие, auto — непрерывная автопропрутка при удержании. */
  volumeKeysEnabled: 'off' | 'single' | 'auto';
  /** Скорость автопропрутки (режим 'auto'): интервал между страницами. */
  volumeKeySpeed: 'slow' | 'normal' | 'fast';
  brightness: number; // 50 to 150
  contrast: number; // 50 to 150
  deletePhysicalFile?: boolean; // legacy, migrated to deleteMode
  deleteMode?: 'off' | 'trash' | 'permanent';
}

const formatLibraryPath = (uri: string | null): string => {
  if (!uri) return '';
  try {
    const decoded = decodeURIComponent(uri);
    // Desktop (Tauri): the URI is already a full filesystem path — show it as-is.
    if (!decoded.startsWith('content://')) {
      return decoded;
    }
    // Android SAF: content://.../tree/primary:Path/To/Folder → /storage/emulated/0/Path/To/Folder
    const match = decoded.match(/(?:tree|document)\/([^/]+)/);
    if (match) {
      const pathPart = match[1];
      if (pathPart.includes(':')) {
        const [storage, ...pathSegments] = pathPart.split(':');
        const path = pathSegments.join(':');
        if (storage === 'primary') {
          return `/storage/emulated/0/${path}`;
        }
        return `/storage/${storage}/${path}`;
      }
      return pathPart;
    }
    return decoded;
  } catch {
    return uri;
  }
};

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  settings: ReaderSettings;
  onUpdateSettings: (newSettings: Partial<ReaderSettings>) => void;
  onClearLibrary: () => void;
  onChangeLibraryFolder: () => void;
  onSyncLibrary: () => void;
  libraryFolderUri: string | null;
}

export const Settings: React.FC<SettingsProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onClearLibrary,
  onChangeLibraryFolder,
  onSyncLibrary,
  libraryFolderUri,
}) => {
  const [storageUsage, setStorageUsage] = useState<string>('');

  useEffect(() => {
    if (isOpen) {
      updateStorageUsage();
    }
  }, [isOpen]);

  const updateStorageUsage = async () => {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        const usage = estimate.usage || 0;
        const quota = estimate.quota || 0;
        
        const formatSize = (bytes: number) => {
          const mb = bytes / (1024 * 1024);
          if (mb >= 1024) {
            return `${(mb / 1024).toFixed(1)} ГБ`;
          }
          return `${mb.toFixed(0)} МБ`;
        };
        
        setStorageUsage(`Хранилище: ${formatSize(usage)} из ${formatSize(quota)}`);
      }
      } catch {
        console.warn('Failed to get storage estimate');
      }
  };

  if (!isOpen) return null;

  return (
    <div className="settings-overlay active">
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-panel">
        <div className="settings-header">
          <h3 className="settings-title">Настройки</h3>
          <button className="btn-icon" onClick={onClose} aria-label="Закрыть">
            <X size={20} />
          </button>
        </div>

        {/* Хранилище */}
        <div className="settings-section">
          <span className="settings-section-title">Хранилище</span>
          
          {libraryFolderUri && (
            <div style={{ padding: '12px', marginBottom: '12px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Выбранная папка:</div>
              <div style={{ fontSize: '14px', fontFamily: 'monospace', color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                {formatLibraryPath(libraryFolderUri)}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {libraryFolderUri && (
              <button
                onClick={() => {
                  onSyncLibrary();
                  onClose();
                }}
                className="btn"
                style={{ width: '100%', justifyContent: 'center', backgroundColor: 'var(--accent)', color: '#fff' }}
              >
                Синхронизировать библиотеку
              </button>
            )}

            <button
              onClick={() => {
                onChangeLibraryFolder();
                onClose();
              }}
              className="btn"
              style={{ width: '100%', justifyContent: 'center', backgroundColor: 'var(--bg-tertiary)' }}
            >
              Сменить папку библиотеки
            </button>

            <button
              onClick={async () => {
                if (await confirmDialog('Вы уверены, что хотите удалить базу данных и отвязать папку? Файлы на устройстве останутся.', 'Очистка базы данных')) {
                  onClearLibrary();
                  onClose();
                }
              }}
              className="btn btn-danger"
              style={{ width: '100%', justifyContent: 'center' }}
            >
              Очистить базу данных
            </button>
          </div>

          {storageUsage && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '16px' }}>
              {storageUsage}
            </div>
          )}
        </div>

        {/* Theme Settings */}
        <div className="settings-section">
          <span className="settings-section-title">Тема оформления</span>
          <select
            value={settings.theme}
            onChange={(e) => onUpdateSettings({ theme: e.target.value as any })}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: '8px',
              backgroundColor: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-color)',
              outline: 'none',
              fontSize: '14px',
              cursor: 'pointer'
            }}
          >
            <option value="system">Авто (Системная)</option>
            <option value="light-slate">Светлый сланец (Slate)</option>
            <option value="dark-slate">Тёмный сланец (Slate)</option>
            <option value="oled-slate">OLED сланец (Slate)</option>
            <option value="light-nord">Светлый Nord</option>
            <option value="dark-nord">Тёмный Nord</option>
            <option value="oled-nord">OLED Nord</option>
            <option value="light-midnight">Светлый Токио (Midnight)</option>
            <option value="dark-midnight">Тёмный Токио (Midnight)</option>
            <option value="oled-midnight">OLED Токио (Midnight)</option>
            <option value="light-dracula">Светлый Dracula</option>
            <option value="dark-dracula">Тёмный Dracula</option>
            <option value="oled-dracula">OLED Dracula</option>
            <option value="light-sepia">Светлая сепия</option>
            <option value="dark-sepia">Тёмная сепия</option>
            <option value="oled-sepia">OLED сепия</option>
            <option value="light-evergreen">Светлый Evergreen</option>
            <option value="dark-evergreen">Тёмный Evergreen</option>
            <option value="oled-evergreen">OLED Evergreen</option>
            <option value="light-amber">Светлый янтарь (Amber)</option>
            <option value="dark-amber">Тёмный янтарь (Amber)</option>
            <option value="oled-amber">OLED янтарь (Amber)</option>
            <option value="light-sakura">Светлая сакура (Sakura)</option>
            <option value="dark-sakura">Тёмная сакура (Sakura)</option>
            <option value="oled-sakura">OLED сакура (Sakura)</option>
            <option value="light-cyberpunk">Светлый киберпанк</option>
            <option value="dark-cyberpunk">Тёмный киберпанк</option>
            <option value="oled-cyberpunk">OLED киберпанк</option>
          </select>
        </div>

        {/* Reading Direction */}
        <div className="settings-section">
          <span className="settings-section-title">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <ArrowRightLeft size={14} /> Направление чтения
            </span>
          </span>
          <div className="segmented-control">
            <button
              className={`segmented-btn ${settings.direction === 'ltr' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ direction: 'ltr' })}
            >
              Слева направо
            </button>
            <button
              className={`segmented-btn ${settings.direction === 'rtl' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ direction: 'rtl' })}
            >
              Справа налево (Манга)
            </button>
          </div>
        </div>

        {/* Reading Mode */}
        <div className="settings-section">
          <span className="settings-section-title">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <Layout size={14} /> Режим отображения
            </span>
          </span>
          <div className="segmented-control">
            <button
              className={`segmented-btn ${settings.mode === 'paged' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ mode: 'paged' })}
            >
              Постранично
            </button>
            <button
              className={`segmented-btn ${settings.mode === 'webtoon' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ mode: 'webtoon' })}
            >
              Лента (Webtoon)
            </button>
          </div>
        </div>

        {/* Fast Scroll Handle Position (Only for Webtoon Mode) */}
        {/* Page Fitting (Only for Paged Mode) */}
        {settings.mode === 'paged' && (
          <div className="settings-section">
            <span className="settings-section-title">Размер страниц</span>
            <div className="segmented-control">
              <button
                className={`segmented-btn ${settings.fitMode === 'contain' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ fitMode: 'contain' })}
              >
                Вписать в экран
              </button>
              <button
                className={`segmented-btn ${settings.fitMode === 'width' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ fitMode: 'width' })}
              >
                По ширине
              </button>
              <button
                className={`segmented-btn ${settings.fitMode === 'height' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ fitMode: 'height' })}
              >
                По высоте
              </button>
            </div>
          </div>
        )}

        {/* Adjustments (CSS Filters) */}
        <div className="settings-section">
          <span className="settings-section-title">Изображение</span>
          
          <div className="settings-option-row">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
              <Sun size={16} /> Яркость: {settings.brightness}%
            </span>
          </div>
          <div className="filter-slider-container">
            <input
              type="range"
              min="50"
              max="150"
              value={settings.brightness}
              onChange={(e) => onUpdateSettings({ brightness: parseInt(e.target.value) })}
              className="page-slider"
            />
          </div>

          <div className="settings-option-row">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
              <Contrast size={16} /> Контраст: {settings.contrast}%
            </span>
          </div>
          <div className="filter-slider-container">
            <input
              type="range"
              min="50"
              max="150"
              value={settings.contrast}
              onChange={(e) => onUpdateSettings({ contrast: parseInt(e.target.value) })}
              className="page-slider"
            />
          </div>
        </div>

        {/* Additional Toggles */}
        <div className="settings-section">
          <span className="settings-section-title">Дополнительные опции</span>
          
          {settings.mode === 'paged' && (
            <>
              <div className="settings-option-row">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                  <BookOpen size={16} /> Разделять развороты
                </span>
                <label className="switch-control">
                  <input
                    type="checkbox"
                    checked={settings.splitDoublePages}
                    onChange={(e) => onUpdateSettings({ splitDoublePages: e.target.checked })}
                  />
                  <span className="switch-slider"></span>
                </label>
              </div>

              <div className="settings-option-row">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                  <Eye size={16} /> Сохранять масштаб страниц
                </span>
                <label className="switch-control">
                  <input
                    type="checkbox"
                    checked={settings.zoomLock}
                    onChange={(e) => onUpdateSettings({ zoomLock: e.target.checked })}
                  />
                  <span className="switch-slider"></span>
                </label>
              </div>
            </>
          )}

          <div className="settings-option-row">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
              <Volume2 size={16} /> Листать кнопками громкости
            </span>
          </div>
          <div className="segmented-control" style={{ marginBottom: '6px' }}>
            <button
              className={`segmented-btn ${settings.volumeKeysEnabled === 'off' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ volumeKeysEnabled: 'off' })}
            >
              Выкл
            </button>
            <button
              className={`segmented-btn ${settings.volumeKeysEnabled === 'single' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ volumeKeysEnabled: 'single' })}
            >
              По одной
            </button>
            <button
              className={`segmented-btn ${settings.volumeKeysEnabled === 'auto' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ volumeKeysEnabled: 'auto' })}
            >
              Автопропрутка
            </button>
          </div>
          {/* Подсказка: что делает выбранный режим (чтобы «Выкл» не вызывал
              вопросов, а «Автопропрутка» не путала с автоскроллом ленты). */}
          <div style={{ fontSize: '12px', lineHeight: 1.4, opacity: 0.65, marginBottom: '10px' }}>
            {settings.volumeKeysEnabled === 'off' && 'Кнопки громкости не листают страницы.'}
            {settings.volumeKeysEnabled === 'single' && 'Одно нажатие кнопки громкости — одна страница.'}
            {settings.volumeKeysEnabled === 'auto' && 'Удерживайте кнопку громкости — страницы листаются непрерывно.'}
          </div>

          {/* Скорость автопропрутки. Видна ВСЕГДА (не только в режиме «Автопропрутка»),
              но активна только в нём — чтобы настройка не «пропадала». */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '4px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
              <Gauge size={16} /> Скорость автопропрутки
            </span>
            <div
              className="segmented-control"
              style={{
                opacity: settings.volumeKeysEnabled === 'auto' ? 1 : 0.45,
                pointerEvents: settings.volumeKeysEnabled === 'auto' ? 'auto' : 'none',
              }}
            >
              <button
                className={`segmented-btn ${settings.volumeKeySpeed === 'slow' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ volumeKeySpeed: 'slow' })}
              >
                Медленно
              </button>
              <button
                className={`segmented-btn ${settings.volumeKeySpeed === 'normal' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ volumeKeySpeed: 'normal' })}
              >
                Нормально
              </button>
              <button
                className={`segmented-btn ${settings.volumeKeySpeed === 'fast' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ volumeKeySpeed: 'fast' })}
              >
                Быстро
              </button>
            </div>
            {settings.volumeKeysEnabled !== 'auto' && (
              <div style={{ fontSize: '12px', opacity: 0.65 }}>
                Доступна в режиме «Автопропрутка»
              </div>
            )}
          </div>

          {/* Deletion mode: full-width select (like the theme select above) so
              the long Russian option text never overflows the narrow panel. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
              <Trash2 size={16} /> Удаление файлов с устройства
            </span>
            <select
              value={settings.deleteMode || 'off'}
              onChange={(e) => onUpdateSettings({ deleteMode: e.target.value as 'off' | 'trash' | 'permanent' })}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                backgroundColor: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                outline: 'none',
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              <option value="off">Не удалять (только из библиотеки)</option>
              <option value="trash">В корзину (можно восстановить)</option>
              <option value="permanent">Безвозвратно</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
};
