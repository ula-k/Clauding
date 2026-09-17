// A placeholder that is a suggestion, not a shape.
//
// The "Extra claude flags" fields show the one flag string this app was built
// around, but grey text nobody can accept is only a hint: the flag still had
// to be typed out, `@claude-plugins-official` and all, and a slip there ends
// with the CLI refusing to start. So in an empty field **Tab** (or **→**)
// types the placeholder in and leaves the cursor in the field, and **Escape**
// on a field with something in it clears it instead of closing the sheet.
//
// The decision is pure so it can be checked without a window
// (test/placeholderAccept.test.js); the small handler under it is what the
// four fields actually call.

// "accept" — put the placeholder in the field; "clear" — empty it;
// "ignore" — this key means whatever it always meant (Tab moves on, Escape
// closes the sheet).
export function placeholderKeyDecision({ key, value = "", placeholder = "", hasModifier = false } = {}) {
  if (hasModifier) {
    return "ignore";
  }
  const typed = String(value === null || value === undefined ? "" : value);
  if ((key === "Tab" || key === "ArrowRight") && typed === "" && String(placeholder || "") !== "") {
    return "accept";
  }
  if (key === "Escape" && typed !== "") {
    return "clear";
  }
  return "ignore";
}

// Call from a field's onKeyDown. `applyValue` is the field's own setter, so
// the helper line under it ("Flags: …") updates like any other keystroke.
// Answers true when the key was used up here.
export function handlePlaceholderKey(event, placeholder, applyValue) {
  const decision = placeholderKeyDecision({
    key: event.key,
    value: event.target ? event.target.value : "",
    placeholder,
    hasModifier: event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
  });
  if (decision === "accept") {
    event.preventDefault();
    applyValue(placeholder);
    return true;
  }
  if (decision === "clear") {
    event.preventDefault();
    // The sheets and dialogs listen for Escape on the window to close
    // themselves; clearing the field is the answer here, so it stops there.
    event.stopPropagation();
    applyValue("");
    return true;
  }
  return false;
}
