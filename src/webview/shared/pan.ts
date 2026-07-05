/**
 * Canvas panning and zooming for large diagrams.
 *
 * Pan gestures (never collide with left-button selection / drag / edge draw):
 *   - middle mouse button drag
 *   - hold Space and drag with the left button
 *
 * Zoom (maxGraph canvases):
 *   - mouse wheel            → zoom to the cursor
 *   - Ctrl/Cmd + '=' / '-'   → zoom in / out around the centre
 *   - Ctrl/Cmd + '0'         → reset to 100%
 *   - toolbar +/−/% buttons  → via the returned controller
 *
 * maxGraph diagrams (class, state) use the built-in PanningHandler for pan
 * and the view transform for zoom; the custom SVG sequence diagram pans by
 * scrolling its container and zooms via its own React state.
 */

import {
  InternalEvent,
  PanningHandler,
  type Graph,
  type InternalMouseEvent
} from '@maxgraph/core';

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.15;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export interface GraphPanZoomController {
  dispose(): void;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
}

/**
 * Enables middle-drag / Space+drag panning and wheel + keyboard zooming on a
 * maxGraph canvas. `onScaleChange` is invoked with the current scale whenever
 * it changes (including Fit). Returns a controller for toolbar zoom buttons.
 */
export function installGraphPanZoom(
  graph: Graph,
  onScaleChange?: (scale: number) => void
): GraphPanZoomController {
  const container = graph.getContainer();
  const view = graph.getView();
  let spaceDown = false;

  graph.setPanning(true);
  const ph = graph.getPlugin<PanningHandler>(PanningHandler.pluginId);
  if (ph) {
    ph.panningEnabled = true;
    // Force panning (even over cells) for our two gestures only. The default
    // Ctrl+Shift / popup triggers stay intact via the untouched methods.
    ph.isForcePanningEvent = (me: InternalMouseEvent): boolean => {
      const evt = me.getEvent() as MouseEvent;
      return evt.button === 1 || (spaceDown && evt.button === 0);
    };
  }

  // Report scale on any view change so the toolbar % stays in sync (covers
  // wheel/keyboard zoom, the returned controller, and the Fit plugin).
  const reportScale = () => onScaleChange?.(view.scale);
  view.addListener(InternalEvent.SCALE, reportScale);
  view.addListener(InternalEvent.SCALE_AND_TRANSLATE, reportScale);

  // Zoom keeping the graph point at (cx, cy) container-pixels fixed.
  const zoomAt = (cx: number, cy: number, factor: number) => {
    const oldScale = view.scale;
    const newScale = clampScale(oldScale * factor);
    if (newScale === oldScale) return;
    const tx = view.translate.x;
    const ty = view.translate.y;
    const gx = cx / oldScale - tx;
    const gy = cy / oldScale - ty;
    view.scaleAndTranslate(newScale, cx / newScale - gx, cy / newScale - gy);
  };
  const zoomCenter = (factor: number) =>
    zoomAt(container.clientWidth / 2, container.clientHeight / 2, factor);

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !spaceDown && !isTypingTarget(e.target)) {
      spaceDown = true;
      container.style.cursor = 'grab';
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (e.key === '=' || e.key === '+') {
        zoomCenter(ZOOM_STEP);
        e.preventDefault();
      } else if (e.key === '-' || e.key === '_') {
        zoomCenter(1 / ZOOM_STEP);
        e.preventDefault();
      } else if (e.key === '0') {
        zoomCenter(1 / view.scale);
        e.preventDefault();
      }
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      spaceDown = false;
      container.style.cursor = '';
    }
  };
  // Suppress the browser's middle-click autoscroll widget inside the canvas.
  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  container.addEventListener('mousedown', onMouseDown);
  container.addEventListener('wheel', onWheel, { passive: false });

  // Emit the starting scale.
  reportScale();

  return {
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('wheel', onWheel);
      view.removeListener(reportScale);
      container.style.cursor = '';
    },
    zoomIn: () => zoomCenter(ZOOM_STEP),
    zoomOut: () => zoomCenter(1 / ZOOM_STEP),
    reset: () => zoomCenter(1 / view.scale)
  };
}

/**
 * Enables middle-drag and Space+drag panning on a scrollable container
 * (the SVG sequence diagram). Returns a disposer.
 */
export function installScrollPan(el: HTMLElement): () => void {
  let spaceDown = false;
  let panning = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !spaceDown && !isTypingTarget(e.target)) {
      spaceDown = true;
      el.style.cursor = 'grab';
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      spaceDown = false;
      if (!panning) el.style.cursor = '';
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    const trigger = e.button === 1 || (e.button === 0 && spaceDown);
    if (!trigger) return;
    panning = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = el.scrollLeft;
    startTop = el.scrollTop;
    el.style.cursor = 'grabbing';
    el.setPointerCapture(e.pointerId);
    // Capture-phase + stop so child SVG selection/drag handlers don't fire.
    e.preventDefault();
    e.stopPropagation();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!panning) return;
    el.scrollLeft = startLeft - (e.clientX - startX);
    el.scrollTop = startTop - (e.clientY - startY);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!panning) return;
    panning = false;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    el.style.cursor = spaceDown ? 'grab' : '';
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  el.addEventListener('pointerdown', onPointerDown, true);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    el.removeEventListener('pointerdown', onPointerDown, true);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerUp);
    el.style.cursor = '';
  };
}
