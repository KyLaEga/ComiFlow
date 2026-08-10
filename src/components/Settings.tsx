import React, { useState, useEffect, useRef } from 'react';
import { X, Sun, Eye, Contrast, Layout, ArrowRightLeft, BookOpen, Volume2, Trash2, Gauge, Palette, Archive, SkipForward } from 'lucide-react';
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
   *  странице на нажатие, auto — непрерывная автопропрутка. */
  volumeKeysEnabled: 'off' | 'single' | 'auto';
  /** Скорость автопропрутки (режим 'auto'): секунды на страницу (0.5..10). */
  volumeKeySpeed: number;
  /** В режиме 'auto' в конце книги — автоматически открывать следующую. */
  autoOpenNext: boolean;
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

// ── Вкладки настроек ────────────────────────────────────────────────────────
type SettingsTab = 'reading' | 'appearance' | 'storage';

// ── Пресеты яркости/контраста ───────────────────────────────────────────────
// Ползунком на телефоне трудно попасть в нужное значение — выбираем готовые.
const IMAGE_PRESETS = [50, 75, 100, 125, 150];

// ── Скорость автопропрутки (секунды на страницу) ───────────────────────────
const AUTO_SPEED_PRESETS = [0.5, 1, 1.5, 2, 3, 4, 5, 8, 10];
const formatSpeed = (s: number): string => `${s % 1 === 0 ? s : s.toFixed(1)} с`;

// ── Карточки тем ────────────────────────────────────────────────────────────
// Цвета (bg/accent/text) для превью каждой семьи берём из universal-themes.css,
// чтобы карточка показывала реальную палитру темы, а не условные «свотчи».
interface ThemeVariantColors {
  bg: string;
  accent: string;
  text: string;
}
interface ThemeFamily {
  value: string;
  label: string;
  light: ThemeVariantColors;
  dark: ThemeVariantColors;
  oled: ThemeVariantColors;
}

const THEME_FAMILIES: ThemeFamily[] = [
  { value: 'slate', label: 'Slate',
    light: { bg: '#f4f5f7', accent: '#4c5699', text: '#1f2329' },
    dark:  { bg: '#0f1013', accent: '#4c5699', text: '#f2f3f5' },
    oled:  { bg: '#000000', accent: '#4c5699', text: '#f2f3f5' } },
  { value: 'nord', label: 'Nord',
    light: { bg: '#eceff4', accent: '#5e81ac', text: '#2e3440' },
    dark:  { bg: '#2e3440', accent: '#5e81ac', text: '#eceff4' },
    oled:  { bg: '#000000', accent: '#5e81ac', text: '#eceff4' } },
  { value: 'midnight', label: 'Токио',
    light: { bg: '#f0f4fe', accent: '#7aa2f7', text: '#1a1b26' },
    dark:  { bg: '#1a1b26', accent: '#7aa2f7', text: '#c0caf5' },
    oled:  { bg: '#000000', accent: '#7aa2f7', text: '#c0caf5' } },
  { value: 'dracula', label: 'Dracula',
    light: { bg: '#f6f3fc', accent: '#bd93f9', text: '#282a36' },
    dark:  { bg: '#282a36', accent: '#bd93f9', text: '#f8f8f2' },
    oled:  { bg: '#000000', accent: '#bd93f9', text: '#f8f8f2' } },
  { value: 'sepia', label: 'Сепия',
    light: { bg: '#fcfaf2', accent: '#a0522d', text: '#433422' },
    dark:  { bg: '#1e1b18', accent: '#a0522d', text: '#efebe4' },
    oled:  { bg: '#000000', accent: '#a0522d', text: '#efebe4' } },
  { value: 'evergreen', label: 'Evergreen',
    light: { bg: '#f1f7f4', accent: '#2d6a4f', text: '#1c2e24' },
    dark:  { bg: '#0f1a14', accent: '#2d6a4f', text: '#e2e8e6' },
    oled:  { bg: '#000000', accent: '#2d6a4f', text: '#e2e8e6' } },
  { value: 'amber', label: 'Янтарь',
    light: { bg: '#fffdf5', accent: '#d35400', text: '#3d321d' },
    dark:  { bg: '#1a130f', accent: '#d35400', text: '#fdf5f0' },
    oled:  { bg: '#000000', accent: '#d35400', text: '#fdf5f0' } },
  { value: 'sakura', label: 'Сакура',
    light: { bg: '#fff0f5', accent: '#d87093', text: '#5c2c3a' },
    dark:  { bg: '#1f1619', accent: '#d87093', text: '#ffd1dc' },
    oled:  { bg: '#000000', accent: '#d87093', text: '#ffd1dc' } },
  { value: 'cyberpunk', label: 'Киберпанк',
    light: { bg: '#fcf5fa', accent: '#ff007f', text: '#2c003e' },
    dark:  { bg: '#0e0d16', accent: '#ff007f', text: '#ffffff' },
    oled:  { bg: '#000000', accent: '#ff007f', text: '#ffffff' } },
];

