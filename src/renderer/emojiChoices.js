// Everything the emoji field needs: how to cut one emoji out of whatever
// arrives (paste, typing, the native macOS panel), and the small built-in
// list the popover draws when the user would rather just pick one.
//
// electron/agents.js keeps its own copy of the same "first grapheme" rule —
// the renderer must not import from the Electron side, and the store is the
// one that decides what may be written to agents.json.

// The first grapheme cluster of `text`, so a composed emoji ("🧑‍💻",
// "👩🏽‍🔬", "✅") survives as one character instead of being cut in half.
// Whitespace around it is dropped, so pasting "✅ Test" leaves "✅".
export function firstGrapheme(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return "";
  }
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    for (const segment of segmenter.segment(trimmed)) {
      return segment.segment;
    }
    return "";
  }
  // Older engines: at least keep whole code points (surrogate pairs) intact.
  return Array.from(trimmed)[0] || "";
}

// ~64 emoji worth putting on an agent, in five short rows. `keywords` is
// what the search box matches on — English only and written out here, so
// the app needs no emoji library.
export const EMOJI_GROUPS = [
  {
    labelKey: "agents.emojiGroupWork",
    choices: [
      { emoji: "✦", keywords: "star spark default agent" },
      { emoji: "📐", keywords: "ruler spec design plan" },
      { emoji: "🧭", keywords: "compass guide direction" },
      { emoji: "📊", keywords: "chart report data" },
      { emoji: "📈", keywords: "growth chart up metrics" },
      { emoji: "📋", keywords: "clipboard todo list task" },
      { emoji: "🗂", keywords: "folders files archive" },
      { emoji: "📝", keywords: "note writing spec memo" },
      { emoji: "✅", keywords: "check done ready approved" },
      { emoji: "🎯", keywords: "target goal focus" },
      { emoji: "🚀", keywords: "rocket release launch ship" },
      { emoji: "🧩", keywords: "puzzle piece feature" },
      { emoji: "🔍", keywords: "search find magnifier review" }
    ]
  },
  {
    labelKey: "agents.emojiGroupTools",
    choices: [
      { emoji: "🛠", keywords: "tools build repair" },
      { emoji: "🔧", keywords: "wrench fix maintenance" },
      { emoji: "🔨", keywords: "hammer build" },
      { emoji: "⚙️", keywords: "gear settings automation" },
      { emoji: "🧰", keywords: "toolbox kit" },
      { emoji: "💾", keywords: "save disk backup storage" },
      { emoji: "💻", keywords: "laptop code developer" },
      { emoji: "🖥", keywords: "desktop screen monitor" },
      { emoji: "⌨️", keywords: "keyboard typing terminal" },
      { emoji: "🖱", keywords: "mouse click pointer" },
      { emoji: "🧪", keywords: "test experiment lab quality" },
      { emoji: "🔬", keywords: "microscope research analysis" },
      { emoji: "🖨", keywords: "printer output paper" }
    ]
  },
  {
    labelKey: "agents.emojiGroupPeople",
    choices: [
      { emoji: "🧑‍💻", keywords: "developer coder programmer" },
      { emoji: "👩‍🔬", keywords: "scientist researcher" },
      { emoji: "🧑‍🏫", keywords: "teacher tutor coach" },
      { emoji: "🧑‍🎨", keywords: "artist designer" },
      { emoji: "👷", keywords: "worker builder engineer" },
      { emoji: "🕵️", keywords: "detective investigator search" },
      { emoji: "🧙", keywords: "wizard magic expert" },
      { emoji: "🧑‍🚀", keywords: "astronaut explorer" },
      { emoji: "👩‍⚕️", keywords: "doctor health care" },
      { emoji: "🧑‍🌾", keywords: "farmer gardener" },
      { emoji: "🦸", keywords: "hero rescue helper" },
      { emoji: "🤖", keywords: "robot bot automation machine" },
      { emoji: "👋", keywords: "hello greeting welcome" }
    ]
  },
  {
    labelKey: "agents.emojiGroupSymbols",
    choices: [
      { emoji: "⭐️", keywords: "star favourite quality" },
      { emoji: "✨", keywords: "sparkles polish shine new" },
      { emoji: "💡", keywords: "idea light insight" },
      { emoji: "❤️", keywords: "heart love care" },
      { emoji: "🔥", keywords: "fire hot urgent" },
      { emoji: "⚡️", keywords: "lightning fast energy speed" },
      { emoji: "🎵", keywords: "music note sound audio" },
      { emoji: "🔔", keywords: "bell alert reminder notice" },
      { emoji: "🏆", keywords: "trophy winner award" },
      { emoji: "🧿", keywords: "amulet protection eye" },
      { emoji: "♻️", keywords: "recycle refresh cleanup" },
      { emoji: "⚓️", keywords: "anchor stable steady" },
      { emoji: "🧠", keywords: "brain thinking memory smart" }
    ]
  },
  {
    labelKey: "agents.emojiGroupNature",
    choices: [
      { emoji: "🌱", keywords: "seedling growth start" },
      { emoji: "🌳", keywords: "tree nature forest" },
      { emoji: "🌸", keywords: "blossom flower spring" },
      { emoji: "🍀", keywords: "clover luck" },
      { emoji: "🌍", keywords: "earth world global planet" },
      { emoji: "🌙", keywords: "moon night late" },
      { emoji: "☀️", keywords: "sun day bright morning" },
      { emoji: "🌊", keywords: "wave water ocean flow" },
      { emoji: "🐝", keywords: "bee busy work" },
      { emoji: "🦊", keywords: "fox clever animal" },
      { emoji: "🐙", keywords: "octopus many hands parallel" },
      { emoji: "🐢", keywords: "turtle slow steady patient" }
    ]
  }
];

// The rows left after the search box, each group keeping only what matches.
// An empty search returns every group unchanged.
export function filterEmojiGroups(searchText) {
  const needle = String(searchText || "").trim().toLowerCase();
  if (!needle) {
    return EMOJI_GROUPS;
  }
  const matched = [];
  for (const group of EMOJI_GROUPS) {
    const choices = group.choices.filter((choice) => {
      return choice.emoji === needle || choice.keywords.includes(needle);
    });
    if (choices.length > 0) {
      matched.push({ labelKey: group.labelKey, choices });
    }
  }
  return matched;
}
