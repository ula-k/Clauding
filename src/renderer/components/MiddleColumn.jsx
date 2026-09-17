import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { folderLabel } from "../paths.js";
import TerminalPane from "./TerminalPane.jsx";
import DocumentReader from "./DocumentReader.jsx";
import FindBar from "./FindBar.jsx";
import { DotsIcon, FolderIcon, ForkIcon, PencilIcon, SparkIcon } from "./Icons.jsx";
import PopupMenu, { MenuItem, MenuLabel, MenuNote, MenuSeparator, MenuSubmenu } from "./PopupMenu.jsx";
import { AgentChip } from "./AgentBadge.jsx";
import { MENU_AGENT_LIMIT, titleWithoutAgentEmoji } from "../agentConstants.js";
import { fitToolbar, HEADER_ITEM_PRIORITY } from "../toolbarFit.js";

// The title never gets squeezed below this; it truncates with an ellipsis
// instead, and the controls to its right fall into the "…" one by one.
const TITLE_MINIMUM_WIDTH = 160;
// The `gap` of .header-top, counted with each control it follows.
const HEADER_ITEM_GAP = 12;

// "Create agent from this conversation" and "Harvest skills": both fork the
// conversation into a second terminal that does one job — the Agent Maker
// distilling this conversation into a definition, or the skill-maker
// looking for the procedures in it. Neither can run before the CLI has
// registered a session id, because there is nothing to fork yet; until then
// the buttons are disabled and say why.
function MetaActionButton({ label, tooltip, disabled, onClick, marker }) {
  const attributes = marker === "create-agent" ? { "data-create-agent-button": true } : { "data-harvest-skills-button": true };
  return (
    <button type="button" className="fork-button" disabled={disabled} title={tooltip} onClick={onClick} {...attributes}>
      {marker === "create-agent" && <SparkIcon />}
      {label}
    </button>
  );
}

// The header's own "…": everything the header had no room for, and under a
// separator the session actions that were never buttons in the first place
// — the flags, the agent this session is assigned to, deleting it, the
// skills list, renaming it.
function HeaderMenuButton({
  overflowedItems,
  sessionId,
  agents,
  currentAgentId,
  runsElsewhere,
  onAssignAgent,
  onOpenAgentPicker,
  onEditSessionFlags,
  onDeleteSession,
  onRenameSession
}) {
  const { translate } = useTranslation();
  const [menuAnchor, setMenuAnchor] = useState(null);
  const menuButtonRef = useRef(null);

  function runAndClose(action) {
    setMenuAnchor(null);
    action();
  }

  return (
    <>
      <button
        type="button"
        className="row-menu-button is-header"
        ref={menuButtonRef}
        title={translate("header.menu")}
        aria-label={translate("header.menu")}
        data-header-menu-button
        onClick={() => setMenuAnchor(menuButtonRef.current.getBoundingClientRect())}
      >
        <DotsIcon />
      </button>
      {menuAnchor && (
        <PopupMenu anchor={menuAnchor} onClose={() => setMenuAnchor(null)}>
          {/* What the line had no room for, most important first. The chip
              and the pill come across as themselves — they were never
              buttons, and a menu row that cannot be clicked would be a lie. */}
          {overflowedItems.map((item) =>
            item.menu ? (
              <MenuItem
                key={item.id}
                marker={item.id}
                disabled={Boolean(item.menu.disabled)}
                title={item.menu.tooltip || null}
                onClick={() => runAndClose(item.menu.onClick)}
              >
                {item.menu.label}
              </MenuItem>
            ) : (
              <MenuNote key={item.id} marker={item.id}>
                {item.node}
              </MenuNote>
            )
          )}
          {overflowedItems.length > 0 && <MenuSeparator />}
          {onEditSessionFlags && (
            <MenuItem
              marker="session-flags"
              disabled={!sessionId}
              onClick={() => runAndClose(() => onEditSessionFlags(sessionId))}
            >
              {translate("flags.sessionMenu")}
            </MenuItem>
          )}
          <MenuSubmenu label={translate("row.assignToAgent")} marker="assign-agent">
            <MenuLabel>{translate("row.assignToAgent")}</MenuLabel>
            <MenuItem
              marker="assign-none"
              selected={!currentAgentId}
              onClick={() => runAndClose(() => onAssignAgent(sessionId, null))}
            >
              {translate("row.noAgent")}
            </MenuItem>
            {agents.slice(0, MENU_AGENT_LIMIT).map((agent) => (
              <MenuItem
                key={agent.id}
                marker={`assign-${agent.id}`}
                selected={agent.id === currentAgentId}
                onClick={() => runAndClose(() => onAssignAgent(sessionId, agent.id))}
              >
                {`${agent.emoji} ${agent.name}`}
              </MenuItem>
            ))}
            {agents.length > MENU_AGENT_LIMIT && onOpenAgentPicker && (
              <MenuItem marker="assign-more" onClick={() => runAndClose(() => onOpenAgentPicker(sessionId))}>
                {translate("agents.more")}
              </MenuItem>
            )}
          </MenuSubmenu>
          {onDeleteSession && (
            <MenuItem
              marker="delete-session"
              tone="danger"
              disabled={!sessionId || runsElsewhere}
              title={runsElsewhere ? translate("row.deleteRunningElsewhere") : translate("row.deleteHint")}
              onClick={() => runAndClose(() => onDeleteSession(sessionId))}
            >
              {translate("row.delete")}
            </MenuItem>
          )}
          {onRenameSession && (
            <MenuItem marker="rename-session" onClick={() => runAndClose(onRenameSession)}>
              {translate("row.rename")}
            </MenuItem>
          )}
        </PopupMenu>
      )}
    </>
  );
}

