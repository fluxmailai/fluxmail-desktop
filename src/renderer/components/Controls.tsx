import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Minus } from "lucide-react";
import type { KeyboardShortcutHint } from "../shortcuts";

type TooltipSide = "top" | "right" | "bottom";
export type SelectionState = "unchecked" | "mixed" | "checked";

export function SelectionCheckbox({
  state,
  label,
  className = "",
  disabled,
  onClick,
}: {
  state: SelectionState;
  label: string;
  className?: string;
  disabled?: boolean;
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "mixed" ? "mixed" : state === "checked"}
      aria-label={label}
      className={`selection-checkbox ${className} ${state}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="selection-indicator">
        {state === "checked" ? <Check size={12} strokeWidth={2.8} /> : null}
        {state === "mixed" ? <Minus size={12} strokeWidth={2.8} /> : null}
      </span>
    </button>
  );
}

export interface MenuOption {
  id: string;
  label: string;
  icon?: ReactNode;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect(): void;
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  label: string;
  children: ReactNode;
  tooltipSide?: TooltipSide;
  shortcut?: KeyboardShortcutHint;
}

export function IconButton({
  label,
  children,
  className = "icon-button",
  tooltipSide = "bottom",
  shortcut,
  type = "button",
  ...buttonProps
}: IconButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const tooltip = useTooltipVisibility();
  return (
    <span
      className="tooltip-control"
      onPointerEnter={tooltip.showLater}
      onPointerLeave={tooltip.hide}
      onFocusCapture={tooltip.showLater}
      onBlurCapture={tooltip.hide}
    >
      <button
        {...buttonProps}
        ref={buttonRef}
        type={type}
        className={className}
        aria-label={label}
        aria-keyshortcuts={shortcut?.keys}
        aria-describedby={tooltip.visible ? tooltipId : undefined}
      >
        {children}
      </button>
      {tooltip.visible ? (
        <TooltipBubble
          id={tooltipId}
          anchorRef={buttonRef}
          label={label}
          shortcut={shortcut}
          side={tooltipSide}
        />
      ) : null}
    </span>
  );
}

export function TooltipLabel({
  label,
  children,
  className = "",
  tooltipContent,
  tooltipClassName,
  tooltipSide = "top",
}: {
  label: string;
  children: ReactNode;
  className?: string;
  tooltipContent?: ReactNode;
  tooltipClassName?: string;
  tooltipSide?: TooltipSide;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const tooltip = useTooltipVisibility();
  return (
    <span
      className="tooltip-control"
      onPointerEnter={tooltip.showLater}
      onPointerLeave={tooltip.hide}
      onFocusCapture={tooltip.showLater}
      onBlurCapture={tooltip.hide}
    >
      <span
        ref={anchorRef}
        tabIndex={0}
        className={className}
        aria-label={label}
        aria-describedby={tooltip.visible ? tooltipId : undefined}
      >
        {children}
      </span>
      {tooltip.visible ? (
        <TooltipBubble
          id={tooltipId}
          anchorRef={anchorRef}
          label={label}
          content={tooltipContent}
          className={tooltipClassName}
          side={tooltipSide}
        />
      ) : null}
    </span>
  );
}

export function MenuButton({
  label,
  children,
  options,
  className = "",
  triggerClassName = "icon-button",
  menuClassName = "",
  align = "left",
  tooltip: tooltipEnabled = true,
  disabled = false,
  shortcut,
}: {
  label: string;
  children: ReactNode;
  options: MenuOption[];
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  align?: "left" | "right";
  tooltip?: boolean;
  disabled?: boolean;
  shortcut?: KeyboardShortcutHint;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const menuId = useId();
  const tooltip = useTooltipVisibility(tooltipEnabled && !open);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useDismissOnOutsidePress(open, rootRef, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`popup-control ${className}`}
      onPointerEnter={tooltip.showLater}
      onPointerLeave={tooltip.hide}
      onFocusCapture={tooltip.showLater}
      onBlurCapture={tooltip.hide}
    >
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-keyshortcuts={shortcut?.keys}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-describedby={tooltip.visible ? tooltipId : undefined}
        disabled={disabled}
        onClick={() => {
          tooltip.hide();
          setOpen((value) => !value);
        }}
      >
        {children}
      </button>
      {tooltip.visible ? (
        <TooltipBubble
          id={tooltipId}
          anchorRef={triggerRef}
          label={label}
          shortcut={shortcut}
          side="bottom"
        />
      ) : null}
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          className={`popup-menu popup-${align} ${menuClassName}`}
          role="menu"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
              return;
            }
            if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            if (focusMenuItemForKey(menuRef.current, event.key)) event.preventDefault();
          }}
        >
          {options.map((option) => (
            <button
              type="button"
              role="menuitem"
              key={option.id}
              className={option.danger ? "danger" : ""}
              disabled={option.disabled}
              onClick={() => {
                setOpen(false);
                option.onSelect();
              }}
            >
              <span className="popup-item-icon">
                {option.selected ? <Check size={14} /> : option.icon}
              </span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: KeyboardShortcutHint;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  submenu?: ContextMenuItem[];
  onSelect?(): void;
}

export type ContextMenuEntry =
  | ContextMenuItem
  | { type: "separator"; id: string }
  | { type: "heading"; id: string; label: string };

type MenuPoint = { x: number; y: number };
type MenuSize = { width: number; height: number };

const CONTEXT_MENU_MARGIN = 6;

/** Opens a menu at a pointer position and keeps it inside the window, like a native menu. */
export function calculateContextMenuPosition(
  point: MenuPoint,
  menu: MenuSize,
  viewport = { width: window.innerWidth, height: window.innerHeight },
): { left: number; top: number } {
  const margin = CONTEXT_MENU_MARGIN;
  let left = point.x;
  let top = point.y;
  if (left + menu.width > viewport.width - margin) left = point.x - menu.width;
  if (top + menu.height > viewport.height - margin) top = point.y - menu.height;
  left = Math.max(margin, Math.min(left, viewport.width - menu.width - margin));
  top = Math.max(margin, Math.min(top, viewport.height - menu.height - margin));
  return { left, top };
}

/** Places a submenu beside its item, flipping to the left when the right side has no room. */
export function calculateSubmenuPosition(
  item: Pick<DOMRect, "top" | "left" | "right">,
  menu: MenuSize,
  viewport = { width: window.innerWidth, height: window.innerHeight },
): { left: number; top: number } {
  const margin = CONTEXT_MENU_MARGIN;
  const overlap = 2;
  const left =
    item.right - overlap + menu.width > viewport.width - margin
      ? item.left + overlap - menu.width
      : item.right - overlap;
  const top = Math.max(margin, Math.min(item.top - 5, viewport.height - menu.height - margin));
  return { left: Math.max(margin, left), top };
}

export function ContextMenu({
  label,
  position,
  entries,
  onClose,
}: {
  label: string;
  position: MenuPoint;
  entries: ContextMenuEntry[];
  onClose(): void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  const [submenu, setSubmenu] = useState<{
    id: string;
    left: number;
    top: number;
    ready: boolean;
  } | null>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  const submenuCloseTimer = useRef<number | undefined>(undefined);
  const cancelSubmenuClose = () => window.clearTimeout(submenuCloseTimer.current);
  // A short delay lets the pointer cross other items on its way into the submenu.
  const closeSubmenuSoon = () => {
    cancelSubmenuClose();
    submenuCloseTimer.current = window.setTimeout(() => setSubmenu(null), 300);
  };
  const items = entries.filter((entry): entry is ContextMenuItem => !("type" in entry));
  const openSubmenuItem = submenu ? items.find((item) => item.id === submenu.id) : undefined;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    setPlacement(calculateContextMenuPosition(position, menu.getBoundingClientRect()));
    // On macOS, contextmenu fires during mousedown, before the browser focuses the clicked
    // element, so focus the menu on the next frame to keep keyboard input in the menu.
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && !menu.contains(active))
        returnFocus.current = active;
      menu.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [position]);

  useLayoutEffect(() => {
    if (!submenu || submenu.ready) return;
    const item = findMenuItem(menuRef.current, submenu.id);
    const menu = submenuRef.current;
    if (!item || !menu) return;
    setSubmenu({
      id: submenu.id,
      ...calculateSubmenuPosition(item.getBoundingClientRect(), menu.getBoundingClientRect()),
      ready: true,
    });
  }, [submenu]);

  useDismissOnOutsidePress(true, rootRef, onClose);

  useEffect(() => {
    const close = () => onCloseRef.current();
    const closeIfOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !rootRef.current?.contains(target)) close();
    };
    // The menu takes focus a frame after it opens, so a quick Escape can still land outside it.
    // The menu's own key handler covers Escape once focus is inside.
    const closeOnEscapeOutside = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", closeIfOutside, true);
    document.addEventListener("keydown", closeOnEscapeOutside, true);
    return () => {
      window.clearTimeout(submenuCloseTimer.current);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", closeIfOutside, true);
      document.removeEventListener("keydown", closeOnEscapeOutside, true);
    };
  }, []);

  const closeAndRestoreFocus = () => {
    onClose();
    if (returnFocus.current?.isConnected) returnFocus.current.focus();
  };

  const select = (item: ContextMenuItem) => {
    if (item.disabled) return;
    if (item.submenu) {
      openSubmenu(item, true);
      return;
    }
    onClose();
    item.onSelect?.();
  };

  const openSubmenu = (item: ContextMenuItem, focusFirst = false) => {
    if (!item.submenu?.length || item.disabled) return;
    if (submenu?.id !== item.id) setSubmenu({ id: item.id, left: 0, top: 0, ready: false });
    if (focusFirst)
      window.requestAnimationFrame(() => focusableItems(submenuRef.current)[0]?.focus());
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, level: "root" | "submenu") => {
    event.stopPropagation();
    const container = level === "root" ? menuRef.current : submenuRef.current;
    const levelItems = level === "root" ? items : (openSubmenuItem?.submenu ?? []);
    const focusedItem = levelItems.find(
      (item) => item.id === (document.activeElement as HTMLElement | null)?.dataset.menuItem,
    );
    if (event.key === "Escape" || (level === "submenu" && event.key === "ArrowLeft")) {
      event.preventDefault();
      if (level === "submenu") {
        setSubmenu(null);
        findMenuItem(menuRef.current, openSubmenuItem!.id)?.focus();
      } else closeAndRestoreFocus();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === "ArrowRight" && level === "root" && focusedItem?.submenu) {
      event.preventDefault();
      openSubmenu(focusedItem, true);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && focusedItem) {
      event.preventDefault();
      select(focusedItem);
      return;
    }
    if (focusMenuItemForKey(container, event.key)) {
      event.preventDefault();
      return;
    }
    if (level === "root" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const match = items.find(
        (item) =>
          !item.disabled && item.shortcut?.display.toLowerCase() === event.key.toLowerCase(),
      );
      if (match) {
        event.preventDefault();
        select(match);
      }
    }
  };

  return createPortal(
    <div ref={rootRef} className="context-menu-layer">
      <div
        ref={menuRef}
        className={`popup-menu context-menu ${placement ? "" : "measuring"}`}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={placement ?? { left: position.x, top: position.y }}
        onKeyDown={(event) => handleKeyDown(event, "root")}
        onContextMenu={(event) => event.preventDefault()}
      >
        {entries.map((entry) => {
          if ("type" in entry) {
            return entry.type === "separator" ? (
              <div key={entry.id} className="context-menu-separator" role="separator" />
            ) : (
              <div key={entry.id} className="context-menu-heading" role="presentation">
                {entry.label}
              </div>
            );
          }
          return (
            <ContextMenuButton
              key={entry.id}
              item={entry}
              expanded={submenu?.id === entry.id}
              onPointerEnter={(event) => {
                if (entry.submenu?.length && !entry.disabled) {
                  cancelSubmenuClose();
                  event.currentTarget.focus();
                  openSubmenu(entry);
                  return;
                }
                closeSubmenuSoon();
                if (!entry.disabled) event.currentTarget.focus();
              }}
              onClick={() => select(entry)}
            />
          );
        })}
      </div>
      {openSubmenuItem?.submenu ? (
        <div
          ref={submenuRef}
          className={`popup-menu context-menu context-submenu ${submenu?.ready ? "" : "measuring"}`}
          role="menu"
          aria-label={openSubmenuItem.label}
          style={{ left: submenu?.left, top: submenu?.top }}
          onKeyDown={(event) => handleKeyDown(event, "submenu")}
          onPointerEnter={cancelSubmenuClose}
          onContextMenu={(event) => event.preventDefault()}
        >
          {openSubmenuItem.submenu.map((item) => (
            <ContextMenuButton
              key={item.id}
              item={item}
              onPointerEnter={(event) => {
                if (!item.disabled) event.currentTarget.focus();
              }}
              onClick={() => select(item)}
            />
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function ContextMenuButton({
  item,
  expanded,
  onPointerEnter,
  onClick,
}: {
  item: ContextMenuItem;
  expanded?: boolean;
  onPointerEnter(event: React.PointerEvent<HTMLButtonElement>): void;
  onClick(): void;
}) {
  const hasSubmenu = Boolean(item.submenu?.length);
  return (
    <button
      type="button"
      role={item.selected !== undefined ? "menuitemcheckbox" : "menuitem"}
      aria-checked={item.selected !== undefined ? item.selected : undefined}
      aria-haspopup={hasSubmenu ? "menu" : undefined}
      aria-expanded={hasSubmenu ? Boolean(expanded) : undefined}
      aria-keyshortcuts={item.shortcut?.keys}
      data-menu-item={item.id}
      tabIndex={-1}
      className={`${item.danger ? "danger" : ""} ${expanded ? "expanded" : ""}`}
      disabled={item.disabled}
      onPointerEnter={onPointerEnter}
      onClick={onClick}
    >
      <span className="popup-item-icon">{item.selected ? <Check size={14} /> : item.icon}</span>
      <span className="context-menu-label">{item.label}</span>
      {item.shortcut ? (
        <kbd className="context-menu-shortcut" aria-hidden="true">
          {item.shortcut.display}
        </kbd>
      ) : null}
      {hasSubmenu ? <ChevronRight className="context-menu-chevron" size={13} /> : null}
    </button>
  );
}

function findMenuItem(container: HTMLElement | null, id: string): HTMLElement | undefined {
  return [...(container?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? [])].find(
    (element) => element.dataset.menuItem === id,
  );
}

function focusableItems(container: HTMLElement | null): HTMLButtonElement[] {
  return [...(container?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
}

/** Moves focus between a menu's enabled items for the arrow, Home and End keys. */
function focusMenuItemForKey(container: HTMLElement | null, key: string): boolean {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return false;
  const items = focusableItems(container);
  if (!items.length) return true;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? items.length - 1
        : key === "ArrowDown"
          ? (current + 1) % items.length
          : current < 0
            ? items.length - 1
            : (current - 1 + items.length) % items.length;
  items[next]?.focus();
  return true;
}

/** Closes a menu when the user presses or right-clicks outside it, including inside an email. */
function useDismissOnOutsidePress(
  active: boolean,
  rootRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  const onDismissRef = useRef(onDismiss);
  useLayoutEffect(() => {
    onDismissRef.current = onDismiss;
  });
  useEffect(() => {
    if (!active) return;
    const dismiss = () => onDismissRef.current();
    const dismissIfOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !rootRef.current?.contains(target)) dismiss();
    };
    document.addEventListener("pointerdown", dismissIfOutside, true);
    document.addEventListener("contextmenu", dismissIfOutside, true);
    window.addEventListener("iframe-pointerdown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismissIfOutside, true);
      document.removeEventListener("contextmenu", dismissIfOutside, true);
      window.removeEventListener("iframe-pointerdown", dismiss);
    };
  }, [active, rootRef]);
}

function TooltipBubble({
  id,
  anchorRef,
  label,
  content,
  className = "",
  shortcut,
  side,
}: {
  id: string;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  content?: ReactNode;
  className?: string;
  shortcut?: KeyboardShortcutHint;
  side: TooltipSide;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;
    setPosition(
      calculateTooltipPosition(
        anchor.getBoundingClientRect(),
        bubble.getBoundingClientRect(),
        side,
      ),
    );
  }, [anchorRef, side]);

  useLayoutEffect(place, [place]);
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, place]);

  return createPortal(
    <div
      ref={bubbleRef}
      id={id}
      className={`tooltip-bubble ${className} ${position.ready ? "" : "measuring"}`}
      role="tooltip"
      style={{ left: position.left, top: position.top }}
    >
      {content ?? <span>{label}</span>}
      {shortcut ? (
        <kbd className="tooltip-shortcut" aria-hidden="true">
          {shortcut.display}
        </kbd>
      ) : null}
    </div>,
    document.body,
  );
}

export function calculateTooltipPosition(
  anchor: Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">,
  bubble: Pick<DOMRect, "width" | "height">,
  preferredSide: TooltipSide,
  viewport = { width: window.innerWidth, height: window.innerHeight },
): { left: number; top: number; ready: boolean } {
  const defaultGap = 7;
  const rightGap = 15;
  const margin = 6;
  let side = preferredSide;
  if (side === "top" && anchor.top - bubble.height - defaultGap < margin) side = "bottom";
  else if (side === "bottom" && anchor.bottom + bubble.height + defaultGap > viewport.height)
    side = "top";
  else if (side === "right" && anchor.right + bubble.width + rightGap > viewport.width)
    side = "top";

  let left = anchor.left + (anchor.width - bubble.width) / 2;
  let top = side === "top" ? anchor.top - bubble.height - defaultGap : anchor.bottom + defaultGap;
  if (side === "right") {
    left = anchor.right + rightGap;
    top = anchor.top + (anchor.height - bubble.height) / 2;
  }
  left = Math.min(viewport.width - bubble.width - margin, Math.max(margin, left));
  top = Math.min(viewport.height - bubble.height - margin, Math.max(margin, top));
  return { left, top, ready: true };
}

function useTooltipVisibility(enabled = true): {
  visible: boolean;
  showLater(): void;
  hide(): void;
} {
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const hide = () => {
    window.clearTimeout(timer.current);
    setVisible(false);
  };
  const showLater = () => {
    if (!enabled) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(true), 320);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (enabled) return;
    window.clearTimeout(timer.current);
    setVisible(false);
  }, [enabled]);
  return { visible, showLater, hide };
}
