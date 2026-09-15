// Tiny inline icons so we do not pull an icon library.
export function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// Marks the "Hidden (N)" line at the bottom of the list.
export function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function FolderIcon({ className = "folder-icon" }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v5.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// The Fork button: one line that splits into a second one.
export function ForkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.9" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="3.5" r="1.9" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.5" cy="12.5" r="1.9" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 5.4v5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M11.5 5.4v1.1A2.5 2.5 0 0 1 9 9H4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="12.5" cy="8" r="1.4" />
    </svg>
  );
}

export function ChevronRightIcon({ className = "chevron-icon" }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m6 3.5 5 4.5-5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

// The Skills button: a small four-pointed spark, the "something was
// distilled out of a conversation" mark.
export function SparkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5c.6 3.2 1.3 3.9 4.5 4.5-3.2.6-3.9 1.3-4.5 4.5-.6-3.2-1.3-3.9-4.5-4.5C6.7 5.4 7.4 4.7 8 1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M12.2 10.2c.3 1.5.6 1.8 2.1 2.1-1.5.3-1.8.6-2.1 2.1-.3-1.5-.6-1.8-2.1-2.1 1.5-.3 1.8-.6 2.1-2.1Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

// The settings gear next to it.
export function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.3" strokeDasharray="1.7 1.35" />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m11 2.5 2.5 2.5L5 13.5H2.5V11L11 2.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ReloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.5-3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M13 2.5v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function GlobeIcon() {
  return (
    <svg className="panel-tab-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function PageIcon() {
  return (
    <svg className="panel-tab-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 2h6l3 3v9h-9V2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6 8.5 4.5 10 6 11.5M10 8.5l1.5 1.5-1.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MarkdownIcon() {
  return (
    <svg className="panel-tab-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 2h6l3 3v9h-9V2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M5 11.5V8l1.75 2L8.5 8v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// "Read this here": an open page with lines of text. Marks the rows that
// open the middle-column reader — a skill, an agent definition.
export function ReadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 3.5h4a2 2 0 0 1 2 2v7a1.6 1.6 0 0 0-1.6-1.4H2V3.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M14 3.5h-4a2 2 0 0 0-2 2v7a1.6 1.6 0 0 1 1.6-1.4H14V3.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

// The reader's way back to the terminal.
export function ArrowLeftIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A magnifying glass over a folder: "look through this Mac for skills".
export function ScanIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h2.6l1.2 1.4H12a1.2 1.2 0 0 1 1.2 1.2v1.1" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M1.5 4.2v7.1A1.2 1.2 0 0 0 2.7 12.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="10.6" cy="10.1" r="2.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="m12.7 12.2 1.8 1.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