// "Start a copy of this conversation in a new terminal; this one stays as it
// is." Shown wherever a session id is known: in a live terminal's header, and
// on the note for a session running in a terminal or job outside the app —
// forking is the one useful thing that can be done with such a session.
function ForkButton({ onFork, standalone = false }) {
  const { translate } = useTranslation();
  return (
    <button
      type="button"
      className={standalone ? "fork-button is-standalone" : "fork-button"}
      title={translate("fork.tooltip")}
      onClick={onFork}
      data-fork-button
    >
      <ForkIcon />
      {translate("fork.button")}
    </button>
  );
}

// A fork opened to do one job types its own first message. When the CLI
// never got to its prompt in time (a dialog nobody answered, a slow start),
// nothing was typed — and the header says so, because otherwise the
// terminal just sits there looking idle.
function KickoffHint() {
  const { translate } = useTranslation();
  return (
    <span className="kickoff-hint" data-kickoff-hint>
      {translate("kickoff.typeToStart")}
    </span>
  );
}

function statusText(statusGroup, translate) {
  if (statusGroup === "running") {
    return translate("status.running");
  }
  if (statusGroup === "waiting") {
    return translate("status.waiting");
  }
  return translate("status.idle");
}

function StatusPill({ statusGroup }) {
  const { translate } = useTranslation();
  const className =
    statusGroup === "running" ? "status-pill is-running" : statusGroup === "waiting" ? "status-pill is-waiting" : "status-pill";
  return <span className={className}>{statusText(statusGroup, translate)}</span>;
}

