import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { renderMarkdown, withoutFrontmatter } from "../markdown.js";
import { CloseIcon, GlobeIcon, MarkdownIcon, PageIcon, PlusIcon, ReloadIcon } from "./Icons.jsx";

// The right panel: Hermes-style tabs next to the terminal. Each tab is a
// local HTML file or an http(s) page (rendered in a locked-down <webview>)
// or a Markdown file (rendered by the app's own markdown pipeline). The tab
// set belongs to the session on screen; App.jsx keeps it in sync with the
// main process, which also serves the `clauding open` command.

const COPIED_FEEDBACK_MILLISECONDS = 1200;

function fileUrl(filePath) {
  return `file://${encodeURI(filePath)}`;
}

// "/Users/<you>/Desktop/page.html" -> folder "/Users/<you>/Desktop/" + name "page.html";
// "https://example.com/docs/" -> "https://example.com/" + "docs/".
function splitAddress(target) {
  const withoutTrailingSlash = target.length > 1 ? target.replace(/\/$/, "") : target;
  const lastSlash = withoutTrailingSlash.lastIndexOf("/");
  if (lastSlash <= 0 || (target.startsWith("http") && lastSlash < target.indexOf("//") + 2)) {
    return { folder: "", name: target };
  }
  return { folder: withoutTrailingSlash.slice(0, lastSlash + 1), name: withoutTrailingSlash.slice(lastSlash + 1) };
}

function AddressText({ target }) {
  const { folder, name } = splitAddress(target);
  return (
    <>
      <span className="address-folder">{folder}</span>
      <span className="address-name">{name}</span>
    </>
  );
}

function TabIcon({ kind }) {
  if (kind === "url") {
    return <GlobeIcon />;
  }
  if (kind === "markdown") {
    return <MarkdownIcon />;
  }
  return <PageIcon />;
}

// An http(s) page or a local HTML file. `reloadCounter` bumps whenever the
// file changed on disk or Reload was pressed.
function WebviewTab({ tab, active, reloadCounter, onTitle }) {
  const { translate } = useTranslation();
  const webviewRef = useRef(null);
  const [failure, setFailure] = useState(null);
  const source = tab.kind === "url" ? tab.target : fileUrl(tab.target);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      return undefined;
    }
    function handleTitle(event) {
      if (tab.kind === "url" && event.title) {
        onTitle(tab.tabId, event.title);
      }
    }
    function handleFailure(event) {
      // -3 is Chromium's "aborted" (a reload interrupting a load); not an error.
      if (event.isMainFrame && event.errorCode !== -3) {
        setFailure(event.errorDescription || String(event.errorCode));
      }
    }
    function handleStart() {
      setFailure(null);
    }
    webview.addEventListener("page-title-updated", handleTitle);
    webview.addEventListener("did-fail-load", handleFailure);
    webview.addEventListener("did-start-loading", handleStart);
    return () => {
      webview.removeEventListener("page-title-updated", handleTitle);
      webview.removeEventListener("did-fail-load", handleFailure);
      webview.removeEventListener("did-start-loading", handleStart);
    };
  }, [tab.tabId, tab.kind, onTitle]);

  useEffect(() => {
    if (reloadCounter > 0 && webviewRef.current) {
      try {
        webviewRef.current.reload();
      } catch (error) {
        // The guest may not be attached yet; the next change reloads it.
      }
    }
  }, [reloadCounter]);

  return (
    <div className={active ? "panel-tab-content" : "panel-tab-content is-hidden"}>
      <webview
        ref={webviewRef}
        src={source}
        partition="persist:clauding-panel"
        webpreferences="contextIsolation=yes, sandbox=yes, nodeIntegration=no"
        className="panel-webview"
      />
      {failure && <div className="panel-note is-error">{translate("panel.loadError", { message: failure })}</div>}
    </div>
  );
}