const THEME_VARIANT_LABELS = { light: 'Светлые', dark: 'Тёмные', oled: 'OLED' } as const;

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
  const [activeTab, setActiveTab] = useState<SettingsTab>('reading');
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      updateStorageUsage();
      // Каждый раз открываем настройки с первой вкладки — предсказуемо.
      setActiveTab('reading');
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

  // Переключение вкладки: сбрасываем прокрутку панели, чтобы новая вкладка
  // начиналась с начала (панель — единый скролл-контейнер).
  const switchTab = (tab: SettingsTab) => {
    setActiveTab(tab);
    panelRef.current?.scrollTo({ top: 0 });
  };

  if (!isOpen) return null;

  return (
    <div className="settings-overlay active">
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-panel" ref={panelRef}>
        <div className="settings-header">
          <h3 className="settings-title">Настройки</h3>
          <button className="btn-icon" onClick={onClose} aria-label="Закрыть">
            <X size={20} />
          </button>
        </div>

        {/* Вкладки */}
        <div className="settings-tabs">
          <button
            className={`settings-tab ${activeTab === 'reading' ? 'active' : ''}`}
            onClick={() => switchTab('reading')}
          >
            <BookOpen size={14} /> Чтение
          </button>
          <button
            className={`settings-tab ${activeTab === 'appearance' ? 'active' : ''}`}
            onClick={() => switchTab('appearance')}
          >
            <Palette size={14} /> Оформление
          </button>
          <button
            className={`settings-tab ${activeTab === 'storage' ? 'active' : ''}`}
            onClick={() => switchTab('storage')}
          >
            <Archive size={14} /> Хранилище
          </button>
        </div>

        {/* ══ ВКЛАДКА: ЧТЕНИЕ ══ */}
        {activeTab === 'reading' && (
          <>
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

            {/* Adjustments (CSS Filters): пресеты вместо ползунков — на телефоне
                ползунком трудно попасть в нужное значение, а кнопка ставит точно. */}
            <div className="settings-section">
              <span className="settings-section-title">Изображение</span>

              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                <Sun size={16} /> Яркость: {settings.brightness}%
              </span>
              <div className="preset-chip-grid">
                {IMAGE_PRESETS.map((v) => (
                  <button
                    key={v}
                    className={`preset-chip ${settings.brightness === v ? 'active' : ''}`}
                    onClick={() => onUpdateSettings({ brightness: v })}
                  >
                    {v}%
                  </button>
                ))}
              </div>

              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px', marginTop: '4px' }}>
                <Contrast size={16} /> Контраст: {settings.contrast}%
              </span>
              <div className="preset-chip-grid">
                {IMAGE_PRESETS.map((v) => (
                  <button
                    key={v}
                    className={`preset-chip ${settings.contrast === v ? 'active' : ''}`}
                    onClick={() => onUpdateSettings({ contrast: v })}
                  >
                    {v}%
                  </button>
                ))}
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
            </div>

            {/* Автопропрутка */}
            <div className="settings-section">
              <span className="settings-section-title">Автопропрутка</span>

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
                {settings.volumeKeysEnabled === 'auto' && 'Страницы листаются сами — кнопка громкости ставит на паузу и продолжает.'}
              </div>

              {/* Скорость: секунды на страницу. Видна ВСЕГДА (не только в режиме
                  «Автопропрутка»), активна только в нём — чтобы настройка не
                  «пропадала». Больше вариантов: 0.5..10 секунд на страницу. */}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                <Gauge size={16} /> Скорость: {formatSpeed(settings.volumeKeySpeed)} / стр.
              </span>
              <div
                className="preset-chip-grid speed-grid"
                style={{
                  opacity: settings.volumeKeysEnabled === 'auto' ? 1 : 0.45,
                  pointerEvents: settings.volumeKeysEnabled === 'auto' ? 'auto' : 'none',
                }}
              >
                {AUTO_SPEED_PRESETS.map((v) => (
                  <button
                    key={v}
                    className={`preset-chip ${settings.volumeKeySpeed === v ? 'active' : ''}`}
                    onClick={() => onUpdateSettings({ volumeKeySpeed: v })}
                  >
                    {formatSpeed(v)}
                  </button>
                ))}
              </div>

              {/* В конце книги — переходить на следующую автоматически. */}
              <div className="settings-option-row">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                  <SkipForward size={16} /> В конце книги открывать следующую
                </span>
                <label className="switch-control">
                  <input
                    type="checkbox"
                    checked={settings.autoOpenNext}
                    onChange={(e) => onUpdateSettings({ autoOpenNext: e.target.checked })}
                  />
                  <span className="switch-slider"></span>
                </label>
              </div>
              {settings.volumeKeysEnabled !== 'auto' && (
                <div style={{ fontSize: '12px', opacity: 0.65 }}>
                  Доступно в режиме «Автопропрутка»
                </div>
              )}
            </div>
          </>
        )}

        {/* ══ ВКЛАДКА: ОФОРМЛЕНИЕ ══ */}
        {activeTab === 'appearance' && (
          <div className="settings-section">
            <span className="settings-section-title">Тема оформления</span>

            {/* Авто (системная) */}
            <button
              className={`theme-card ${settings.theme === 'system' ? 'selected' : ''}`}
              onClick={() => onUpdateSettings({ theme: 'system' as ReaderSettings['theme'] })}
              style={{ width: 'calc(33.33% - 6px)', minWidth: '104px' }}
            >
              <div
                className="theme-card-preview"
                style={{ background: 'linear-gradient(135deg, #f4f5f7 50%, #0f1013 50%)' }}
              >
                <div className="theme-card-line" style={{ background: '#1f2329', opacity: 0.35, width: '70%' }} />
                <div className="theme-card-line" style={{ background: '#1f2329', opacity: 0.2, width: '45%' }} />
                <div className="theme-card-dot" style={{ background: '#4c5699' }} />
              </div>
              <span className="theme-card-label">Авто (системная)</span>
            </button>

            {/* Семьи тем по вариантам: Светлые / Тёмные / OLED */}
            {(['light', 'dark', 'oled'] as const).map((variant) => (
              <div key={variant} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span className="theme-group-title">{THEME_VARIANT_LABELS[variant]}</span>
                <div className="theme-card-grid">
                  {THEME_FAMILIES.map((f) => {
                    const c = f[variant];
                    const value = `${variant}-${f.value}`;
                    return (
                      <button
                        key={value}
                        className={`theme-card ${settings.theme === value ? 'selected' : ''}`}
                        onClick={() => onUpdateSettings({ theme: value as ReaderSettings['theme'] })}
                      >
                        <div className="theme-card-preview" style={{ background: c.bg }}>
                          <div className="theme-card-line" style={{ background: c.text, opacity: 0.35, width: '70%' }} />
                          <div className="theme-card-line" style={{ background: c.text, opacity: 0.2, width: '45%' }} />
                          <div className="theme-card-dot" style={{ background: c.accent }} />
                        </div>
                        <span className="theme-card-label">{f.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ══ ВКЛАДКА: ХРАНИЛИЩЕ ══ */}
        {activeTab === 'storage' && (
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

            {storageUsage && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '16px' }}>
                {storageUsage}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
