// The "Colour ▸" submenu of a session row: the eight palette swatches and
// "Automatic", which is what a session has until somebody picks a colour by
// hand (see sessionColors.js). The same items serve one row and a whole
// selection of them, so the bulk menu colours ten sessions with one click.
import { useTranslation } from "../i18n.js";
import { MenuItem } from "./PopupMenu.jsx";
import { SESSION_COLOR_TOKENS } from "../sessionColors.js";

export default function ColorMenuItems({ currentToken = null, automatic = true, onPick }) {
  const { translate } = useTranslation();
  return (
    <>
      <MenuItem marker="color-automatic" selected={automatic} onClick={() => onPick(null)}>
        {translate("row.colorAutomatic")}
      </MenuItem>
      <div className="popup-menu-swatches">
        {SESSION_COLOR_TOKENS.map((token) => (
          <button
            type="button"
            key={token}
            className={!automatic && token === currentToken ? "color-swatch is-selected" : "color-swatch"}
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
