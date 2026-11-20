import { type KeyboardEvent, useRef } from 'react';
import { flushSync } from 'react-dom';
import { Button } from './ui';
import { shortcutLabel } from '../lib/navigation';
import { desktopSettingsAvailable } from '../lib/desktop';
import { readUiPreference, writeUiPreference } from '../lib/ui-preferences';

export type SidebarState = { hidden: boolean; width: number };

function limits() {
  const style = getComputedStyle(document.documentElement);
  const size = (name: string) => Number(style.getPropertyValue(name).replace('px', ''));
  return { min: size('--side-min-width'), max: size('--side-width') };
}

export function readSidebarState(): SidebarState {
  const { min, max } = limits();
  const width = Number(readUiPreference('nod.sidebar-width'));
  return {
    hidden: readUiPreference('nod.sidebar') === 'hidden',
    width: width > 0 ? Math.min(max, Math.max(min, width)) : max,
  };
}

export function writeSidebarState({ hidden, width }: SidebarState) {
  writeUiPreference('nod.sidebar', hidden ? 'hidden' : 'shown');
  writeUiPreference('nod.sidebar-width', String(width));
}

export function toggleSidebarState(state: SidebarState): SidebarState {
  return { ...state, hidden: !state.hidden };
}

let stopSlide = () => {};

export function stopSidebarSlide() {
  stopSlide();
}

function slideSidebar(toggle: HTMLElement, apply: () => void) {
  const shell = toggle.closest<HTMLElement>('.app-shell');
  const sidebar = shell?.querySelector<HTMLElement>('.sidebar');
  const body = shell?.querySelector<HTMLElement>('.workspace-body');
  if (
    !shell ||
    !sidebar ||
    !body ||
    window.matchMedia('(max-width: 640px), (prefers-reduced-motion: reduce)').matches
  )
    return apply();
  const toolbar = shell.querySelector<HTMLElement>('.desktop-toolbar');
  const centre = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return (rect.left + rect.right) / 2;
  };
  const edge = sidebar.getBoundingClientRect();
  const bodyFrom = centre(body);
  const toggleFrom = toggle.getBoundingClientRect().left;
  stopSlide();
  flushSync(apply);
  shell.toggleAttribute('data-sliding', true);
  const hidden = shell.classList.contains('sidebar-hidden');
  sidebar.style.width = hidden ? `${edge.width}px` : '';
  const width = hidden ? edge.width : sidebar.getBoundingClientRect().width;
  const timing = {
    duration: 300,
    easing: getComputedStyle(shell).getPropertyValue('--ease-enter').trim() || 'ease-out',
  };
  const bodyShift = bodyFrom - centre(body);
  const toggleShift = toggleFrom - toggle.getBoundingClientRect().left;
  const covered = toolbar ? Math.max(0, edge.right - toolbar.getBoundingClientRect().left) : 0;
  const divider = shell.querySelector<HTMLElement>('.sidebar-resizer');
  const dividerAt = divider ? centre(divider) : 0;
  const panel = sidebar.animate(
    {
      transform: [`translateX(${edge.right - width}px)`, hidden ? 'translateX(-100%)' : 'none'],
    },
    timing,
  );
  const sliding = [
    panel,
    body.animate({ transform: [`translateX(${bodyShift}px)`, 'none'] }, timing),
    ...(toggleShift
      ? [toggle.animate({ transform: [`translateX(${toggleShift}px)`, 'none'] }, timing)]
      : []),
    ...(divider?.offsetWidth
      ? [
          divider.animate(
            {
              transform: [
                `translateX(${edge.right - dividerAt}px)`,
                `translateX(${(hidden ? 0 : width) - dividerAt}px)`,
              ],
            },
            timing,
          ),
        ]
      : []),
    ...(toolbar && covered
      ? [toolbar.animate({ clipPath: [`inset(0 0 0 ${covered}px)`, 'inset(0)'] }, timing)]
      : []),
  ];
  const stop = () => {
    stopSlide = () => {};
    for (const animation of sliding) animation.cancel();
    shell.removeAttribute('data-sliding');
    sidebar.style.width = '';
  };
  stopSlide = stop;
  panel.finished.then(
    () => {
      if (stopSlide === stop) stop();
    },
    () => {},
  );
}

