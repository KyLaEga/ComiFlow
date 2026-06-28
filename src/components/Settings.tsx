import React from 'react';
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
}

export const Settings: React.FC<SettingsProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onClearLibrary,
}) => {
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

        {/* Danger zone / Clear Library */}
        <div className="settings-section" style={{ marginTop: 'auto', paddingTop: '20px' }}>
          <button 
            className="btn btn-danger" 
            onClick={() => {
              if (window.confirm('Вы действительно хотите очистить всю библиотеку комиксов? Это действие нельзя отменить.')) {
                onClearLibrary();
                onClose();
              }
            }}
            style={{ width: '100%', border: '1px solid var(--danger)', borderRadius: '12px' }}
          >
            Очистить библиотеку
          </button>
        </div>
      </div>
    </div>
  );
};
