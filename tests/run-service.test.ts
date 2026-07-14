import { describe, expect, it, vi } from "vitest";
import { createChatRunService, type SseClient } from "../src/run-service";

function recordingClient() {
  const records: Array<{ event: string; data: { value: number }; id?: number }> = [];
  const client: SseClient<{ value: number }> = {
    send(event, data, id) {
      records.push({ event, data, id });
    },
    end: vi.fn(),
    cleanup: vi.fn()
  };
  return { client, records };
}

describe("createChatRunService lifecycle", () => {
  it("transitions queued → running → succeeded", async () => {
    const runs = createChatRunService();
    const run = runs.create();

    expect(run.status).toBe("queued");
    runs.markRunning(run);
    expect(run.status).toBe("running");
    runs.finish(run, "succeeded");

    await expect(runs.wait(run)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("transitions running → failed and running → canceled", () => {
    const runs = createChatRunService();
    const failed = runs.create();
    const canceled = runs.create();

    runs.markRunning(failed);
    runs.fail(failed, "TEST_FAILURE", "failure for lifecycle test");
    expect(failed.status).toBe("failed");

    runs.markRunning(canceled);
    runs.cancel(canceled);
    expect(canceled.status).toBe("canceled");
  });
});

describe("createChatRunService streaming", () => {
  it("replay after Last-Event-ID", () => {
    const runs = createChatRunService();
    const run = runs.create();
    const replay = recordingClient();

    const first = runs.emit(run, "agent", { value: 1 });
    const second = runs.emit(run, "agent", { value: 2 });
    const third = runs.emit(run, "agent", { value: 3 });

    runs.subscribe(run, replay.client, { lastEventId: first.id });

    expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);
    expect(replay.records).toEqual([
      { event: "agent", data: { value: 2 }, id: 2 },
      { event: "agent", data: { value: 3 }, id: 3 }
    ]);
  });

  it("multi-client fan-out", () => {
    const runs = createChatRunService();
    const run = runs.create();
    const first = recordingClient();
    const second = recordingClient();

    runs.subscribe(run, first.client);
    runs.subscribe(run, second.client);
    runs.emit(run, "agent", { value: 7 });

    expect(first.records).toEqual(second.records);
    expect(first.records).toEqual([{ event: "agent", data: { value: 7 }, id: 1 }]);
  });
});
