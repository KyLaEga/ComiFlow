import React, { useState, useEffect, useRef, useCallback } from 'react';
import { updateComicProgress } from '../utils/db';
import type { ComicMetadata } from '../utils/db';
import { getPageBlob, clearCBZCache } from '../utils/cbz';
import type { ReaderSettings } from './Settings';
import { ArrowLeft, Settings as SettingsIcon, ChevronLeft, ChevronRight } from 'lucide-react';


interface ReaderProps {
  comic: ComicMetadata;
  fileBlob: Blob;
  settings: ReaderSettings;
  onClose: () => void;
  onOpenSettings: () => void;
}

export const Reader: React.FC<ReaderProps> = ({
  comic,
  fileBlob,
  settings,
  onClose,
  onOpenSettings,
}) => {
  const [currentPage, setCurrentPage] = useState(comic.currentPage);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [nextPageUrl, setNextPageUrl] = useState<string | null>(null);
  const [isLoadingPage, setIsLoadingPage] = useState(false);
  const [isHudActive, setIsHudActive] = useState(true);

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

  // Webtoon scroll images URLs
  const [webtoonPageUrls, setWebtoonPageUrls] = useState<string[]>([]);
  const webtoonContainerRef = useRef<HTMLDivElement>(null);

  // Reset zoom & pan
  const resetZoom = useCallback(() => {
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  // Prefetch adjacent page
  const prefetchNextPage = useCallback(async (nextIdx: number) => {
    if (nextIdx >= 0 && nextIdx < comic.pages.length) {
      try {
        const nextBlob = await getPageBlob(comic.id, fileBlob, comic.pages[nextIdx]);
        const url = URL.createObjectURL(nextBlob);
        setNextPageUrl(url);
      } catch (err) {
        console.warn('Failed to prefetch next page:', err);
      }
    } else {
      setNextPageUrl(null);
    }
  }, [comic.id, comic.pages, fileBlob]);

  // Load a single page for paged mode
  const loadPage = useCallback(async (index: number) => {
    setIsLoadingPage(true);
    try {
      // Clear previous page url to avoid memory leaks
      if (pageUrl && pageUrl !== nextPageUrl) {
        URL.revokeObjectURL(pageUrl);
      }

      // If we already prefetched this page, use it!
      if (nextPageUrl && index === currentPage + 1) {
        setPageUrl(nextPageUrl);
        setNextPageUrl(null);
      } else {
        const blob = await getPageBlob(comic.id, fileBlob, comic.pages[index]);
        const url = URL.createObjectURL(blob);
        setPageUrl(url);
      }

      if (!settings.zoomLock) {
        resetZoom();
      }
      
      // Update DB progress
      await updateComicProgress(comic.id, index);
      
      // Prefetch the next page in the background
      const nextIdx = index + (settings.direction === 'ltr' ? 1 : -1);
      prefetchNextPage(nextIdx);
    } catch (err) {
      console.error('Error loading page:', err);
    } finally {
      setIsLoadingPage(false);
    }
  }, [comic.id, comic.pages, fileBlob, currentPage, pageUrl, nextPageUrl, settings.zoomLock, settings.direction, resetZoom, prefetchNextPage]);

  // Load all pages for Webtoon mode
  const loadAllWebtoonPages = useCallback(async () => {
    setIsLoadingPage(true);
    try {
      // Revoke any previous urls
      webtoonPageUrls.forEach(url => URL.revokeObjectURL(url));
      
      const urls: string[] = [];
      // To prevent lagging, load them sequentially
      for (let i = 0; i < comic.pages.length; i++) {
        const blob = await getPageBlob(comic.id, fileBlob, comic.pages[i]);
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
  }, [comic.id, comic.pages, fileBlob, currentPage]);

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
      }
    } else {
      if (currentPage > 0) {
        setCurrentPage((prev) => prev - 1);
        setSplitPart(null);
      }
    }
  }, [currentPage, comic.totalPages, settings.direction, settings.splitDoublePages, isLandscape, splitPart]);

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

  // Pointer dragging (Panning when zoomed)
  const handlePointerDown = (e: React.PointerEvent) => {
    if (zoomScale === 1) {
      handleDoubleTap(e.clientX, e.clientY);
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
    if (!isDragging.current) return;
    const newX = e.clientX - startDragOffset.current.x;
    const newY = e.clientY - startDragOffset.current.y;
    
    // Boundary check to keep images inside screen
    setPanOffset({ x: newX, y: newY });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
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
                transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`,
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
    </div>
  );
};
