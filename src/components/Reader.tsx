import React, { useState, useEffect, useRef, useCallback } from 'react';
import { updateComicProgress } from '../utils/db';
import type { ComicMetadata } from '../utils/db';
import { getPageBlob, clearCBZCache } from '../utils/cbz';
import { getPdfPageBlob, clearPDFCache } from '../utils/pdf';
import type { ReaderSettings } from './Settings';
import { ArrowLeft, Settings as SettingsIcon, ChevronLeft, ChevronRight, LayoutGrid, X } from 'lucide-react';


interface ReaderProps {
  comic: ComicMetadata;
  fileBlob: Blob;
  settings: ReaderSettings;
  onClose: () => void;
  onOpenSettings: () => void;
  shelfComics: ComicMetadata[];
  onSelectComic: (id: string) => void;
}

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
  const [nextPageUrl, setNextPageUrl] = useState<string | null>(null);
  const [isLoadingPage, setIsLoadingPage] = useState(false);
  const [isHudActive, setIsHudActive] = useState(true);
  
  // Find next comic on this shelf
  const sortedShelfComics = [...shelfComics].sort((a, b) => a.title.localeCompare(b.title));
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
  
  // Touch swipe states
  const [swipeTranslation, setSwipeTranslation] = useState(0);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const isSwipeDragging = useRef(false);

  // Webtoon scroll images URLs
  const [webtoonPageUrls, setWebtoonPageUrls] = useState<string[]>([]);
  const webtoonContainerRef = useRef<HTMLDivElement>(null);

  // Reset zoom & pan
  const resetZoom = useCallback(() => {
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  // Helper to fetch page Blob depending on format
  const fetchPageBlob = useCallback(async (index: number): Promise<Blob> => {
    if (comic.format === 'pdf') {
      return await getPdfPageBlob(comic.id, fileBlob, index + 1);
    } else {
      return await getPageBlob(comic.id, fileBlob, comic.pages[index]);
    }
  }, [comic.id, comic.pages, comic.format, fileBlob]);

  // Prefetch adjacent page
  const prefetchNextPage = useCallback(async (nextIdx: number) => {
    if (nextIdx >= 0 && nextIdx < comic.pages.length) {
      try {
        const nextBlob = await fetchPageBlob(nextIdx);
        const url = URL.createObjectURL(nextBlob);
        setNextPageUrl(url);
      } catch (err) {
        console.warn('Failed to prefetch next page:', err);
      }
    } else {
      setNextPageUrl(null);
    }
  }, [comic.pages.length, fetchPageBlob]);

  // Load a single page for paged mode
  const loadPage = useCallback(async (index: number) => {
    setIsLoadingPage(true);
    const loadId = ++latestLoadId.current;
    try {
      // Clear previous page url to avoid memory leaks
      if (pageUrl && pageUrl !== nextPageUrl) {
        URL.revokeObjectURL(pageUrl);
      }

      // If we jumped to a page that isn't the next page, revoke prefetch to prevent memory leak
      if (nextPageUrl && index !== currentPage + 1) {
        URL.revokeObjectURL(nextPageUrl);
        setNextPageUrl(null);
      }

      let newUrl: string;
      // If we already prefetched this page, use it!
      if (nextPageUrl && index === currentPage + 1) {
        newUrl = nextPageUrl;
        setNextPageUrl(null);
      } else {
        const blob = await fetchPageBlob(index);
        newUrl = URL.createObjectURL(blob);
      }

      // If this request was superseded by a newer page turn, abort and clean up
      if (loadId !== latestLoadId.current) {
        URL.revokeObjectURL(newUrl);
        return;
      }

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
  }, [currentPage, pageUrl, nextPageUrl, settings.zoomLock, settings.direction, resetZoom, prefetchNextPage, fetchPageBlob, comic.id]);

  // Load all pages for Webtoon mode
  const loadAllWebtoonPages = useCallback(async () => {
    setIsLoadingPage(true);
    try {
      // Revoke any previous urls
      webtoonPageUrls.forEach(url => URL.revokeObjectURL(url));
      
      const urls: string[] = [];
      // To prevent lagging, load them sequentially
      for (let i = 0; i < comic.pages.length; i++) {
        const blob = await fetchPageBlob(i);
        urls.push(URL.createObjectURL(blob));
      }
      setWebtoonPageUrls(urls);

      // Scroll to current page after loading
      setTimeout(() => {
        const pageEl = document.getElementById(`webtoon-page-${currentPage}`);
        if (pageEl) {
          pageEl.scrollIntoView({ block: 'start' });
        }
      }, 300);
    } catch (err) {
      console.error('Error loading webtoon pages:', err);
    } finally {
      setIsLoadingPage(false);
    }
  }, [comic.pages.length, fetchPageBlob, webtoonPageUrls, currentPage]);

  // Init mode transitions
  useEffect(() => {
    if (settings.mode === 'webtoon') {
      loadAllWebtoonPages();
    } else {
      loadPage(currentPage);
    }

    return () => {
      // Cleanup URLs
      if (pageUrl) URL.revokeObjectURL(pageUrl);
      if (nextPageUrl) URL.revokeObjectURL(nextPageUrl);
      webtoonPageUrls.forEach(url => URL.revokeObjectURL(url));
      clearCBZCache();
      clearPDFCache();
    };
  }, [settings.mode]);

  // Sync page changes in paged mode
  useEffect(() => {
    if (settings.mode === 'paged') {
      loadPage(currentPage);
    }
  }, [currentPage, settings.mode]);

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

  // Webtoon scroll listener to track page progress
  const handleWebtoonScroll = () => {
    if (settings.mode !== 'webtoon' || !webtoonContainerRef.current) return;
    const container = webtoonContainerRef.current;
    const scrollPos = container.scrollTop + container.clientHeight / 2;
    
    // Find which page is in the middle of viewport
    let currentActiveIdx = 0;
    for (let i = 0; i < comic.totalPages; i++) {
      const pageEl = document.getElementById(`webtoon-page-${i}`);
      if (pageEl) {
        const { offsetTop, clientHeight } = pageEl;
        if (scrollPos >= offsetTop && scrollPos <= offsetTop + clientHeight) {
          currentActiveIdx = i;
          break;
        }
      }
    }
    
    if (currentActiveIdx !== currentPage) {
      setCurrentPage(currentActiveIdx);
      updateComicProgress(comic.id, currentActiveIdx);
    }
  };

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

  // Filter Styles for Brightness and Contrast
  const filterStyles = {
    filter: `brightness(${settings.brightness}%) contrast(${settings.contrast}%)`,
  };

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
        onScroll={settings.mode === 'webtoon' ? handleWebtoonScroll : undefined}
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
            {webtoonPageUrls.map((url, idx) => (
              <img
                key={idx}
                id={`webtoon-page-${idx}`}
                src={url}
                alt={`Страница ${idx + 1}`}
                className="webtoon-page"
                style={filterStyles}
                loading="lazy"
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
          <div className="reader-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <span className="drawer-title">Выпуски на полке</span>
              <button className="btn-icon" onClick={() => setIsDrawerOpen(false)} aria-label="Закрыть">
                <X size={20} />
              </button>
            </div>
            <div className="drawer-comic-list">
              {shelfComics.map((c) => (
                <div
                  key={c.id}
                  className={`drawer-comic-card ${c.id === comic.id ? 'active' : ''}`}
                  onClick={() => {
                    if (c.id !== comic.id) {
                      onSelectComic(c.id);
                      setIsDrawerOpen(false);
                    }
                  }}
                >
                  <div className="drawer-cover-wrapper">
                    {c.coverUrl && (
                      <img
                        src={c.coverUrl}
                        alt={c.title}
                        className="drawer-cover"
                      />
                    )}
                  </div>
                  <span className="drawer-comic-title">{c.title}</span>
                </div>
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
            {nextComic.coverUrl && (
              <img src={nextComic.coverUrl} alt={nextComic.title} className="next-issue-cover" />
            )}
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
    </div>
  );
};
