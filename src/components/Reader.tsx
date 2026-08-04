import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { updateComicProgress } from '../utils/db';
import type { ComicMetadata } from '../utils/db';
import { getPageBlob } from '../utils/cbz';
import { getPdfPageBlob, clearPDFCache, clearPdfPageCache } from '../utils/pdf';
import type { ReaderSettings } from './Settings';
import { ArrowLeft, Settings as SettingsIcon, ChevronLeft, ChevronRight, LayoutGrid, X } from 'lucide-react';


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

  // Fast Scroll Handle states (Webtoon mode)
  const [isScrollingFastScroll, setIsScrollingFastScroll] = useState(false);
  const [isDraggingFastScroll, setIsDraggingFastScroll] = useState(false);
  const [fastScrollPct, setFastScrollPct] = useState(0); // 0 to 100
  const fastScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fastScrollTrackRef = useRef<HTMLDivElement>(null);

  // Listen to scrolls on webtoonContainer
  useEffect(() => {
    const container = webtoonContainerRef.current;
    if (!container || settings.mode !== 'webtoon' || settings.fastScrollPosition === 'disabled') return;

    const handleScroll = () => {
      const totalScrollable = container.scrollHeight - container.clientHeight;
      if (totalScrollable <= 0) return;
      const pct = (container.scrollTop / totalScrollable) * 100;
      setFastScrollPct(pct);

      setIsScrollingFastScroll(true);

      if (fastScrollTimerRef.current) clearTimeout(fastScrollTimerRef.current);
      fastScrollTimerRef.current = setTimeout(() => {
        setIsScrollingFastScroll(false);
      }, 1000);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (fastScrollTimerRef.current) clearTimeout(fastScrollTimerRef.current);
    };
  }, [settings.mode, settings.fastScrollPosition, webtoonContainerRef]);

  // Pointer dragging handler for Fast Scroll handle
  const handleFastScrollPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFastScroll(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    handleFastScrollDrag(e.clientY);
  };

  const handleFastScrollDrag = (clientY: number) => {
    const track = fastScrollTrackRef.current;
    const container = webtoonContainerRef.current;
    if (!track || !container) return;

    const rect = track.getBoundingClientRect();
    const padding = 20;
    const trackHeight = rect.height - padding * 2;
    if (trackHeight <= 0) return;
    const relativeY = Math.max(0, Math.min(trackHeight, clientY - rect.top - padding));
    const pct = relativeY / trackHeight;

    setFastScrollPct(pct * 100);

    const totalScrollable = container.scrollHeight - container.clientHeight;
    container.scrollTop = pct * totalScrollable;
  };

  const handleFastScrollPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingFastScroll) return;
    e.preventDefault();
    e.stopPropagation();
    handleFastScrollDrag(e.clientY);
  };

  const handleFastScrollPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFastScroll(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    
    if (fastScrollTimerRef.current) clearTimeout(fastScrollTimerRef.current);
    fastScrollTimerRef.current = setTimeout(() => {
      setIsScrollingFastScroll(false);
    }, 1000);
  };

  // Reset zoom & pan
  const resetZoom = useCallback(() => {
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  // Helper to fetch page Blob depending on format
  const fetchPageBlob = useCallback(async (index: number): Promise<Blob> => {
    if (comic.format === 'pdf') {
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

  // Init / mode transitions: только webtoon нуждается в прыжке к текущей
  // странице; в paged-режиме загрузку страницы делает эффект
  // [currentPage, settings.mode] ниже (иначе при старте страница грузилась
  // дважды — из обоих эффектов).
  useEffect(() => {
    if (settings.mode === 'webtoon') {
      const timer = setTimeout(() => {
        const pageEl = document.getElementById(`webtoon-page-${currentPage}`);
        pageEl?.scrollIntoView({ block: 'start' });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [settings.mode, currentPage]);

  // Unmount cleanup: object-URL страниц + кэши (по рефам — ревок никогда
  // не сработает во время активного отображения страницы).
  useEffect(() => {
    return () => {
      if (pageUrlRef.current) URL.revokeObjectURL(pageUrlRef.current);
      if (nextPageUrlRef.current) URL.revokeObjectURL(nextPageUrlRef.current);
      clearPDFCache();
      clearPdfPageCache();
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
        setCurrentPage((prev) => prev + 1);
        setSplitPart(null);
      } else if (nextComic) {
        setShowNextOverlay(true);
      }
    } else {
      if (currentPage > 0) {
        setCurrentPage((prev) => prev - 1);
        setSplitPart(null);
      }
    }
  }, [currentPage, comic.totalPages, settings.direction, settings.splitDoublePages, isLandscape, splitPart, nextComic]);

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

  // Keyboard navigation & Volume keys overrides
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Paged navigation
      if (settings.mode === 'paged') {
        if (e.key === 'ArrowRight' || e.key === ' ') {
          e.preventDefault();
          turnPage('next');
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          turnPage('prev');
        }
      }

      // Volume buttons page turning (VolumeUp / VolumeDown overrides)
      if (settings.volumeKeysEnabled) {
        if (e.key === 'VolumeUp' || e.key === 'AudioVolumeUp') {
          e.preventDefault();
          turnPage(settings.direction === 'ltr' ? 'prev' : 'next');
        } else if (e.key === 'VolumeDown' || e.key === 'AudioVolumeDown') {
          e.preventDefault();
          turnPage(settings.direction === 'ltr' ? 'next' : 'prev');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [settings.mode, settings.volumeKeysEnabled, settings.direction, turnPage]);

  // Listener for native volume keys override (dispatched from Java)
  useEffect(() => {
    const handleNativeVolumeKey = (e: Event) => {
      if (!settings.volumeKeysEnabled) return;
      const customEvent = e as CustomEvent<{ key: 'volume_up' | 'volume_down' }>;
      const keyType = customEvent.detail.key;
      if (keyType === 'volume_up') {
        turnPage(settings.direction === 'ltr' ? 'prev' : 'next');
      } else if (keyType === 'volume_down') {
        turnPage(settings.direction === 'ltr' ? 'next' : 'prev');
      }
    };

    window.addEventListener('nativeVolumeKey', handleNativeVolumeKey);
    return () => window.removeEventListener('nativeVolumeKey', handleNativeVolumeKey);
  }, [settings.volumeKeysEnabled, settings.direction, turnPage]);

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
      if (zoomScale > 1) {
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
          
          setZoomScale(2.5);
          setPanOffset({ x: newX, y: newY });
        }
      }
    }
    lastTapTime.current = now;
  };

  // Pointer dragging (Panning when zoomed, swiping when 1x zoom)
  const handlePointerDown = (e: React.PointerEvent) => {
    if (zoomScale === 1) {
      handleDoubleTap(e.clientX, e.clientY);
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
      x: e.clientX - panOffset.x,
      y: e.clientY - panOffset.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (zoomScale === 1) {
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
    setPanOffset({ x: newX, y: newY });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (zoomScale === 1) {
      if (!isSwipeDragging.current) return;
      isSwipeDragging.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
      
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
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // Toggle HUD Overlay
  const toggleHud = () => {
    setIsHudActive((prev) => !prev);
  };

  // Slide handle fast change
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pageIndex = parseInt(e.target.value);
    setCurrentPage(pageIndex);
    
    if (settings.mode === 'webtoon') {
      const pageEl = document.getElementById(`webtoon-page-${pageIndex}`);
      pageEl?.scrollIntoView({ block: 'start' });
    }
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
              title="Выпуски на полке"
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
      <div 
        className={`reader-viewport ${settings.mode === 'webtoon' ? 'webtoon-mode' : ''}`}
        ref={settings.mode === 'webtoon' ? webtoonContainerRef : null}
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
              />
            ))}
          </div>
        )}

        {/* PAGED RENDERING */}
        {settings.mode === 'paged' && pageUrl && (
          <div className="paged-container">
            <div
              ref={viewportRef}
              className="page-image-wrapper"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
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
              <span className="drawer-title" style={{ fontSize: '18px', fontWeight: 'bold' }}>Выпуски на полке ({shelfComics.length})</span>
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
            <span className="next-issue-badge">Выпуск прочитан!</span>
            <DynamicCoverImage coverBlob={nextComic.coverBlob} coverDataUrl={nextComic.coverDataUrl} title={nextComic.title} className="next-issue-cover" fallbackClassName="next-issue-cover-placeholder" />
            <h4 className="next-issue-title">Открыть следующий выпуск?</h4>
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

      {/* Fast Scroll Handle Track (Webtoon mode) */}
      {settings.mode === 'webtoon' && settings.fastScrollPosition && settings.fastScrollPosition !== 'disabled' && (
        <div 
          ref={fastScrollTrackRef}
          className={`fast-scroll-track ${isScrollingFastScroll || isDraggingFastScroll ? 'visible' : ''}`}
          onPointerMove={handleFastScrollPointerMove}
          onPointerUp={handleFastScrollPointerUp}
          onPointerCancel={handleFastScrollPointerUp}
          style={{
            position: 'absolute',
            top: '80px',
            bottom: '100px',
            [settings.fastScrollPosition]: '12px',
            width: '24px',
            zIndex: 110,
            display: 'flex',
            justifyContent: 'center',
            opacity: isScrollingFastScroll || isDraggingFastScroll ? 0.7 : 0,
            pointerEvents: isScrollingFastScroll || isDraggingFastScroll ? 'auto' : 'none',
            transition: 'opacity 0.3s ease',
          }}
        >
          <div
            className="fast-scroll-handle"
            onPointerDown={handleFastScrollPointerDown}
            style={{
              width: '8px',
              height: '48px',
              borderRadius: '4px',
              backgroundColor: 'var(--text-primary)',
              cursor: 'ns-resize',
              position: 'absolute',
              top: `calc(20px + ${fastScrollPct}% * (100% - 40px) / 100)`,
              transform: 'translateY(-50%)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
              transition: 'background-color 0.2s ease, transform 0.1s ease',
              touchAction: 'none'
            }}
          />
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
}

const WebtoonPageWrapper: React.FC<WebtoonPageWrapperProps> = React.memo(
  ({ index, fetchPageBlob, onVisible, filterStyles }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [imgUrl, setImgUrl] = useState<string | null>(null);
    const [aspectRatio, setAspectRatio] = useState<number | null>(null);
    // Реф владеет URL: observer-колбэк читает/пишет его, а state только
    // отражает текущий URL для отрисовки. Раньше `imgUrl` был в deps —
    // cleanup ревокал URL ещё показываемой картинки (гонка с async-загрузкой).
    const imgUrlRef = useRef<string | null>(null);

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
        setAspectRatio(img.naturalWidth / img.naturalHeight);
      }
    };

    return (
      <div
        ref={containerRef}
        id={`webtoon-page-${index}`}
        style={{
          width: '100%',
          aspectRatio: aspectRatio ? `${aspectRatio}` : '2/3',
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
