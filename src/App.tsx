import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { z } from "zod";
import "./styles.css";
import { APP_NAME } from "./index";
import type { Conversation, TranscriptEntry } from "./conversation-store";
import { ARCHITECT_EFFORTS, BUILDER_EFFORTS, type ArchitectEffort, type BuilderEffort } from "./effort";
import { isJsonObject, type JsonObject, type JsonValue } from "./shared/json";
import { isTestDelta } from "./shared/test-delta-shape";
import {
  actorOf,
  booleanField,
  jsonField,
  jsonLabel,
  liveBuildStatus,
  mergeTranscriptEntry,
  numberField,
  parseTranscriptEntryMessage,
  planGateStatus,
  stringField,
  transcriptEntryTypes,
  type LiveBuildStatus,
  type PlanGateStatus,
  type TranscriptActor
} from "./ui/chat-model";
import { Markdown } from "./ui/markdown";
import { ArchiveIcon, ChevronIcon, CloseIcon, CollapseIcon, MenuIcon, PencilIcon, RestoreIcon, SplitIcon, TimelineIcon, TrashIcon } from "./ui/icons";
import { continueListOnEnter } from "./ui/list-continue";

const MAX_MESSAGE_CHARS = 20_000;
const MAX_PLAN_OUTPUT_HEIGHT = 320;

// Resizable sidebar bounds (px). The default matches the CSS --sidebar-width; the operator can drag
// the handle between MIN and MAX. Persisted to localStorage under SIDEBAR_WIDTH_KEY.
const DEFAULT_SIDEBAR_WIDTH = 336;
const MIN_SIDEBAR_WIDTH = 260;
const MAX_SIDEBAR_WIDTH = 560;
const SIDEBAR_WIDTH_KEY = "planforge.sidebarWidth";

const conversationSchema = z.object({
  id: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
  title: z.string().nullable(),
  lastSeq: z.number(),
  sessionStarted: z.boolean(),
  archived: z.boolean().optional().default(false),
  targetRepo: z.string().nullable().optional().default(null),
  architectModel: z.string().nullable().optional().default(null),
  architectEffort: z.enum(ARCHITECT_EFFORTS).nullable().optional().default(null),
  builderModel: z.string().nullable().optional().default(null),
  builderEffort: z.enum(BUILDER_EFFORTS).nullable().optional().default(null)
});

const conversationsResponseSchema = z.object({
  conversations: z.array(conversationSchema)
});

const createConversationResponseSchema = z.object({
  id: z.string().min(1)
});

const okResponseSchema = z.object({
  ok: z.boolean()
});

const conversationMutationResponseSchema = conversationSchema;

// PATCH /api/conversations/:id replies with { ok, conversation }; retarget reads the conversation back
// so the header reflects the server-authoritative target after a re-point.
const conversationPatchResponseSchema = z.object({
  ok: z.boolean(),
  conversation: conversationSchema
});

const allowedTargetSchema = z.object({
  path: z.string().min(1),
  label: z.string().min(1)
});

const configResponseSchema = z.object({
  targetRepo: z.string().nullable(),
  allowedTargets: z.array(allowedTargetSchema),
  architectModels: z.array(z.string().min(1)).optional().default(["default", "opus", "sonnet", "haiku"]),
  builderModels: z.array(z.string().min(1)).optional().default(["default"]),
  architectEfforts: z.array(z.enum(ARCHITECT_EFFORTS)).optional().default(["low", "medium", "high", "xhigh", "max"]),
  builderEfforts: z.array(z.enum(BUILDER_EFFORTS)).optional().default(["none", "minimal", "low", "medium", "high", "xhigh"])
});

type AllowedTarget = z.infer<typeof allowedTargetSchema>;
type TargetSelection = { readonly path: string; readonly label: string };
type RunControlField = "architectModel" | "architectEffort" | "builderModel" | "builderEffort";
type RunControlSelections = Record<RunControlField, string>;

type ViewMode = "timeline" | "split";
type TranscriptRenderItem =
  | {
      readonly kind: "entry";
      readonly key: string;
      readonly entry: TranscriptEntry;
      readonly actor: TranscriptActor;
    }
  | {
      readonly kind: "build_output";
      readonly key: string;
      readonly entries: readonly TranscriptEntry[];
      readonly actor: "builder";
    };

type VerifyRecord = {
  readonly name: string;
  readonly status: string;
  readonly exitCode?: number;
  readonly output?: string;
};

type PlanDecision = {
  readonly verdict: "approved" | "changes_requested";
  readonly feedback?: string;
};

// The collapsible entry types: the verbose builder/architect tooling that benefits from a collapse-
// all toggle. Prose (user/architect messages), the plan gate, and verdict markers stay open.
const COLLAPSIBLE_TYPES: ReadonlySet<TranscriptEntry["type"]> = new Set([
  "tool_use",
  "tool_result",
  "build_output",
  "test_delta",
  "verify_result",
  "change_diff"
]);

const SERVER_DEFAULT_VALUE = "__server_default__";

// API error responses carry the server's crafted { code, message } body (http-server
// errorResponse). Keep both on the thrown error so notices explain the failure (e.g. the
// E_SESSION_ALREADY_STARTED target-lock message) instead of a bare statusText like "Conflict".
class ApiRequestError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
  }
}

async function fetchJson<T>(input: RequestInfo | URL, init: RequestInit | undefined, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json()) as JsonValue;
  if (!response.ok) {
    const message = isJsonObject(body) ? stringField(body, "message") : "";
    const code = isJsonObject(body) ? stringField(body, "code") : "";
    throw new ApiRequestError(
      message || response.statusText || `Request failed with status ${response.status}.`,
      code || null
    );
  }
  return schema.parse(body);
}

function newestFirst(conversations: readonly Conversation[]): readonly Conversation[] {
  return [...conversations].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
}

function conversationTitle(conversation: Conversation | undefined): string {
  return conversation?.title?.trim() || "Untitled conversation";
}

function conversationSubtitle(conversation: Conversation): string {
  return conversation.lastSeq > 0 ? `${conversation.lastSeq} entries` : "No transcript yet";
}

function conversationFromCreatedId(id: string): Conversation {
  const now = Date.now();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    title: null,
    lastSeq: 0,
    sessionStarted: false,
    archived: false,
    targetRepo: null,
    architectModel: null,
    architectEffort: null,
    builderModel: null,
    builderEffort: null
  };
}

function messageFromError(error: Error): string {
  const message = error.message.trim() || "Request failed.";
  return error instanceof ApiRequestError && error.code ? `${message} (${error.code})` : message;
}

// Reduce an absolute repo path to a short "<bucket>/<project>" label for the header chip. Falls back
// to the basename if the path is not under projects/<bucket>/<project>.
function targetShortLabel(targetRepo: string): string {
  const parts = targetRepo.replace(/\/+$/, "").split("/");
  const project = parts.at(-1);
  const bucket = parts.at(-2);
  return bucket && project ? `${bucket}/${project}` : (project ?? targetRepo);
}

function selectionToNullable(value: string): string | null {
  return value === SERVER_DEFAULT_VALUE ? null : value;
}

function selectionToArchitectEffort(value: string): ArchitectEffort | null {
  return value !== SERVER_DEFAULT_VALUE && ARCHITECT_EFFORTS.includes(value as ArchitectEffort)
    ? (value as ArchitectEffort)
    : null;
}

function selectionToBuilderEffort(value: string): BuilderEffort | null {
  return value !== SERVER_DEFAULT_VALUE && BUILDER_EFFORTS.includes(value as BuilderEffort)
    ? (value as BuilderEffort)
    : null;
}

function conversationSelection(value: string | null | undefined): string {
  return value ?? SERVER_DEFAULT_VALUE;
}

function createConversationBody(
  targetRepo: string | null,
  controls: RunControlSelections
): Partial<Record<RunControlField | "targetRepo", string>> {
  return {
    ...(targetRepo ? { targetRepo } : {}),
    ...(controls.architectModel !== SERVER_DEFAULT_VALUE ? { architectModel: controls.architectModel } : {}),
    ...(controls.architectEffort !== SERVER_DEFAULT_VALUE ? { architectEffort: controls.architectEffort } : {}),
    ...(controls.builderModel !== SERVER_DEFAULT_VALUE ? { builderModel: controls.builderModel } : {}),
    ...(controls.builderEffort !== SERVER_DEFAULT_VALUE ? { builderEffort: controls.builderEffort } : {})
  };
}

