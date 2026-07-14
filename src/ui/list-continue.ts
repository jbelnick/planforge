// Markdown list auto-continuation for the composer.
//
// When the user presses Enter at the end of a line that is a list item, insert the next marker on
// the new line: an ordered list `1. ` continues to `2. `, `3. `...; an unordered `- ` or `* `
// continues to `- `. If the current line is an EMPTY list item (only the marker + whitespace),
// pressing Enter removes the marker entirely so the user can exit the list (the same convention as
// every other rich editor). Plain Enter still inserts the newline; the only added behavior is the
// marker prefix on the following line.
//
// Continuation only fires when the caret is at the END of the list line (no text after it on that
// line) — pressing Enter mid-word splits the word normally, which is the expected editor behavior.
//
// Pure and unit-tested: given the textarea value + selection, returns the next value + caret, or
// null when no list continuation applies (so the caller lets the browser handle the key normally).

const ORDERED = /^(\s*)(\d+)([.)])(\s*)$/;
const ORDERED_ITEM = /^(\s*)(\d+)([.)])\s+/;
const UNORDERED_ITEM = /^(\s*)([-*+])\s*$/;
const UNORDERED = /^(\s*)([-*+])\s+/;

export type ListContinueResult = {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
};

type MarkerDecision = { readonly prefix: string; readonly remove: true } | { readonly prefix: string; readonly remove: false };

// Inspect a single line (the current list line, with no trailing newline) and decide what marker, if
// any, should follow on Enter.
export function nextLineMarker(line: string): { readonly prefix: string; readonly remove: boolean } | null {
  // Empty ordered item: `1.`, `1. `, `1)  ` (marker + optional trailing whitespace, no content).
  const emptyOrdered = line.match(ORDERED);
  if (emptyOrdered) {
    return { prefix: "", remove: true };
  }
  // Empty unordered item: `-`, `-  `.
  if (UNORDERED_ITEM.test(line)) {
    return { prefix: "", remove: true };
  }
  // A populated ordered item: continue to the next number.
  const ordered = line.match(ORDERED_ITEM);
  if (ordered) {
    const indent = ordered[1] ?? "";
    const number = Number(ordered[2] ?? "1");
    const delimiter = ordered[3] ?? ".";
    return { prefix: `${indent}${number + 1}${delimiter} `, remove: false };
  }
  // A populated unordered item: repeat the same marker.
  const unordered = line.match(UNORDERED);
  if (unordered) {
    const indent = unordered[1] ?? "";
    const marker = unordered[2] ?? "-";
    return { prefix: `${indent}${marker} `, remove: false };
  }
  return null;
}

export function continueListOnEnter(
  value: string,
  selectionStart: number,
  selectionEnd: number
): ListContinueResult | null {
  const caret = Math.min(selectionStart, selectionEnd);
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const lineStart = before.lastIndexOf("\n") + 1;
  // The current line up to the caret. If there is any non-newline text after the caret on the same
  // line, this is a mid-line Enter: do not continue the list, let the browser split the line.
  const remainingOnLine = after.length > 0 ? after.indexOf("\n") : -1;
  const tail = remainingOnLine === -1 ? after : after.slice(0, remainingOnLine);
  if (tail.length > 0) {
    return null;
  }
  const currentLine = before.slice(lineStart);
  const decision = nextLineMarker(currentLine);
  if (!decision) {
    return null;
  }
  const resolved = decision as MarkerDecision;

  if (resolved.remove) {
    // Exit the list: delete the empty marker on the current line. The browser's default newline is
    // suppressed; the caret stays at the start of the (now blank) line.
    const stripped = before.slice(0, lineStart);
    return {
      value: `${stripped}${after}`,
      selectionStart: lineStart,
      selectionEnd: lineStart
    };
  }

  // Insert the newline + the next marker, caret positioned after the marker so typing continues the
  // new item.
  const next = `${before}\n${resolved.prefix}${after}`;
  const caretNext = before.length + 1 + resolved.prefix.length;
  return {
    value: next,
    selectionStart: caretNext,
    selectionEnd: caretNext
  };
}
