// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { Conversation, TranscriptEntry, TranscriptEntryType } from "../src/conversation-store";
import type { JsonObject, JsonValue } from "../src/run-service";

const conversationOne = "11111111-1111-4111-8111-111111111111";
const conversationTwo = "22222222-2222-4222-8222-222222222222";
const conversationThree = "33333333-3333-4333-8333-333333333333";

type FetchCall = {
  readonly url: string;
  readonly method: string;
  readonly body: JsonValue;
};

type FetchFixture = {
  readonly calls: FetchCall[];
  readonly fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
};

type ConfigFixture = {
  readonly targetRepo: string | null;
  readonly allowedTargets: readonly { readonly path: string; readonly label: string }[];
  readonly architectModels?: readonly string[];
  readonly builderModels?: readonly string[];
  readonly architectEfforts?: readonly string[];
  readonly builderEfforts?: readonly string[];
};

// Makes PATCH /api/conversations/:id fail with the server's crafted { code, message } error body,
// exercising fetchJson's error surfacing (message + code, not the bare statusText).
type PatchFailure = {
  readonly status: number;
  readonly statusText: string;
  readonly code: string;
  readonly message: string;
};

type FetchOptions = {
  readonly rejectCreate?: boolean;
  readonly patchFailure?: PatchFailure;
  readonly config?: ConfigFixture;
};

type ConversationSeed = Omit<
  Conversation,
  | "updatedAt"
  | "lastSeq"
  | "sessionStarted"
  | "archived"
  | "targetRepo"
  | "architectModel"
  | "architectEffort"
  | "builderModel"
  | "builderEffort"
> &
  Partial<
    Pick<
      Conversation,
      | "updatedAt"
      | "lastSeq"
      | "sessionStarted"
      | "archived"
      | "targetRepo"
      | "architectModel"
      | "architectEffort"
      | "builderModel"
      | "builderEffort"
    >
  >;

type EventListener = (event: MessageEvent<string>) => void;

const transcriptTypes: readonly TranscriptEntryType[] = [
  "user_message",
  "architect_message",
  "tool_use",
  "tool_result",
  "plan_proposed",
  "approval",
  "build_output",
  "change_diff",
  "verify_result",
  "cycle_complete",
  "error"
];

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(entry: TranscriptEntry): void {
    const event = new MessageEvent<string>(entry.type, { data: JSON.stringify(entry) });
    for (const listener of this.listeners.get(entry.type) ?? []) {
      listener(event);
    }
  }
}

function conversation(seed: ConversationSeed): Conversation {
  return {
    updatedAt: seed.createdAt,
    lastSeq: 0,
    sessionStarted: false,
    archived: false,
    targetRepo: null,
    architectModel: null,
    architectEffort: null,
    builderModel: null,
    builderEffort: null,
    ...seed
  };
}

function entry(seq: number, type: TranscriptEntryType, data: JsonObject): TranscriptEntry {
  return {
    seq,
    ts: 1_800_000_000_000 + seq,
    type,
    data
  };
}

function jsonResponse(body: JsonValue): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function requestMethod(init: Parameters<typeof fetch>[1]): string {
  return init?.method?.toUpperCase() ?? "GET";
}

function requestBody(init: Parameters<typeof fetch>[1]): JsonValue {
  const rawBody = init?.body;
  if (typeof rawBody !== "string") {
    return null;
  }
  return JSON.parse(rawBody) as JsonValue;
}

