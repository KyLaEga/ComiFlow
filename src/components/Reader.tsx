import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { updateComicProgress } from '../utils/db';
import type { ComicMetadata } from '../utils/db';
import { getPageBlob } from '../utils/cbz';
import { getPdfPageBlob, clearPDFCache, clearPdfPageCache } from '../utils/pdf';
import { isAndroid, getPdfPageNative } from '../utils/nativeBridge';
import { base64ToBlob } from '../utils/pageUtils';
import { setReaderActive, releaseReaderFile } from '../utils/nativeBridge';
import type { ReaderSettings } from './Settings';
import { ArrowLeft, Settings as SettingsIcon, ChevronLeft, ChevronRight, LayoutGrid, X, Pause, Play } from 'lucide-react';


interface ReaderProps {
  comic: ComicMetadata;
  /** Required for PDF (pdf.js needs the document bytes). Unused for CBZ in
   *  Tauri, where pages are streamed from disk one at a time. */
  fileBlob: Blob | null;
  settings: ReaderSettings;
  onClose: () => void;
  onOpenSettings: () => void;
  shelfComics: ComicMetadata[];
  onSelectComic: (id: string) => void;
}

interface DynamicCoverImageProps {
  coverBlob: Blob | null;
  /** Preferred source: a persisted data-URL string (survives IndexedDB). */
  coverDataUrl?: string | null;
  title: string;
  className?: string;
  fallbackClassName?: string;
}

const DynamicCoverImage: React.FC<DynamicCoverImageProps> = ({ coverBlob, coverDataUrl, title, className, fallbackClassName }) => {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  useEffect(() => {
    // Prefer the reliable data-URL; fall back to a transient object URL.
    if (coverDataUrl) {
      setCoverUrl(coverDataUrl);
      return;
    }
    if (coverBlob) {
      let url = '';
      try {
        url = URL.createObjectURL(coverBlob);
        setCoverUrl(url);
      } catch (err) {
        console.error('Failed to create object URL:', err);
      }
      return () => {
        if (url) URL.revokeObjectURL(url);
      };
    } else {
      setCoverUrl(null);
    }
  }, [coverDataUrl, coverBlob]);

  if (coverUrl) {
    return <img src={coverUrl} alt={title} className={className} />;
  }

  return (
    <div className={fallbackClassName} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', backgroundColor: 'var(--bg-tertiary)' }}>
      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Нет</span>
    </div>
  );
};

interface DrawerComicCardProps {
  c: ComicMetadata;
  isActive: boolean;
  onClick: () => void;
}

const DrawerComicCard: React.FC<DrawerComicCardProps> = ({ c, isActive, onClick }) => {
  const progressPercent = c.totalPages > 0 
    ? Math.round((c.currentPage / (c.totalPages - 1 || 1)) * 100) 
    : 0;

  const isCompleted = progressPercent >= 95;
  const isUnread = c.currentPage === 0 && !c.lastReadAt;

  return (
    <div
      className={`drawer-comic-card ${isActive ? 'active' : ''}`}
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minWidth: '105px',
        maxWidth: '105px',
        cursor: 'pointer',
        textAlign: 'left',
        position: 'relative'
      }}
    >
      <div 
        className="drawer-cover-wrapper" 
        style={{ 
          position: 'relative',
          width: '100%',
          aspectRatio: '2 / 3',
          borderRadius: '12px',
          overflow: 'hidden',
          backgroundColor: 'rgba(255, 255, 255, 0.05)',
          border: isActive ? '2px solid var(--accent)' : '1px solid var(--border-color)',
          boxShadow: isActive ? '0 0 15px var(--accent-border)' : '0 4px 12px rgba(0,0,0,0.15)',
          transition: 'all 0.2s ease',
          flexShrink: 0
        }}
      >
        <DynamicCoverImage
          coverBlob={c.coverBlob}
          coverDataUrl={c.coverDataUrl}
          title={c.title}
          className="drawer-cover"
          fallbackClassName="drawer-cover-placeholder"
        />
        
        {progressPercent > 0 && (
          <div 
            style={{ 
              position: 'absolute', 
              bottom: 0, 
              left: 0, 
              right: 0,
              height: '4px',
              backgroundColor: 'rgba(0, 0, 0, 0.4)'
            }} 
          >
            <div
              style={{
                height: '100%',
                backgroundColor: isCompleted ? 'var(--success)' : 'var(--accent)',
                width: `${Math.min(100, progressPercent)}%` 
              }}
            />
          </div>
        )}

        <div style={{
          position: 'absolute',
          top: '6px',
          right: '6px',
          zIndex: 5,
        }}>
          {isCompleted ? (
            <span style={{
              backgroundColor: 'var(--success)',
              color: 'var(--text-on-accent)',
              fontSize: '9px',
              fontWeight: 'bold',
              padding: '2px 6px',
              borderRadius: '4px',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
            }}>✓</span>
          ) : isUnread ? (
            <span style={{
              backgroundColor: 'var(--accent)',
              color: 'var(--text-on-accent)',
              fontSize: '9px',
              fontWeight: 'bold',
              padding: '2px 6px',
              borderRadius: '4px',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
            }}>Новый</span>
          ) : (
            <span style={{
              backgroundColor: 'var(--bg-translucent)',
              color: 'var(--text-on-accent)',
              fontSize: '9px',
              fontWeight: '600',
              padding: '2px 5px',
              borderRadius: '4px',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
            }}>{progressPercent}%</span>
          )}
        </div>
      </div>
      
      <div className="drawer-comic-info" style={{ display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden' }}>
        <span 
          className="drawer-comic-title" 
          style={{ 
            fontWeight: isActive ? '600' : '500', 
            fontSize: '12px', 
            lineHeight: '1.25',
            maxHeight: '2.5em',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            color: isActive ? 'var(--accent)' : 'var(--text-primary)',
            textOverflow: 'ellipsis'
          }}
          title={c.title}
        >
          {c.title}
        </span>
        {c.totalPages > 0 && !isCompleted && !isUnread && (
          <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
            стр. {c.currentPage + 1}/{c.totalPages}
          </span>
        )}
      </div>
    </div>
  );
};

