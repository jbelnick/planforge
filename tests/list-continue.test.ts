import { describe, expect, it } from "vitest";
import { continueListOnEnter, nextLineMarker } from "../src/ui/list-continue";

describe("nextLineMarker", () => {
  it("continues an ordered list to the next number", () => {
    expect(nextLineMarker("1. create task 1")).toEqual({ prefix: "2. ", remove: false });
    expect(nextLineMarker("2. create task 2")).toEqual({ prefix: "3. ", remove: false });
    expect(nextLineMarker("10. tenth")).toEqual({ prefix: "11. ", remove: false });
  });

  it("honors the delimiter (period or paren) and indentation", () => {
    expect(nextLineMarker("  1) nested")).toEqual({ prefix: "  2) ", remove: false });
    expect(nextLineMarker("\t1. tabbed")).toEqual({ prefix: "\t2. ", remove: false });
  });

  it("continues an unordered list with the same marker", () => {
    expect(nextLineMarker("- bullet")).toEqual({ prefix: "- ", remove: false });
    expect(nextLineMarker("* star")).toEqual({ prefix: "* ", remove: false });
    expect(nextLineMarker("  + nested plus")).toEqual({ prefix: "  + ", remove: false });
  });

  it("marks an empty list item for removal so Enter exits the list", () => {
    expect(nextLineMarker("1. ")).toEqual({ prefix: "", remove: true });
    expect(nextLineMarker("-   ")).toEqual({ prefix: "", remove: true });
    expect(nextLineMarker("2.")).toEqual({ prefix: "", remove: true });
  });

  it("returns null for a non-list line", () => {
    expect(nextLineMarker("just prose")).toBeNull();
    expect(nextLineMarker("")).toBeNull();
  });
});

describe("continueListOnEnter", () => {
  it("inserts the next ordered marker on Enter at the end of a line", () => {
    const value = "1. create task 1\n2. create task 2";
    const result = continueListOnEnter(value, value.length, value.length);
    expect(result).not.toBeNull();
    expect(result?.value).toBe("1. create task 1\n2. create task 2\n3. ");
    expect(result?.selectionStart).toBe(result?.value.length);
  });

  it("inserts a bullet on Enter at the end of an unordered item", () => {
    // Caret at the end of the first line "- one" (index 5); the following "\n- two" stays put.
    const result = continueListOnEnter("- one\n- two", 5, 5);
    expect(result?.value).toBe("- one\n- \n- two");
    // Caret lands right after the new "- " marker.
    expect(result?.selectionStart).toBe("- one\n- ".length);
  });

  it("removes an empty marker on Enter so the user exits the list", () => {
    const result = continueListOnEnter("1. one\n2. ", 10, 10);
    expect(result?.value).toBe("1. one\n");
    expect(result?.selectionStart).toBe("1. one\n".length);
  });

  it("does not continue a list when Enter is pressed mid-line (lets the browser split the line)", () => {
    // Caret in the middle of "create": mid-line Enter is a normal split, not a list continuation.
    expect(continueListOnEnter("1. create task 1", 4, 4)).toBeNull();
  });

  it("returns null (no interception) for a non-list line so the browser inserts a plain newline", () => {
    expect(continueListOnEnter("plain text", 6, 6)).toBeNull();
    expect(continueListOnEnter("", 0, 0)).toBeNull();
  });

  it("handles a multi-item ordered list being typed in sequence (the user's example)", () => {
    let value = "";
    // Type "1. create task 1" then Enter -> "2. " is appended.
    value = "1. create task 1";
    let r = continueListOnEnter(value, value.length, value.length);
    expect(r).not.toBeNull();
    value = r!.value;
    expect(value).toBe("1. create task 1\n2. ");
    // Type "create task 2" then Enter -> "3. " is appended.
    value += "create task 2";
    r = continueListOnEnter(value, value.length, value.length);
    expect(r?.value).toBe("1. create task 1\n2. create task 2\n3. ");
  });
});