function setupFetch(initialConversations: readonly ConversationSeed[], options: FetchOptions = {}): FetchFixture {
  const calls: FetchCall[] = [];
  const conversations = initialConversations.map(conversation);
  let created = 0;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    const method = requestMethod(init);
    const body = requestBody(init);
    calls.push({ url, method, body });

    if (url === "/api/conversations" && method === "GET") {
      return jsonResponse({ conversations: conversations.filter((entry) => !entry.archived) });
    }
    if (url === "/api/conversations?includeArchived=true" && method === "GET") {
      return jsonResponse({ conversations });
    }
    if (url === "/api/config" && method === "GET") {
      // Default fixture exposes no allowlisted targets → the picker stays hidden; create sends no
      // target. A test can supply options.config to exercise the picker and per-conversation retarget.
      return jsonResponse(options.config ?? { targetRepo: null, allowedTargets: [] });
    }
    if (url === "/api/conversations" && method === "POST") {
      if (options.rejectCreate) {
        throw new Error("Create failed");
      }
      const id = created === 0 ? conversationThree : `44444444-4444-4444-8444-44444444444${created}`;
      created += 1;
      const newConversation = conversation({
        id,
        title: null,
        createdAt: 1_800_000_010_000 + created
      });
      conversations.unshift(newConversation);
      return jsonResponse({ id });
    }
    if (url.endsWith("/messages") && method === "POST") {
      return jsonResponse({ ok: true });
    }
    if (url.endsWith("/approve") && method === "POST") {
      return jsonResponse({ ok: true });
    }
    // PATCH /api/conversations/:id renames or re-points the conversation in the fixture's list.
    if (/\/api\/conversations\/[^/]+$/.test(url) && method === "PATCH" && options.patchFailure) {
      return new Response(
        JSON.stringify({ ok: false, code: options.patchFailure.code, message: options.patchFailure.message }),
        {
          status: options.patchFailure.status,
          statusText: options.patchFailure.statusText,
          headers: { "content-type": "application/json; charset=utf-8" }
        }
      );
    }
    if (/\/api\/conversations\/[^/]+$/.test(url) && method === "PATCH") {
      const target = conversations.find((entry) => url.endsWith(`/${entry.id}`));
      if (target && body && typeof body === "object" && "title" in body) {
        const renamed = { ...target, title: String((body as { title: string }).title) };
        conversations.splice(conversations.indexOf(target), 1, renamed);
        return jsonResponse({ ok: true, conversation: renamed });
      }
      if (target && body && typeof body === "object" && "targetRepo" in body) {
        const retargeted = { ...target, targetRepo: String((body as { targetRepo: string }).targetRepo) };
        conversations.splice(conversations.indexOf(target), 1, retargeted);
        return jsonResponse({ ok: true, conversation: retargeted });
      }
      return jsonResponse({ ok: true });
    }
    // DELETE /api/conversations/:id soft-archives the conversation in the fixture's list.
    if (/\/api\/conversations\/[^/]+$/.test(url) && method === "DELETE") {
      const target = conversations.find((entry) => url.endsWith(`/${entry.id}`));
      if (target) {
        const archived = { ...target, archived: true };
        conversations.splice(conversations.indexOf(target), 1, archived);
        return jsonResponse({ ok: true, archived: true, conversation: archived });
      }
      return jsonResponse({ ok: true, archived: true });
    }
    // POST /api/conversations/:id/restore un-archives the conversation.
    if (url.endsWith("/restore") && method === "POST") {
      const target = conversations.find((entry) => url.endsWith(`/${entry.id}/restore`));
      if (target) {
        const restored = { ...target, archived: false };
        conversations.splice(conversations.indexOf(target), 1, restored);
        return jsonResponse({ ok: true, conversation: restored });
      }
      return jsonResponse({ ok: true });
    }
    return new Response(JSON.stringify({ ok: false, code: "E_NOT_FOUND", message: "Route not found." }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function latestEventSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) {
    throw new Error("Expected an EventSource instance.");
  }
  return source;
}

async function renderWithConversation(): Promise<FetchFixture> {
  const fixture = setupFetch([
    {
      id: conversationOne,
      title: "Fixture conversation",
      createdAt: 1_800_000_000_000
    }
  ]);
  render(<App />);
  await screen.findByRole("button", { name: "Fixture conversation" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  return fixture;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat pane", () => {
  it("loads conversations, shows empty state, creates a new conversation, and repoints one EventSource", async () => {
    setupFetch([
      { id: conversationOne, title: "First conversation", createdAt: 1_800_000_000_000 },
      { id: conversationTwo, title: "Second conversation", createdAt: 1_800_000_005_000 }
    ]);
    const { unmount } = render(<App />);
    const second = await screen.findByRole("button", { name: "Second conversation" });
    const first = screen.getByRole("button", { name: "First conversation" });

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]?.url).toBe(`/api/conversations/${conversationTwo}/events`);

    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await screen.findByRole("button", { name: "Untitled conversation" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(FakeEventSource.instances.filter((source) => !source.closed)).toHaveLength(1);
    expect(FakeEventSource.instances[1]?.url).toBe(`/api/conversations/${conversationThree}/events`);

    await userEvent.click(first);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(3));
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
    expect(FakeEventSource.instances[2]?.url).toBe(`/api/conversations/${conversationOne}/events`);

    await userEvent.click(second);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(4));
    expect(FakeEventSource.instances[2]?.closed).toBe(true);
    expect(FakeEventSource.instances[3]?.url).toBe(`/api/conversations/${conversationTwo}/events`);

    unmount();
    expect(FakeEventSource.instances.at(-1)?.closed).toBe(true);
  });

  it("resumes the stream with afterSeq when switching back to a conversation with loaded entries", async () => {
    setupFetch([
      { id: conversationOne, title: "First conversation", createdAt: 1_800_000_000_000 },
      { id: conversationTwo, title: "Second conversation", createdAt: 1_800_000_005_000 }
    ]);
    render(<App />);
    await screen.findByRole("button", { name: "Second conversation" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]?.url).toBe(`/api/conversations/${conversationTwo}/events`);

    const source = latestEventSource();
    act(() => {
      source.emit(entry(1, "user_message", { text: "Objective for the second conversation." }));
      source.emit(entry(2, "architect_message", { text: "Acknowledged." }));
    });

    // A conversation with nothing loaded still replays from seq 0 (no afterSeq).
    await userEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1]?.url).toBe(`/api/conversations/${conversationOne}/events`);

    // Switching back resumes past the entries already in memory instead of replaying everything.
    await userEvent.click(screen.getByRole("button", { name: "Second conversation" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(3));
    expect(FakeEventSource.instances[2]?.url).toBe(`/api/conversations/${conversationTwo}/events?afterSeq=2`);
    // The already-loaded entries are still rendered without a replay.
    expect(screen.getByText("Objective for the second conversation.")).toBeInTheDocument();
    expect(screen.getByText("Acknowledged.")).toBeInTheDocument();
  });

  it("renders in-order (fast-path) appends in the same order as an out-of-order replay merge", async () => {
    await renderWithConversation();
    const source = latestEventSource();
    act(() => {
      source.emit(entry(1, "user_message", { text: "first message" }));
      source.emit(entry(2, "architect_message", { text: "second message" }));
      source.emit(entry(3, "user_message", { text: "third message" }));
    });
    const inOrder = screen.getAllByTestId(/^entry-/).map((node) => node.textContent);
    expect(inOrder).toHaveLength(3);

    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const replaySource = latestEventSource();
    act(() => {
      replaySource.emit(entry(3, "user_message", { text: "third message" }));
      replaySource.emit(entry(1, "user_message", { text: "first message" }));
      replaySource.emit(entry(2, "architect_message", { text: "second message" }));
    });
    const merged = screen.getAllByTestId(/^entry-/).map((node) => node.textContent);
    expect(merged).toEqual(inOrder);
  });

  it("renders the empty conversation state when the server has no conversations", async () => {
    setupFetch([]);
    render(<App />);
    expect(await screen.findByText("Create a conversation to begin.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse all" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Transcript view" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toHaveAttribute("placeholder", "Message the architect to start...");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Message"), "Start from this objective.");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("creates a conversation on the first send and posts through the returned id", async () => {
    const { calls } = setupFetch([]);
    render(<App />);
    await screen.findByText("Create a conversation to begin.");
    const input = screen.getByLabelText("Message");
    const send = screen.getByRole("button", { name: "Send" });

    await userEvent.type(input, "Give the architect a real first objective.");
    expect(send).toBeEnabled();
    await userEvent.click(send);

    await waitFor(() =>
      expect(calls.map((call) => `${call.method} ${call.url}`)).toContain(
        `POST /api/conversations/${conversationThree}/messages`
      )
    );
    // The create-on-send path posts the conversation then the message. Assert by URL+method so the
    // incidental GET /api/config (the target picker) does not make the index-based slice brittle.
    expect(calls.filter((call) => call.method === "POST")).toMatchObject([
      { url: "/api/conversations", method: "POST", body: null },
      {
        url: `/api/conversations/${conversationThree}/messages`,
        method: "POST",
        body: { text: "Give the architect a real first objective." }
      }
    ]);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]?.url).toBe(`/api/conversations/${conversationThree}/events`);
  });

  it("renders all transcript entry types and groups build output into one mono block", async () => {
    await renderWithConversation();
    const source = latestEventSource();

    act(() => {
      source.emit(entry(1, "user_message", { text: "Read the repo and fix the failing fixture." }));
      source.emit(entry(2, "architect_message", { text: "I am checking the constraints." }));
      source.emit(entry(3, "tool_use", { name: "read_repo_file", input: { path: "package.json" } }));
      source.emit(entry(4, "tool_result", { content: "Tool failed with fixture output.", isError: true }));
      source.emit(entry(5, "plan_proposed", { title: "Fixture repair", plan: "Patch the fixture and rerun tests." }));
      source.emit(entry(6, "approval", { verdict: "approved" }));
      source.emit(entry(7, "build_output", { chunk: "npm test\n" }));
      source.emit(entry(8, "build_output", { chunk: "143 passed\n" }));
      source.emit(
        entry(9, "verify_result", {
          status: "pass",
          verifierResults: [{ name: "vitest", status: "pass", exitCode: 0, output: "green" }]
        })
      );
      source.emit(
        entry(10, "change_diff", {
          stat: " src/App.tsx | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n",
          patch: "diff --git a/src/App.tsx b/src/App.tsx\n",
          truncated: false,
          summary: { files: 1, insertions: 1, deletions: 1 }
        })
      );
      source.emit(entry(11, "cycle_complete", { branch: "planforge/chat-ui", grade: "A" }));
      source.emit(entry(12, "error", { message: "Recoverable API error" }));
    });

    for (const type of transcriptTypes) {
      expect(screen.getAllByTestId(`entry-${type.replaceAll("_", "-")}`).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("I am checking the constraints.")).toBeInTheDocument();
    const buildOutput = screen.getByTestId("entry-build-output");
    expect(buildOutput).toHaveTextContent("npm test");
    expect(buildOutput).toHaveTextContent("143 passed");
    expect(screen.getByTestId("entry-tool-result")).toHaveAttribute("data-verdict", "error");
    expect(screen.getByText("Tool error")).toBeInTheDocument();
    expect(screen.getByText("cycle complete")).toBeInTheDocument();
    expect(screen.getByTestId("entry-change-diff")).not.toHaveAttribute("open");
    expect(screen.getByText("View changes · 1 file, +1 −1")).toBeInTheDocument();
    expect(screen.queryByText("sign_off")).not.toBeInTheDocument();
  });

  it("keeps plan approval pending until the approval SSE frame resolves it", async () => {
    const { calls } = await renderWithConversation();
    const source = latestEventSource();

    act(() => {
      source.emit(entry(1, "plan_proposed", { title: "Repair plan", plan: "Make the fixture deterministic." }));
    });

    const card = screen.getByTestId("entry-plan-proposed");
    expect(within(card).getByText("Pending approval")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve" }));

    expect(calls.at(-1)).toMatchObject({
      url: `/api/conversations/${conversationOne}/approve`,
      method: "POST",
      body: { verdict: "approved" }
    });
    expect(within(card).getByText("Pending approval")).toBeInTheDocument();

    act(() => {
      source.emit(entry(2, "approval", { verdict: "approved" }));
    });
    expect(within(card).getByText("Approved")).toBeInTheDocument();
  });

  it("requires feedback before posting requested changes and resolves from SSE", async () => {
    const { calls } = await renderWithConversation();
    const source = latestEventSource();

    act(() => {
      source.emit(entry(1, "plan_proposed", { title: "Needs review", plan: "Do the obvious patch." }));
    });

    const card = screen.getByTestId("entry-plan-proposed");
    const requestButton = within(card).getByRole("button", { name: "Request changes" });
    expect(requestButton).toBeDisabled();

    await userEvent.type(within(card).getByLabelText("Feedback"), "Name the exact test first.");
    expect(requestButton).toBeEnabled();
    await userEvent.click(requestButton);

    expect(calls.at(-1)).toMatchObject({
      url: `/api/conversations/${conversationOne}/approve`,
      method: "POST",
      body: { verdict: "changes_requested", feedback: "Name the exact test first." }
    });

    act(() => {
      source.emit(entry(2, "approval", { verdict: "changes_requested", feedback: "Name the exact test first." }));
    });
    expect(within(card).getByText("Changes requested")).toBeInTheDocument();
  });

  it("supersedes earlier plans and leaves only the latest proposal actionable", async () => {
    await renderWithConversation();
    const source = latestEventSource();

    act(() => {
      source.emit(entry(1, "plan_proposed", { title: "Old plan", plan: "Patch A." }));
      source.emit(entry(2, "plan_proposed", { title: "New plan", plan: "Patch B." }));
    });

    const cards = screen.getAllByTestId("entry-plan-proposed");
    expect(within(cards[0]).getByText("Superseded")).toBeInTheDocument();
    expect(within(cards[0]).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(within(cards[1]).getByText("Pending approval")).toBeInTheDocument();
    expect(within(cards[1]).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("switches timeline and split-lane views without refetching or opening a new EventSource", async () => {
    const { fetchMock } = await renderWithConversation();
    const source = latestEventSource();
    const fetchCount = fetchMock.mock.calls.length;
    const eventSourceCount = FakeEventSource.instances.length;

    act(() => {
      source.emit(entry(1, "architect_message", { text: "Architect note" }));
      source.emit(
        entry(2, "verify_result", {
          status: "fail",
          verifierResults: [{ name: "vitest", status: "fail", exitCode: 1, output: "red" }]
        })
      );
    });

    await userEvent.click(screen.getByRole("button", { name: "Split lanes" }));

    expect(fetchMock.mock.calls).toHaveLength(fetchCount);
    expect(FakeEventSource.instances).toHaveLength(eventSourceCount);
    expect(
      screen
        .getAllByTestId("split-lane-architect")
        .some((cell) => within(cell).queryByText("Architect note") !== null)
    ).toBe(true);
    expect(
      screen.getAllByTestId("split-lane-builder").some((cell) => within(cell).queryByText("vitest") !== null)
    ).toBe(true);
  });

  it("sends composer messages within bounds and renders the SSE echo exactly once", async () => {
    const { calls } = await renderWithConversation();
    const source = latestEventSource();
    const input = screen.getByLabelText("Message");
    const send = screen.getByRole("button", { name: "Send" });

    expect(send).toBeDisabled();
    await userEvent.type(input, "   ");
    expect(send).toBeDisabled();
    fireEvent.change(input, { target: { value: "x".repeat(20_001) } });
    expect(send).toBeDisabled();

    fireEvent.change(input, { target: { value: "Please repair the flaky test." } });
    expect(send).toBeEnabled();
    await userEvent.click(send);

    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        url: `/api/conversations/${conversationOne}/messages`,
        method: "POST",
        body: { text: "Please repair the flaky test." }
      })
    );
    expect(calls.filter((call) => call.method === "POST" && call.url === "/api/conversations")).toHaveLength(0);
    expect(screen.queryByText("Please repair the flaky test.")).not.toBeInTheDocument();

    act(() => {
      source.emit(entry(4, "user_message", { text: "Please repair the flaky test." }));
      source.emit(entry(4, "user_message", { text: "Please repair the flaky test." }));
      source.emit(entry(5, "error", { message: "Temporary failure" }));
    });

    expect(screen.getAllByText("Please repair the flaky test.")).toHaveLength(1);
    expect(screen.getByText("Temporary failure")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "Follow-up after the error." } });
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("preserves the draft and surfaces a notice when create-on-send fails", async () => {
    const { calls } = setupFetch([], { rejectCreate: true });
    render(<App />);
    await screen.findByText("Create a conversation to begin.");
    const input = screen.getByLabelText("Message");

    await userEvent.type(input, "This should remain in the composer.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Create failed");
    expect(input).toHaveValue("This should remain in the composer.");
    expect(calls.filter((call) => call.url.endsWith("/messages"))).toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("renames a conversation from the header title and PATCHes the new title", async () => {
    const { calls } = await renderWithConversation();
    // The header title button is labeled "Rename conversation <title>" to stay distinct from the row.
    await userEvent.click(screen.getByRole("button", { name: "Rename conversation Fixture conversation" }));
    const titleInput = screen.getByLabelText("Conversation title");
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Renamed from header{Enter}");

    await waitFor(() =>
      expect(calls.map((call) => `${call.method} ${call.url}`)).toContain(`PATCH /api/conversations/${conversationOne}`)
    );
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { title: "Renamed from header" } });
    // The header now shows the renamed title.
    expect(screen.getByRole("button", { name: "Rename conversation Renamed from header" })).toBeInTheDocument();
  });

  it("surfaces the server's error message and code in the notice, not the bare statusText", async () => {
    setupFetch(
      [
        {
          id: conversationOne,
          title: "Fixture conversation",
          createdAt: 1_800_000_000_000
        }
      ],
      {
        patchFailure: {
          status: 409,
          statusText: "Conflict",
          code: "E_SESSION_ALREADY_STARTED",
          message: "This conversation has already started; its build target is locked."
        }
      }
    );
    render(<App />);
    await screen.findByRole("button", { name: "Rename conversation Fixture conversation" });
    await userEvent.click(screen.getByRole("button", { name: "Rename conversation Fixture conversation" }));
    const titleInput = screen.getByLabelText("Conversation title");
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Locked rename{Enter}");

    const notice = await screen.findByRole("status");
    // The crafted body's explanation and code reach the operator; "Conflict" alone tells them nothing.
    expect(notice).toHaveTextContent(
      "This conversation has already started; its build target is locked. (E_SESSION_ALREADY_STARTED)"
    );
  });

  it("renames a conversation from the sidebar row hover action", async () => {
    const { calls } = await renderWithConversation();
    await userEvent.click(screen.getByRole("button", { name: "Rename Fixture conversation" }));
    const rowInput = screen.getByLabelText("Rename Fixture conversation");
    await userEvent.clear(rowInput);
    await userEvent.type(rowInput, "Renamed from sidebar{Enter}");

    await waitFor(() =>
      expect(calls.some((call) => call.method === "PATCH" && call.url === `/api/conversations/${conversationOne}`)).toBe(true)
    );
  });

  it("archives a conversation via the row trash action, hides it, and restores it from Archived", async () => {
    const { calls } = await renderWithConversation();

    await userEvent.click(screen.getByRole("button", { name: "Archive Fixture conversation" }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === "DELETE" && call.url === `/api/conversations/${conversationOne}`)).toBe(true)
    );
    // Archived conversation is gone from the live list.
    expect(screen.queryByRole("button", { name: "Fixture conversation" })).not.toBeInTheDocument();

    // Expand Archived and restore it.
    await userEvent.click(screen.getByRole("button", { name: /Archived/ }));
    await screen.findByRole("button", { name: "Restore Fixture conversation" });
    await userEvent.click(screen.getByRole("button", { name: "Restore Fixture conversation" }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST" && call.url === `/api/conversations/${conversationOne}/restore`)).toBe(true)
    );
  });

  it("renders the proposed plan markdown as structured headings and lists, not raw text", async () => {
    await renderWithConversation();
    const source = latestEventSource();

    act(() => {
      source.emit(
        entry(1, "plan_proposed", {
          title: "Comment the grace constant",
          plan: "## Objective\n\nAdd a comment.\n\n## Change\n\n- one\n- two"
        })
      );
    });

    const card = screen.getByTestId("entry-plan-proposed");
    // The `##` markers are parsed into heading elements, not rendered as literal `##` text.
    expect(within(card).getByText("Objective").tagName).toMatch(/^H/);
    expect(within(card).getByText("Change").tagName).toMatch(/^H/);
    expect(within(card).getByText("one").tagName).toBe("LI");
    expect(within(card).queryByText("## Objective")).not.toBeInTheDocument();
  });

  it("renders architect messages as markdown rich text", async () => {
    await renderWithConversation();
    const source = latestEventSource();

    act(() => {
      source.emit(entry(1, "architect_message", { text: "Here is the **bold** part and `code`." }));
    });

    const message = screen.getByTestId("entry-architect-message");
    expect(within(message).getByText("bold").tagName).toBe("STRONG");
    expect(within(message).getByText("code").tagName).toBe("CODE");
  });

  it("collapses and expands all collapsible entries via the header toggle", async () => {
    await renderWithConversation();
    const source = latestEventSource();

    act(() => {
      source.emit(entry(1, "build_output", { chunk: "npm test\n" }));
      source.emit(entry(2, "build_output", { chunk: "143 passed\n" }));
    });

    const buildBlock = screen.getByTestId("entry-build-output");
    // Default: build output is open.
    expect(buildBlock).toHaveAttribute("open");

    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.getByTestId("entry-build-output")).not.toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Expand all" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByTestId("entry-build-output")).toHaveAttribute("open");
  });

  it("shows a live build status strip with the latest codex command while a build is in flight", async () => {
    await renderWithConversation();
    const source = latestEventSource();

    act(() => {
      source.emit(entry(1, "approval", { verdict: "approved" }));
      source.emit(
        entry(2, "build_output", {
          chunk: '{"type":"item.started","item":{"item_type":"command_execution","command":"npm ci"}}\n'
        })
      );
    });

    const strip = screen.getByTestId("build-status-strip");
    expect(strip).toHaveTextContent("build in flight");
    // The fixture timestamps sit ahead of the clock, so the elapsed chip clamps to its floor.
    expect(strip).toHaveTextContent("0s");
    expect(strip).toHaveTextContent("npm ci");

    // A newer chunk replaces the shown item — even when the JSONL line is split across two chunks
    // and preceded by unparseable noise.
    act(() => {
      source.emit(
        entry(3, "build_output", {
          chunk: 'garbage that is not JSON\n{"type":"item.completed","item":{"item_type":"command_execution",'
        })
      );
      source.emit(entry(4, "build_output", { chunk: '"command":"npx vitest run tests/chat-ui.test.tsx"}}\n' }));
    });
    expect(screen.getByTestId("build-status-strip")).toHaveTextContent("npx vitest run tests/chat-ui.test.tsx");
    expect(screen.getByTestId("build-status-strip")).not.toHaveTextContent("npm ci");

    act(() => {
      source.emit(entry(5, "verify_result", { status: "pass", verifierResults: [] }));
    });
    expect(screen.queryByTestId("build-status-strip")).not.toBeInTheDocument();
  });

  it("keeps the build strip alive on unparseable output and swaps to the latest agent message", async () => {
    await renderWithConversation();
    const source = latestEventSource();

    act(() => {
      source.emit(entry(1, "build_output", { chunk: "plain text with no codex JSON\n" }));
    });
    // Unparseable chunks never block the strip: elapsed still shows, the item chip is simply absent.
    const strip = screen.getByTestId("build-status-strip");
    expect(strip).toHaveTextContent("build in flight");
    expect(strip.querySelector("code")).toBeNull();

    act(() => {
      source.emit(
        entry(2, "build_output", {
          chunk: '{"type":"item.completed","item":{"item_type":"agent_message","text":"Running the chat-ui suite now."}}\n'
        })
      );
    });
    expect(screen.getByTestId("build-status-strip")).toHaveTextContent("Running the chat-ui suite now.");

    act(() => {
      source.emit(entry(3, "verify_result", { status: "pass", verifierResults: [] }));
      source.emit(entry(4, "cycle_complete", { branch: "planforge/live-strip" }));
    });
    expect(screen.queryByTestId("build-status-strip")).not.toBeInTheDocument();
  });

  it("renders the end-of-loop usage summary for BOTH sides (architect tokens + builder build time)", async () => {
    await renderWithConversation();
    const source = latestEventSource();

    act(() => {
      source.emit(
        entry(1, "usage", {
          side: "architect",
          model: "claude-opus-4-5",
          effort: "max",
          inputTokens: 2000,
          outputTokens: 600,
          durationMs: 7300,
          costUsd: 0.0203
        })
      );
      source.emit(
        entry(2, "usage", {
          side: "builder",
          model: "glm-5.2",
          effort: "high",
          durationMs: 184000
        })
      );
    });

    const usages = screen.getAllByTestId("entry-usage");
    expect(usages).toHaveLength(2);

    // Architect side: model + effort + tokens + cost + turn time.
    const architect = usages.find((node) => node.textContent?.includes("architect usage"));
    expect(architect).toBeDefined();
    expect(architect).toHaveTextContent("claude-opus-4-5");
    expect(architect).toHaveTextContent("effort max");
    expect(architect).toHaveTextContent("2.0k in");
    expect(architect).toHaveTextContent("600 out");
    expect(architect).toHaveTextContent("7s");
    expect(architect).toHaveTextContent("$0.0203");

    // Builder side: model + effort + build wall-clock, NO token chips (the builder emits none).
    const builder = usages.find((node) => node.textContent?.includes("builder usage"));
    expect(builder).toBeDefined();
    expect(builder).toHaveTextContent("glm-5.2");
    expect(builder).toHaveTextContent("effort high");
    expect(builder).toHaveTextContent("3m 4s");
    expect(builder).not.toHaveTextContent("in");
    expect(builder).not.toHaveTextContent("out");
  });

  it("keeps the shaped view buttons accessible by name with their icons", async () => {
    await renderWithConversation();
    // The toggles are now shaped segmented buttons, but the frozen accessible names are preserved.
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Timeline" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Split lanes" })).toBeInTheDocument();
    // The segmented control groups the view buttons.
    expect(screen.getByRole("group", { name: "Transcript view" })).toBeInTheDocument();
  });
});

