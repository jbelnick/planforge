import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConversationStore,
  type Conversation,
  type TranscriptEntry
} from "../src/conversation-store";
import { PlanForgeError } from "../src/errors";
import type { SseClient } from "../src/run-service";

type Frame = {
  readonly event: string;
  readonly data: TranscriptEntry;
  readonly id?: number;
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempConversationRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-conversation-store-"));
  tempDirs.push(root);
  return path.join(root, "conversations");
}

function conversationPath(root: string, id: string): string {
  return path.join(root, id, "conversation.json");
}

function transcriptPath(root: string, id: string): string {
  return path.join(root, id, "transcript.jsonl");
}

function recordingClient() {
  const frames: Frame[] = [];
  let cleanupCount = 0;
  let endCount = 0;
  const client: SseClient<TranscriptEntry> = {
    send(event, data, id) {
      frames.push({ event, data, id });
    },
    end() {
      endCount += 1;
    },
    cleanup() {
      cleanupCount += 1;
    }
  };
  return {
    client,
    frames,
    cleanupCount: () => cleanupCount,
    endCount: () => endCount
  };
}

async function readPersistedConversation(root: string, id: string): Promise<Conversation> {
  return JSON.parse(await readFile(conversationPath(root, id), "utf8")) as Conversation;
}

