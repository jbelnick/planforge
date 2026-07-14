import { describe, expect, it } from "vitest";
import {
  ARCHITECT_EFFORTS,
  BUILDER_EFFORTS,
  parseArchitectEffort,
  parseBuilderEffort,
  parseOptionalArchitectEffort,
  parseOptionalBuilderEffort
} from "../src/effort";

describe("PlanForge effort vocabulary", () => {
  it("parses every architect effort level to itself", () => {
    for (const effort of ARCHITECT_EFFORTS) {
      expect(parseArchitectEffort(effort)).toBe(effort);
    }
  });

  it("parses every builder effort level to itself", () => {
    for (const effort of BUILDER_EFFORTS) {
      expect(parseBuilderEffort(effort)).toBe(effort);
    }
  });

  it("rejects non-empty invalid values", () => {
    expect(() => parseArchitectEffort("maximum")).toThrow(expect.objectContaining({ code: "E_INVALID_EFFORT" }));
    expect(() => parseBuilderEffort("extreme")).toThrow(expect.objectContaining({ code: "E_INVALID_EFFORT" }));
    expect(() => parseOptionalBuilderEffort("extreme")).toThrow(expect.objectContaining({ code: "E_INVALID_EFFORT" }));
  });

  it("maps optional empty inputs to undefined", () => {
    expect(parseOptionalArchitectEffort(undefined)).toBeUndefined();
    expect(parseOptionalArchitectEffort("")).toBeUndefined();
    expect(parseOptionalBuilderEffort(undefined)).toBeUndefined();
    expect(parseOptionalBuilderEffort("   ")).toBeUndefined();
  });
});
