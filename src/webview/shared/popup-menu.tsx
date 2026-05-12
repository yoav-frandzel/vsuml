/**
 * Theme-aware cursor-anchored popup menu, used as a custom alternative to
 * VS Code's showQuickPick when an action UI needs to appear at the click
 * position rather than at the top of the editor.
 *
 * Dismissal: callers wire up a window mousedown/contextmenu/Escape
 * listener that closes the menu unless the event target is inside the
 * forwarded ref.
 */

import React from 'react';

export type PopupMenuItem =
  | {
      label: string;
      shortcut?: string;
      icon?: React.ReactNode;
      checked?: boolean;
      onClick: () => void;
      separator?: false;
    }
  | { separator: true };

interface PopupMenuProps {
  x: number;
  y: number;
  items: PopupMenuItem[];
  /** Width reserved for icons / check marks. Defaults to 0 (no column). */
  iconColumnWidth?: number;
}

export const PopupMenu = React.forwardRef<HTMLDivElement, PopupMenuProps>(
  function PopupMenu({ x, y, items, iconColumnWidth }, ref) {
    const hasIcons =
      items.some(it => 'icon' in it && it.icon) ||
      items.some(it => 'checked' in it && it.checked);
    const colW = iconColumnWidth ?? (hasIcons ? 56 : 0);
    return (
      <div
        ref={ref}
        role="menu"
        style={{
          position: 'fixed',
          left: x,
          top: y,
          zIndex: 1000,
          background: 'var(--vscode-menu-background)',
          color: 'var(--vscode-menu-foreground)',
          border:
            '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          padding: '4px 0',
          minWidth: 200,
          fontFamily: 'var(--vscode-font-family)',
          fontSize: 12
        }}
        onMouseDown={e => e.stopPropagation()}
        onContextMenu={e => e.preventDefault()}
      >
        {items.map((it, i) =>
          'separator' in it && it.separator ? (
            <div
              key={`sep-${i}`}
              style={{
                height: 1,
                margin: '4px 0',
                background:
                  'var(--vscode-menu-separatorBackground, rgba(255,255,255,0.1))'
              }}
            />
          ) : (
            <button
              key={i}
              role="menuitem"
              onClick={it.onClick}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                padding: '4px 12px',
                gap: 10,
                background: 'transparent',
                color: 'inherit',
                border: 0,
                textAlign: 'left',
                cursor: 'pointer'
              }}
              onMouseOver={e => {
                (e.currentTarget as HTMLElement).style.background =
                  'var(--vscode-menu-selectionBackground)';
                (e.currentTarget as HTMLElement).style.color =
                  'var(--vscode-menu-selectionForeground)';
              }}
              onMouseOut={e => {
                (e.currentTarget as HTMLElement).style.background = 'transparent';
                (e.currentTarget as HTMLElement).style.color = 'inherit';
              }}
            >
              {colW > 0 && (
                <span
                  style={{
                    width: colW,
                    height: 14,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                    flex: '0 0 auto'
                  }}
                >
                  {it.checked ? '✓' : (it.icon ?? null)}
                </span>
              )}
              <span style={{ flex: 1 }}>{it.label}</span>
              {it.shortcut && (
                <span style={{ opacity: 0.7, marginLeft: 16 }}>{it.shortcut}</span>
              )}
            </button>
          )
        )}
      </div>
    );
  }
);

/**
 * Convenience hook: attaches global mousedown / contextmenu / Escape
 * listeners that close the popup when the user clicks outside it.
 *
 * Call with the open state and a ref attached to the PopupMenu container.
 * Returns nothing; pass `() => setOpen(undefined)` as the close callback.
 */
export function useDismissOnOutsideClick(
  isOpen: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  close: () => void
): void {
  React.useEffect(() => {
    if (!isOpen) return;
    const dismiss = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && containerRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const t = setTimeout(() => {
      window.addEventListener('mousedown', dismiss);
      window.addEventListener('contextmenu', dismiss);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('contextmenu', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, containerRef, close]);
}