// `renameRequest` is the "Rename…" item of the "…" menu: a counter, because
// the same request can be made twice in a row.
function EditableTitle({ title, onRename, renameRequest }) {
  const { translate } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);

  useEffect(() => {
    if (!editing) {
      setDraftTitle(title);
    }
  }, [title, editing]);

  useEffect(() => {
    if (renameRequest > 0 && onRename) {
      setEditing(true);
    }
  }, [renameRequest, onRename]);

  function commit() {
    const trimmed = draftTitle.trim();
    setEditing(false);
    if (trimmed && trimmed !== title) {
      onRename(trimmed);
    }
  }

  if (editing) {
    return (
      <input
        type="text"
        className="title-input"
        value={draftTitle}
        autoFocus
        onChange={(event) => setDraftTitle(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          } else if (event.key === "Escape") {
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <h1
      title={onRename ? translate("header.renameHint") : undefined}
      className={onRename ? "is-editable" : ""}
      onClick={() => onRename && setEditing(true)}
    >
      {title}
      {onRename && <PencilIcon />}
    </h1>
  );
}

// One line, never two. The title takes what is left, the controls are kept
// from the most important down for as long as they fit, and the rest go
// into the "…" — never into both places.
//
// The widths are measured, not guessed: on the first render (and whenever
// the controls or the language change) every control is drawn and read
// back, inside a layout effect, so the measuring pass is over before the
// window is painted. Only the available width changes on a resize, and a
// ResizeObserver supplies that; the measured widths are kept.
function HeaderToolbar({ titleNode, items, signature, trailing, renderMenuButton }) {
  const rowRef = useRef(null);
  const trailingRef = useRef(null);
  const menuButtonRef = useRef(null);
  const [rowWidth, setRowWidth] = useState(0);
  const [measurement, setMeasurement] = useState(null);
  const measuring = !measurement || measurement.signature !== signature;

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    const currentWidth = row.getBoundingClientRect().width;
    // A header inside a `display: none` stack (the reader is over the
    // terminal) measures as nothing: keep what was measured while it was
    // on screen rather than throwing it away.
    if (currentWidth <= 0) {
      return;
    }
    setRowWidth(currentWidth);
    if (!measuring) {
      return;
    }
    const widths = {
      trailing: trailingRef.current ? trailingRef.current.getBoundingClientRect().width : 0,
      menuButton: menuButtonRef.current ? menuButtonRef.current.getBoundingClientRect().width : 0
    };
    for (const node of row.querySelectorAll("[data-toolbar-item]")) {
      widths[node.dataset.toolbarItem] = node.getBoundingClientRect().width;
    }
    setMeasurement({ signature, widths });
  });

  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0].contentRect.width;
      if (measured > 0) {
        setRowWidth(measured);
      }
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  // The "…" is always on the header: besides whatever overflowed, it holds
  // the session actions that were never buttons (the flags, the agent,
  // Delete session…, Skills, Rename…). So its width is taken off the top
  // instead of being reserved only on overflow.
  const widths = measurement ? measurement.widths : null;
  const fitted =
    measuring || !widths || rowWidth <= 0
      ? { visible: items.map((item) => item.id), overflowed: [] }
      : fitToolbar({
          availableWidth: rowWidth - TITLE_MINIMUM_WIDTH - widths.trailing - widths.menuButton - HEADER_ITEM_GAP,
          items: items.map((item) => ({
            id: item.id,
            priority: item.priority,
            width: (widths[item.id] || 0) + HEADER_ITEM_GAP
          })),
          overflowButtonWidth: 0
        });
  const visibleItems = items.filter((item) => fitted.visible.includes(item.id));
  const overflowedItems = fitted.overflowed.map((id) => items.find((item) => item.id === id));

  return (
    <div className="header-top" ref={rowRef}>
      {titleNode}
      {visibleItems.map((item) => (
        <span className="header-item" key={item.id} data-toolbar-item={item.id}>
          {item.node}
        </span>
      ))}
      <span className="header-item" ref={menuButtonRef}>
        {renderMenuButton(overflowedItems)}
      </span>
      <span className="header-item header-trailing" ref={trailingRef}>
        {trailing}
      </span>
    </div>
  );
}

// What the middle column shows:
//   "terminal"   a live terminal of this app (new, or resumed here)
//   "elsewhere"  a terminal or job outside the app owns the session: a short
//                note and nothing else — this window is for talking, and that
//                conversation is not ours to talk in
//   "opening"    the click's terminal is still being spawned (or spawning
//                failed, which also raises an alert)
function columnMode({ session, terminal }) {
  if (terminal) {
    return "terminal";
  }
  if (session && session.liveStatus && session.liveStatus.source !== "app") {
    return "elsewhere";
  }
  return "opening";
}

function terminalStatusGroup(terminal, session) {
  if (session && session.ownedByApp) {
    return session.statusGroup;
  }
  return terminal.registryStatus === "idle" ? "waiting" : "running";
}

