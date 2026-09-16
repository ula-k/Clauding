// Extra `claude` flags: the one piece of the command line the user writes
// themselves. Pure string work and nothing from node, because both sides
// need it — the main process when it composes a command line, and the
// renderer's three fields (settings, the agent form, the "+ New" sheet) when
// they check what was typed.
//
// Three places may add flags to the command line, and they are merged in this
// order, each one appended after the last: settings.json (every terminal),
// the agent (every session that agent runs) and the session itself. So a
// global `--model sonnet` can be overridden per session, and a per-session
// `--channels plugin:telegram` follows that conversation through every resume,
// restart and fork.
//
// The field is written the way it would be typed in a terminal, so it is
// split the way a shell would: quotes hold a value together, a backslash
// escapes the next character outside quotes.
export function splitArguments(text) {
  const tokens = [];
  let current = "";
  let started = false;
  let quote = null;
  const characters = Array.from(String(text || ""));
  for (let position = 0; position < characters.length; position += 1) {
    const character = characters[position];
    if (quote) {
      if (character === quote) {
        quote = null;
      } else if (character === "\\" && quote === '"' && position + 1 < characters.length) {
        position += 1;
        current += characters[position];
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\" && position + 1 < characters.length) {
      position += 1;
      current += characters[position];
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

// Flags the app builds itself. Letting one of them through the field would
// either fight with the app's own command line (a second --resume) or take
// the CLI out of its interactive mode altogether (--print), leaving a
// terminal that never answers.
export const RESERVED_FLAGS = ["--resume", "--print", "-p", "--output-format", "--system-prompt-snapshot"];
const RESERVED_PREFIXES = ["--append-system-prompt"];

export function isReservedFlag(token) {
  const name = String(token || "").split("=")[0];
  return RESERVED_FLAGS.includes(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function reservedFlagsIn(tokens) {
  return (tokens || []).filter(isReservedFlag);
}

// What the field's own validation says: the tokens it would add, and a
// message naming what cannot be used when it holds one of the app's flags.
export function checkExtraArguments(text) {
  const tokens = splitArguments(text);
  const reserved = reservedFlagsIn(tokens);
  return {
    tokens,
    reserved,
    message: reserved.length === 0
      ? ""
      : `Clauding sets ${reserved.join(", ")} itself — please take ${reserved.length === 1 ? "it" : "them"} out.`
  };
}

// The three levels, in order, with anything reserved dropped: the merge is
// the last line of defence, so a flag that got into a file by hand still
// cannot break a terminal.
export function mergeExtraArguments(levels) {
  const tokens = [];
  for (const level of levels || []) {
    const levelTokens = splitArguments(level);
    for (let position = 0; position < levelTokens.length; position += 1) {
      const token = levelTokens[position];
      if (!isReservedFlag(token)) {
        tokens.push(token);
        continue;
      }
      // A dropped flag takes its value with it: leaving "abc" behind from
      // "--resume abc" would hand the CLI a stray argument.
      const next = levelTokens[position + 1];
      if (!token.includes("=") && typeof next === "string" && !next.startsWith("-")) {
        position += 1;
      }
    }
  }
  return tokens;
}
