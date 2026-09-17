import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { renderMarkdown } from "../markdown.js";

// The results of "Find in conversation…", drawn in the side panel as the
// session's one **Search: <query>** tab — in the app's reading style, the
// same serif column a Markdown page gets, because this is something to read
// rather than a list of file names.
//
// Each hit is one message (or one thinking block, or one tool call, or one
// tool result) that holds the word: a role badge, the time, and the snippet
// with every match on a lavender ground. Clicking it opens the whole
// message underneath.
//
// The transcript keeps growing while the session runs, so nothing is
// watched: the find bar's Enter and the **Refresh** link here read the file
// again, which is the whole of the live story.

// The same splitting the snippet already had done for it in the main
// process, for the expanded full text. Plain text, never a pattern.
function splitOnMatches(text, query) {
  const haystack = String(text || "");
  const needle = String(query || "").toLowerCase();
  if (!needle) {
    return [{ text: haystack, match: false }];
  }
  const lowered = haystack.toLowerCase();
  const pieces = [];
  let cursor = 0;
  for (;;) {
    const at = lowered.indexOf(needle, cursor);
    if (at === -1) {
      break;
    }
    if (at > cursor) {
      pieces.push({ text: haystack.slice(cursor, at), match: false });
    }
    pieces.push({ text: haystack.slice(at, at + needle.length), match: true });
    cursor = at + needle.length;
  }
  if (cursor < haystack.length) {
    pieces.push({ text: haystack.slice(cursor), match: false });
  }
  return pieces;
}

// In a snippet the message's own line breaks are noise — a preview that
// gives a blank line to every paragraph break shows two sentences in the
// space of six lines. They are collapsed to single spaces here (and only
// here: an opened message keeps its shape exactly).
function collapseWhitespace(text) {
  return String(text).replace(/\s+/g, " ");
}

function Marked({ segments, collapse = false }) {
  return segments.map((piece, pieceIndex) => {
    const shown = collapse ? collapseWhitespace(piece.text) : piece.text;
    return piece.match ? (
      <mark key={pieceIndex} className="find-match">
        {shown}
      </mark>
    ) : (
      <span key={pieceIndex}>{shown}</span>
    );
  });
}

function clockTime(timestamp) {
  if (!timestamp) {
    return "";
  }
  const moment = new Date(timestamp);
  if (Number.isNaN(moment.getTime())) {
    return "";
  }
  return moment.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// user / assistant / tool are the app's own three; anything else is the
// label the main process made for a subagent ("subagent (Explore)") and is
// shown as it came.
function roleLabel(role, translate) {
  if (role === "user" || role === "assistant" || role === "tool") {
    return translate(`find.role.${role}`);
  }
  return role;
}

function roleClassName(role) {
  if (role === "user" || role === "assistant" || role === "tool") {
    return `find-role is-${role}`;
  }
  return "find-role is-subagent";
}

function kindLabel(hit, translate) {
  if (hit.kind === "tool_use") {
    return hit.toolName || translate("find.kind.tool_use");
  }
  return translate(`find.kind.${hit.kind}`);
}

// The whole message, once a hit is clicked open. An assistant's own words
// are markdown and are read as markdown; everything else — a tool result, a
// tool call's JSON, what the user typed — is shown exactly as it is, with
// the matches marked.
function FullText({ hit, query }) {
  const { translate } = useTranslation();
  const asMarkdown = hit.role === "assistant" && hit.kind === "text";
  const html = useMemo(() => (asMarkdown ? renderMarkdown(hit.fullText) : ""), [asMarkdown, hit.fullText]);
  return (
    <div className="find-full">
      {asMarkdown ? (
        <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="find-full-text">
          <Marked segments={splitOnMatches(hit.fullText, query)} />
        </pre>
      )}
      {hit.fullTextTruncated && <p className="find-truncated">{translate("find.truncated")}</p>}
    </div>
  );
}

export default function SearchResults({ query, result, currentIndex, onSelectHit, onRefresh, searching }) {
  const { translate } = useTranslation();
  const [expanded, setExpanded] = useState({});
  const containerRef = useRef(null);

  // A new search starts with everything folded again.
  useEffect(() => {
    setExpanded({});
  }, [result]);

  // ↑ / ↓ in the find bar move the marker; the list follows it here, so the
  // hit being pointed at is always the one on screen.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const current = container.querySelector(`[data-search-hit="${currentIndex}"]`);
    if (current) {
      current.scrollIntoView({ block: "nearest" });
    }
  }, [currentIndex, result]);

  const hits = result ? result.hits : [];
  const askedFor = result ? result.query : query;

  return (
    <div className="panel-tab-content panel-reading find-results" ref={containerRef}>
      <header className="find-results-header">
        <h2>{translate("find.resultsTitle", { query: askedFor })}</h2>
        <p className="find-results-count">
          {result && result.transcriptFound === false
            ? translate("find.noTranscript")
            : translate("find.resultsCount", { messages: hits.length, matches: result ? result.totalMatches : 0 })}
        </p>
        <button type="button" className="find-refresh" onClick={onRefresh} disabled={searching} data-find-refresh>
          {searching ? translate("find.searching") : translate("find.refresh")}
        </button>
      </header>
      {hits.length === 0 && result && result.transcriptFound !== false && (
        <p className="find-empty">{translate("find.noMatches")}</p>
      )}
      <ol className="find-hits">
        {hits.map((hit) => (
          <li
            key={hit.index}
            className={hit.index === currentIndex ? "find-hit is-current" : "find-hit"}
            data-search-hit={hit.index}
          >
            <button
              type="button"
              className="find-hit-button"
              data-search-hit-button={hit.index}
              onClick={() => {
                onSelectHit(hit.index);
                setExpanded((previous) => ({ ...previous, [hit.index]: !previous[hit.index] }));
              }}
            >
              <span className="find-hit-top">
                <span className={roleClassName(hit.role)}>{roleLabel(hit.role, translate)}</span>
                <span className="find-kind">{kindLabel(hit, translate)}</span>
                <span className="find-time">{clockTime(hit.timestamp)}</span>
                {hit.matchCount > 1 && <span className="find-hit-count">{hit.matchCount}</span>}
              </span>
              <span className="find-snippet">
                {hit.snippet.trimmedStart && <span className="find-ellipsis">…</span>}
                <Marked segments={hit.snippet.segments} collapse />
                {hit.snippet.trimmedEnd && <span className="find-ellipsis">…</span>}
              </span>
            </button>
            {expanded[hit.index] && <FullText hit={hit} query={askedFor} />}
          </li>
        ))}
      </ol>
    </div>
  );
}