export default function MiddleColumn({
  session,
  terminal,
  agent,
  agentDefinitionPending = false,
  agents,
  panelOpen,
  onTogglePanel,
  onRename,
  onFork,
  onAssignAgent,
  onOpenAgentPicker,
  onCreateAgent,
  onHarvestSkills,
  onEditSessionFlags,
  onDeleteSession,
  reader,
  onCloseReader,
  onOpenReaderInPanel,
  find,
  windowTools
}) {
  const { translate, language } = useTranslation();
  const [renameRequest, setRenameRequest] = useState(0);
  const mode = columnMode({ session, terminal });
  const sessionId = (terminal && terminal.sessionId) || (session && session.sessionId) || null;
  // With the reader open the window tools move into its header, so they are
  // rendered once and stay in the same corner of the window.
  const readerPane = reader ? (
    <DocumentReader reader={reader} onClose={onCloseReader} onOpenInPanel={onOpenReaderInPanel} windowTools={windowTools} />
  ) : null;
  const underTools = reader ? null : windowTools;

  if (!session && !terminal) {
    return (
      <div className="column column-middle">
        {readerPane}
        {!reader && (
          <>
            <div className="middle-tools">{underTools}</div>
            <div className="middle-centered">
              <div className="empty-card">
                <div className="empty-icon">✿</div>
                {translate("transcript.empty")}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // The chip next to it already carries the emoji, so the title does not.
  const title = titleWithoutAgentEmoji(session ? session.title : translate("newSession.untitled"), agent);
  const projectLabel = session ? session.projectLabel || session.projectName : folderLabel(terminal.workingDirectory);
  const workingDirectoryShort = session ? session.workingDirectoryShort : terminal.workingDirectory;

  if (mode !== "terminal") {
    return (
      <div className="column column-middle">
        {readerPane}
        {!reader && (
          <>
            <div className="middle-tools">{underTools}</div>
            <div className="middle-centered">
              <div className="elsewhere-note" data-elsewhere-note={mode === "elsewhere" ? "1" : "0"}>
                <div className="elsewhere-title">{title}</div>
                <div className="elsewhere-folder" title={workingDirectoryShort}>
                  <FolderIcon />
                  {projectLabel}
                </div>
                <p className="elsewhere-text">
                  {mode === "elsewhere" ? translate("middle.runningElsewhere") : translate("middle.opening")}
                </p>
                {mode === "elsewhere" && onFork && session && session.sessionId && <ForkButton onFork={onFork} standalone />}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  const projectColorIndex = session ? session.projectColorIndex : 0;
  // The flags this terminal's `claude` was really started with (global,
  // agent and session levels already merged in the main process). They get
  // no control of their own: the folder's tooltip says them.
  const extraArgumentsText = terminal && terminal.extraArguments ? terminal.extraArguments.join(" ") : "";

  const statusGroup = terminalStatusGroup(terminal, session);
  const agentStarting = Boolean(terminal && terminal.agentId && terminal.kickoffState === "waiting");
  const needsFirstMessage = Boolean(terminal && terminal.kickoffState === "needsMessage");
  const metaDisabled = !sessionId;
  const metaTooltipKey = metaDisabled ? "meta.waitForSession" : null;

  // Ula's order, highest first: the agent chip, then the status, then Fork,
  // then the two meta actions. Above all of them and never hidden: the
  // settings gear and Hide/Show panel, which live in `trailing`.
  const headerItems = [
    agent
      ? {
          id: "agent",
          priority: HEADER_ITEM_PRIORITY.agentChip,
          label: `${agent.emoji}${agent.name}${agentDefinitionPending}${agentStarting}`,
          node: <AgentChip agent={agent} definitionPending={agentDefinitionPending} starting={agentStarting} />
        }
      : null,
    needsFirstMessage
      ? {
          id: "kickoff",
          priority: HEADER_ITEM_PRIORITY.kickoffHint,
          label: "kickoff",
          node: <KickoffHint />
        }
      : null,
    {
      id: "status",
      priority: HEADER_ITEM_PRIORITY.statusPill,
      label: statusGroup,
      node: <StatusPill statusGroup={statusGroup} />
    },
    onFork && terminal.sessionId
      ? {
          id: "fork",
          priority: HEADER_ITEM_PRIORITY.fork,
          label: "fork",
          node: <ForkButton onFork={onFork} />,
          menu: { label: translate("fork.button"), tooltip: translate("fork.tooltip"), onClick: onFork }
        }
      : null,
    {
      id: "createAgent",
      priority: HEADER_ITEM_PRIORITY.createAgent,
      label: `createAgent${metaDisabled}`,
      node: (
        <MetaActionButton
          marker="create-agent"
          label={translate("meta.createAgent")}
          tooltip={translate(metaTooltipKey || "meta.createAgentTooltip")}
          disabled={metaDisabled}
          onClick={onCreateAgent}
        />
      ),
      menu: {
        label: translate("meta.createAgentLong"),
        tooltip: translate(metaTooltipKey || "meta.createAgentTooltip"),
        disabled: metaDisabled,
        onClick: onCreateAgent
      }
    },
    {
      id: "harvestSkills",
      priority: HEADER_ITEM_PRIORITY.harvestSkills,
      label: `harvestSkills${metaDisabled}`,
      node: (
        <MetaActionButton
          marker="harvest-skills"
          label={translate("meta.harvestSkills")}
          tooltip={translate(metaTooltipKey || "meta.harvestSkillsTooltip")}
          disabled={metaDisabled}
          onClick={onHarvestSkills}
        />
      ),
      menu: {
        label: translate("meta.harvestSkills"),
        tooltip: translate(metaTooltipKey || "meta.harvestSkillsTooltip"),
        disabled: metaDisabled,
        onClick: onHarvestSkills
      }
    }
  ].filter(Boolean);

  // Re-measure when what is written on the controls can have changed —
  // never on a resize, where only the room they have to fit in changes.
  const signature = [language, panelOpen, Boolean(underTools), ...headerItems.map((item) => `${item.id}:${item.label}`)].join("|");

  // The terminal stays mounted while the reader is on top of it: unmounting
  // TerminalPane would detach the xterm instance and the scrollback would
  // scroll back into view from the top. Only its wrapper is hidden.
  return (
    <div className="column column-middle">
      {readerPane}
      <div className={reader ? "terminal-stack is-hidden" : "terminal-stack"} data-terminal-stack={reader ? "hidden" : "shown"}>
        <header className="transcript-header">
          <HeaderToolbar
            signature={signature}
            items={headerItems}
            titleNode={
              <EditableTitle title={title} onRename={session ? onRename : null} renameRequest={renameRequest} />
            }
            trailing={
              <>
                {underTools}
                <button type="button" className="panel-toggle" onClick={onTogglePanel}>
                  {panelOpen ? translate("panel.hide") : translate("panel.show")}
                </button>
              </>
            }
            renderMenuButton={(overflowedItems) => (
              <HeaderMenuButton
                overflowedItems={overflowedItems}
                sessionId={sessionId}
                agents={agents || []}
                currentAgentId={agent ? agent.id : null}
                onOpenAgentPicker={onOpenAgentPicker}
                runsElsewhere={Boolean(session && session.liveStatus && session.liveStatus.source !== "app")}
                onAssignAgent={onAssignAgent}
                onEditSessionFlags={onEditSessionFlags}
                onDeleteSession={onDeleteSession}
                onRenameSession={session && onRename ? () => setRenameRequest(renameRequest + 1) : null}
              />
            )}
          />
          <div className="header-meta">
            <span
              className="meta-item"
              title={
                extraArgumentsText
                  ? `${workingDirectoryShort}\n${translate("flags.effective")}: ${extraArgumentsText}`
                  : workingDirectoryShort
              }
              data-extra-flags={extraArgumentsText || null}
            >
              <span className="project-dot" style={{ background: `var(--project-color-${projectColorIndex})` }} />
              <FolderIcon />
              {projectLabel}
            </span>
            {session && session.gitBranch && (
              <span className="meta-item">
                <span className="meta-label">{translate("header.branch")}</span>
                <code>{session.gitBranch}</code>
              </span>
            )}
          </div>
        </header>
        <div className="terminal-area">
          {/* "Find in conversation…": over the terminal, never a second
              header line. The terminal keeps running underneath. */}
          {find && find.open && (
            <FindBar
              query={find.query}
              onQueryChange={find.onQueryChange}
              onSubmit={find.onSubmit}
              onStep={find.onStep}
              onClose={find.onClose}
              result={find.result}
              currentIndex={find.currentIndex}
              searching={find.searching}
            />
          )}
          <TerminalPane terminalId={terminal.terminalId} />
        </div>
      </div>
    </div>
  );
}
