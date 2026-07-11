import React, { useState, useEffect } from 'react';
import { X, Sun, Eye, Contrast, Layout, ArrowRightLeft, BookOpen, Volume2, Trash2 } from 'lucide-react';

export interface ReaderSettings {
  theme: 'light' | 'dark' | 'dracula' | 'nord' | 'tokyo' | 'oled-black' | 'oled-dracula' | 'oled-tokyo' | 'oled-one-dark' | 'oled-evergreen' | 'one-dark' | 'system';
  direction: 'ltr' | 'rtl';
  mode: 'paged' | 'webtoon';
  fitMode: 'contain' | 'width' | 'height';
  splitDoublePages: boolean;
  zoomLock: boolean;
  volumeKeysEnabled: boolean;
  brightness: number; // 50 to 150
  contrast: number; // 50 to 150
  deletePhysicalFile?: boolean;
}

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
    } catch (e) {
      console.warn('Failed to get storage estimate', e);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
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
                {decodeURIComponent(libraryFolderUri).split('/').pop()}
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
              onClick={() => {
                if (window.confirm('Вы уверены, что хотите удалить базу данных и отвязать папку? Файлы на устройстве останутся.')) {
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
            <option value="light">Светлая</option>
            <option value="dark">Темная</option>
            <option value="dracula">Dracula</option>
            <option value="nord">Nord</option>
            <option value="tokyo">Tokyo</option>
            <option value="one-dark">One Dark</option>
            <option value="oled-black">OLED Black</option>
            <option value="oled-dracula">OLED Dracula</option>
            <option value="oled-tokyo">OLED Tokyo</option>
            <option value="oled-one-dark">OLED One Dark</option>
            <option value="oled-evergreen">OLED Evergreen</option>
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

          <div className="settings-option-row">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
              <Trash2 size={16} /> Удалять файлы с устройства
            </span>
            <label className="switch-control">
              <input
                type="checkbox"
                checked={settings.deletePhysicalFile || false}
                onChange={(e) => onUpdateSettings({ deletePhysicalFile: e.target.checked })}
              />
              <span className="switch-slider"></span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
};
