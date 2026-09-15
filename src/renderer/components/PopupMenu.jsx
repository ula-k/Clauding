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
export default function PopupMenu({ anchor, align = "right", variant = "menu", onClose, children }) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ left: 0, top: 0, visible: false });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !anchor) {
      return;
    }
    const size = menu.getBoundingClientRect();
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
  }, [anchor, align, children]);

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

export function MenuItem({ onClick, disabled = false, selected = false, tone = "plain", children }) {
  const classNames = ["popup-menu-item"];
  if (tone === "danger") {
    classNames.push("is-danger");
  }
  if (selected) {
    classNames.push("is-selected");
  }
  return (
    <button type="button" className={classNames.join(" ")} disabled={disabled} onClick={onClick}>
      <span className="popup-menu-item-text">{children}</span>
      {selected && <span className="popup-menu-item-mark">✓</span>}
    </button>
  );
}