function parseStreamErrorMessage(text: string): string | null {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return "The conversation stream failed.";
  }
  if (isJsonObject(parsed)) {
    const message = stringField(parsed, "message");
    if (message) {
      return message;
    }
  }
  return "The conversation stream failed.";
}

function verifierRecords(data: JsonObject): readonly VerifyRecord[] {
  const value = jsonField(data, "verifierResults");
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((record): readonly VerifyRecord[] => {
    if (!isJsonObject(record)) {
      return [];
    }
    const name = stringField(record, "name");
    const status = stringField(record, "status");
    if (!name || !status) {
      return [];
    }
    const exitCode = numberField(record, "exitCode");
    const output = stringField(record, "output");
    return [
      {
        name,
        status,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(output ? { output } : {})
      }
    ];
  });
}

// ANSI escape sequences (color codes etc.) bleed into the Codex stream and render as raw escape
// gibberish. Strip them so the build output is human-readable plain text.
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function buildRenderItems(entries: readonly TranscriptEntry[]): readonly TranscriptRenderItem[] {
  const items: TranscriptRenderItem[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    if (!entry) {
      index += 1;
      continue;
    }
    if (entry.type === "build_output") {
      const group: TranscriptEntry[] = [];
      let cursor = index;
      while (entries[cursor]?.type === "build_output") {
        const buildEntry = entries[cursor];
        if (buildEntry) {
          group.push(buildEntry);
        }
        cursor += 1;
      }
      items.push({
        kind: "build_output",
        key: `build-${group[0]?.seq ?? entry.seq}`,
        entries: group,
        actor: "builder"
      });
      index = cursor;
      continue;
    }
    if (entry.type === "change_diff" && hasFollowingCycleComplete(entries, entry.seq)) {
      index += 1;
      continue;
    }
    items.push({
      kind: "entry",
      key: String(entry.seq),
      entry,
      actor: actorOf(entry.type)
    });
    index += 1;
  }
  return items;
}

function hasFollowingCycleComplete(entries: readonly TranscriptEntry[], seq: number): boolean {
  for (const entry of entries) {
    if (entry.seq <= seq) {
      continue;
    }
    if (entry.type === "cycle_complete") {
      return true;
    }
    if (entry.type === "verify_result") {
      return false;
    }
  }
  return false;
}

function transcriptItemClassName(item: TranscriptRenderItem): string {
  return item.kind === "build_output" ? "transcript-item transcript-item-static" : "transcript-item";
}

function useNewItemKeys(items: readonly TranscriptRenderItem[], resetKey: string): ReadonlySet<string> {
  const previousKeys = useRef<ReadonlySet<string> | null>(null);
  const previousResetKey = useRef(resetKey);
  if (previousResetKey.current !== resetKey) {
    previousResetKey.current = resetKey;
    previousKeys.current = null;
  }
  const currentKeys = useMemo(() => new Set(items.map((item) => item.key)), [items]);
  const newKeys = useMemo(() => {
    if (!previousKeys.current) {
      return new Set<string>();
    }
    return new Set(items.filter((item) => !previousKeys.current?.has(item.key)).map((item) => item.key));
  }, [items]);
  useEffect(() => {
    previousKeys.current = currentKeys;
  }, [currentKeys]);
  return newKeys;
}

function transcriptItemClassNameFor(item: TranscriptRenderItem, newItemKeys: ReadonlySet<string>): string {
  return newItemKeys.has(item.key) ? `${transcriptItemClassName(item)} is-new-arrival` : transcriptItemClassName(item);
}