async function readPersistedTranscript(root: string, id: string): Promise<TranscriptEntry[]> {
  const content = await readFile(transcriptPath(root, id), "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptEntry);
}

describe("createConversationStore persistence", () => {
  it("creates conversation files, reads them back, lists newest first, and returns null for missing ids", async () => {
    const root = await tempConversationRoot();
    let currentTime = 1_000;
    const ids = ["conversation-a", "conversation-b"];
    const store = createConversationStore({
      root,
      now: () => currentTime,
      idFactory: () => ids.shift() ?? "unexpected-id"
    });

    const first = await store.create({ title: "Alpha" });
    currentTime = 2_000;
    const second = await store.create();

    expect((await stat(conversationPath(root, first.id))).isFile()).toBe(true);
    expect(await readFile(transcriptPath(root, first.id), "utf8")).toBe("");
    expect(first.sessionStarted).toBe(false);
    await expect(store.get(first.id)).resolves.toEqual(first);
    await expect(store.get("missing-conversation")).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([second, first]);
  });

  it("marks sessionStarted durably across store instances", async () => {
    const root = await tempConversationRoot();
    const storeA = createConversationStore({ root, idFactory: () => "conversation-started" });
    const conversation = await storeA.create();

    await storeA.markSessionStarted(conversation.id);
    await storeA.markSessionStarted(conversation.id);
    const storeB = createConversationStore({ root });

    await expect(storeB.get(conversation.id)).resolves.toMatchObject({
      id: conversation.id,
      sessionStarted: true
    });
  });

  it("throws E_CONVERSATION_NOT_FOUND when marking a missing conversation as started", async () => {
    const root = await tempConversationRoot();
    const store = createConversationStore({ root });

    await expect(store.markSessionStarted("missing")).rejects.toMatchObject({
      code: "E_CONVERSATION_NOT_FOUND"
    });
  });

  it("treats a missing conversation.json as absent but surfaces a corrupt one loudly as E_CONVERSATION_CORRUPT", async () => {
    const root = await tempConversationRoot();
    const store = createConversationStore({ root, now: () => 1_000, idFactory: () => "valid" });
    const valid = await store.create({ title: "Valid" });
    await mkdir(path.join(root, "bare-dir"), { recursive: true });
    await mkdir(path.join(root, "malformed"), { recursive: true });
    await writeFile(path.join(root, "malformed", "conversation.json"), "{", "utf8");
    await writeFile(path.join(root, ".DS_Store"), "ignored", "utf8");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // ENOENT is genuine absence.
      await expect(store.get("bare-dir")).resolves.toBeNull();
      // Corruption is NOT absence: the conversation (and its possibly intact transcript) must not
      // silently vanish. get/append surface a distinct error instead of E_CONVERSATION_NOT_FOUND…
      await expect(store.get("malformed")).rejects.toMatchObject({ code: "E_CONVERSATION_CORRUPT" });
      await expect(store.append("malformed", "user_message", { text: "hi" })).rejects.toMatchObject({
        code: "E_CONVERSATION_CORRUPT"
      });
      expect(errorSpy).toHaveBeenCalled();
      // …while list stays available, skipping the corrupt conversation instead of failing wholesale.
      await expect(store.list()).resolves.toEqual([valid]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("appends monotonic transcript entries, updates conversation metadata, and fans out live entries", async () => {
    const root = await tempConversationRoot();
    let currentTime = 10;
    const store = createConversationStore({ root, now: () => currentTime, idFactory: () => "conversation-live" });
    const conversation = await store.create();
    const subscriber = recordingClient();
    await store.subscribe(conversation.id, subscriber.client);

    currentTime = 11;
    const first = await store.append(conversation.id, "user_message", { text: "hello" });
    currentTime = 12;
    const second = await store.append(conversation.id, "architect_message", { text: "hi" });

    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(await readPersistedTranscript(root, conversation.id)).toEqual([first, second]);
    await expect(readPersistedConversation(root, conversation.id)).resolves.toMatchObject({
      updatedAt: 12,
      lastSeq: 2
    });
    expect(subscriber.frames).toEqual([
      { event: "user_message", data: first, id: 1 },
      { event: "architect_message", data: second, id: 2 }
    ]);
  });

  it("throws E_CONVERSATION_NOT_FOUND when appending to a missing conversation", async () => {
    const root = await tempConversationRoot();
    const store = createConversationStore({ root });

    await expect(store.append("missing", "error", { message: "missing" })).rejects.toMatchObject({
      code: "E_CONVERSATION_NOT_FOUND"
    });
  });

  it("replays after Last-Event-ID, streams live entries, and stops after unsubscribe", async () => {
    const root = await tempConversationRoot();
    let currentTime = 100;
    const store = createConversationStore({ root, now: () => currentTime, idFactory: () => "conversation-replay" });
    const conversation = await store.create();
    currentTime = 101;
    const first = await store.append(conversation.id, "user_message", { text: "one" });
    currentTime = 102;
    const second = await store.append(conversation.id, "architect_message", { text: "two" });

    const replayAll = recordingClient();
    const unsubscribeAll = await store.subscribe(conversation.id, replayAll.client, { lastEventId: 0 });
    expect(replayAll.frames).toEqual([
      { event: "user_message", data: first, id: 1 },
      { event: "architect_message", data: second, id: 2 }
    ]);

    const invalidLastEventId = recordingClient();
    const unsubscribeInvalid = await store.subscribe(conversation.id, invalidLastEventId.client, {
      lastEventId: Number.POSITIVE_INFINITY
    });
    expect(invalidLastEventId.frames).toEqual([
      { event: "user_message", data: first, id: 1 },
      { event: "architect_message", data: second, id: 2 }
    ]);

    const replayAfterOne = recordingClient();
    const unsubscribeAfterOne = await store.subscribe(conversation.id, replayAfterOne.client, { lastEventId: 1 });
    expect(replayAfterOne.frames).toEqual([{ event: "architect_message", data: second, id: 2 }]);

    currentTime = 103;
    const third = await store.append(conversation.id, "tool_use", { name: "mcp__planforge__propose_plan" });
    expect(replayAfterOne.frames).toEqual([
      { event: "architect_message", data: second, id: 2 },
      { event: "tool_use", data: third, id: 3 }
    ]);

    unsubscribeAfterOne();
    currentTime = 104;
    await store.append(conversation.id, "tool_result", { status: "ok" });
    expect(replayAfterOne.frames).toEqual([
      { event: "architect_message", data: second, id: 2 },
      { event: "tool_use", data: third, id: 3 }
    ]);
    expect(replayAfterOne.cleanupCount()).toBe(1);
    expect(replayAfterOne.endCount()).toBe(0);
    unsubscribeInvalid();
    unsubscribeAll();
  });

  it("delivers an append racing subscribe exactly once with gap-free seqs", async () => {
    const root = await tempConversationRoot();
    let currentTime = 200;
    const store = createConversationStore({ root, now: () => currentTime, idFactory: () => "conversation-race" });
    const conversation = await store.create();
    currentTime = 201;
    await store.append(conversation.id, "user_message", { text: "one" });
    currentTime = 202;
    await store.append(conversation.id, "architect_message", { text: "two" });
    const client = recordingClient();

    currentTime = 203;
    const [unsubscribe] = await Promise.all([
      store.subscribe(conversation.id, client.client, { lastEventId: 0 }),
      store.append(conversation.id, "plan_proposed", { title: "Race plan" })
    ]);

    const seqs = client.frames.map((frame) => frame.id);
    expect(seqs).toEqual([1, 2, 3]);
    expect(new Set(seqs).size).toBe(seqs.length);
    unsubscribe();
  });

  it("recovers the next seq from transcript.jsonl when conversation.json lastSeq is stale", async () => {
    const root = await tempConversationRoot();
    let currentTime = 300;
    const storeA = createConversationStore({ root, now: () => currentTime, idFactory: () => "conversation-stale" });
    const conversation = await storeA.create();
    currentTime = 301;
    await storeA.append(conversation.id, "user_message", { text: "one" });
    currentTime = 302;
    await storeA.append(conversation.id, "architect_message", { text: "two" });
    const staleConversation = await readPersistedConversation(root, conversation.id);
    await writeFile(
      conversationPath(root, conversation.id),
      `${JSON.stringify({ ...staleConversation, updatedAt: 301, lastSeq: 1 })}\n`,
      "utf8"
    );

    currentTime = 303;
    const storeB = createConversationStore({ root, now: () => currentTime });
    const next = await storeB.append(conversation.id, "verify_result", { status: "pass" });

    expect(next.seq).toBe(3);
    await expect(readPersistedConversation(root, conversation.id)).resolves.toMatchObject({
      updatedAt: 303,
      lastSeq: 3
    });
  });

  it("persists conversations and transcript replay across a fresh store instance", async () => {
    const root = await tempConversationRoot();
    let currentTime = 400;
    const storeA = createConversationStore({ root, now: () => currentTime, idFactory: () => "conversation-durable" });
    const conversation = await storeA.create({ title: "Durable" });
    currentTime = 401;
    const entry = await storeA.append(conversation.id, "approval", { verdict: "approved" });

    const storeB = createConversationStore({ root, now: () => 500 });
    await expect(storeB.get(conversation.id)).resolves.toMatchObject({
      id: conversation.id,
      title: "Durable",
      lastSeq: 1
    });
    await expect(storeB.list()).resolves.toHaveLength(1);
    await expect(storeB.readTranscript(conversation.id)).resolves.toEqual([entry]);

    const client = recordingClient();
    const unsubscribe = await storeB.subscribe(conversation.id, client.client, { lastEventId: 0 });
    expect(client.frames).toEqual([{ event: "approval", data: entry, id: 1 }]);
    unsubscribe();
  });

  it("self-heals a corrupt mid-file transcript line in subscribe instead of throwing on reconnect", async () => {
    const root = await tempConversationRoot();
    const store = createConversationStore({ root, idFactory: () => "conversation-corrupt" });
    const conversation = await store.create();
    // A corrupt entry that is NOT the last line cannot be dismissed as a torn tail; subscribe must
    // quarantine just that line and keep replaying the valid entries on every reconnect.
    await writeFile(
      transcriptPath(root, conversation.id),
      [
        '{"seq":1,"ts":1,"type":"user_message","data":{"text":"hi"}}',
        '{"seq":2,"ts":2,"type":"bogus","data":{}}',
        '{"seq":3,"ts":3,"type":"user_message","data":{"text":"bye"}}',
        ""
      ].join("\n"),
      "utf8"
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = recordingClient();
      const unsubscribe = await store.subscribe(conversation.id, client.client, { lastEventId: 0 });
      expect(client.frames.map((frame) => [frame.event, frame.data.seq])).toEqual([
        ["user_message", 1],
        ["user_message", 3]
      ]);
      unsubscribe();
    }
  });

  it("tolerates a corrupt mid-file transcript line on append with a gap-free monotonic seq", async () => {
    const root = await tempConversationRoot();
    let currentTime = 550;
    const store = createConversationStore({ root, now: () => currentTime, idFactory: () => "conversation-append-corrupt" });
    const conversation = await store.create();
    // A corrupt entry that is NOT the last line cannot be dismissed as a torn tail. append must
    // quarantine just that line (as subscribe does) instead of rejecting forever, and compute the
    // next seq from the surviving entries so the transcript stays gap-free and monotonic.
    await writeFile(
      transcriptPath(root, conversation.id),
      [
        '{"seq":1,"ts":1,"type":"user_message","data":{"text":"hi"}}',
        '{"seq":2,"ts":2,"type":"bogus","data":{}}',
        '{"seq":3,"ts":3,"type":"user_message","data":{"text":"bye"}}',
        ""
      ].join("\n"),
      "utf8"
    );

    currentTime = 551;
    const next = await store.append(conversation.id, "verify_result", { status: "pass" });

    // Next seq is computed from the surviving entries (1, 3), so the new entry is 4 — gap-free and
    // strictly greater than every surviving seq — rather than rejecting on the corrupt mid-file line.
    expect(next.seq).toBe(4);
    await expect(readPersistedConversation(root, conversation.id)).resolves.toMatchObject({
      updatedAt: 551,
      lastSeq: 4
    });
    // The append landed; a quarantining reader (as subscribe uses on replay) sees the gap-free chain.
    const client = recordingClient();
    const unsubscribe = await store.subscribe(conversation.id, client.client, { lastEventId: 0 });
    expect(client.frames.map((frame) => frame.data.seq)).toEqual([1, 3, 4]);
    unsubscribe();
  });

  it("skips a torn trailing transcript line and repairs it before the next append", async () => {
    const root = await tempConversationRoot();
    let currentTime = 600;
    const store = createConversationStore({ root, now: () => currentTime, idFactory: () => "conversation-torn" });
    const conversation = await store.create();
    const validEntry: TranscriptEntry = {
      seq: 1,
      ts: 601,
      type: "cycle_complete",
      data: { status: "done" }
    };
    await writeFile(transcriptPath(root, conversation.id), `${JSON.stringify(validEntry)}\n{"seq":2`, "utf8");

    await expect(store.readTranscript(conversation.id)).resolves.toEqual([validEntry]);
    currentTime = 602;
    const next = await store.append(conversation.id, "error", { message: "after torn tail" });

    expect(next.seq).toBe(2);
    await expect(store.readTranscript(conversation.id)).resolves.toEqual([validEntry, next]);
    expect(await readPersistedTranscript(root, conversation.id)).toEqual([validEntry, next]);
  });

  it("invalidates the warm tail cache on an append failure so the next append repairs a torn tail", async () => {
    const root = await tempConversationRoot();
    let currentTime = 700;
    const store = createConversationStore({ root, now: () => currentTime, idFactory: () => "conversation-append-fail" });
    const conversation = await store.create();
    // Prime the warm tail cache with a successful append (tail = 1).
    const first = await store.append(conversation.id, "user_message", { text: "hi" });
    expect(first.seq).toBe(1);

    // Fail the next append mid-write (EACCES stands in for ENOSPC/EIO), then simulate the partial
    // flush such a failure can leave behind: torn bytes with no trailing newline.
    await chmod(transcriptPath(root, conversation.id), 0o400);
    await expect(store.append(conversation.id, "user_message", { text: "lost" })).rejects.toMatchObject({
      code: "EACCES"
    });
    await chmod(transcriptPath(root, conversation.id), 0o600);
    await appendFile(transcriptPath(root, conversation.id), '{"seq":2,"ts":', "utf8");

    // The failure invalidated the cache, so this append re-runs the full read/repair path: the torn
    // tail is repaired and the new entry lands as seq 2 on its own line. A still-warm cache would
    // have appended straight after the torn bytes, welding two entries onto one corrupt line.
    currentTime = 701;
    const next = await store.append(conversation.id, "error", { message: "after failed append" });
    expect(next.seq).toBe(2);
    expect(await readPersistedTranscript(root, conversation.id)).toEqual([first, next]);
  });
});

describe("createConversationStore rename and archive", () => {
  it("rename trims, persists, and round-trips the title across store instances", async () => {
    const root = await tempConversationRoot();
    let currentTime = 1_000;
    const storeA = createConversationStore({ root, now: () => currentTime, idFactory: () => "conversation-rename" });
    const conversation = await storeA.create();

    currentTime = 1_100;
    const renamed = await storeA.rename(conversation.id, "  Shaped title  ");
    expect(renamed.title).toBe("Shaped title");
    expect(renamed.updatedAt).toBe(1_100);

    // A fresh store reads the renamed title back from disk (durable, not in-memory only).
    const storeB = createConversationStore({ root });
    await expect(storeB.get(conversation.id)).resolves.toMatchObject({
      id: conversation.id,
      title: "Shaped title",
      archived: false
    });
  });

  it("rename rejects an empty or over-long title and leaves the existing title intact", async () => {
    const root = await tempConversationRoot();
    const store = createConversationStore({ root, idFactory: () => "conversation-rename-guard" });
    const conversation = await store.create({ title: "Original" });

    await expect(store.rename(conversation.id, "   ")).rejects.toMatchObject({ code: "E_INVALID_TITLE" });
    await expect(store.rename(conversation.id, "x".repeat(201))).rejects.toMatchObject({ code: "E_INVALID_TITLE" });
    await expect(store.rename("missing", "Anything")).rejects.toMatchObject({ code: "E_CONVERSATION_NOT_FOUND" });

    // The rejected renames did not mutate the stored title.
    await expect(store.get(conversation.id)).resolves.toMatchObject({ title: "Original" });
  });

  it("archives a conversation out of the default list and restores it on demand", async () => {
    const root = await tempConversationRoot();
    let currentTime = 2_000;
    const ids = ["conversation-active", "conversation-doomed"];
    const store = createConversationStore({
      root,
      now: () => currentTime,
      idFactory: () => ids.shift() ?? "unexpected-id"
    });
    const active = await store.create({ title: "Active" });
    currentTime = 2_100;
    const doomed = await store.create({ title: "Doomed" });

    currentTime = 2_200;
    await store.setArchived(doomed.id, true);

    // Default list excludes the archived conversation.
    const live = await store.list();
    expect(live.map((entry) => entry.id)).toEqual([active.id]);
    expect(live.every((entry) => !entry.archived)).toBe(true);

    // includeArchived surfaces it again.
    const full = await store.list({ includeArchived: true });
    expect(full.map((entry) => entry.id).sort()).toEqual([active.id, doomed.id].sort());
    expect(full.find((entry) => entry.id === doomed.id)?.archived).toBe(true);

    // Restoring brings it back into the default list.
    currentTime = 2_300;
    await store.setArchived(doomed.id, false);
    expect((await store.list()).map((entry) => entry.id).sort()).toEqual([active.id, doomed.id].sort());
  });

  it("persists the archived flag across a fresh store instance and a legacy file without the field", async () => {
    const root = await tempConversationRoot();
    let currentTime = 3_000;
    const storeA = createConversationStore({ root, now: () => currentTime, idFactory: () => "conversation-archive-durable" });
    const conversation = await storeA.create();
    currentTime = 3_100;
    await storeA.setArchived(conversation.id, true);

    // A fresh store reads the archived flag back from disk.
    const storeB = createConversationStore({ root });
    await expect(storeB.get(conversation.id)).resolves.toMatchObject({ id: conversation.id, archived: true });

    // A legacy conversation.json written without an `archived` field defaults to not-archived, so an
    // existing store's conversations do not disappear or error when this field is added.
    const legacyId = "conversation-legacy";
    await mkdir(path.join(root, legacyId), { recursive: true });
    await writeFile(
      path.join(root, legacyId, "conversation.json"),
      `${JSON.stringify({
        id: legacyId,
        createdAt: 3_200,
        updatedAt: 3_200,
        title: "Legacy",
        lastSeq: 0,
        sessionStarted: false
      })}\n`,
      "utf8"
    );
    const storeC = createConversationStore({ root });
    await expect(storeC.get(legacyId)).resolves.toMatchObject({ id: legacyId, archived: false });
    expect((await storeC.list()).some((entry) => entry.id === legacyId)).toBe(true);
  });
});

describe("createConversationStore target validation", () => {
  it("runs the validateTargetRepo gate at create time and rejects a disallowed target", async () => {
    const root = await tempConversationRoot();
    const seen: string[] = [];
    const store = createConversationStore({
      root,
      validateTargetRepo: (targetRepo) => {
        seen.push(targetRepo);
        if (!targetRepo.startsWith("/allowed/")) {
          throw new PlanForgeError("E_TARGET_NOT_ALLOWLISTED", "disallowed");
        }
      }
    });

    const allowed = await store.create({ targetRepo: "/allowed/planforge" });
    expect(allowed.targetRepo).toBe("/allowed/planforge");

    const disallowed = store.create({ targetRepo: "/etc/passwd" });
    await expect(disallowed).rejects.toMatchObject({ code: "E_TARGET_NOT_ALLOWLISTED" });
    // The gate was invoked for the disallowed target (it pushes then throws), so the validator saw it.
    expect(seen).toContain("/etc/passwd");

    // A conversation with no chosen target is created without invoking the gate (server default).
    seen.length = 0;
    const defaulted = await store.create({});
    expect(defaulted.targetRepo).toBeNull();
    expect(seen).toEqual([]);
  });

  it("persists and round-trips the per-conversation targetRepo", async () => {
    const root = await tempConversationRoot();
    const storeA = createConversationStore({ root });
    const created = await storeA.create({ targetRepo: "/allowed/planforge" });

    const storeB = createConversationStore({ root });
    await expect(storeB.get(created.id)).resolves.toMatchObject({
      id: created.id,
      targetRepo: "/allowed/planforge"
    });
  });

  it("updateTarget re-points a not-yet-started conversation through the allowlist gate and persists", async () => {
    const root = await tempConversationRoot();
    let currentTime = 1_000;
    const store = createConversationStore({
      root,
      now: () => currentTime,
      validateTargetRepo: (targetRepo) => {
        if (!targetRepo.startsWith("/allowed/")) {
          throw new PlanForgeError("E_TARGET_NOT_ALLOWLISTED", "disallowed");
        }
      }
    });
    const created = await store.create({ targetRepo: "/allowed/first" });

    currentTime = 1_100;
    const updated = await store.updateTarget(created.id, "/allowed/second");
    expect(updated.targetRepo).toBe("/allowed/second");
    expect(updated.updatedAt).toBe(1_100);

    // Durable across a fresh store instance.
    const storeB = createConversationStore({ root });
    await expect(storeB.get(created.id)).resolves.toMatchObject({ id: created.id, targetRepo: "/allowed/second" });
  });

  it("updateTarget rejects a disallowed target and leaves the existing target intact", async () => {
    const root = await tempConversationRoot();
    const store = createConversationStore({
      root,
      validateTargetRepo: (targetRepo) => {
        if (!targetRepo.startsWith("/allowed/")) {
          throw new PlanForgeError("E_TARGET_NOT_ALLOWLISTED", "disallowed");
        }
      }
    });
    const created = await store.create({ targetRepo: "/allowed/keep" });

    await expect(store.updateTarget(created.id, "/etc/passwd")).rejects.toMatchObject({
      code: "E_TARGET_NOT_ALLOWLISTED"
    });
    await expect(store.get(created.id)).resolves.toMatchObject({ targetRepo: "/allowed/keep" });
  });

  it("updateTarget refuses to re-point a conversation whose session has started", async () => {
    const root = await tempConversationRoot();
    const store = createConversationStore({ root, validateTargetRepo: () => {} });
    const created = await store.create({ targetRepo: "/allowed/locked" });
    await store.markSessionStarted(created.id);

    await expect(store.updateTarget(created.id, "/allowed/elsewhere")).rejects.toMatchObject({
      code: "E_SESSION_ALREADY_STARTED"
    });
    // The locked target is unchanged.
    await expect(store.get(created.id)).resolves.toMatchObject({ targetRepo: "/allowed/locked" });
  });

  it("updateTarget throws E_CONVERSATION_NOT_FOUND for a missing conversation", async () => {
    const root = await tempConversationRoot();
    const store = createConversationStore({ root, validateTargetRepo: () => {} });

    await expect(store.updateTarget("missing", "/allowed/x")).rejects.toMatchObject({
      code: "E_CONVERSATION_NOT_FOUND"
    });
  });

  it("persists and round-trips per-conversation model and effort controls", async () => {
    const root = await tempConversationRoot();
    const storeA = createConversationStore({ root });
    const created = await storeA.create({
      architectModel: "opus",
      architectEffort: "max",
      builderModel: "gpt-5.2-codex",
      builderEffort: "xhigh"
    });

    const storeB = createConversationStore({ root });
    await expect(storeB.get(created.id)).resolves.toMatchObject({
      architectModel: "opus",
      architectEffort: "max",
      builderModel: "gpt-5.2-codex",
      builderEffort: "xhigh"
    });
  });

  it("updateRunControls edits controls before start and rejects them after start", async () => {
    const root = await tempConversationRoot();
    const store = createConversationStore({ root });
    const created = await store.create({});

    await expect(
      store.updateRunControls(created.id, {
        architectModel: "sonnet",
        architectEffort: "high",
        builderModel: "default",
        builderEffort: "medium"
      })
    ).resolves.toMatchObject({
      architectModel: "sonnet",
      architectEffort: "high",
      builderModel: "default",
      builderEffort: "medium"
    });

    await store.markSessionStarted(created.id);
    await expect(store.updateRunControls(created.id, { builderEffort: "xhigh" })).rejects.toMatchObject({
      code: "E_SESSION_ALREADY_STARTED"
    });
    await expect(store.get(created.id)).resolves.toMatchObject({ builderEffort: "medium" });
  });
});
