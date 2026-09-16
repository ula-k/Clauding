import { useEffect, useLayoutEffect, useRef, useState } from "react";

// A small menu that hangs off a button (or the mouse pointer for a
// right-click). It is positioned `fixed` on purpose: the session list
// scrolls, and an absolutely positioned menu inside it would be clipped by
// the scroll container.
//
// `anchor` is a DOMRect-like { left, right, top, bottom }.
const MENU_MARGIN_PIXELS = 6;

// `variant` "wide" is the Skills and settings popovers: the same box, wide
// enough for a skill's description and a folder path.
//
// `placement` "side" is a submenu: it opens beside the item it hangs off
// instead of under it, and flips to the other side when the window ends.
export default function PopupMenu({ anchor, align = "right", placement = "below", variant = "menu", onClose, children }) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ left: 0, top: 0, visible: false });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !anchor) {
      return;
    }
    const size = menu.getBoundingClientRect();
    if (placement === "side") {
      let sideLeft = anchor.right + 4;
      if (sideLeft + size.width > window.innerWidth - MENU_MARGIN_PIXELS) {
        sideLeft = anchor.left - size.width - 4;
      }
      sideLeft = Math.max(MENU_MARGIN_PIXELS, sideLeft);
      let sideTop = Math.min(anchor.top - 6, window.innerHeight - size.height - MENU_MARGIN_PIXELS);
      sideTop = Math.max(MENU_MARGIN_PIXELS, sideTop);
      setPosition({ left: sideLeft, top: sideTop, visible: true });
      return;
    }
    let left = align === "right" ? anchor.right - size.width : anchor.left;
    let top = anchor.bottom + 4;
    left = Math.min(left, window.innerWidth - size.width - MENU_MARGIN_PIXELS);
    left = Math.max(MENU_MARGIN_PIXELS, left);
    if (top + size.height > window.innerHeight - MENU_MARGIN_PIXELS) {
      top = anchor.top - size.height - 4;
    }
    // Whatever the anchor did (a row scrolled half out of the list, say),
    // the menu itself stays inside the window.
    top = Math.min(top, window.innerHeight - size.height - MENU_MARGIN_PIXELS);
    top = Math.max(MENU_MARGIN_PIXELS, top);
    setPosition({ left, top, visible: true });
  }, [anchor, align, placement, children]);

  useEffect(() => {
    function handleMouseDown(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        onClose();
      }
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className={variant === "wide" ? "popup-menu is-wide" : "popup-menu"}
      ref={menuRef}
      style={{ left: `${position.left}px`, top: `${position.top}px`, visibility: position.visible ? "visible" : "hidden" }}
      data-popup-menu
    >
      {children}
    </div>
  );
}

export function MenuLabel({ children }) {
  return <div className="popup-menu-label">{children}</div>;
}

export function MenuSeparator() {
  return <div className="popup-menu-separator" />;
}

// A line in a menu that is not a button: what a control the header had no
// room for was *saying* — the agent's name, the status, a hint. It is the
// only honest way to move a chip or a pill into a menu, because clicking a
// chip has never done anything.
export function MenuNote({ marker = null, children }) {
  return (
    <div className="popup-menu-note is-item" data-menu-note={marker || undefined}>
      {children}
    </div>
  );
}

// An item that opens a second menu beside itself. The submenu is rendered
// inside this menu's own box, so a click in it is a click inside the
// parent too and does not close it; Escape and a click anywhere else close
// both.
export function MenuSubmenu({ label, marker = null, children }) {
  const [submenuAnchor, setSubmenuAnchor] = useState(null);
  const triggerRef = useRef(null);
  return (
    <>
      <button
        type="button"
        className={submenuAnchor ? "popup-menu-item is-submenu is-open" : "popup-menu-item is-submenu"}
        ref={triggerRef}
        data-menu-item={marker || undefined}
        onClick={() => setSubmenuAnchor(triggerRef.current.getBoundingClientRect())}
      >
        <span className="popup-menu-item-text">{label}</span>
        <span className="popup-menu-item-arrow">▸</span>
      </button>
      {submenuAnchor && (
        <PopupMenu anchor={submenuAnchor} placement="side" onClose={() => setSubmenuAnchor(null)}>
          {children}
        </PopupMenu>
      )}
    </>
  );
}

// `marker` is written out as data-menu-item: a name the dev click hook (and
// a smoke run) can reach an item by, since the text in a menu changes with
// the language.
export function MenuItem({ onClick, disabled = false, selected = false, tone = "plain", marker = null, title = null, children }) {
  const classNames = ["popup-menu-item"];
  if (tone === "danger") {
    classNames.push("is-danger");
  }
  if (selected) {
    classNames.push("is-selected");
  }
  return (
    <button
      type="button"
      className={classNames.join(" ")}
      disabled={disabled}
      title={title || undefined}
      data-menu-item={marker || undefined}
      onClick={onClick}
    >
      <span className="popup-menu-item-text">{children}</span>
      {selected && <span className="popup-menu-item-mark">✓</span>}
    </button>
  );
}