// A Markdown file, read through the main process and re-read on change.
function MarkdownTab({ tab, active, reloadCounter }) {
  const { translate } = useTranslation();
  const [text, setText] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    let cancelled = false;
    window.clauding
      .readPanelFile(tab.target)
      .then((content) => {
        if (!cancelled) {
          setText(content);
          setFailure(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setFailure(error && error.message ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tab.target, reloadCounter]);

  const html = useMemo(() => (text === null ? "" : renderMarkdown(withoutFrontmatter(text))), [text]);

  return (
    <div className={active ? "panel-tab-content panel-reading" : "panel-tab-content panel-reading is-hidden"}>
      {failure && <div className="panel-note is-error">{translate("panel.loadError", { message: failure })}</div>}
      {text === null && !failure && <div className="panel-note">{translate("panel.loading")}</div>}
      {text !== null && <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}

function AddressForm({ onOpen, autoFocus }) {
  const { translate } = useTranslation();
  const [value, setValue] = useState("");
  const [failure, setFailure] = useState(null);

  async function submit(event) {
    event.preventDefault();
    const target = value.trim();
    if (!target) {
      return;
    }
    try {
      await onOpen(target);
      setValue("");
      setFailure(null);
    } catch (error) {
      setFailure(error && error.message ? error.message : String(error));
    }
  }

  return (
    <form className="panel-address-form" onSubmit={submit}>
      <label className="panel-address-label" htmlFor="panel-address-input">
        {translate("panel.addressLabel")}
      </label>
      <input
        id="panel-address-input"
        type="text"
        className="panel-address-input"
        value={value}
        placeholder={translate("panel.addressPlaceholder")}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        data-panel-address
      />
      {failure && <div className="panel-note is-error">{failure}</div>}
      <p className="panel-address-hint">{translate("panel.emptyHint")}</p>
    </form>
  );
}

export default function SidePanel({ open, sessionKey, panelState, actions }) {
  const { translate } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reloadCounters, setReloadCounters] = useState({});
  const tabs = panelState.tabs;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const localTargetsKey = tabs
    .filter((tab) => tab.kind !== "url")
    .map((tab) => tab.target)
    .join("\n");
  const activeTab = tabs.find((tab) => tab.tabId === panelState.activeTabId) || null;
  const showAddressForm = adding || tabs.length === 0;

  // A new active tab (opened by the CLI, a click, or the address field) closes the "+" view.
  useEffect(() => {
    setAdding(false);
  }, [panelState.activeTabId, sessionKey]);

  useEffect(() => {
    setReloadCounters({});
  }, [sessionKey]);

  // Local files reload when they change on disk (fs.watch in the main process).
  useEffect(() => {
    const localTargets = localTargetsKey ? localTargetsKey.split("\n") : [];
    for (const target of localTargets) {
      window.clauding.watchPanelFile(target);
    }
    const stop = window.clauding.onPanelFileChanged(({ filePath }) => {
      setReloadCounters((previous) => {
        const next = { ...previous };
        for (const tab of tabsRef.current) {
          if (tab.kind !== "url" && tab.target === filePath) {
            next[tab.tabId] = (next[tab.tabId] || 0) + 1;
          }
        }
        return next;
      });
    });
    return () => {
      stop();
      for (const target of localTargets) {
        window.clauding.unwatchPanelFile(target);
      }
    };
  }, [localTargetsKey]);

  function reloadActive() {
    if (!activeTab) {
      return;
    }
    setReloadCounters((previous) => ({ ...previous, [activeTab.tabId]: (previous[activeTab.tabId] || 0) + 1 }));
  }

  function copyAddress() {
    if (!activeTab) {
      return;
    }
    navigator.clipboard.writeText(activeTab.target).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MILLISECONDS);
    });
  }

  function openExternally() {
    if (activeTab) {
      window.clauding.openExternally(activeTab.target).catch((error) => console.error("Could not open externally", error));
    }
  }

  const handleTitle = useMemo(
    () => (tabId, title) => {
      actions.setTitle(tabId, title);
    },
    [actions]
  );

  return (
    <aside className={open ? "column column-right" : "column column-right is-collapsed"} data-panel-open={open ? "1" : "0"}>
      {open && (
        <>
          <div className="panel-tabs" role="tablist">
            <div className="panel-tabs-scroll">
              {tabs.map((tab) => (
                <div
                  key={tab.tabId}
                  role="tab"
                  className={tab.tabId === panelState.activeTabId && !adding ? "panel-tab is-active" : "panel-tab"}
                  onClick={() => {
                    setAdding(false);
                    actions.activate(tab.tabId);
                  }}
                  title={tab.target}
                  data-panel-tab={tab.kind}
                >
                  <TabIcon kind={tab.kind} />
                  <span className="panel-tab-title">{tab.title}</span>
                  <button
                    type="button"
                    className="panel-tab-close"
                    aria-label={translate("panel.closeTab")}
                    title={translate("panel.closeTab")}
                    onClick={(event) => {
                      event.stopPropagation();
                      actions.close(tab.tabId);
                    }}
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={showAddressForm ? "panel-tab panel-tab-add is-active" : "panel-tab panel-tab-add"}
                onClick={() => setAdding(true)}
                title={translate("panel.newTab")}
                aria-label={translate("panel.newTab")}
              >
                <PlusIcon />
              </button>
            </div>
          </div>
          <div className="panel-toolbar">
            <button
              type="button"
              className={!activeTab ? "panel-address is-empty" : copied ? "panel-address is-copied" : "panel-address"}
              onClick={copyAddress}
              disabled={!activeTab}
              title={activeTab ? translate("panel.copyHint") : undefined}
            >
              {!activeTab ? translate("panel.noTab") : copied ? translate("panel.copied") : <AddressText target={activeTab.target} />}
            </button>
            <button type="button" className="panel-tool" onClick={reloadActive} disabled={!activeTab} title={translate("panel.reload")}>
              <ReloadIcon />
              <span>{translate("panel.reload")}</span>
            </button>
            <button type="button" className="panel-tool" onClick={openExternally} disabled={!activeTab} title={translate("panel.openInBrowser")}>
              <span>{translate("panel.openInBrowser")}</span>
            </button>
            <button type="button" className="panel-tool" onClick={actions.hide} title={translate("panel.hide")}>
              <span>{translate("panel.hide")}</span>
            </button>
          </div>
          <div className="panel-body">
            {showAddressForm && <AddressForm onOpen={actions.open} autoFocus={adding} />}
            {tabs.map((tab) =>
              tab.kind === "markdown" ? (
                <MarkdownTab
                  key={tab.tabId}
                  tab={tab}
                  active={!showAddressForm && tab.tabId === panelState.activeTabId}
                  reloadCounter={reloadCounters[tab.tabId] || 0}
                />
              ) : (
                <WebviewTab
                  key={tab.tabId}
                  tab={tab}
                  active={!showAddressForm && tab.tabId === panelState.activeTabId}
                  reloadCounter={reloadCounters[tab.tabId] || 0}
                  onTitle={handleTitle}
                />
              )
            )}
          </div>
        </>
      )}
    </aside>
  );
}
