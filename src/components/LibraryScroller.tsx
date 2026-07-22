import { useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

/**
 * Floating fast-scroll control for the comic library grid.
 *
 * A vertical track + draggable thumb, bottom-right (thumb-friendly zone on
 * mobile), with a direction-aware action button above it:
 *
 *   ┌─────┐
 *   │  ▲  │   ← Tap the button: jump to the opposite end of the catalog
 *   └─────┘     (▲ "to top" when past the middle, ▼ "to bottom" otherwise).
 *   ┌─────┐
 *   │     │   ← The track holds a draggable thumb (●). Press & drag it
 *   │  ●  │     up/down to fast-travel to any position instantly. Tapping
 *   │     │     anywhere on the track also scrubs to that position.
 *   └─────┘
 *
 * The whole widget appears once you've scrolled away from the very top, and
 * fades out after ~1.2s of inactivity so it never clutters the view.
 *
 * Tracks `window` scroll (library uses VirtuosoGrid with `useWindowScroll`).
 */
interface LibraryScrollerProps {
  /** Total number of items in the visible (filtered) catalog. */
  itemCount: number;
}

const HIDE_DELAY_MS = 1200;

export const LibraryScroller: React.FC<LibraryScrollerProps> = ({ itemCount }) => {
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pct, setPct] = useState(0); // 0..100 scroll progress
  // Whether the page actually has enough content to scroll. Measured from the
  // real document height rather than a fixed item count, so the scroller shows
  // up whenever scrolling is possible (even with few comics) and hides when not.
  const [hasScroll, setHasScroll] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const reveal = () => {
    setVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
  };

  useEffect(() => {
    // Minimum overflow (px) for the scroller to be worth showing.
    const SCROLL_THRESHOLD = 80;
    const measure = () => {
      const overflow = document.documentElement.scrollHeight - window.innerHeight;
      setHasScroll(overflow > SCROLL_THRESHOLD);
    };
    // VirtuosoGrid renders items asynchronously, so measure after paint and on resize.
    measure();
    const raf = requestAnimationFrame(measure);
    const later = setTimeout(measure, 300);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(later);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemCount]);

  useEffect(() => {
    if (!hasScroll) return;

    const handleScroll = () => {
      const total = document.documentElement.scrollHeight - window.innerHeight;
      const current = total > 0 ? (window.scrollY / total) * 100 : 0;
      setPct(Math.max(0, Math.min(100, current)));
      if (window.scrollY > window.innerHeight * 0.2) {
        reveal();
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasScroll]);

  // Map a pointer Y within the track to a scroll ratio.
  const scrubFromClientY = (clientY: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const total = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: ratio * total, behavior: 'auto' });
    setPct(ratio * 100);
  };

  const onThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    setDragging(true);
    reveal();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubFromClientY(e.clientY);
  };

  const onThumbPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    scrubFromClientY(e.clientY);
  };

  const onThumbPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = false;
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    reveal();
  };

  // Tap the top button = jump to the opposite end of the catalog.
  const onTopClick = () => {
    const nearTop = pct < 50;
    const target = nearTop ? document.documentElement.scrollHeight : 0;
    window.scrollTo({ top: target, behavior: 'smooth' });
    reveal();
  };

  if (!hasScroll) return null;

  const show = visible || dragging;
  const opacity = show ? (dragging ? 1 : 0.85) : 0;
  const nearTop = pct < 50;
  const THUMB_H = 40;

  return (
    <div
      style={{
        position: 'fixed',
        right: '10px',
        bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        opacity,
        pointerEvents: show ? 'auto' : 'none',
        transition: 'opacity 0.25s ease',
        touchAction: 'none',
      }}
    >
      {/* Direction-aware jump button */}
      <button
        onClick={onTopClick}
        aria-label={nearTop ? 'Вниз' : 'Наверх'}
        style={{
          width: '44px',
          height: '44px',
          borderRadius: '50%',
          border: '1px solid var(--border-color)',
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          color: 'var(--text-primary)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 16px var(--shadow)',
          flexShrink: 0,
        }}
      >
        {nearTop ? <ChevronDown size={22} /> : <ChevronUp size={22} />}
      </button>

      {/* Vertical scrub track + draggable thumb */}
      <div
        ref={trackRef}
        onPointerDown={(e) => {
          // Tap anywhere on the track scrubs to that position.
          onThumbPointerDown(e as unknown as React.PointerEvent<HTMLDivElement>);
        }}
        style={{
          position: 'relative',
          width: '28px',
          height: '150px',
          borderRadius: '14px',
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid var(--border-color)',
          boxShadow: '0 4px 16px var(--shadow)',
          touchAction: 'none',
          cursor: 'ns-resize',
        }}
      >
        <div
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
          onPointerCancel={onThumbPointerUp}
          style={{
            position: 'absolute',
            left: '4px',
            right: '4px',
            height: `${THUMB_H}px`,
            borderRadius: '10px',
            background: 'var(--accent)',
            top: `calc(${pct}% - ${(pct / 100) * THUMB_H}px)`,
            boxShadow: dragging ? '0 0 0 3px var(--accent-glow)' : '0 2px 6px var(--shadow)',
            transition: dragging ? 'none' : 'top 0.1s ease',
            cursor: 'grab',
          }}
        />
      </div>
    </div>
  );
};