export const Reader: React.FC<ReaderProps> = ({
  comic,
  fileBlob,
  settings,
  onClose,
  onOpenSettings,
  shelfComics,
  onSelectComic,
}) => {
  const [currentPage, setCurrentPage] = useState(comic.currentPage);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [showNextOverlay, setShowNextOverlay] = useState(false);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [isLoadingPage, setIsLoadingPage] = useState(false);
  const [isHudActive, setIsHudActive] = useState(true);
  
  type DrawerSortType = 'alphabetical' | 'alphabetical-desc' | 'progress-asc' | 'progress-desc' | 'added-new' | 'added-old';
  const [drawerSort, setDrawerSort] = useState<DrawerSortType>(() => {
    return (localStorage.getItem('comiflow_drawer_sort') as DrawerSortType) || 'alphabetical';
  });

  const getSortedShelfComics = () => {
    const list = [...shelfComics];
    switch (drawerSort) {
      case 'alphabetical':
        return list.sort((a, b) => a.title.localeCompare(b.title));
      case 'alphabetical-desc':
        return list.sort((a, b) => b.title.localeCompare(a.title));
      case 'progress-asc':
        return list.sort((a, b) => {
          const progressA = a.totalPages > 0 ? a.currentPage / a.totalPages : 0;
          const progressB = b.totalPages > 0 ? b.currentPage / b.totalPages : 0;
          return progressA - progressB;
        });
      case 'progress-desc':
        return list.sort((a, b) => {
          const progressA = a.totalPages > 0 ? a.currentPage / a.totalPages : 0;
          const progressB = b.totalPages > 0 ? b.currentPage / b.totalPages : 0;
          return progressB - progressA;
        });
      case 'added-new':
        return list.sort((a, b) => b.addedAt - a.addedAt);
      case 'added-old':
        return list.sort((a, b) => a.addedAt - b.addedAt);
      default:
        return list;
    }
  };

  const sortedShelfComics = getSortedShelfComics();
  const currentIdx = sortedShelfComics.findIndex((c) => c.id === comic.id);
  const nextComic = currentIdx !== -1 && currentIdx < sortedShelfComics.length - 1 ? sortedShelfComics[currentIdx + 1] : null;

  // Split state for landscape pages
  const [isLandscape, setIsLandscape] = useState(false);
  const [splitPart, setSplitPart] = useState<'left' | 'right' | null>(null);

  // Zooming & panning states
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startDragOffset = useRef({ x: 0, y: 0 });
  const lastTapTime = useRef(0);
  const latestLoadId = useRef(0);
  // Рефы владеют жизненным циклом object-URL страниц: стейт нужен только
  // для отрисовки, а ревок происходит по рефам — без гонок с re-render.
  const pageUrlRef = useRef<string | null>(null);
  const nextPageUrlRef = useRef<string | null>(null);
  
  // Touch swipe states
  const [swipeTranslation, setSwipeTranslation] = useState(0);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const isSwipeDragging = useRef(false);

  const webtoonContainerRef = useRef<HTMLDivElement>(null);

  // Refs для зума/пана — жесты читают СВЕЖИЕ значения внутри серии
  // pointer-событий (стейт может отставать между событиями). ВАЖНО: рефы
  // обновляются ТОЛЬКО через setZoom/setPan (вместе со стейтом) — никаких
  // обратных синхронизаций из useEffect (иначе быстрые события пинча
  // перетирают реф устаревшим стейтом, и панорама «улетает»).
  const zoomScaleRef = useRef(1);
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const setZoom = useCallback((z: number) => {
    zoomScaleRef.current = z;
    setZoomScale(z);
  }, []);
  const setPan = useCallback((p: { x: number; y: number }) => {
    panOffsetRef.current = p;
    setPanOffset(p);
  }, []);

  // Reset zoom & pan
  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [setZoom, setPan]);

  // Helper to fetch page Blob depending on format
  const fetchPageBlob = useCallback(async (index: number): Promise<Blob> => {
    if (comic.format === 'pdf') {
      if (isAndroid()) {
        // Android: страница рендерится нативным PdfRenderer (pdf.js не может
        // прочитать SAF content:// через fetch — asset-протокол Tauri его
        // не отдаёт). data-URL из invoke превращаем в Blob напрямую через
        // base64ToBlob: fetch() на data: URL в Android WebView падает с
        // «Failed to fetch» (CBZ-путь уже использует base64ToBlob).
        const dataUrl = await getPdfPageNative(comic.uri, String(index + 1));
        if (!dataUrl) throw new Error('Не удалось прочитать PDF-страницу.');
        return base64ToBlob(dataUrl);
      }
      if (!fileBlob) throw new Error('PDF file blob is required for reading.');
      return await getPdfPageBlob(comic.id, fileBlob, index + 1);
    } else {
      // CBZ in Tauri: `uri` is the absolute file path Rust reads from disk.
      // `fileBlob` is only used on the web fallback path (JSZip).
      return await getPageBlob(comic.uri, fileBlob, comic.pages[index]);
    }
  }, [comic.uri, comic.pages, comic.format, comic.id, fileBlob]);

  // Prefetch adjacent page
  const prefetchNextPage = useCallback(async (nextIdx: number) => {
    if (nextIdx >= 0 && nextIdx < comic.pages.length) {
      try {
        const nextBlob = await fetchPageBlob(nextIdx);
        const url = URL.createObjectURL(nextBlob);
        // Заменить непотреблённый prefetch (если листали быстрее, чем он грузился).
        if (nextPageUrlRef.current) URL.revokeObjectURL(nextPageUrlRef.current);
        nextPageUrlRef.current = url;
      } catch (err) {
        console.warn('Failed to prefetch next page:', err);
      }
    } else {
      if (nextPageUrlRef.current) {
        URL.revokeObjectURL(nextPageUrlRef.current);
        nextPageUrlRef.current = null;
      }
    }
  }, [comic.pages.length, fetchPageBlob]);

  // Load a single page for paged mode
  const loadPage = useCallback(async (index: number) => {
    setIsLoadingPage(true);
    const loadId = ++latestLoadId.current;
    try {
      // Ревок предыдущей страницы — по рефам, чтобы никогда не задеть
      // prefetch, который вот-вот будет использован.
      if (pageUrlRef.current && pageUrlRef.current !== nextPageUrlRef.current) {
        URL.revokeObjectURL(pageUrlRef.current);
        pageUrlRef.current = null;
      }

      // Если прыгнули мимо prefetch-страницы — он больше не нужен.
      if (nextPageUrlRef.current && index !== currentPage + 1) {
        URL.revokeObjectURL(nextPageUrlRef.current);
        nextPageUrlRef.current = null;
      }

      let newUrl: string;
      // Если prefetch уже на месте — используем его без повторной загрузки.
      if (nextPageUrlRef.current && index === currentPage + 1) {
        newUrl = nextPageUrlRef.current;
        nextPageUrlRef.current = null;
      } else {
        const blob = await fetchPageBlob(index);
        newUrl = URL.createObjectURL(blob);
      }

      // If this request was superseded by a newer page turn, abort and clean up
      if (loadId !== latestLoadId.current) {
        URL.revokeObjectURL(newUrl);
        return;
      }

      pageUrlRef.current = newUrl;
      setPageUrl(newUrl);

      if (!settings.zoomLock) {
        resetZoom();
      }
      
      // Update DB progress
      await updateComicProgress(comic.id, index);
      
      // Prefetch the next page in the background
      const nextIdx = index + (settings.direction === 'ltr' ? 1 : -1);
      prefetchNextPage(nextIdx);
    } catch (err) {
      if (loadId === latestLoadId.current) {
        console.error('Error loading page:', err);
      }
    } finally {
      if (loadId === latestLoadId.current) {
        setIsLoadingPage(false);
      }
    }
  }, [currentPage, settings.zoomLock, settings.direction, resetZoom, prefetchNextPage, fetchPageBlob, comic.id]);

  // Init / mode transitions: прыжок к текущей странице нужен ТОЛЬКО при
  // открытии ридера или смене режима на webtoon. НЕ вешаем на currentPage:
  // при скролле ленты currentPage обновляется IntersectionObserver'ом, и
  // перезапуск эффекта заставлял ленту «сама прыгать» (автоскроллинг).
  useEffect(() => {
    if (settings.mode === 'webtoon') {
      const timer = setTimeout(() => {
        const pageEl = document.getElementById(`webtoon-page-${currentPageRef.current}`);
        pageEl?.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
      }, 500);
      return () => clearTimeout(timer);
    }
    // currentPage намеренно НЕ в deps — см. комментарий выше.
  }, [settings.mode]);

  // Unmount cleanup: object-URL страниц + кэши (по рефам — ревок никогда
  // не сработает во время активного отображения страницы). Плюс закрываем
  // нативный кэш открытой книги (дескриптор файла) и отменяем rAF слайдера.
  useEffect(() => {
    // Пока читалка открыта — боковые края экрана не перехватываются
    // системной жесты-навигацией Android (свайпы листания от края).
    setReaderActive(true);
    return () => {
      setReaderActive(false);
      if (webtoonScrollRafRef.current != null) {
        cancelAnimationFrame(webtoonScrollRafRef.current);
        webtoonScrollRafRef.current = null;
      }
      if (pageUrlRef.current) URL.revokeObjectURL(pageUrlRef.current);
      if (nextPageUrlRef.current) URL.revokeObjectURL(nextPageUrlRef.current);
      clearPDFCache();
      clearPdfPageCache();
      releaseReaderFile(comic.uri);
    };
  }, []);

  // Sync page changes in paged mode
  useEffect(() => {
    if (settings.mode === 'paged') {
      loadPage(currentPage);
    }
  }, [currentPage, settings.mode, loadPage]);

  // Handle page turns (paged mode)
  const turnPage = useCallback((dir: 'next' | 'prev') => {
    const isLtr = settings.direction === 'ltr';
    const goForward = (dir === 'next' && isLtr) || (dir === 'prev' && !isLtr);

    // If double split pages is enabled, and the page is landscape, split it
    if (settings.splitDoublePages && isLandscape) {
      const isRtl = !isLtr;
      if (goForward) {
        if (splitPart === null) {
          setSplitPart(isRtl ? 'left' : 'right');
          return;
        } else if ((isRtl && splitPart === 'left') || (!isRtl && splitPart === 'right')) {
          setSplitPart(null); // Proceed to next physical page
        }
      } else {
        if (splitPart === null) {
          setSplitPart(isRtl ? 'right' : 'left');
          return;
        } else if ((isRtl && splitPart === 'right') || (!isRtl && splitPart === 'left')) {
          setSplitPart(null); // Proceed to prev physical page
        }
      }
    }

    if (goForward) {
      if (currentPage < comic.totalPages - 1) {
        goToPage(currentPage + 1);
        setSplitPart(null);
      } else if (nextComic) {
        setShowNextOverlay(true);
      }
    } else {
      if (currentPage > 0) {
        goToPage(currentPage - 1);
        setSplitPart(null);
      }
    }
  }, [currentPage, comic.totalPages, settings.direction, settings.splitDoublePages, isLandscape, splitPart, nextComic, settings.mode]);

  // Программное листание (кнопки, жесты, автопропрутка): в webtoon-ленте
  // прокручиваем к целевой странице. Обычный скролл пользователя это НЕ
  // вызывает (там currentPage меняется наблюдателем видимости, и лента не
  // «прыгает» сама) — только явные переходы. behavior:'instant' — прыжок
  // сразу к месту (без анимации через все промежуточные страницы).
  const goToPage = (target: number) => {
    setCurrentPage(target);
    if (settings.mode === 'webtoon') {
      setTimeout(() => {
        document.getElementById(`webtoon-page-${target}`)?.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
      }, 50);
    }
    ensureAutoPlayRunning();
  };

  // Image load helper to detect aspect ratio
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    const landscape = naturalWidth > naturalHeight;
    setIsLandscape(landscape);
    
    if (settings.splitDoublePages && landscape && splitPart === null) {
      // Initialize split part depending on reading direction
      setSplitPart(settings.direction === 'rtl' ? 'right' : 'left');
    }
  };

  // Keyboard navigation (стрелки / пробел; клавиши громкости приходят
  // нативным путём — см. обработчик nativeVolumeKey ниже)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (settings.mode !== 'paged') return;
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        turnPage('next');
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        turnPage('prev');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [settings.mode, turnPage]);

  // Native volume keys (события от MainActivity с repeat-счётчиком):
  //  - "single" — одна страница на одно нажатие (повторы удержания игнорируются);
  //  - "auto"   — автопропрутка: файл листается САМ с интервалом
  //               VOLUME_AUTO_SPEED_MS, кнопка громкости — пауза/продолжение.
  const turnPageRef = useRef(turnPage);
  const currentPageRef = useRef(currentPage);
  useEffect(() => {
    turnPageRef.current = turnPage;
  }, [turnPage]);
  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  // ── Автопропрутка (режим "auto") ───────────────────────────────────────
  // «Включил — и файл листается сам»: после открытия ридера страницы
  // перелистываются автоматически, пока режим включён. Остановки: конец
  // книги, пауза (кнопка громкости / пилюля в HUD), смена режима, выход.
  const [autoPlayPaused, setAutoPlayPaused] = useState(false);
  const autoPlayPausedRef = useRef(false);
  const autoPlayStoppedRef = useRef(false);
  const autoPlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Рефы для «в конце книги открыть следующую»: замыкание тика должно видеть
  // СВЕЖИЕ значения (настройка может поменяться, список полки — тоже).
  const autoOpenNextRef = useRef(settings.autoOpenNext);
  const nextComicRef = useRef(nextComic);
  const onSelectComicRef = useRef(onSelectComic);
  useEffect(() => {
    autoOpenNextRef.current = settings.autoOpenNext;
  }, [settings.autoOpenNext]);
  useEffect(() => {
    nextComicRef.current = nextComic;
  }, [nextComic]);
  useEffect(() => {
    onSelectComicRef.current = onSelectComic;
  }, [onSelectComic]);

  // Цепочка setTimeout (не setInterval): каждый тик перепланируется и берёт
  // СВЕЖУЮ страницу через currentPageRef — замыкание никогда не устаревает.
  const scheduleAutoPlayTick = useCallback(() => {
    if (autoPlayTimerRef.current) clearTimeout(autoPlayTimerRef.current);
    autoPlayTimerRef.current = setTimeout(() => {
      autoPlayTimerRef.current = null;
      if (autoPlayStoppedRef.current || autoPlayPausedRef.current) return;
      // Конец книги: либо автопропрутка завершена, либо (если включено в
      // настройках) автоматически открываем следующую книгу с полки.
      if (currentPageRef.current >= comic.totalPages - 1) {
        if (autoOpenNextRef.current && nextComicRef.current) {
          onSelectComicRef.current(nextComicRef.current.id);
        }
        return;
      }
      goToPage(currentPageRef.current + 1);
      scheduleAutoPlayTick();
    }, settings.volumeKeySpeed * 1000);
    // settings.mode в deps: при смене режима цепочка пересоздаётся со свежим
    // goToPage (иначе замыкание листало бы по старому режиму).
  }, [comic.totalPages, settings.volumeKeySpeed, settings.mode]);

  const stopAutoPlay = useCallback(() => {
    autoPlayStoppedRef.current = true;
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
      autoPlayTimerRef.current = null;
    }
  }, []);

  const toggleAutoPlay = useCallback(() => {
    autoPlayPausedRef.current = !autoPlayPausedRef.current;
    setAutoPlayPaused(autoPlayPausedRef.current);
    if (!autoPlayPausedRef.current && !autoPlayStoppedRef.current) {
      // Возобновление — перезапускаем цепочку.
      scheduleAutoPlayTick();
    }
  }, [scheduleAutoPlayTick]);

  // Перезапуск цепочки после ручной навигации (кнопки, ползунок): если
  // автопропрутка «завершилась» на конце книги, а пользователь вернулся
  // назад — листание продолжается само.
  const ensureAutoPlayRunning = useCallback(() => {
    if (settings.volumeKeysEnabled === 'auto' && !autoPlayPausedRef.current && !autoPlayStoppedRef.current) {
      scheduleAutoPlayTick();
    }
  }, [settings.volumeKeysEnabled, scheduleAutoPlayTick]);

  // Старт/стоп при смене режима листания (и при смене скорости).
  useEffect(() => {
    if (settings.volumeKeysEnabled === 'auto') {
      autoPlayStoppedRef.current = false;
      autoPlayPausedRef.current = false;
      setAutoPlayPaused(false);
      // Небольшая задержка — дать увидеть первую страницу.
      const startTimer = setTimeout(() => {
        if (!autoPlayStoppedRef.current && !autoPlayPausedRef.current) {
          scheduleAutoPlayTick();
        }
      }, 1500);
      return () => {
        clearTimeout(startTimer);
        stopAutoPlay();
      };
    }
    stopAutoPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.volumeKeysEnabled, scheduleAutoPlayTick, stopAutoPlay]);

  // Пауза, когда приложение ушло в фон; продолжение при возврате.
  useEffect(() => {
    if (settings.volumeKeysEnabled !== 'auto') return;
    const onVisibility = () => {
      if (document.hidden) {
        autoPlayPausedRef.current = true;
        setAutoPlayPaused(true);
      } else {
        autoPlayPausedRef.current = false;
        setAutoPlayPaused(false);
        if (!autoPlayStoppedRef.current) scheduleAutoPlayTick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [settings.volumeKeysEnabled, scheduleAutoPlayTick]);

  useEffect(() => {
    if (settings.volumeKeysEnabled === 'off') return;

    const handleNativeVolumeKey = (e: Event) => {
      const ce = e as CustomEvent<{ key: 'volume_up' | 'volume_down'; repeat: number }>;
      const { key, repeat } = ce.detail;

      if (settings.volumeKeysEnabled === 'auto') {
        // Кнопка громкости в режиме автопропрутки — пауза/продолжение.
        if (repeat === 0) {
          toggleAutoPlay();
        }
        return;
      }

      // "single": листаем только на первое нажатие; удержание не листает.
      if (repeat === 0) {
        const isLtr = settings.direction === 'ltr';
        const dir: 'next' | 'prev' = key === 'volume_up'
          ? (isLtr ? 'prev' : 'next')
          : (isLtr ? 'next' : 'prev');
        turnPageRef.current(dir);
      }
    };

    window.addEventListener('nativeVolumeKey', handleNativeVolumeKey);
    return () => {
      window.removeEventListener('nativeVolumeKey', handleNativeVolumeKey);
    };
    // ВАЖНО: turnPage НЕ в deps — иначе эффект перезапускался бы на каждом
    // листании (turnPage меняется вместе с currentPage). Используем ref.
  }, [settings.volumeKeysEnabled, settings.direction, toggleAutoPlay]);

  // Webtoon scroll dynamic page visibility callback
  const handlePageVisibleInWebtoon = useCallback((index: number) => {
    setCurrentPage(index);
    updateComicProgress(comic.id, index);
  }, [comic.id]);

  // Double tap zoom handler
  const handleDoubleTap = (clientX: number, clientY: number) => {
    const now = Date.now();
    const DOUBLE_TAP_DELAY = 300;
    
    if (now - lastTapTime.current < DOUBLE_TAP_DELAY) {
      if (zoomScaleRef.current > 1) {
        resetZoom();
      } else {
        // Zoom in to 2.5x at tap location
        if (viewportRef.current) {
          const rect = viewportRef.current.getBoundingClientRect();
          const tapX = clientX - rect.left;
          const tapY = clientY - rect.top;
          
          // Calculate pan offset to focus zoom on tap location
          const newX = (rect.width / 2 - tapX) * 1.5;
          const newY = (rect.height / 2 - tapY) * 1.5;
          
          setZoom(2.5);
          setPan({ x: newX, y: newY });
        }
      }
    }
    lastTapTime.current = now;
  };

  // Pointer dragging (Panning when zoomed, swiping when 1x zoom).
  // Обработчики висят на .reader-viewport (общий родитель hotspots и
  // paged-container); в webtoon-режиме они неактивны (там своя прокрутка).
  // Два пальца — пинч: приближение и отдаление (1x..5x), точка под серединой
  // пальцев остаётся неподвижной. Отдалить можно всегда — пинч «сводит»
  // масштаб обратно к 1 (и панель обнуляется).
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchBaseRef = useRef<{ dist: number; zoom: number; panX: number; panY: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (settings.mode !== 'paged') return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2) {
      // Второй палец: начинаем пинч, свайп отменяем. База фиксируется ОДИН
      // раз (расстояние, зум и панорама на старте) — от неё считается всё.
      isSwipeDragging.current = false;
      isDragging.current = false;
      setSwipeTranslation(0);
      const [a, b] = [...pointersRef.current.values()];
      pinchBaseRef.current = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        zoom: zoomScaleRef.current,
        panX: panOffsetRef.current.x,
        panY: panOffsetRef.current.y,
      };
      return;
    }

    // Дабл-тап ВСЕГДА: при зуме 1 — приближение, при зуме >1 — сброс к 1.
    // (Раньше вызывался только при zoom===1, поэтому «уменьшить обратно»
    // двойным тапом было нельзя — нажатие уходило в ветку панорамирования.)
    handleDoubleTap(e.clientX, e.clientY);

    if (zoomScaleRef.current === 1) {
      // Track swipes only in paged mode
      if (settings.mode === 'paged') {
        touchStartX.current = e.clientX;
        touchStartY.current = e.clientY;
        isSwipeDragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }
    isDragging.current = true;
    startDragOffset.current = {
      x: e.clientX - panOffsetRef.current.x,
      y: e.clientY - panOffsetRef.current.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (settings.mode !== 'paged') return;
    const pointers = pointersRef.current;
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Пинч: масштаб от расстояния между пальцами. Точка под серединой пальцев
    // остаётся неподвижной — формула использует панораму НА СТАРТЕ пинча
    // (base.panX/panY), а не текущую: иначе каждый тик пере-якоривает и
    // панорама экспоненциально «улетает».
    if (pointers.size === 2 && pinchBaseRef.current) {
      const [a, b] = [...pointers.values()];
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const base = pinchBaseRef.current;
      const nextZoom = Math.max(1, Math.min(5, base.zoom * (dist / base.dist)));
      const nextPan = {
        x: midX - (midX - base.panX) * (nextZoom / base.zoom),
        y: midY - (midY - base.panY) * (nextZoom / base.zoom),
      };
      setZoom(nextZoom);
      setPan(nextPan);
      return;
    }

    if (zoomScaleRef.current === 1) {
      if (!isSwipeDragging.current) return;
      const deltaX = e.clientX - touchStartX.current;
      const deltaY = e.clientY - touchStartY.current;
      
      // If horizontal movement is dominant, capture swipe preview translation
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
        setSwipeTranslation(deltaX);
      }
      return;
    }
    if (!isDragging.current) return;
    const newX = e.clientX - startDragOffset.current.x;
    const newY = e.clientY - startDragOffset.current.y;
    
    // Boundary check to keep images inside screen
    setPan({ x: newX, y: newY });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (settings.mode !== 'paged') return;
    pointersRef.current.delete(e.pointerId);

    if (pinchBaseRef.current && pointersRef.current.size < 2) {
      // Пинч завершён. Если масштаб вернулся к 1 — панель обнуляется,
      // иначе остаётся как есть (страница приближена/отдалена).
      pinchBaseRef.current = null;
      if (zoomScaleRef.current === 1) {
        resetZoom();
      }
      return;
    }

    if (zoomScaleRef.current === 1) {
      if (!isSwipeDragging.current) return;
      isSwipeDragging.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer capture мог уже сняться системой — не критично */
      }
      
      const deltaX = e.clientX - touchStartX.current;
      setSwipeTranslation(0); // Trigger snap back transition
      
      // Trigger page turn if dragged threshold exceeded
      if (Math.abs(deltaX) > 80) {
        if (deltaX > 0) {
          turnPage(settings.direction === 'ltr' ? 'prev' : 'next');
        } else {
          turnPage(settings.direction === 'ltr' ? 'next' : 'prev');
        }
      }
      return;
    }
    isDragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  // Toggle HUD Overlay
  const toggleHud = () => {
    setIsHudActive((prev) => !prev);
  };

  // Slide handle fast change. В webtoon-ленте скролл к целевой странице
  // троттлится через requestAnimationFrame: при быстром перетаскивании
  // ползунка выполняется ТОЛЬКО последняя позиция за кадр, а не каждая
  // промежуточная — иначе лента «пролистывается» через все страницы.
  const webtoonScrollRafRef = useRef<number | null>(null);
  const webtoonTargetRef = useRef(-1);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pageIndex = parseInt(e.target.value);
    setCurrentPage(pageIndex);
    
    if (settings.mode === 'webtoon') {
      webtoonTargetRef.current = pageIndex;
      if (webtoonScrollRafRef.current == null) {
        webtoonScrollRafRef.current = requestAnimationFrame(() => {
          webtoonScrollRafRef.current = null;
          const target = webtoonTargetRef.current;
          document.getElementById(`webtoon-page-${target}`)?.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
        });
      }
    }
    // Перетащили ползунок в режиме автопропрутки — листание продолжается.
    ensureAutoPlayRunning();
  };

  // Filter Styles for Brightness and Contrast (мемоизованы — иначе каждый
  // скролл в webtoon пересоздаёт объект и ререндерит все страницы ленты)
  const filterStyles = useMemo(
    () => ({
      filter: `brightness(${settings.brightness}%) contrast(${settings.contrast}%)`,
    }),
    [settings.brightness, settings.contrast],
  );

  return (
    <div className="reader-container">
      {/* Top HUD */}
      <div className={`reader-hud reader-hud-top ${isHudActive ? 'active' : ''}`}>
        <button className="btn-icon" onClick={onClose} aria-label="Назад">
          <ArrowLeft size={20} />
        </button>
        <span className="hud-title">{comic.title}</span>
        <div className="hud-actions">
          {shelfComics.length > 1 && (
            <button 
              className="btn-icon" 
              onClick={() => setIsDrawerOpen(true)} 
              title="Книги на полке"
              style={{ marginRight: '4px' }}
            >
              <LayoutGrid size={20} />
            </button>
          )}
          <button className="btn-icon" onClick={onOpenSettings} aria-label="Настройки">
            <SettingsIcon size={20} />
          </button>
        </div>
      </div>

      {/* Viewport Area */}
      {/* Pointer-обработчики свайпов/пана здесь: nav-hotspot'ы — сиблинги
          paged-container (оба внутри viewport), поэтому события от них
          всплывают только до viewport'а. */}
      <div 
        className={`reader-viewport ${settings.mode === 'webtoon' ? 'webtoon-mode' : ''}`}
        ref={settings.mode === 'webtoon' ? webtoonContainerRef : viewportRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Hotspots for Paged turning */}
        {settings.mode === 'paged' && zoomScale === 1 && (
          <>
            <div 
              className="nav-hotspot nav-hotspot-left" 
              onClick={() => turnPage(settings.direction === 'ltr' ? 'prev' : 'next')} 
            />
            <div 
              className="nav-hotspot nav-hotspot-center" 
              onClick={toggleHud} 
            />
            <div 
              className="nav-hotspot nav-hotspot-right" 
              onClick={() => turnPage(settings.direction === 'ltr' ? 'next' : 'prev')} 
            />
          </>
        )}

        {/* LOADING SPINNER */}
        {isLoadingPage && (
          <div className="loading-overlay" style={{ background: 'transparent' }}>
            <div className="spinner"></div>
          </div>
        )}

        {/* WEBTOON RENDERING */}
        {settings.mode === 'webtoon' && (
          <div className="webtoon-scroll-container" onClick={toggleHud}>
            {comic.pages.map((_, idx) => (
              <WebtoonPageWrapper
                key={`${comic.id}-page-${idx}`}
                index={idx}
                fetchPageBlob={fetchPageBlob}
                onVisible={handlePageVisibleInWebtoon}
                filterStyles={filterStyles}
                aspectRatio={comic.aspectRatios?.[idx] ?? null}
              />
            ))}
          </div>
        )}

        {/* PAGED RENDERING */}
        {settings.mode === 'paged' && pageUrl && (
          <div className="paged-container">
            <div
              className="page-image-wrapper"
              style={{
                transform: `translate(${panOffset.x + swipeTranslation}px, ${panOffset.y}px) scale(${zoomScale})`,
                transition: swipeTranslation === 0 ? 'transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
                cursor: zoomScale > 1 ? 'grab' : 'default',
              }}
            >
              {settings.splitDoublePages && isLandscape && splitPart ? (
                // Double split render
                <div 
                  className="double-spread-container"
                  style={{
                    width: '100vw',
                    height: '100vh',
                    ...filterStyles,
                  }}
                >
                  <div 
                    className={`spread-half ${splitPart === 'left' ? 'spread-left' : 'spread-right'}`}
                    style={{
                      backgroundImage: `url(${pageUrl})`,
                    }}
                  />
                </div>
              ) : (
                // Normal full page render
                <img
                  src={pageUrl}
                  alt={`Страница ${currentPage + 1}`}
                  onLoad={handleImageLoad}
                  className={`page-image ${
                    settings.fitMode === 'width' 
                      ? 'fit-width' 
                      : settings.fitMode === 'height' 
                        ? 'fit-height' 
                        : ''
                  }`}
                  style={filterStyles}
                />
              )}
            </div>

            {/* Visual desktop side arrows for easier PC click support */}
            {zoomScale === 1 && (
              <>
                {currentPage > 0 && (
                  <button
                    className="btn-icon"
                    style={{ position: 'absolute', left: '16px', zIndex: 105, backgroundColor: 'rgba(0,0,0,0.4)', color: '#fff' }}
                    onClick={() => turnPage('prev')}
                  >
                    <ChevronLeft size={24} />
                  </button>
                )}
                {currentPage < comic.totalPages - 1 && (
                  <button
                    className="btn-icon"
                    style={{ position: 'absolute', right: '16px', zIndex: 105, backgroundColor: 'rgba(0,0,0,0.4)', color: '#fff' }}
                    onClick={() => turnPage('next')}
                  >
                    <ChevronRight size={24} />
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Bottom HUD */}
      <div className={`reader-hud reader-hud-bottom ${isHudActive ? 'active' : ''}`}>
        <div className="hud-progress-row">
          {settings.volumeKeysEnabled === 'auto' && (
            <button
              className={`autoplay-pill ${autoPlayPaused ? 'paused' : ''}`}
              onClick={toggleAutoPlay}
              aria-label={autoPlayPaused ? 'Продолжить автопропрутку' : 'Поставить автопропрутку на паузу'}
              title={autoPlayPaused ? 'Продолжить автопропрутку' : 'Поставить на паузу'}
            >
              {autoPlayPaused ? <Play size={14} /> : <Pause size={14} />}
              <span>Автопропрутка</span>
            </button>
          )}
          <input
            type="range"
            min="0"
            max={comic.totalPages - 1}
            value={currentPage}
            onChange={handleSliderChange}
            className="page-slider"
          />
          <span className="page-indicator">
            {currentPage + 1} / {comic.totalPages}
          </span>
        </div>
      </div>

      {/* Shelf issues bottom sheet drawer */}
      {shelfComics.length > 1 && (
        <div className={`reader-drawer-overlay ${isDrawerOpen ? 'active' : ''}`} onClick={() => setIsDrawerOpen(false)}>
          <div className="reader-drawer" onClick={(e) => e.stopPropagation()} style={{ maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="drawer-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px', borderBottom: '1px solid var(--border-color)', gap: '12px' }}>
              <span className="drawer-title" style={{ fontSize: '18px', fontWeight: 'bold' }}>Книги на полке ({shelfComics.length})</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <select
                  value={drawerSort}
                  onChange={(e) => {
                    const val = e.target.value as DrawerSortType;
                    setDrawerSort(val);
                    localStorage.setItem('comiflow_drawer_sort', val);
                  }}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-color)',
                    fontSize: '13px',
                    outline: 'none',
                    cursor: 'pointer'
                  }}
                >
                  <option value="alphabetical">А-Я (по названию)</option>
                  <option value="alphabetical-desc">Я-А (по названию)</option>
                  <option value="added-new">Сначала новые (по дате)</option>
                  <option value="added-old">Сначала старые (по дате)</option>
                  <option value="progress-asc">Сначала непрочитанные</option>
                  <option value="progress-desc">Сначала прочитанные</option>
                </select>
                <button className="btn-icon" onClick={() => setIsDrawerOpen(false)} aria-label="Закрыть">
                  <X size={20} />
                </button>
              </div>
            </div>
            <div className="drawer-comic-list" style={{ flex: 1, padding: '16px 8px' }}>
              {sortedShelfComics.map((c) => (
                <DrawerComicCard
                  key={c.id}
                  c={c}
                  isActive={c.id === comic.id}
                  onClick={() => {
                    if (c.id !== comic.id) {
                      onSelectComic(c.id);
                      setIsDrawerOpen(false);
                    }
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Next Issue Auto-Turn Overlay */}
      {showNextOverlay && nextComic && (
        <div className="next-issue-overlay">
          <div className="next-issue-card">
            <span className="next-issue-badge">Книга прочитана!</span>
            <DynamicCoverImage coverBlob={nextComic.coverBlob} coverDataUrl={nextComic.coverDataUrl} title={nextComic.title} className="next-issue-cover" fallbackClassName="next-issue-cover-placeholder" />
            <h4 className="next-issue-title">Открыть следующую книгу?</h4>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{nextComic.title}</p>
            <div className="next-issue-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  onSelectComic(nextComic.id);
                  setShowNextOverlay(false);
                }}
              >
                Читать следующий
              </button>
              <button
                className="btn btn-danger"
                style={{ border: '1px solid var(--border-color)', backgroundColor: 'transparent', color: 'var(--text-secondary)' }}
                onClick={() => setShowNextOverlay(false)}
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

// =======================================================
// Webtoon Page Lazy/Virtual Loader Wrapper Component
// =======================================================
interface WebtoonPageWrapperProps {
  index: number;
  fetchPageBlob: (index: number) => Promise<Blob>;
  onVisible: (index: number) => void;
  filterStyles: React.CSSProperties;
  /** Реальная пропорция страницы (w/h) из метаданных — резервирует высоту
   *  ДО загрузки картинки, чтобы лента не «прыгала» при скролле. */
  aspectRatio: number | null;
}

const WebtoonPageWrapper: React.FC<WebtoonPageWrapperProps> = React.memo(
  ({ index, fetchPageBlob, onVisible, filterStyles, aspectRatio }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [imgUrl, setImgUrl] = useState<string | null>(null);
    const [loadedRatio, setLoadedRatio] = useState<number | null>(null);
    // Реф владеет URL: observer-колбэк читает/пишет его, а state только
    // отражает текущий URL для отрисовки. Раньше `imgUrl` был в deps —
    // cleanup ревокал URL ещё показываемой картинки (гонка с async-загрузкой).
    const imgUrlRef = useRef<string | null>(null);

    // Плейсхолдер резервирует РЕАЛЬНУЮ высоту страницы (из метаданных),
    // поэтому при загрузке картинки лента не сдвигается.
    const displayRatio = loadedRatio ?? aspectRatio;

    const setUrl = (url: string | null) => {
      imgUrlRef.current = url;
      setImgUrl(url);
    };

    useEffect(() => {
      let cancelled = false;
      const observer = new IntersectionObserver(
        async (entries) => {
          const entry = entries[0];
          if (entry.isIntersecting) {
            onVisible(index);

            // Lazy load page blob (только если ещё не загружена)
            if (!imgUrlRef.current) {
              try {
                const blob = await fetchPageBlob(index);
                if (cancelled) return; // компонент размонтирован — blob просто выбрасываем
                setUrl(URL.createObjectURL(blob));
              } catch (err) {
                console.error(`Failed to load Webtoon page ${index}:`, err);
              }
            }
          } else {
            // Offload image if scrolled far away to protect RAM memory
            if (imgUrlRef.current) {
              URL.revokeObjectURL(imgUrlRef.current);
              setUrl(null);
            }
          }
        },
        {
          rootMargin: '1000px 0px', // Load images 1000px before entering viewport
          threshold: 0.01,
        },
      );

      if (containerRef.current) {
        observer.observe(containerRef.current);
      }

      return () => {
        cancelled = true;
        observer.disconnect();
        if (imgUrlRef.current) {
          URL.revokeObjectURL(imgUrlRef.current);
          imgUrlRef.current = null;
        }
      };
    }, [index, fetchPageBlob, onVisible]);

    const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      if (img.naturalWidth && img.naturalHeight) {
        setLoadedRatio(img.naturalWidth / img.naturalHeight);
      }
    };

    return (
      <div
        ref={containerRef}
        id={`webtoon-page-${index}`}
        style={{
          width: '100%',
          aspectRatio: displayRatio ? `${displayRatio}` : '2/3',
          backgroundColor: '#000000',
          minHeight: '200px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={`Страница ${index + 1}`}
            onLoad={handleImageLoad}
            style={{
              width: '100%',
              height: 'auto',
              display: 'block',
              ...filterStyles,
            }}
          />
        ) : (
          <div className="spinner" style={{ width: '30px', height: '30px', borderTopColor: 'var(--accent)' }} />
        )}
      </div>
    );
  },
);