describe("target selection UI", () => {
  const config: ConfigFixture = {
    targetRepo: "/estate/projects/products/planforge",
    allowedTargets: [
      { path: "/estate/projects/products/planforge", label: "products/planforge" },
      { path: "/estate/projects/agent-workflows/gmail-summary-workflow", label: "agent-workflows/gmail-summary-workflow" }
    ]
  };

  function headerPicker(): HTMLElement {
    const chip = screen.getAllByTestId("target-picker").find((node) => node.className.includes("is-chip"));
    if (!chip) {
      throw new Error("Expected an editable header target picker.");
    }
    return chip;
  }

  it("labels the sidebar picker for NEW conversations, not the active one", async () => {
    setupFetch([{ id: conversationOne, title: "Pre-start", createdAt: 1_800_000_000_000 }], { config });
    render(<App />);
    await screen.findByRole("button", { name: "Pre-start" });

    // The sidebar control is explicitly scoped to new conversations; the old ambiguous "Building in"
    // label (which read identically to the header chip) is gone.
    expect(await screen.findByText("New conversation target")).toBeInTheDocument();
    expect(screen.queryByText("Building in")).toBeNull();
  });

  it("re-points a not-yet-started conversation from the header chip and PATCHes the new target", async () => {
    const fixture = setupFetch([{ id: conversationOne, title: "Pre-start", createdAt: 1_800_000_000_000 }], { config });
    render(<App />);
    await screen.findByRole("button", { name: "Pre-start" });

    const picker = await waitFor(headerPicker);
    fireEvent.click(within(picker).getByRole("button", { name: "Build target" }));
    fireEvent.click(within(picker).getByRole("button", { name: /agent-workflows\/gmail-summary-workflow/ }));

    await waitFor(() => {
      const patch = fixture.calls.find(
        (call) => call.method === "PATCH" && /\/api\/conversations\/[^/]+$/.test(call.url)
      );
      expect(patch?.body).toMatchObject({ targetRepo: "/estate/projects/agent-workflows/gmail-summary-workflow" });
    });
  });

  it("locks the header to a read-only chip once the conversation has started", async () => {
    setupFetch(
      [{ id: conversationOne, title: "Building", createdAt: 1_800_000_000_000, sessionStarted: true, lastSeq: 4 }],
      { config }
    );
    render(<App />);
    await screen.findByRole("button", { name: "Building" });

    // A started conversation exposes no editable header picker (only the sidebar one, for new chats).
    await waitFor(() => expect(screen.getByText("New conversation target")).toBeInTheDocument());
    expect(screen.getAllByTestId("target-picker").some((node) => node.className.includes("is-chip"))).toBe(false);
    expect(screen.getByText("products/planforge")).toBeInTheDocument();
  });
});

