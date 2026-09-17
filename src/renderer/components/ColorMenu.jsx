// The "Color ▸" submenu of a session row: the eight palette swatches and
// "None", which is what every session is until somebody picks a color by
// hand — picking it again drops the stored color (see sessionColors.js).
// The same items serve one row and a whole selection of them, so the bulk
// menu colors ten sessions with one click.
import { useTranslation } from "../i18n.js";
import { MenuItem } from "./PopupMenu.jsx";
import { SESSION_COLOR_TOKENS } from "../sessionColors.js";

export default function ColorMenuItems({ currentToken = null, hasOwnColor = false, onPick }) {
  const { translate } = useTranslation();
  return (
    <>
      <MenuItem marker="color-none" selected={!hasOwnColor} onClick={() => onPick(null)}>
        {translate("row.colorNone")}
      </MenuItem>
      <div className="popup-menu-swatches">
        {SESSION_COLOR_TOKENS.map((token) => (
          <button
            type="button"
            key={token}
            className={hasOwnColor && token === currentToken ? "color-swatch is-selected" : "color-swatch"}
            style={{ "--session-color": `var(${token})` }}
            aria-label={token}
            title={token}
            data-color-swatch={token}
            onClick={() => onPick(token)}
          />
        ))}
      </div>
    </>
  );
}