export function App() {
  const [conversations, setConversations] = useState<readonly Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [entriesByConversation, setEntriesByConversation] = useState<Record<string, readonly TranscriptEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("timeline");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  // Collapse-all toggle: when true, every collapsible entry (tool_use/result, build_output,
  // verify_result) renders closed; the operator can still open any one individually. Prose stays open.
  const [collapseAll, setCollapseAll] = useState(false);
  const [archivedConversations, setArchivedConversations] = useState<readonly Conversation[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Build-target picker: the server default + the allowlisted choices, fetched once. A new
  // conversation builds in `selectedTarget` (defaults to the server default). Each existing
  // conversation shows its own targetRepo (or the default) in the header.
  const [defaultTarget, setDefaultTarget] = useState<TargetSelection | null>(null);
  const [allowedTargets, setAllowedTargets] = useState<readonly TargetSelection[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<TargetSelection | null>(null);
  const [architectModels, setArchitectModels] = useState<readonly string[]>(["default", "opus", "sonnet", "haiku"]);
  const [builderModels, setBuilderModels] = useState<readonly string[]>(["default"]);
  const [architectEfforts, setArchitectEfforts] = useState<readonly string[]>(["low", "medium", "high", "xhigh", "max"]);
  const [builderEfforts, setBuilderEfforts] = useState<readonly string[]>([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh"
  ]);
  const [newRunControls, setNewRunControls] = useState<RunControlSelections>({
    architectModel: SERVER_DEFAULT_VALUE,
    architectEffort: SERVER_DEFAULT_VALUE,
    builderModel: SERVER_DEFAULT_VALUE,
    builderEffort: SERVER_DEFAULT_VALUE
  });
  // Operator-resizable sidebar. The width is a CSS var the grid reads; persisted to localStorage so
  // it survives reloads. Clamped to a sane range on the desktop layout (the mobile drawer ignores it).
  const [sidebarWidth, setSidebarWidth] = useState<number>(DEFAULT_SIDEBAR_WIDTH);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchJson("/api/conversations", undefined, conversationsResponseSchema);
        if (cancelled) {
          return;
        }
        const sorted = newestFirst(response.conversations);
        setConversations(sorted);
        setActiveConversationId((current) => current ?? sorted[0]?.id ?? null);
      } catch (error) {
        if (!cancelled && error instanceof Error) {
          setNotice(messageFromError(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the server build-target config once: the default target + the allowlisted choices for the
  // New-conversation picker. Best-effort; a failure leaves the picker empty (the default is still
  // sent on create when no target is chosen).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchJson("/api/config", undefined, configResponseSchema);
        if (cancelled) {
          return;
        }
        const targets: readonly TargetSelection[] = response.allowedTargets;
        setAllowedTargets(targets);
        const match = targets.find((target) => target.path === response.targetRepo) ?? null;
        const def = match ?? (response.targetRepo ? { path: response.targetRepo, label: targetShortLabel(response.targetRepo) } : null);
        setDefaultTarget(def);
        setSelectedTarget(def);
        setArchitectModels(response.architectModels);
        setBuilderModels(response.builderModels);
        setArchitectEfforts(response.architectEfforts);
        setBuilderEfforts(response.builderEfforts);
      } catch {
        // Non-fatal: the picker stays empty and create sends no targetRepo (server default applies).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore the operator's last sidebar width (clamped), then keep the CSS var in sync with state.
  useEffect(() => {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(SIDEBAR_WIDTH_KEY) : null;
    if (stored) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed) && parsed >= MIN_SIDEBAR_WIDTH && parsed <= MAX_SIDEBAR_WIDTH) {
        setSidebarWidth(parsed);
      }
    }
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  // Mirrors entriesByConversation so the stream effect below can read the already-loaded entries at
  // subscribe time without re-running (and reopening the stream) on every incoming entry.
  const entriesByConversationRef = useRef(entriesByConversation);
  useEffect(() => {
    entriesByConversationRef.current = entriesByConversation;
  }, [entriesByConversation]);

  useEffect(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (!activeConversationId) {
      return undefined;
    }

    // Resume from the last entry already loaded for this conversation instead of replaying the whole
    // transcript from seq 0 on every switch. EventSource cannot set Last-Event-ID on a fresh
    // connection, so the resume point travels as the afterSeq query param (the server prefers the
    // browser's Last-Event-ID header on auto-reconnect, which is at least as current).
    const lastKnownSeq = entriesByConversationRef.current[activeConversationId]?.at(-1)?.seq ?? 0;
    const source = new EventSource(
      lastKnownSeq > 0
        ? `/api/conversations/${activeConversationId}/events?afterSeq=${lastKnownSeq}`
        : `/api/conversations/${activeConversationId}/events`
    );
    eventSourceRef.current = source;
    // A terminal `stream_error` frame means the server gave up on this stream (e.g. an unrecoverable
    // subscribe failure). Surface the message and close the source so the browser does NOT auto-
    // reconnect into the same dead stream. This listener is separate from the transcript-entry
    // listeners because `stream_error` is not a transcript entry type.
    source.addEventListener("stream_error", (messageEvent) => {
      const message = parseStreamErrorMessage((messageEvent as MessageEvent<string>).data);
      if (message) {
        setNotice(message);
      }
      source.close();
      if (eventSourceRef.current === source) {
        eventSourceRef.current = null;
      }
    });
    for (const type of transcriptEntryTypes) {
      source.addEventListener(type, (messageEvent) => {
        const entry = parseTranscriptEntryMessage((messageEvent as MessageEvent<string>).data);
        if (!entry) {
          return;
        }
        setEntriesByConversation((previous) => ({
          ...previous,
          [activeConversationId]: mergeTranscriptEntry(previous[activeConversationId] ?? [], entry)
        }));
        setConversations((previous) => {
          const index = previous.findIndex((conversation) => conversation.id === activeConversationId);
          const existing = index === -1 ? undefined : previous[index];
          if (!existing) {
            return previous;
          }
          const updatedAt = Math.max(existing.updatedAt, entry.ts);
          const lastSeq = Math.max(existing.lastSeq, entry.seq);
          // Replayed entries move nothing; keep the array identity so React skips the re-render.
          if (updatedAt === existing.updatedAt && lastSeq === existing.lastSeq) {
            return previous;
          }
          const updated = { ...existing, updatedAt, lastSeq };
          // Common live-stream case: the active conversation is already newest, so bumping its
          // updatedAt keeps the order — replace the row without re-sorting the whole list.
          if (index === 0) {
            return [updated, ...previous.slice(1)];
          }
          return newestFirst(previous.map((conversation) => (conversation.id === activeConversationId ? updated : conversation)));
        });
      });
    }
    return () => {
      source.close();
      if (eventSourceRef.current === source) {
        eventSourceRef.current = null;
      }
    };
  }, [activeConversationId]);

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const entries = activeConversationId ? entriesByConversation[activeConversationId] ?? [] : [];
  const sendDisabled = sending || message.trim().length === 0 || message.length > MAX_MESSAGE_CHARS;

  async function createConversation(): Promise<string | null> {
    setCreating(true);
    try {
      const targetOverride = selectedTarget && selectedTarget.path !== defaultTarget?.path ? selectedTarget.path : null;
      const body = createConversationBody(targetOverride, newRunControls);
      const response = await fetchJson(
        "/api/conversations",
        {
          method: "POST",
          // Only send a body when overriding a server default; otherwise omit it so the create is a
          // bare POST and byte-identical to the pre-controls path.
          ...(Object.keys(body).length > 0
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
            : {})
        },
        createConversationResponseSchema
      );
      const created = conversationFromCreatedId(response.id);
      // Carry the chosen target into the local view immediately so the header chip is correct before
      // the next list refresh.
      setConversations((previous) =>
        newestFirst([
          {
            ...created,
            targetRepo: targetOverride,
            architectModel: selectionToNullable(newRunControls.architectModel),
            architectEffort: selectionToArchitectEffort(newRunControls.architectEffort),
            builderModel: selectionToNullable(newRunControls.builderModel),
            builderEffort: selectionToBuilderEffort(newRunControls.builderEffort)
          },
          ...previous
        ])
      );
      setActiveConversationId(created.id);
      setNotice(null);
      return created.id;
    } catch (error) {
      if (error instanceof Error) {
        setNotice(messageFromError(error));
      }
      return null;
    } finally {
      setCreating(false);
    }
  }

  async function sendMessage() {
    if (sendDisabled) {
      return;
    }
    const text = message.trim();
    setSending(true);
    try {
      const id = activeConversationId ?? (await createConversation());
      if (!id) {
        return;
      }
      await fetchJson(
        `/api/conversations/${id}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text })
        },
        okResponseSchema
      );
      setMessage("");
      setNotice(null);
    } catch (error) {
      if (error instanceof Error) {
        setNotice(messageFromError(error));
      }
    } finally {
      setSending(false);
    }
  }

  async function approvePlan(decision: PlanDecision): Promise<void> {
    if (!activeConversationId) {
      return;
    }
    try {
      await fetchJson(
        `/api/conversations/${activeConversationId}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            verdict: decision.verdict,
            ...(decision.feedback ? { feedback: decision.feedback } : {})
          })
        },
        okResponseSchema
      );
      setNotice(null);
    } catch (error) {
      if (error instanceof Error) {
        setNotice(messageFromError(error));
      }
    }
  }

  // Rename: optimistic local update, then PATCH. On failure, surface a notice and leave the row's
  // server-authoritative title untouched (the next list refresh reconciles).
  async function renameConversation(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      return;
    }
    const apply = (list: readonly Conversation[]) =>
      list.map((conversation) =>
        conversation.id === id ? { ...conversation, title: trimmed, updatedAt: Date.now() } : conversation
      );
    setConversations((previous) => newestFirst(apply(previous)));
    setArchivedConversations((previous) => apply(previous));
    try {
      await fetchJson(
        `/api/conversations/${id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: trimmed })
        },
        conversationMutationResponseSchema
      );
      setNotice(null);
    } catch (error) {
      if (error instanceof Error) {
        setNotice(messageFromError(error));
      }
    }
  }

  // Re-point an existing (not-yet-started) conversation at a different allowlisted target. Optimistic
  // local update, then PATCH; on success reconcile from the server-authoritative conversation, on
  // failure (e.g. the conversation already started → 409) surface the message. Distinct from the
  // sidebar picker, which only arms the target for NEW conversations.
  async function retargetConversation(id: string, targetRepo: string): Promise<void> {
    setConversations((previous) =>
      newestFirst(
        previous.map((conversation) =>
          conversation.id === id ? { ...conversation, targetRepo, updatedAt: Date.now() } : conversation
        )
      )
    );
    try {
      const { conversation } = await fetchJson(
        `/api/conversations/${id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetRepo })
        },
        conversationPatchResponseSchema
      );
      setConversations((previous) =>
        newestFirst(previous.map((existing) => (existing.id === id ? { ...existing, ...conversation } : existing)))
      );
      setNotice(null);
    } catch (error) {
      if (error instanceof Error) {
        setNotice(messageFromError(error));
      }
      // Reconcile the optimistic change against server truth (the re-point may have been rejected).
      void refreshConversations();
    }
  }

  async function refreshConversations(): Promise<void> {
    try {
      const response = await fetchJson("/api/conversations", undefined, conversationsResponseSchema);
      setConversations(newestFirst(response.conversations));
    } catch {
      // Best-effort reconcile; a failed refresh leaves the optimistic state until the next event.
    }
  }

  async function loadArchived(): Promise<void> {
    try {
      const response = await fetchJson(
        "/api/conversations?includeArchived=true",
        undefined,
        conversationsResponseSchema
      );
      setArchivedConversations(newestFirst(response.conversations.filter((conversation) => conversation.archived)));
    } catch (error) {
      if (error instanceof Error) {
        setNotice(messageFromError(error));
      }
    }
  }

  // Archive (soft delete): remove from the live list, move into the archived list, and select the
  // next live conversation if the active one was archived.
  async function archiveConversation(id: string): Promise<void> {
    const removed = conversations.find((conversation) => conversation.id === id) ?? null;
    const remaining = conversations.filter((conversation) => conversation.id !== id);
    setConversations(remaining);
    if (removed) {
      setArchivedConversations((previous) => newestFirst([{ ...removed, archived: true }, ...previous]));
    }
    if (activeConversationId === id) {
      setActiveConversationId(remaining[0]?.id ?? null);
    }
    try {
      await fetchJson(`/api/conversations/${id}`, { method: "DELETE" }, okResponseSchema);
      setNotice(null);
    } catch (error) {
      if (error instanceof Error) {
        setNotice(messageFromError(error));
      }
      // Best-effort reconcile on failure.
      void loadArchived();
    }
  }

  async function restoreConversation(id: string): Promise<void> {
    const restored = archivedConversations.find((conversation) => conversation.id === id) ?? null;
    setArchivedConversations((previous) => previous.filter((conversation) => conversation.id !== id));
    if (restored) {
      setConversations((previous) => newestFirst([{ ...restored, archived: false }, ...previous]));
    }
    try {
      await fetchJson(`/api/conversations/${id}/restore`, { method: "POST" }, okResponseSchema);
      setNotice(null);
    } catch (error) {
      if (error instanceof Error) {
        setNotice(messageFromError(error));
      }
      void loadArchived();
    }
  }

  function selectConversation(id: string): void {
    setActiveConversationId(id);
    setSidebarOpen(false);
  }

  // Pointer-driven sidebar resize: capture the pointer so the drag keeps working outside the handle,
  // rAF-batched for smoothness, clamped to bounds. The latest width is tracked in a ref so the
  // pointerup handler persists the final value (not the stale closure width).
  const sidebarWidthRef = useRef(sidebarWidth);
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);
  function startSidebarResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidthRef.current;
    let frame = 0;
    const onMove = (moveEvent: PointerEvent) => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const next = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, startWidth + (moveEvent.clientX - startX)));
        setSidebarWidth(next);
        sidebarWidthRef.current = next;
      });
    };
    const finish = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current));
      } catch {
        // localStorage may be unavailable (private mode); the in-memory width still applies for the session.
      }
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  return (
    <main className="chat-shell" data-sidebar-open={sidebarOpen ? "true" : "false"}>
      <button
        type="button"
        className="sidebar-scrim"
        aria-label="Close conversations"
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => setSidebarOpen(false)}
      />
      <aside className="sidebar" data-testid="conversation-sidebar" aria-label="Conversations">
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">{APP_NAME}</p>
            <h1>Conversation loop</h1>
          </div>
          <button className="button button-quiet" type="button" onClick={() => void createConversation()} disabled={creating}>
            New
          </button>
        </div>
        <TargetPicker
          allowedTargets={allowedTargets}
          value={selectedTarget}
          defaultValue={defaultTarget}
          onChange={setSelectedTarget}
          label="New conversation target"
        />
        <RunControlSelectors
          value={newRunControls}
          architectModels={architectModels}
          architectEfforts={architectEfforts}
          builderModels={builderModels}
          builderEfforts={builderEfforts}
          onChange={(field, value) => setNewRunControls((previous) => ({ ...previous, [field]: value }))}
        />
        <ConversationList
          conversations={conversations}
          activeConversationId={activeConversationId}
          loading={loading}
          onSelect={selectConversation}
          onRename={renameConversation}
          onArchive={archiveConversation}
        />
        <ArchivedConversations
          open={showArchived}
          onToggle={(next) => {
            setShowArchived(next);
            if (next) {
              void loadArchived();
            }
          }}
          conversations={archivedConversations}
          onSelect={selectConversation}
          onRestore={restoreConversation}
        />
      </aside>
      <button
        type="button"
        className="sidebar-resizer"
        aria-label="Resize conversation sidebar"
        aria-valuenow={sidebarWidth}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        role="separator"
        onPointerDown={startSidebarResize}
      />
      <section className="chat-pane" aria-label="PlanForge chat pane">
        <header className="chat-header">
          <button
            type="button"
            className="menu-toggle"
            aria-label="Open conversations"
            onClick={() => setSidebarOpen(true)}
          >
            <MenuIcon />
          </button>
          <ConversationTitle
            conversation={activeConversation}
            onRename={(title) => activeConversationId && void renameConversation(activeConversationId, title)}
          />
          <TargetControl
            conversation={activeConversation}
            defaultTarget={defaultTarget}
            allowedTargets={allowedTargets}
            onRetarget={retargetConversation}
          />
          {activeConversation?.sessionStarted ? (
            <RunControlSummary
              value={{
                architectModel: conversationSelection(activeConversation.architectModel),
                architectEffort: conversationSelection(activeConversation.architectEffort),
                builderModel: conversationSelection(activeConversation.builderModel),
                builderEffort: conversationSelection(activeConversation.builderEffort)
              }}
              architectModels={architectModels}
              architectEfforts={architectEfforts}
              builderModels={builderModels}
              builderEfforts={builderEfforts}
            />
          ) : null}
          {activeConversationId ? (
            <div className="chat-header-actions">
              <CollapseToggle value={collapseAll} onChange={setCollapseAll} />
              <ViewToggle value={viewMode} onChange={setViewMode} />
            </div>
          ) : null}
        </header>
        <div className="transcript-scroll">
          {notice ? (
            <div className="inline-error" role="status">
              {notice}
            </div>
          ) : null}
          {!activeConversationId ? (
            <div className="empty-transcript">
              <h3>Create a conversation to begin.</h3>
              <p>Start with New, then send the first objective message.</p>
            </div>
          ) : (
            <Transcript
              conversationId={activeConversationId}
              entries={entries}
              mode={viewMode}
              collapseAll={collapseAll}
              onApprove={approvePlan}
            />
          )}
        </div>
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <label className="composer-field">
            <span className="sr-only">Message</span>
            <textarea
              aria-label="Message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                // Rich list continuation: Enter (or Shift+Enter) at the end of a `1. ` / `- ` item
                // inserts the next marker on the new line; Enter on an empty item exits the list.
                // Cmd/Ctrl+Enter is left for a future "send" shortcut, so it is not intercepted here.
                if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) {
                  return;
                }
                const textarea = event.currentTarget;
                const result = continueListOnEnter(message, textarea.selectionStart, textarea.selectionEnd);
                if (!result) {
                  return;
                }
                event.preventDefault();
                setMessage(result.value);
                // Restore the caret after React commits the new value.
                window.requestAnimationFrame(() => {
                  textarea.selectionStart = result.selectionStart;
                  textarea.selectionEnd = result.selectionEnd;
                });
              }}
              placeholder={activeConversationId ? "Tell the architect what to do next" : "Message the architect to start..."}
              rows={3}
            />
          </label>
          <div className="composer-actions">
            <span className={message.length > MAX_MESSAGE_CHARS ? "char-count is-over" : "char-count"}>
              {message.length}/{MAX_MESSAGE_CHARS}
            </span>
            <button className="button button-send" type="submit" disabled={sendDisabled}>
              Send
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function ConversationTitle(input: {
  readonly conversation: Conversation | undefined;
  readonly onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const title = conversationTitle(input.conversation);

  function commit(): void {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed.length > 0 && trimmed !== title) {
      input.onRename(trimmed);
    }
  }

  if (editing) {
    return (
      <label className="title-editor">
        <span className="sr-only">Conversation title</span>
        <input
          aria-label="Conversation title"
          defaultValue={title}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
        />
      </label>
    );
  }

  return (
    <div className="title-display">
      <p className="eyebrow">conversation</p>
      <button
        type="button"
        className="title-button"
        aria-label={`Rename conversation ${title}`}
        title="Rename conversation"
        onClick={() => setEditing(true)}
      >
        <h2>{title}</h2>
        <PencilIcon className="title-edit-glyph" />
      </button>
    </div>
  );
}

