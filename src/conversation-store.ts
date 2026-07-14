import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename as renameFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARCHITECT_EFFORTS, BUILDER_EFFORTS, type ArchitectEffort, type BuilderEffort } from "./effort";
import { PlanForgeError } from "./errors";
import { isJsonObject, type JsonObject, type JsonValue } from "./shared/json";
import type { SseClient } from "./run-service";

const TRANSCRIPT_ENTRY_TYPES = [
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
] as const;

export type TranscriptEntryType = (typeof TRANSCRIPT_ENTRY_TYPES)[number];

export type TranscriptEntry = {
  readonly seq: number;
  readonly ts: number;
  readonly type: TranscriptEntryType;
  readonly data: JsonObject;
};

export type Conversation = {
  readonly id: string;
  readonly createdAt: number;
  updatedAt: number;
  title: string | null;
  lastSeq: number;
  sessionStarted: boolean;
  archived: boolean;
  // The allowlisted repo this conversation builds in. Null for legacy conversations (created before
  // per-conversation targets) — resolved to the server default at run start.
  targetRepo: string | null;
  architectModel: string | null;
  architectEffort: ArchitectEffort | null;
  builderModel: string | null;
  builderEffort: BuilderEffort | null;
};

export type ConversationStore = ReturnType<typeof createConversationStore>;

type CreateConversationStoreInput = {
  readonly root: string;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  // Optional allowlist gate run at create time. When provided, a conversation's chosen targetRepo is
  // validated before it is persisted; a disallowed target throws (mapped to HTTP 400 by the handler).
  // Kept injectable so the store stays free of filesystem/workspace-root knowledge.
  readonly validateTargetRepo?: (targetRepo: string) => void;
};

type CreateConversationMeta = {
  readonly title?: string;
  readonly targetRepo?: string;
  readonly architectModel?: string;
  readonly architectEffort?: ArchitectEffort;
  readonly builderModel?: string;
  readonly builderEffort?: BuilderEffort;
};

type UpdateConversationRunControls = {
  readonly targetRepo?: string;
  readonly architectModel?: string;
  readonly architectEffort?: ArchitectEffort;
  readonly builderModel?: string;
  readonly builderEffort?: BuilderEffort;
};

type ReadTranscriptOptions = {
  readonly afterSeq?: number;
  // When true, a corrupt mid-file line is quarantined (skipped) instead of throwing, so a single
  // bad entry cannot make every subscribe replay fail forever. Mirrors the torn-tail repair path.
  readonly quarantineCorrupt?: boolean;
};

type SubscribeOptions = {
  readonly lastEventId?: number;
};

type Subscriber = (entry: TranscriptEntry) => void;

type TranscriptReadResult = {
  readonly entries: TranscriptEntry[];
  readonly needsTailRepair: boolean;
};

function isTranscriptEntryType(value: JsonValue | undefined): value is TranscriptEntryType {
  return typeof value === "string" && TRANSCRIPT_ENTRY_TYPES.includes(value as TranscriptEntryType);
}

function isArchitectEffort(value: JsonValue | undefined): value is ArchitectEffort {
  return typeof value === "string" && ARCHITECT_EFFORTS.includes(value as ArchitectEffort);
}

function isBuilderEffort(value: JsonValue | undefined): value is BuilderEffort {
  return typeof value === "string" && BUILDER_EFFORTS.includes(value as BuilderEffort);
}

function parseConversation(value: JsonValue): Conversation | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const title = value.title;
  if (
    typeof value.id !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    !(typeof title === "string" || title === null) ||
    typeof value.lastSeq !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    title,
    lastSeq: value.lastSeq,
    sessionStarted: typeof value.sessionStarted === "boolean" ? value.sessionStarted : false,
    archived: typeof value.archived === "boolean" ? value.archived : false,
    // Legacy conversations predate per-conversation targets → null, resolved to the server default
    // at run start.
    targetRepo: typeof value.targetRepo === "string" ? value.targetRepo : null,
    architectModel: typeof value.architectModel === "string" ? value.architectModel : null,
    architectEffort: isArchitectEffort(value.architectEffort) ? value.architectEffort : null,
    builderModel: typeof value.builderModel === "string" ? value.builderModel : null,
    builderEffort: isBuilderEffort(value.builderEffort) ? value.builderEffort : null
  };
}

