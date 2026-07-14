import type { TranscriptEntry, TranscriptEntryType } from "../conversation-store";
import { isJsonObject, type JsonObject, type JsonValue } from "../shared/json";

export const transcriptEntryTypes: readonly TranscriptEntryType[] = [
  "user_message",
  "architect_message",
  "tool_use",
  "tool_result",
  "plan_proposed",
  "approval",
  "build_output",
  "test_delta",
  "verify_result",
  "change_diff",
  "cycle_complete",
  "run_meta",
  "usage",
  "merge_blocked",
  "recovery",
  "error"
];

export type TranscriptActor = "operator" | "architect" | "builder" | "system";

const actorByType = {
  user_message: "operator",
  approval: "operator",
  architect_message: "architect",
  plan_proposed: "architect",
  tool_use: "architect",
  tool_result: "architect",
  build_output: "builder",
  test_delta: "builder",
  verify_result: "builder",
  change_diff: "builder",
  cycle_complete: "builder",
  run_meta: "system",
  usage: "architect",
  merge_blocked: "builder",
  recovery: "system",
  error: "system"
} satisfies Record<TranscriptEntryType, TranscriptActor>;

export type PlanGateStatus = "actionable" | "approved" | "builder_started" | "changes_requested" | "superseded";

export function actorOf(type: TranscriptEntryType): TranscriptActor {
  return actorByType[type];
}

export function mergeTranscriptEntry(entries: readonly TranscriptEntry[], entry: TranscriptEntry): readonly TranscriptEntry[] {
  // Seqs are strictly monotonic, so a live entry past the current tail is a pure O(1) append; only
  // out-of-order frames and replays pay for the dedupe-and-sort rebuild.
  const last = entries.at(-1);
  if (last === undefined || entry.seq > last.seq) {
    return [...entries, entry];
  }
  const bySeq = new Map<number, TranscriptEntry>();
  for (const existing of entries) {
    bySeq.set(existing.seq, existing);
  }
  bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

export function stringField(data: JsonObject, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}

export function booleanField(data: JsonObject, key: string): boolean {
  const value = data[key];
  return typeof value === "boolean" ? value : false;
}

export function numberField(data: JsonObject, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" ? value : undefined;
}

export function jsonField(data: JsonObject, key: string): JsonValue | undefined {
  return data[key];
}

export function jsonLabel(value: JsonValue | undefined): string {
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

export function planGateStatus(entries: readonly TranscriptEntry[], planSeq: number): PlanGateStatus {
  const planSeqs = entries.filter((entry) => entry.type === "plan_proposed").map((entry) => entry.seq);
  const latestPlanSeq = Math.max(...planSeqs);
  const nextPlanSeq = planSeqs.filter((seq) => seq > planSeq).sort((left, right) => left - right)[0];
  const windowEntries = entries.filter(
    (entry) => entry.seq > planSeq && (nextPlanSeq === undefined || entry.seq < nextPlanSeq)
  );
  const approval = windowEntries.find((entry) => entry.type === "approval");

  if (!approval) {
    return latestPlanSeq === planSeq ? "actionable" : "superseded";
  }

  if (stringField(approval.data, "verdict") === "changes_requested") {
    return "changes_requested";
  }

  return windowEntries.some((entry) => actorOf(entry.type) === "builder") ? "builder_started" : "approved";
}

// The live build status derived from the transcript: when the in-flight build's first output chunk
// arrived (the elapsed-time base) and the most recent meaningful codex item parsed from the stream.
export type LiveBuildStatus = {
  readonly startedTs: number;
  readonly latestItem: string | null;
};

// Only the newest chunks can carry the latest item, so JSON parsing is capped to this many trailing
// chunks per derivation instead of re-parsing the whole build log as it streams.
const LIVE_BUILD_CHUNK_WINDOW = 40;
const LIVE_BUILD_ITEM_MAX_CHARS = 96;

// A build is in flight when build_output chunks exist after the latest settle marker. verify_result
// and cycle_complete end a cycle per the loop contract; an error entry also settles the build (the
// orchestrator marks the build settled on error), so a failed build does not strand the strip.
export function liveBuildStatus(entries: readonly TranscriptEntry[]): LiveBuildStatus | null {
  let boundary = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const type = entries[index]?.type;
    if (type === "verify_result" || type === "cycle_complete" || type === "error") {
      boundary = index;
      break;
    }
  }
  let startedTs: number | null = null;
  const chunks: string[] = [];
  for (let index = boundary + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.type !== "build_output") {
      continue;
    }
    startedTs ??= entry.ts;
    chunks.push(stringField(entry.data, "chunk"));
  }
  if (startedTs === null) {
    return null;
  }
  return { startedTs, latestItem: latestCodexItem(chunks) };
}

// codex --json chunks are JSONL fragments (a stdout chunk can split a line). The trailing window is
// joined before line-splitting so a line split across chunk boundaries inside the window still
// parses; anything unparseable (partial lines, non-JSON noise) is ignored. Keeps the last
// item.started/item.completed command_execution command or agent_message text.
function latestCodexItem(chunks: readonly string[]): string | null {
  const windowText = chunks.slice(-LIVE_BUILD_CHUNK_WINDOW).join("");
  let latest: string | null = null;
  for (const line of windowText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(trimmed) as JsonValue;
    } catch {
      continue;
    }
    if (!isJsonObject(parsed)) {
      continue;
    }
    const frame = stringField(parsed, "type");
    if (frame !== "item.started" && frame !== "item.completed") {
      continue;
    }
    const item = parsed.item;
    if (!isJsonObject(item)) {
      continue;
    }
    // Codex versions disagree on the item discriminator key (item_type vs type); accept either.
    const kind = stringField(item, "item_type") || stringField(item, "type");
    const text =
      kind === "command_execution" ? stringField(item, "command") : kind === "agent_message" ? stringField(item, "text") : "";
    if (text) {
      latest = stripLabel(text);
    }
  }
  return latest;
}

function stripLabel(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > LIVE_BUILD_ITEM_MAX_CHARS ? `${flattened.slice(0, LIVE_BUILD_ITEM_MAX_CHARS - 1)}…` : flattened;
}

export function parseTranscriptEntryMessage(text: string): TranscriptEntry | null {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
  if (!isJsonObject(parsed) || !isJsonObject(parsed.data)) {
    return null;
  }
  if (typeof parsed.seq !== "number" || typeof parsed.ts !== "number" || !isTranscriptEntryType(parsed.type)) {
    return null;
  }
  return {
    seq: parsed.seq,
    ts: parsed.ts,
    type: parsed.type,
    data: parsed.data
  };
}

function isTranscriptEntryType(value: JsonValue | undefined): value is TranscriptEntryType {
  return typeof value === "string" && transcriptEntryTypes.includes(value as TranscriptEntryType);
}