function ConversationList(input: {
  readonly conversations: readonly Conversation[];
  readonly activeConversationId: string | null;
  readonly loading: boolean;
  readonly onSelect: (id: string) => void;
  readonly onRename: (id: string, title: string) => void;
  readonly onArchive: (id: string) => void;
}) {
  if (input.loading) {
    return (
      <div className="conversation-list" aria-label="Loading conversations">
        <div className="conversation-skeleton" />
        <div className="conversation-skeleton" />
        <div className="conversation-skeleton" />
      </div>
    );
  }
  if (input.conversations.length === 0) {
    return (
      <div className="sidebar-empty">
        <strong>No conversations yet.</strong>
        <span>Create one and send the first objective.</span>
      </div>
    );
  }
  return (
    <div className="conversation-list">
      {input.conversations.map((conversation) => (
        <ConversationRow
          key={conversation.id}
          conversation={conversation}
          active={conversation.id === input.activeConversationId}
          onSelect={() => input.onSelect(conversation.id)}
          onRename={(title) => input.onRename(conversation.id, title)}
          onArchive={() => input.onArchive(conversation.id)}
        />
      ))}
    </div>
  );
}

function ConversationRow(input: {
  readonly conversation: Conversation;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onRename: (title: string) => void;
  readonly onArchive: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const title = conversationTitle(input.conversation);

  function commit(): void {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed.length > 0 && trimmed !== title) {
      input.onRename(trimmed);
    }
  }

  if (editing) {
    return (
      <div className={input.active ? "conversation-row is-active is-editing" : "conversation-row is-editing"}>
        <input
          className="row-rename-input"
          aria-label={`Rename ${title}`}
          defaultValue={title}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={input.active ? "conversation-row is-active" : "conversation-row"}
      data-testid="conversation-row"
    >
      <button
        className="conversation-select"
        type="button"
        aria-label={title}
        onClick={input.onSelect}
      >
        <span>{title}</span>
        <small>{conversationSubtitle(input.conversation)}</small>
      </button>
      <div className="conversation-row-actions">
        <button
          type="button"
          className="icon-action"
          aria-label={`Rename ${title}`}
          onClick={() => setEditing(true)}
        >
          <PencilIcon />
        </button>
        <button
          type="button"
          className="icon-action"
          aria-label={`Archive ${title}`}
          onClick={input.onArchive}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

function ArchivedConversations(input: {
  readonly open: boolean;
  readonly onToggle: (next: boolean) => void;
  readonly conversations: readonly Conversation[];
  readonly onSelect: (id: string) => void;
  readonly onRestore: (id: string) => void;
}) {
  return (
    <div className="archived-section">
      <button
        type="button"
        className="archived-toggle"
        aria-expanded={input.open}
        onClick={() => input.onToggle(!input.open)}
      >
        <ChevronIcon className={input.open ? "chevron is-open" : "chevron"} />
        <ArchiveIcon />
        <span>Archived</span>
        <small>{input.conversations.length}</small>
      </button>
      {input.open ? (
        <div className="archived-list">
          {input.conversations.length === 0 ? (
            <p className="archived-empty">No archived conversations.</p>
          ) : (
            input.conversations.map((conversation) => {
              const title = conversationTitle(conversation);
              return (
                <div className="archived-row" key={conversation.id}>
                  <button
                    type="button"
                    className="conversation-select"
                    aria-label={`Open archived ${title}`}
                    onClick={() => input.onSelect(conversation.id)}
                  >
                    <span>{title}</span>
                    <small>{conversationSubtitle(conversation)}</small>
                  </button>
                  <button
                    type="button"
                    className="icon-action"
                    aria-label={`Restore ${title}`}
                    onClick={() => input.onRestore(conversation.id)}
                  >
                    <RestoreIcon />
                  </button>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function CollapseToggle(input: { readonly value: boolean; readonly onChange: (value: boolean) => void }) {
  const collapsed = input.value;
  return (
    <button
      type="button"
      className={collapsed ? "segmented-button is-active" : "segmented-button"}
      aria-pressed={collapsed}
      onClick={() => input.onChange(!collapsed)}
    >
      <CollapseIcon />
      <span>{collapsed ? "Expand all" : "Collapse all"}</span>
    </button>
  );
}

function ViewToggle(input: { readonly value: ViewMode; readonly onChange: (value: ViewMode) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Transcript view">
      <button
        type="button"
        className={input.value === "timeline" ? "segmented-button is-active" : "segmented-button"}
        aria-pressed={input.value === "timeline"}
        onClick={() => input.onChange("timeline")}
      >
        <TimelineIcon />
        <span>Timeline</span>
      </button>
      <button
        type="button"
        className={input.value === "split" ? "segmented-button is-active" : "segmented-button"}
        aria-pressed={input.value === "split"}
        onClick={() => input.onChange("split")}
      >
        <SplitIcon />
        <span>Split lanes</span>
      </button>
    </div>
  );
}

// A custom dropdown (not a native <select>) so the chosen label wraps instead of truncating and the
// open menu matches the page theme. Used in two places: the sidebar panel (variant "panel") to choose
// the target for NEW conversations, and the chat header (variant "chip") to re-point the ACTIVE
// conversation before it starts. Hidden when the server exposes no allowed targets and no default.
function TargetPicker(input: {
  readonly allowedTargets: readonly TargetSelection[];
  readonly value: TargetSelection | null;
  readonly defaultValue: TargetSelection | null;
  readonly onChange: (value: TargetSelection) => void;
  readonly label?: string;
  readonly variant?: "panel" | "chip";
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const variant = input.variant ?? "panel";
  const label = input.label ?? "Building in";

  // The full option list: the default first (if not already present), then the rest.
  const options: readonly TargetSelection[] = useMemo(() => {
    const defaultValue = input.defaultValue;
    if (!defaultValue) {
      return input.allowedTargets;
    }
    return input.allowedTargets.some((target) => target.path === defaultValue.path)
      ? input.allowedTargets
      : [defaultValue, ...input.allowedTargets];
  }, [input.allowedTargets, input.defaultValue]);

  const current = input.value ?? input.defaultValue ?? null;

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    function handlePointer(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  if (input.allowedTargets.length === 0 && !input.defaultValue) {
    return null;
  }

  return (
    <div className={variant === "chip" ? "target-picker is-chip" : "target-picker"} data-testid="target-picker" ref={containerRef}>
      <span className="target-picker-label">{label}</span>
      <button
        type="button"
        className={open ? "target-picker-button is-open" : "target-picker-button"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Build target"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="target-picker-value">{current ? targetLabel(current, input.defaultValue) : "Default target"}</span>
        <ChevronIcon className={open ? "target-picker-caret is-open" : "target-picker-caret"} />
      </button>
      {open ? (
        <ul className="target-picker-menu" role="listbox" aria-label="Build targets">
          {options.map((option) => {
            const isActive = current?.path === option.path;
            return (
              <li key={option.path} role="option" aria-selected={isActive}>
                <button
                  type="button"
                  className={isActive ? "target-picker-option is-active" : "target-picker-option"}
                  onClick={() => {
                    input.onChange(option);
                    setOpen(false);
                  }}
                >
                  <span>{targetLabel(option, input.defaultValue)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// The display label for a target, with a "(default)" marker when it matches the server default.
function targetLabel(target: TargetSelection, defaultValue: TargetSelection | null): string {
  return target.path === defaultValue?.path ? `${target.label} (default)` : target.label;
}

function modelOptionLabel(value: string): string {
  return value === "default" ? "CLI default" : value;
}

function controlOptions(values: readonly string[], formatter: (value: string) => string = (value) => value) {
  return [
    { value: SERVER_DEFAULT_VALUE, label: "Server default" },
    ...values.map((value) => ({ value, label: formatter(value) }))
  ];
}

function RunControlSelectors(input: {
  readonly value: RunControlSelections;
  readonly architectModels: readonly string[];
  readonly architectEfforts: readonly string[];
  readonly builderModels: readonly string[];
  readonly builderEfforts: readonly string[];
  readonly onChange?: (field: RunControlField, value: string) => void;
  readonly disabled?: boolean;
  readonly variant?: "panel" | "inline";
}) {
  const disabled = input.disabled === true;
  const className = input.variant === "inline" ? "run-controls is-inline" : "run-controls";
  const controls: readonly {
    readonly field: RunControlField;
    readonly label: string;
    readonly options: readonly { readonly value: string; readonly label: string }[];
  }[] = [
    { field: "architectModel", label: "Architect model", options: controlOptions(input.architectModels, modelOptionLabel) },
    { field: "architectEffort", label: "Architect effort", options: controlOptions(input.architectEfforts) },
    { field: "builderModel", label: "Builder model", options: controlOptions(input.builderModels, modelOptionLabel) },
    { field: "builderEffort", label: "Builder effort", options: controlOptions(input.builderEfforts) }
  ];

  return (
    <div className={className} data-testid="run-controls">
      {controls.map((control) => (
        <label className="run-control" key={control.field}>
          <span>{control.label}</span>
          <select
            value={input.value[control.field]}
            disabled={disabled}
            aria-label={control.label}
            onChange={(event) => input.onChange?.(control.field, event.currentTarget.value)}
          >
            {control.options.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

function resolvedRunControlLabel(value: string, options: readonly { readonly value: string; readonly label: string }[]): string {
  if (value === SERVER_DEFAULT_VALUE) {
    return "Server default";
  }
  return options.find((option) => option.value === value)?.label ?? value;
}

function runControlSummarySide(label: "architect" | "builder", model: string, effort: string): string | null {
  if (model === SERVER_DEFAULT_VALUE && effort === SERVER_DEFAULT_VALUE) {
    return null;
  }
  return `${label} ${model === SERVER_DEFAULT_VALUE ? "default" : model} · ${
    effort === SERVER_DEFAULT_VALUE ? "default" : effort
  }`;
}

function RunControlSummary(input: {
  readonly value: RunControlSelections;
  readonly architectModels: readonly string[];
  readonly architectEfforts: readonly string[];
  readonly builderModels: readonly string[];
  readonly builderEfforts: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const architectModelOptions = controlOptions(input.architectModels, modelOptionLabel);
  const architectEffortOptions = controlOptions(input.architectEfforts);
  const builderModelOptions = controlOptions(input.builderModels, modelOptionLabel);
  const builderEffortOptions = controlOptions(input.builderEfforts);
  const summary = [
    runControlSummarySide("architect", input.value.architectModel, input.value.architectEffort),
    runControlSummarySide("builder", input.value.builderModel, input.value.builderEffort)
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="run-summary" ref={rootRef}>
      <button
        type="button"
        className="run-summary-chip"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {summary || "server defaults"}
      </button>
      {open ? (
        <div className="run-summary-panel" role="group" aria-label="Run controls">
          <dl>
            <div>
              <dt>Architect model</dt>
              <dd>{resolvedRunControlLabel(input.value.architectModel, architectModelOptions)}</dd>
            </div>
            <div>
              <dt>Architect effort</dt>
              <dd>{resolvedRunControlLabel(input.value.architectEffort, architectEffortOptions)}</dd>
            </div>
            <div>
              <dt>Builder model</dt>
              <dd>{resolvedRunControlLabel(input.value.builderModel, builderModelOptions)}</dd>
            </div>
            <div>
              <dt>Builder effort</dt>
              <dd>{resolvedRunControlLabel(input.value.builderEffort, builderEffortOptions)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}


// The chat-header build-target control. Before a conversation starts (no transcript yet) it is an
// editable chip-style picker that re-points THIS conversation; once it has started — or when the
// server exposes no target choices — it falls back to the read-only chip (the target is then locked).
// This is distinct from the sidebar picker, which only arms the target for NEW conversations.
function TargetControl(input: {
  readonly conversation: Conversation | undefined;
  readonly defaultTarget: TargetSelection | null;
  readonly allowedTargets: readonly TargetSelection[];
  readonly onRetarget: (id: string, targetRepo: string) => void;
}) {
  const conversation = input.conversation;
  const editable =
    conversation !== undefined &&
    !conversation.sessionStarted &&
    conversation.lastSeq === 0 &&
    input.allowedTargets.length > 0;
  if (conversation && editable) {
    const current: TargetSelection | null = conversation.targetRepo
      ? { path: conversation.targetRepo, label: targetShortLabel(conversation.targetRepo) }
      : input.defaultTarget;
    return (
      <TargetPicker
        allowedTargets={input.allowedTargets}
        value={current}
        defaultValue={input.defaultTarget}
        onChange={(selection) => input.onRetarget(conversation.id, selection.path)}
        label="building in"
        variant="chip"
      />
    );
  }
  return <TargetChip conversation={conversation} defaultTarget={input.defaultTarget} />;
}

// A read-only chip in the chat header showing which repo the active conversation builds in: the
// conversation's own target, or the server default. Kept short ("bucket/project") so it fits the
// header. Hidden when no target is known (e.g. config not yet loaded).
function TargetChip(input: {
  readonly conversation: Conversation | undefined;
  readonly defaultTarget: TargetSelection | null;
}) {
  const targetRepo = input.conversation?.targetRepo ?? null;
  const label = targetRepo
    ? targetShortLabel(targetRepo)
    : input.defaultTarget?.label ?? null;
  if (!label) {
    return null;
  }
  return (
    <span className="target-chip" title={targetRepo ?? input.defaultTarget?.path ?? ""}>
      <span className="target-chip-label">building in</span>
      <code>{label}</code>
    </span>
  );
}

function Transcript(input: {
  readonly conversationId: string;
  readonly entries: readonly TranscriptEntry[];
  readonly mode: ViewMode;
  readonly collapseAll: boolean;
  readonly onApprove: (decision: PlanDecision) => Promise<void>;
}) {
  const items = useMemo(() => buildRenderItems(input.entries), [input.entries]);
  // Derived once per entries change (not per render): the scan is O(current-cycle tail) and JSON
  // parsing is capped to the newest chunks inside liveBuildStatus, so streaming chunks stay cheap.
  const liveBuild = useMemo(() => liveBuildStatus(input.entries), [input.entries]);
  const working = input.entries.at(-1) ? actorOf(input.entries.at(-1)?.type ?? "error") === "architect" : false;
  if (input.entries.length === 0) {
    return (
      <div className="empty-transcript">
        <h3>No transcript yet.</h3>
        <p>The first message starts the architect.</p>
      </div>
    );
  }
  return input.mode === "split" ? (
    <SplitLaneTranscript
      conversationId={input.conversationId}
      items={items}
      entries={input.entries}
      collapseAll={input.collapseAll}
      onApprove={input.onApprove}
      working={working}
      liveBuild={liveBuild}
    />
  ) : (
    <TimelineTranscript
      conversationId={input.conversationId}
      items={items}
      entries={input.entries}
      collapseAll={input.collapseAll}
      onApprove={input.onApprove}
      working={working}
      liveBuild={liveBuild}
    />
  );
}

function TimelineTranscript(input: {
  readonly conversationId: string;
  readonly items: readonly TranscriptRenderItem[];
  readonly entries: readonly TranscriptEntry[];
  readonly collapseAll: boolean;
  readonly onApprove: (decision: PlanDecision) => Promise<void>;
  readonly working: boolean;
  readonly liveBuild: LiveBuildStatus | null;
}) {
  const newItemKeys = useNewItemKeys(input.items, input.conversationId);
  let previousActor: TranscriptActor | null = null;
  return (
    <section className="transcript transcript-timeline" data-testid="transcript-timeline" aria-label="Transcript timeline">
      {input.items.map((item) => {
        const grouped = previousActor === item.actor;
        previousActor = item.actor;
        return (
          <article className={grouped ? "transcript-row is-grouped" : "transcript-row"} data-actor={item.actor} key={item.key}>
            <div className="actor-gutter">{grouped ? "" : item.actor}</div>
            <div className={transcriptItemClassNameFor(item, newItemKeys)}>
              <RenderItem item={item} entries={input.entries} collapseAll={input.collapseAll} onApprove={input.onApprove} />
            </div>
          </article>
        );
      })}
      {input.liveBuild ? <BuildStatusStrip status={input.liveBuild} /> : null}
      {input.working ? <div className="working-marker">Architect is working</div> : null}
    </section>
  );
}

function SplitLaneTranscript(input: {
  readonly conversationId: string;
  readonly items: readonly TranscriptRenderItem[];
  readonly entries: readonly TranscriptEntry[];
  readonly collapseAll: boolean;
  readonly onApprove: (decision: PlanDecision) => Promise<void>;
  readonly working: boolean;
  readonly liveBuild: LiveBuildStatus | null;
}) {
  const newItemKeys = useNewItemKeys(input.items, input.conversationId);
  return (
    <section className="transcript transcript-split" data-testid="transcript-split-lane" aria-label="Split transcript lanes">
      <div className="lane-label split-label-architect">architect</div>
      <div className="lane-label split-label-builder">builder</div>
      {input.items.map((item) => (
        <div className={`split-cell split-cell-${item.actor}`} data-testid={`split-lane-${item.actor}`} key={item.key}>
          <div className={transcriptItemClassNameFor(item, newItemKeys)}>
            <RenderItem item={item} entries={input.entries} collapseAll={input.collapseAll} onApprove={input.onApprove} />
          </div>
        </div>
      ))}
      {input.liveBuild ? (
        <div className="split-cell split-cell-builder">
          <BuildStatusStrip status={input.liveBuild} />
        </div>
      ) : null}
      {input.working ? <div className="working-marker split-working">Architect is working</div> : null}
    </section>
  );
}

// A collapsible entry defaults to closed when the global collapse-all toggle is on, otherwise open
// (the native <details> default). The operator can still toggle any single entry independently.
function defaultOpenFor(type: TranscriptEntry["type"], collapseAll: boolean): boolean {
  return COLLAPSIBLE_TYPES.has(type) ? !collapseAll : true;
}

function RenderItem(input: {
  readonly item: TranscriptRenderItem;
  readonly entries: readonly TranscriptEntry[];
  readonly collapseAll: boolean;
  readonly onApprove: (decision: PlanDecision) => Promise<void>;
}) {
  if (input.item.kind === "build_output") {
    return <BuildOutputBlock entries={input.item.entries} collapseAll={input.collapseAll} />;
  }
  const entry = input.item.entry;
  switch (entry.type) {
    case "user_message":
      return <ProseEntry entry={entry} label="operator" />;
    case "architect_message":
      return <ProseEntry entry={entry} label="architect" markdown />;
    case "tool_use":
      return <ToolUseEntry entry={entry} open={defaultOpenFor(entry.type, input.collapseAll)} />;
    case "tool_result":
      return <ToolResultEntry entry={entry} open={defaultOpenFor(entry.type, input.collapseAll)} />;
    case "plan_proposed":
      return (
        <PlanProposedCard
          entry={entry}
          status={planGateStatus(input.entries, entry.seq)}
          onApprove={input.onApprove}
        />
      );
    case "approval":
      return <ApprovalEntry entry={entry} />;
    case "build_output":
      // buildRenderItems groups consecutive build_output entries into a "build_output" render item
      // handled above; a lone entry reaching here still renders as a single-entry Codex block
      // rather than being silently dropped.
      return <BuildOutputBlock entries={[entry]} collapseAll={input.collapseAll} />;
    case "test_delta":
      return <TestDeltaEntry entry={entry} open={defaultOpenFor(entry.type, input.collapseAll)} />;
    case "verify_result":
      return <VerifyResultEntry entry={entry} open={defaultOpenFor(entry.type, input.collapseAll)} />;
    case "change_diff":
      return <ChangeDiffEntry entry={entry} />;
    case "cycle_complete":
      return <CycleCompleteEntry entry={entry} entries={input.entries} />;
    case "usage":
      return <UsageEntry entry={entry} />;
    case "run_meta":
      return <RunMetaEntry entry={entry} />;
    case "merge_blocked":
      return <MergeBlockedEntry entry={entry} />;
    case "recovery":
      return <RecoveryEntry entry={entry} />;
    case "error":
      return <ErrorEntry entry={entry} />;
    default: {
      // A new TranscriptEntryType without a renderer is a compile error here, not a silent UI drop.
      const exhaustive: never = entry.type;
      return exhaustive ?? null;
    }
  }
}

function changeDiffForCycle(entries: readonly TranscriptEntry[], cycleSeq: number): TranscriptEntry | null {
  let previousCycleSeq = -1;
  for (const entry of entries) {
    if (entry.seq >= cycleSeq) {
      break;
    }
    if (entry.type === "cycle_complete") {
      previousCycleSeq = entry.seq;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.seq <= previousCycleSeq || entry.seq >= cycleSeq) {
      continue;
    }
    if (entry.type === "change_diff") {
      return entry;
    }
  }
  return null;
}

function diffSummaryLabel(entry: TranscriptEntry): string {
  const summary = jsonField(entry.data, "summary");
  const files = isJsonObject(summary) && typeof summary.files === "number" ? summary.files : 0;
  const insertions = isJsonObject(summary) && typeof summary.insertions === "number" ? summary.insertions : 0;
  const deletions = isJsonObject(summary) && typeof summary.deletions === "number" ? summary.deletions : 0;
  return `View changes · ${files} ${files === 1 ? "file" : "files"}, +${insertions} −${deletions}`;
}

function ChangeDiffEntry(input: { readonly entry: TranscriptEntry }) {
  const notice = stringField(input.entry.data, "notice");
  if (notice) {
    return (
      <div className="entry entry-change-notice" data-testid="entry-change-diff-notice">
        {notice}
      </div>
    );
  }
  return (
    <details className="entry entry-action entry-change-diff" data-testid="entry-change-diff">
      <summary>
        <ChevronIcon className="summary-chevron" />
        {diffSummaryLabel(input.entry)}
      </summary>
      <div className="change-diff-body">
        <pre>{stringField(input.entry.data, "stat")}</pre>
        <pre className="change-diff-patch">{stringField(input.entry.data, "patch")}</pre>
      </div>
    </details>
  );
}

function ProseEntry(input: { readonly entry: TranscriptEntry; readonly label: string; readonly markdown?: boolean }) {
  const text = stringField(input.entry.data, "text");
  return (
    <div className="entry entry-prose" data-testid={`entry-${input.entry.type.replaceAll("_", "-")}`}>
      <span className="entry-label">{input.label}</span>
      {input.markdown ? <Markdown source={text} /> : <p>{text}</p>}
    </div>
  );
}

function ToolUseEntry(input: { readonly entry: TranscriptEntry; readonly open: boolean }) {
  const name = stringField(input.entry.data, "name") || "tool_use";
  return (
    <details className="entry entry-action" data-testid="entry-tool-use" open={input.open}>
      <summary>
        <ChevronIcon className="summary-chevron" />
        {name}
      </summary>
      <pre>{jsonLabel(jsonField(input.entry.data, "input"))}</pre>
    </details>
  );
}

function ToolResultEntry(input: { readonly entry: TranscriptEntry; readonly open: boolean }) {
  const isError = booleanField(input.entry.data, "isError");
  return (
    <details className="entry entry-action" data-testid="entry-tool-result" data-verdict={isError ? "error" : "ok"} open={input.open}>
      <summary>
        <ChevronIcon className="summary-chevron" />
        {isError ? "Tool error" : "Tool result"}
      </summary>
      <pre>{stringField(input.entry.data, "content") || jsonLabel(jsonField(input.entry.data, "content"))}</pre>
    </details>
  );
}

function PlanProposedCard(input: {
  readonly entry: TranscriptEntry;
  readonly status: PlanGateStatus;
  readonly onApprove: (decision: PlanDecision) => Promise<void>;
}) {
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const actionable = input.status === "actionable";
  const labelByStatus = {
    actionable: "Pending approval",
    approved: "Approved",
    builder_started: "Builder started",
    changes_requested: "Changes requested",
    superseded: "Superseded"
  } satisfies Record<PlanGateStatus, string>;

  async function decide(decision: PlanDecision) {
    setSubmitting(true);
    try {
      await input.onApprove(decision);
      if (decision.verdict === "changes_requested") {
        setFeedback("");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article className="entry plan-card" data-testid="entry-plan-proposed" data-status={input.status}>
      <div className="plan-card-header">
        <span className="entry-label">plan</span>
        <span className="status-chip">{labelByStatus[input.status]}</span>
      </div>
      <h3>{stringField(input.entry.data, "title") || "Plan proposed"}</h3>
      <div className="plan-card-body">
        <Markdown source={stringField(input.entry.data, "plan")} />
      </div>
      {actionable ? (
        <div className="approval-controls">
          <button
            className="button button-approve"
            type="button"
            disabled={submitting}
            onClick={() => void decide({ verdict: "approved" })}
          >
            Approve
          </button>
          <label className="feedback-field">
            <span>Feedback</span>
            <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={3} />
          </label>
          <button
            className="button button-secondary"
            type="button"
            disabled={submitting || feedback.trim().length === 0}
            onClick={() => void decide({ verdict: "changes_requested", feedback: feedback.trim() })}
          >
            Request changes
          </button>
        </div>
      ) : null}
    </article>
  );
}

function ApprovalEntry(input: { readonly entry: TranscriptEntry }) {
  const verdict = stringField(input.entry.data, "verdict");
  const requested = verdict === "changes_requested";
  return (
    <div className="entry entry-marker" data-testid="entry-approval" data-verdict={requested ? "changes_requested" : "approved"}>
      <strong>{requested ? "changes requested" : "approved"}</strong>
      {stringField(input.entry.data, "feedback") ? <span>{stringField(input.entry.data, "feedback")}</span> : null}
    </div>
  );
}

function BuildOutputBlock(input: { readonly entries: readonly TranscriptEntry[]; readonly collapseAll: boolean }) {
  // Joining + ANSI-stripping is O(total build output); memoize on the group's identity so unrelated
  // re-renders (composer keystrokes, sidebar drag frames) do not re-process the whole log.
  const text = useMemo(
    () => stripAnsi(input.entries.map((entry) => stringField(entry.data, "chunk")).join("")),
    [input.entries]
  );
  return (
    <details
      className="entry entry-action entry-build"
      data-testid="entry-build-output"
      open={!input.collapseAll}
    >
      <summary>
        <ChevronIcon className="summary-chevron" />
        Codex output
      </summary>
      <pre className="build-output-pre" style={{ maxHeight: input.collapseAll ? undefined : MAX_PLAN_OUTPUT_HEIGHT }}>
        {text}
      </pre>
    </details>
  );
}

// The compact live status strip shown under the streaming Codex output while a build is in flight:
// elapsed time since the build's first output chunk plus the latest meaningful codex item. Mounted
// only while the build is unsettled (liveBuildStatus returns null once verify_result/cycle_complete
// arrives), so the 1s elapsed tick never runs outside an active build.
function BuildStatusStrip(input: { readonly status: LiveBuildStatus }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="build-status-strip" data-testid="build-status-strip" role="status">
      <span className="build-status-pulse" aria-hidden="true" />
      <span className="build-status-label">build in flight</span>
      <span className="build-status-elapsed">{formatDuration(Math.max(0, now - input.status.startedTs))}</span>
      {input.status.latestItem ? (
        <code className="build-status-item" title={input.status.latestItem}>
          {input.status.latestItem}
        </code>
      ) : null}
    </div>
  );
}

function VerifyResultEntry(input: { readonly entry: TranscriptEntry; readonly open: boolean }) {
  const status = stringField(input.entry.data, "status") || "blocked";
  const records = verifierRecords(input.entry.data);
  return (
    <details className="entry entry-action entry-verify" data-testid="entry-verify-result" data-verdict={status} open={input.open}>
      <summary>
        <ChevronIcon className="summary-chevron" />
        Verifier {status}
      </summary>
      <div className="verify-list">
        {records.map((record) => (
          <div className="verify-record" key={`${record.name}-${record.status}`}>
            <strong>{record.name}</strong>
            <span>{record.status}</span>
            {record.exitCode === undefined ? null : <code>exit {record.exitCode}</code>}
            {record.output ? <pre>{record.output}</pre> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

// The deterministic test-delta the builder produced (detect-only). A weakened delta is the loud
// case — a build that changed tests in a way that reduces coverage — so it gets a distinct verdict.
function TestDeltaEntry(input: { readonly entry: TranscriptEntry; readonly open: boolean }) {
  const delta = jsonField(input.entry.data, "testDelta");
  if (!isTestDelta(delta)) {
    return null;
  }
  const verdict = delta.weakened ? "weakened" : "clean";
  return (
    <details className="entry entry-action entry-test-delta" data-testid="entry-test-delta" data-verdict={verdict} open={input.open}>
      <summary>
        <ChevronIcon className="summary-chevron" />
        Test delta {delta.weakened ? "weakened" : "clean"} (+{delta.addedTests} / -{delta.removedTests})
      </summary>
      {delta.signals.length > 0 ? (
        <ul className="test-delta-signals">
          {delta.signals.map((signal) => (
            <li key={signal}>{signal}</li>
          ))}
        </ul>
      ) : (
        <p>No test-weakening signals.</p>
      )}
    </details>
  );
}

function CycleCompleteEntry(input: { readonly entry: TranscriptEntry; readonly entries: readonly TranscriptEntry[] }) {
  const diff = changeDiffForCycle(input.entries, input.entry.seq);
  return (
    <div className="entry entry-cycle" data-testid="entry-cycle-complete">
      <div className="entry-cycle-line">
        <span>cycle complete</span>
        <strong>{stringField(input.entry.data, "branch")}</strong>
        {stringField(input.entry.data, "grade") ? <small>grade {stringField(input.entry.data, "grade")}</small> : null}
      </div>
      {diff ? <ChangeDiffEntry entry={diff} /> : null}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return "0";
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k`;
  }
  return String(count);
}

// The end-of-loop usage summary for ONE side. The architect entry carries model + accumulated
// tokens + cost + turn time; the builder entry carries the build wall-clock + effort (the builder
// emits no parsed tokens). Both render through this component, keyed on `side`.
function UsageEntry(input: { readonly entry: TranscriptEntry }) {
  const data = input.entry.data;
  const side = stringField(data, "side");
  const sideLabel = side === "architect" ? "architect" : side === "builder" ? "builder" : "run";
  const model = stringField(data, "model");
  const effort = stringField(data, "effort");
  const inputTokens = numberField(data, "inputTokens");
  const outputTokens = numberField(data, "outputTokens");
  const durationMs = numberField(data, "durationMs");
  const costUsd = numberField(data, "costUsd");

  return (
    <div className="entry entry-usage" data-testid="entry-usage" role="status">
      <span className="entry-label">{sideLabel} usage</span>
      <div className="usage-stats">
        {model ? <span className="usage-stat usage-model" title="model">{model}</span> : null}
        {effort ? <span className="usage-stat" title="effort">effort {effort}</span> : null}
        {inputTokens !== undefined ? (
          <span className="usage-stat" title="input tokens">{formatTokens(inputTokens)} in</span>
        ) : null}
        {outputTokens !== undefined ? (
          <span className="usage-stat" title="output tokens">{formatTokens(outputTokens)} out</span>
        ) : null}
        {durationMs !== undefined ? <span className="usage-stat" title="time">{formatDuration(durationMs)}</span> : null}
        {costUsd !== undefined ? <span className="usage-stat" title="cost">${costUsd.toFixed(4)}</span> : null}
      </div>
    </div>
  );
}

// Reserved renderer for a per-side run-meta entry (model + effort declared at run start). The
// orchestrator does not currently emit run_meta, but the entry type is part of the transcript model,
// so it must render rather than trip the exhaustive guard.
function RunMetaEntry(input: { readonly entry: TranscriptEntry }) {
  const data = input.entry.data;
  const side = stringField(data, "side");
  const model = stringField(data, "model");
  const effort = stringField(data, "effort");
  return (
    <div className="entry entry-run-meta" data-testid="entry-run-meta" role="status">
      <span className="entry-label">{side || "run"} config</span>
      <div className="usage-stats">
        {model ? <span className="usage-stat usage-model">{model}</span> : null}
        {effort ? <span className="usage-stat">effort {effort}</span> : null}
      </div>
    </div>
  );
}

function MergeBlockedEntry(input: { readonly entry: TranscriptEntry }) {
  const grade = stringField(input.entry.data, "grade");
  const reason = stringField(input.entry.data, "reason");
  return (
    <div className="entry entry-merge-blocked" data-testid="entry-merge-blocked" role="status">
      <span>build ready, merge blocked — the target moved; rebase and re-sign to retry</span>
      <strong>{stringField(input.entry.data, "branch")}</strong>
      {grade ? <small>grade {grade}</small> : null}
      {reason ? <pre>{reason}</pre> : null}
    </div>
  );
}

function RecoveryEntry(input: { readonly entry: TranscriptEntry }) {
  return (
    <div className="entry entry-recovery" data-testid="entry-recovery" role="status">
      {stringField(input.entry.data, "message")}
    </div>
  );
}

function ErrorEntry(input: { readonly entry: TranscriptEntry }) {
  return (
    <div className="entry entry-error" data-testid="entry-error" role="status">
      {stringField(input.entry.data, "message")}
    </div>
  );
}