export function SidebarToggle({
  hidden,
  unread,
  onToggle,
}: {
  hidden: boolean;
  unread: boolean;
  onToggle(): void;
}) {
  const desktop = desktopSettingsAvailable();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const label = hidden ? 'Show sidebar' : 'Hide sidebar';
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="sidebar-toggle"
      data-lights={desktop && mac ? '' : undefined}
      aria-label={hidden && unread ? `${label}, unread messages` : label}
      title={label}
      shortcut={desktop ? shortcutLabel('b', mac) : undefined}
      tooltipSide="bottom"
      aria-expanded={!hidden}
      aria-controls="sidebar-navigation"
      aria-keyshortcuts={desktop ? `${mac ? 'Meta' : 'Control'}+B` : undefined}
      onClick={(event) =>
        event.detail > 0 ? slideSidebar(event.currentTarget, onToggle) : onToggle()
      }
    >
      <svg
        className="sidebar-toggle-symbol"
        width="16"
        height="16"
        viewBox="0 0 18 18"
        fill="none"
        aria-hidden="true"
      >
        <rect x="1.75" y="2.75" width="14.5" height="12.5" rx="2.75" />
        <path className="sidebar-toggle-divider" d="M7.75 3.5v11" />
      </svg>
      {hidden && unread && <span className="sidebar-toggle-dot" aria-hidden="true" />}
    </Button>
  );
}

export function SidebarResizer({
  hidden,
  width,
  onResize,
}: SidebarState & { onResize(state: SidebarState): void }) {
  const drag = useRef<{
    offset: number;
    hidden: boolean;
    width: number;
    restore: number;
  } | null>(null);
  const { min, max } = limits();
  const track = (handle: HTMLElement, size?: number) => {
    const shell = handle.closest<HTMLElement>('.app-shell');
    const sidebar = shell?.querySelector<HTMLElement>('.sidebar');
    const toolbar = shell?.querySelector<HTMLElement>('.desktop-toolbar');
    const toggle = shell?.querySelector<HTMLElement>('.sidebar-toggle');
    const value = size === undefined ? '' : `${size}px`;
    if (sidebar) sidebar.style.width = value;
    if (toolbar) toolbar.style.left = value;
    toggle?.style.setProperty('--desktop-sidebar-width', value);
    return shell;
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowRight'
        ? { hidden: false, width: hidden ? width : Math.min(max, width + 16) }
        : event.key === 'ArrowLeft'
          ? hidden || width - 16 < min
            ? { hidden: true, width }
            : { hidden: false, width: width - 16 }
          : event.key === 'Home'
            ? { hidden: true, width }
            : event.key === 'End'
              ? { hidden: false, width: max }
              : undefined;
    if (!next) return;
    event.preventDefault();
    onResize(next);
  };
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-controls="sidebar-navigation"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={hidden ? 0 : width}
      tabIndex={0}
      onKeyDown={key}
      onDoubleClick={() => onResize({ hidden: false, width: hidden || width < max ? max : min })}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.toggleAttribute('data-dragging', true);
        drag.current = {
          offset: event.clientX - (hidden ? 0 : width),
          hidden,
          width,
          restore: width,
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        const position = event.clientX - current.offset;
        const hide = position < min * (current.hidden ? 0.6 : 0.4);
        if (hide !== current.hidden) {
          current.hidden = hide;
          if (!hide) current.width = min;
          track(event.currentTarget);
          onResize({ hidden: hide, width: hide ? current.restore : current.width });
        }
        if (hide) return;
        current.width = Math.min(max, Math.max(min, Math.round(position)));
        track(event.currentTarget, current.width);
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        if (!current) return;
        drag.current = null;
        event.currentTarget.removeAttribute('data-dragging');
        const width = current.hidden ? current.restore : current.width;
        track(event.currentTarget)?.style.setProperty('--sidebar-width', `${width}px`);
        onResize({ hidden: current.hidden, width });
      }}
      onLostPointerCapture={(event) => {
        if (!drag.current) return;
        drag.current = null;
        event.currentTarget.removeAttribute('data-dragging');
        track(event.currentTarget);
        onResize({ hidden, width });
      }}
    />
  );
}
