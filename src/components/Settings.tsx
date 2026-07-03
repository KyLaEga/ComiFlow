import React, { useState, useEffect } from 'react';
import { X, Sun, Eye, Contrast, Layout, ArrowRightLeft, BookOpen, Volume2 } from 'lucide-react';

export interface ReaderSettings {
  theme: 'light' | 'dark' | 'oled';
  direction: 'ltr' | 'rtl';
  mode: 'paged' | 'webtoon';
  fitMode: 'contain' | 'width' | 'height';
  splitDoublePages: boolean;
  zoomLock: boolean;
  volumeKeysEnabled: boolean;
  brightness: number; // 50 to 150
  contrast: number; // 50 to 150
}

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  settings: ReaderSettings;
  onUpdateSettings: (newSettings: Partial<ReaderSettings>) => void;
  onClearLibrary: () => void;
  onChangeLibraryFolder: () => void;
  libraryFolderUri: string | null;
}

export const Settings: React.FC<SettingsProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onClearLibrary,
  onChangeLibraryFolder,
  libraryFolderUri,
}) => {
  const [storageUsage, setStorageUsage] = useState<string>('');

  useEffect(() => {
    if (isOpen && navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((estimate) => {
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
      }).catch(err => {
        console.warn('Failed to fetch storage estimate:', err);
      });
    }
  }, [isOpen]);

  return (
    <div className={`settings-overlay ${isOpen ? 'active' : ''}`}>
      <div className="settings-backdrop" onClick={onClose} />
      
      <div className="settings-panel">
        <div className="settings-header">
          <h3 className="settings-title">Настройки</h3>
          <button className="btn-icon" onClick={onClose} aria-label="Закрыть">
            <X size={20} />
          </button>
        </div>

        {/* Хранилище */}
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">
            Хранилище
          </h3>
          <div className="bg-white dark:bg-gray-800 rounded-2xl overflow-hidden border border-gray-100 dark:border-gray-700">
            {libraryFolderUri && (
              <div className="p-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-850">
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Выбранная папка библиотеки:</div>
                <div className="text-sm font-mono text-gray-800 dark:text-gray-200 truncate" title={decodeURIComponent(libraryFolderUri)}>
                  {decodeURIComponent(libraryFolderUri).split('/').pop()}
                </div>
              </div>
            )}
            <button
              onClick={() => {
                onChangeLibraryFolder();
                onClose();
              }}
              className="w-full text-left p-4 hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors flex items-center justify-between border-b border-gray-100 dark:border-gray-700"
            >
              <div>
                <div className="font-medium text-indigo-600 dark:text-indigo-400">Сменить папку библиотеки</div>
                <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  Выбрать другую папку для ваших комиксов
                </div>
              </div>
            </button>
            <button
              onClick={() => {
                if (window.confirm('Вы уверены, что хотите удалить базу данных и отвязать папку? Файлы на устройстве останутся.')) {
                  onClearLibrary();
                  onClose();
                }
              }}
              className="w-full text-left p-4 hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors flex items-center justify-between"
            >
              <div>
                <div className="font-medium text-red-600 dark:text-red-400">Очистить базу данных</div>
                <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  Сбросить полки и прогресс чтения
                </div>
              </div>
            </button>
            {storageUsage && (
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400 text-center">
                {storageUsage}
              </div>
            )}
          </div>
        </div>

        {/* Theme Settings */}
        <div className="settings-section">
          <span className="settings-section-title">Тема оформления</span>
          <div className="segmented-control">
            <button
              className={`segmented-btn ${settings.theme === 'light' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ theme: 'light' })}
            >
              Светлая
            </button>
            <button
              className={`segmented-btn ${settings.theme === 'dark' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ theme: 'dark' })}
            >
              Темная
            </button>
            <button
              className={`segmented-btn ${settings.theme === 'oled' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ theme: 'oled' })}
            >
              OLED
            </button>
          </div>
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
            <label className="switch-control">
              <input
                type="checkbox"
                checked={settings.volumeKeysEnabled}
                onChange={(e) => onUpdateSettings({ volumeKeysEnabled: e.target.checked })}
              />
              <span className="switch-slider"></span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
};
