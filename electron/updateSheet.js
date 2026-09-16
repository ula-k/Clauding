// The little progress window the update runs behind: a sheet over the main
// window that says which of the four commands is running. It is deliberately
// its own tiny page — the app's window gets no new controls for this.
import { BrowserWindow } from "electron";

const SHEET_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 22px 24px; background: #14141a; color: #e9e9f0;
    font: 13px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  }
  .title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
  .step { color: #b9b9c8; font-variant-numeric: tabular-nums; }
  .bar { margin-top: 16px; height: 4px; border-radius: 2px; background: #2a2a36; overflow: hidden; }
  .bar span { display: block; height: 100%; width: 35%; border-radius: 2px; background: #b3a4f5;
    animation: slide 1.4s ease-in-out infinite; }
  @keyframes slide { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }
</style></head>
<body>
  <div class="title">Updating Clauding</div>
  <div class="step" id="step">Starting…</div>
  <div class="bar"><span></span></div>
</body></html>`;

export function openUpdateSheet(parentWindow) {
  const sheet = new BrowserWindow({
    parent: parentWindow || undefined,
    modal: Boolean(parentWindow),
    width: 420,
    height: 150,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Updating Clauding",
    show: false
  });
  sheet.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SHEET_PAGE)}`);
  sheet.once("ready-to-show", () => sheet.show());
  return {
    setStep(text) {
      if (sheet.isDestroyed()) {
        return;
      }
      sheet.webContents
        .executeJavaScript(`document.getElementById("step").textContent = ${JSON.stringify(String(text))};`)
        .catch(() => {
          // The sheet was closed while a step was starting; nothing to show.
        });
    },
    close() {
      if (!sheet.isDestroyed()) {
        sheet.destroy();
      }
    }
  };
}