function parseTranscriptEntry(value: JsonValue): TranscriptEntry | null {
  if (!isJsonObject(value) || !isJsonObject(value.data)) {
    return null;
  }
  if (typeof value.seq !== "number" || typeof value.ts !== "number" || !isTranscriptEntryType(value.type)) {
    return null;
  }
  return {
    seq: value.seq,
    ts: value.ts,
    type: value.type,
    data: value.data
  };
}

function conversationMissingError(id: string): PlanForgeError {
  return new PlanForgeError("E_CONVERSATION_NOT_FOUND", `Conversation ${id} was not found.`);
}

// A title is stored trimmed and must be 1..MAX_TITLE_LENGTH chars after trimming. An empty/whitespace
// title is rejected (the caller keeps its old title) rather than silently storing null/empty.
const MAX_TITLE_LENGTH = 200;

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) {
    throw new PlanForgeError(
      "E_INVALID_TITLE",
      `A title must be between 1 and ${MAX_TITLE_LENGTH} characters after trimming.`
    );
  }
  return trimmed;
}

function normalizedSeq(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 0 : value;
}

export function createConversationStore(input: CreateConversationStoreInput) {
  const root = input.root;
  const now = input.now ?? Date.now;
  const idFactory = input.idFactory ?? randomUUID;
  const validateTargetRepo = input.validateTargetRepo;
  const chains = new Map<string, Promise<void>>();
  const subscribers = new Map<string, Set<Subscriber>>();
  // Per-conversation tail seq, authoritative after the first append in this process. Every append is
  // one transcript entry (a codex_stream chunk each), so re-reading the whole transcript per append
  // is O(N^2); appends are chain-serialized, so after one full read the cached tail stays correct.
  // The cache assumes a single writer per conversation dir: PlanForge runs as one launchd process,
  // and multi-process access to a conversation dir was never supported. Any append failure drops the
  // entry (see append) so the next append re-runs the full read/repair path.
  const tailSeqs = new Map<string, number>();

  mkdirSync(root, { recursive: true });

  function conversationDir(id: string): string {
    return path.join(root, id);
  }

  function conversationPath(id: string): string {
    return path.join(conversationDir(id), "conversation.json");
  }

  function transcriptPath(id: string): string {
    return path.join(conversationDir(id), "transcript.jsonl");
  }

  async function writeConversation(conversation: Conversation): Promise<void> {
    // Atomic replace: the read paths (get/readTranscript/list) do not join the conversation chain, so
    // a plain truncate-then-write would let a concurrent reader observe a torn conversation.json and
    // treat the conversation as missing. Write-to-temp + rename keeps every read all-or-nothing.
    const target = conversationPath(conversation.id);
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(conversation)}\n`, "utf8");
    await renameFile(temp, target);
  }

  async function readConversationFile(id: string): Promise<Conversation | null> {
    let content: string;
    try {
      content = await readFile(conversationPath(id), "utf8");
    } catch (error) {
      // Only true absence maps to null. Any other read failure (permissions, I/O) must surface
      // rather than be mistaken for a missing conversation.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    let conversation: Conversation | null = null;
    try {
      conversation = parseConversation(JSON.parse(content) as JsonValue);
    } catch {
      // Unparseable JSON falls through to the corrupt error below.
    }
    if (!conversation) {
      // Corrupt is NOT absent: nulling here would silently vanish the conversation (its transcript
      // is likely intact on disk) and turn every append into E_CONVERSATION_NOT_FOUND. Scream to
      // stderr and surface a distinct error so the operator can repair/restore conversation.json.
      console.error(
        `PlanForge: corrupt conversation.json at ${conversationPath(id)}; refusing to treat conversation ${id} as absent.`
      );
      throw new PlanForgeError(
        "E_CONVERSATION_CORRUPT",
        `Conversation ${id} metadata is corrupt (unreadable conversation.json). The transcript may still be intact; repair or restore conversation.json.`
      );
    }
    return conversation;
  }

  async function requireConversation(id: string): Promise<Conversation> {
    const conversation = await readConversationFile(id);
    if (!conversation) {
      throw conversationMissingError(id);
    }
    return conversation;
  }

  function withConversationChain<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(id) ?? Promise.resolve();
    const running = previous.then(task, task);
    const settled = running.then(
      () => undefined,
      () => undefined
    );
    chains.set(id, settled);
    settled.then(() => {
      if (chains.get(id) === settled) {
        chains.delete(id);
      }
    });
    return running;
  }

  async function readTranscriptEntries(id: string, opts: ReadTranscriptOptions = {}): Promise<TranscriptEntry[]> {
    const result = await readTranscriptFile(id, opts);
    return result.entries;
  }

  async function readTranscriptFile(id: string, opts: ReadTranscriptOptions = {}): Promise<TranscriptReadResult> {
    let content = "";
    try {
      content = await readFile(transcriptPath(id), "utf8");
    } catch {
      return { entries: [], needsTailRepair: false };
    }
    const rawLines = content.split("\n");
    const lastLineIndex = rawLines.reduce((last, line, index) => (line.length > 0 ? index : last), -1);
    const entries: TranscriptEntry[] = [];
    const afterSeq = normalizedSeq(opts.afterSeq);
    let needsTailRepair = lastLineIndex >= 0 && !content.endsWith("\n");

    for (const [index, line] of rawLines.entries()) {
      if (line.length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as JsonValue;
        const entry = parseTranscriptEntry(parsed);
        if (!entry) {
          throw new PlanForgeError("E_INVALID_TRANSCRIPT_ENTRY", `Invalid transcript entry in ${id}.`);
        }
        if (entry.seq > afterSeq) {
          entries.push(entry);
        }
      } catch (error) {
        if (index === lastLineIndex) {
          needsTailRepair = true;
          continue;
        }
        if (opts.quarantineCorrupt) {
          // Self-heal: skip just this corrupt mid-file line and keep replaying the rest, mirroring
          // the torn-tail skip above, so one bad entry does not throw on every reconnect.
          continue;
        }
        if (error instanceof PlanForgeError) {
          throw error;
        }
        throw new PlanForgeError("E_INVALID_TRANSCRIPT_ENTRY", `Invalid transcript entry in ${id}.`);
      }
    }
    return { entries, needsTailRepair };
  }

  async function repairTranscriptTail(id: string, entries: readonly TranscriptEntry[]): Promise<void> {
    const content = entries.length > 0 ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
    await writeFile(transcriptPath(id), content, "utf8");
  }

  function fanOut(id: string, entry: TranscriptEntry): void {
    for (const subscriber of subscribers.get(id) ?? []) {
      subscriber(entry);
    }
  }

  async function create(meta: CreateConversationMeta = {}): Promise<Conversation> {
    const createdAt = now();
    // Validate a chosen target against the allowlist BEFORE persisting, so a disallowed target is
    // rejected at creation (HTTP 400) rather than failing later at run start. The gate is optional
    // (tests may omit it); an absent gate stores the target as-is.
    const targetRepo = meta.targetRepo ?? null;
    if (targetRepo && validateTargetRepo) {
      validateTargetRepo(targetRepo);
    }
    const conversation: Conversation = {
      id: idFactory(),
      createdAt,
      updatedAt: createdAt,
      title: meta.title ?? null,
      lastSeq: 0,
      sessionStarted: false,
      archived: false,
      targetRepo,
      architectModel: meta.architectModel ?? null,
      architectEffort: meta.architectEffort ?? null,
      builderModel: meta.builderModel ?? null,
      builderEffort: meta.builderEffort ?? null
    };
    await mkdir(conversationDir(conversation.id), { recursive: false });
    await writeConversation(conversation);
    await writeFile(transcriptPath(conversation.id), "", "utf8");
    return conversation;
  }

  async function get(id: string): Promise<Conversation | null> {
    return readConversationFile(id);
  }

  async function list(options: { readonly includeArchived?: boolean } = {}): Promise<Conversation[]> {
    const conversations: Conversation[] = [];
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return conversations;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      try {
        const conversation = await readConversationFile(entry.name);
        if (conversation) {
          conversations.push(conversation);
        }
      } catch (error) {
        // Recovery path: one corrupt conversation.json must not take down the whole list.
        // readConversationFile already screamed to stderr; skip it here while direct get/append
        // on the corrupt id keep surfacing E_CONVERSATION_CORRUPT.
        if (!(error instanceof PlanForgeError) || error.code !== "E_CONVERSATION_CORRUPT") {
          throw error;
        }
      }
    }
    const filtered = options.includeArchived ? conversations : conversations.filter((conversation) => !conversation.archived);
    filtered.sort((left, right) => right.updatedAt - left.updatedAt);
    return filtered;
  }

  async function append(id: string, type: TranscriptEntryType, data: JsonObject): Promise<TranscriptEntry> {
    return withConversationChain(id, async () => {
      try {
        const conversation = await requireConversation(id);
        let previousSeq = tailSeqs.get(id);
        if (previousSeq === undefined) {
          // First touch in this process: full recovery scan. Quarantine a corrupt mid-file line rather
          // than rejecting forever (subscribe self-heals the same way), repair a torn tail, and take
          // previousSeq from the surviving entries so the seq stays gap-free. Subsequent appends trust
          // the cache — the chain serializes them, so no other writer can move the tail underneath.
          const transcript = await readTranscriptFile(id, { quarantineCorrupt: true });
          if (transcript.needsTailRepair) {
            await repairTranscriptTail(id, transcript.entries);
          }
          previousSeq = transcript.entries.at(-1)?.seq ?? 0;
        }
        const ts = now();
        const entry: TranscriptEntry = { seq: previousSeq + 1, ts, type, data };
        await appendFile(transcriptPath(id), `${JSON.stringify(entry)}\n`, "utf8");
        tailSeqs.set(id, entry.seq);
        conversation.updatedAt = ts;
        conversation.lastSeq = entry.seq;
        await writeConversation(conversation);
        fanOut(id, entry);
        return entry;
      } catch (error) {
        // A failed append may have torn the tail (a partial appendFile flush on ENOSPC/EIO) while
        // the warm cache still points at the pre-failure seq. Invalidate it so the NEXT append
        // re-runs the full read + torn-tail repair instead of appending after bytes that never
        // fully landed (which would weld two entries onto one corrupt line).
        tailSeqs.delete(id);
        throw error;
      }
    });
  }

  async function markSessionStarted(id: string): Promise<void> {
    await withConversationChain(id, async () => {
      const conversation = await requireConversation(id);
      if (conversation.sessionStarted) {
        return;
      }
      conversation.sessionStarted = true;
      await writeConversation(conversation);
    });
  }

  async function rename(id: string, title: string): Promise<Conversation> {
    const normalized = normalizeTitle(title);
    return withConversationChain(id, async () => {
      const conversation = await requireConversation(id);
      conversation.title = normalized;
      conversation.updatedAt = now();
      await writeConversation(conversation);
      return conversation;
    });
  }

  // Re-point a conversation at a different allowlisted target, BEFORE its architect session starts.
  // Once a session has started the target is locked: a run resolved its target at start, and a build
  // may already own a worktree/branch on the old target (estate rule: one worktree per job), so a
  // late switch would be incoherent — reject it (mapped to HTTP 409) rather than silently re-point.
  async function updateTarget(id: string, targetRepo: string): Promise<Conversation> {
    return withConversationChain(id, async () => {
      const conversation = await requireConversation(id);
      if (conversation.sessionStarted) {
        throw new PlanForgeError(
          "E_SESSION_ALREADY_STARTED",
          `Conversation ${id} has already started; its build target is locked. Start a new conversation to build elsewhere.`
        );
      }
      if (validateTargetRepo) {
        validateTargetRepo(targetRepo);
      }
      conversation.targetRepo = targetRepo;
      conversation.updatedAt = now();
      await writeConversation(conversation);
      return conversation;
    });
  }

  async function updateRunControls(id: string, controls: UpdateConversationRunControls): Promise<Conversation> {
    return withConversationChain(id, async () => {
      const conversation = await requireConversation(id);
      if (conversation.sessionStarted) {
        throw new PlanForgeError(
          "E_SESSION_ALREADY_STARTED",
          `Conversation ${id} has already started; its model, effort, and build target controls are locked. Start a new conversation to change them.`
        );
      }
      if (controls.targetRepo !== undefined && validateTargetRepo) {
        validateTargetRepo(controls.targetRepo);
      }
      if (controls.targetRepo !== undefined) {
        conversation.targetRepo = controls.targetRepo;
      }
      if (controls.architectModel !== undefined) {
        conversation.architectModel = controls.architectModel;
      }
      if (controls.architectEffort !== undefined) {
        conversation.architectEffort = controls.architectEffort;
      }
      if (controls.builderModel !== undefined) {
        conversation.builderModel = controls.builderModel;
      }
      if (controls.builderEffort !== undefined) {
        conversation.builderEffort = controls.builderEffort;
      }
      conversation.updatedAt = now();
      await writeConversation(conversation);
      return conversation;
    });
  }

  async function setArchived(id: string, archived: boolean): Promise<Conversation> {
    return withConversationChain(id, async () => {
      const conversation = await requireConversation(id);
      if (conversation.archived === archived) {
        return conversation;
      }
      conversation.archived = archived;
      conversation.updatedAt = now();
      await writeConversation(conversation);
      return conversation;
    });
  }

  async function readTranscript(id: string, opts: ReadTranscriptOptions = {}): Promise<TranscriptEntry[]> {
    await requireConversation(id);
    return readTranscriptEntries(id, opts);
  }

  async function subscribe(id: string, client: SseClient, opts: SubscribeOptions = {}): Promise<() => void> {
    const lastEventId = normalizedSeq(opts.lastEventId);
    // Seqs are strictly monotonic, so exactly-once delivery needs only a high-watermark of the last
    // seq sent — not a Set that accrues every seq for the life of the SSE subscriber.
    let deliveredThrough = lastEventId;
    let active = true;
    const subscriber: Subscriber = (entry) => {
      if (!active || entry.seq <= deliveredThrough) {
        return;
      }
      deliveredThrough = entry.seq;
      client.send(entry.type, entry, entry.seq);
    };

    await withConversationChain(id, async () => {
      await requireConversation(id);
      let listeners = subscribers.get(id);
      if (!listeners) {
        listeners = new Set();
        subscribers.set(id, listeners);
      }
      listeners.add(subscriber);
      try {
        // Quarantine a corrupt mid-file line rather than throwing on every reconnect: a single bad
        // entry self-heals (is skipped) so the stream stays usable instead of permanently dead.
        const replay = await readTranscriptEntries(id, { afterSeq: lastEventId, quarantineCorrupt: true });
        for (const entry of replay) {
          if (entry.seq > deliveredThrough) {
            deliveredThrough = entry.seq;
            client.send(entry.type, entry, entry.seq);
          }
        }
      } catch (error) {
        listeners.delete(subscriber);
        throw error;
      }
    });

    return () => {
      active = false;
      subscribers.get(id)?.delete(subscriber);
      client.cleanup();
    };
  }

  return {
    create,
    get,
    list,
    append,
    markSessionStarted,
    rename,
    updateTarget,
    updateRunControls,
    setArchived,
    readTranscript,
    subscribe
  };
}