describe("model and effort control UI", () => {
  const config: ConfigFixture = {
    targetRepo: "/estate/projects/products/planforge",
    allowedTargets: [{ path: "/estate/projects/products/planforge", label: "products/planforge" }],
    architectModels: ["default", "opus", "sonnet"],
    builderModels: ["default", "gpt-5.2-codex"],
    architectEfforts: ["low", "medium", "high", "xhigh", "max"],
    builderEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"]
  };

  it("sends selected new-conversation model and effort controls while omitting server defaults", async () => {
    const fixture = setupFetch([], { config });
    render(<App />);
    await screen.findByText("New conversation target");

    await userEvent.selectOptions(screen.getByLabelText("Architect model"), "opus");
    await userEvent.selectOptions(screen.getByLabelText("Architect effort"), "max");
    await userEvent.selectOptions(screen.getByLabelText("Builder model"), "gpt-5.2-codex");
    await userEvent.selectOptions(screen.getByLabelText("Builder effort"), "xhigh");
    fireEvent.click(screen.getByRole("button", { name: "New" }));

    await waitFor(() => {
      const post = fixture.calls.find((call) => call.method === "POST" && call.url === "/api/conversations");
      expect(post?.body).toMatchObject({
        architectModel: "opus",
        architectEffort: "max",
        builderModel: "gpt-5.2-codex",
        builderEffort: "xhigh"
      });
      expect((post?.body as Record<string, unknown>).targetRepo).toBeUndefined();
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  });

  it("renders started conversation controls as a summary chip with an expandable read-only panel", async () => {
    setupFetch(
      [
        {
          id: conversationOne,
          title: "Started controls",
          createdAt: 1_800_000_000_000,
          sessionStarted: true,
          lastSeq: 2,
          architectModel: "opus",
          architectEffort: "max",
          builderModel: "gpt-5.2-codex",
          builderEffort: "xhigh"
        }
      ],
      { config }
    );
    render(<App />);
    await screen.findByRole("button", { name: "Started controls" });

    const chip = await screen.findByRole("button", {
      name: "architect opus · max · builder gpt-5.2-codex · xhigh"
    });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByLabelText("Architect model").filter((node) => node instanceof HTMLSelectElement)).toHaveLength(1);

    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("group", { name: "Run controls" });
    expect(within(panel).getByText("Architect model")).toBeInTheDocument();
    expect(within(panel).getByText("opus")).toBeInTheDocument();
    expect(within(panel).getByText("Architect effort")).toBeInTheDocument();
    expect(within(panel).getByText("max")).toBeInTheDocument();
    expect(within(panel).getByText("Builder model")).toBeInTheDocument();
    expect(within(panel).getByText("gpt-5.2-codex")).toBeInTheDocument();
    expect(within(panel).getByText("Builder effort")).toBeInTheDocument();
    expect(within(panel).getByText("xhigh")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(chip).toHaveAttribute("aria-expanded", "false"));
  });
});
