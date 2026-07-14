// Client-safe boundary guard for a TestDelta carried on a run event / transcript entry. No Node
// imports, so both the orchestrator and the SPA can validate the same shape. The detector emits a
// well-formed object, but a run-event payload is typed only as JsonValue, so re-validate before
// persisting/rendering rather than trusting the wire.
import type { TestDelta } from "../domain";
import { isJsonObject, type JsonValue } from "./json";

function isStringArray(value: JsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isTestDelta(value: JsonValue | undefined): value is TestDelta {
  return (
    isJsonObject(value) &&
    typeof value.weakened === "boolean" &&
    typeof value.addedTests === "number" &&
    typeof value.removedTests === "number" &&
    isStringArray(value.signals) &&
    isStringArray(value.deletedTestFiles)
  );
}
