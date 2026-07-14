import type { DaemonAgentPayload } from "../domain";
import type { JsonArray, JsonObject, JsonValue } from "../run-service";

type BlockScratch = {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  input: string;
};

function asObject(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function asArray(value: JsonValue | undefined): JsonArray {
  return Array.isArray(value) ? value : [];
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function asBoolean(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseJsonValue(line: string): JsonValue | null {
  try {
    return JSON.parse(line) as JsonValue;
  } catch {
    return null;
  }
}

function stringifyToolResult(content: JsonValue | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const object = asObject(item);
        return object && object.type === "text" && typeof object.text === "string" ? object.text : JSON.stringify(item);
      })
      .join("\n");
  }
  return JSON.stringify(content ?? null);
}

export function createClaudeStreamParser(onEvent: (event: DaemonAgentPayload) => void) {
  let buffer = "";
  let currentMessageId: string | null = null;
  const blocks = new Map<string, BlockScratch>();
  // The message whose text/thinking already went out as stream_event deltas. Deltas and the full
  // assistant echo arrive for one message at a time, so only the current id is needed — a Set here
  // would accrue every assistant message id for the life of the session.
  let textStreamedMessageId: string | null = null;

  function blockKey(index: number): string {
    return `${currentMessageId ?? "anon"}:${index}`;
  }

  function feed(chunk: string): void {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        handleLine(line);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }

  function flush(): void {
    const line = buffer.trim();
    buffer = "";
    if (line.length > 0) {
      handleLine(line);
    }
  }

  function handleLine(line: string): void {
    const value = parseJsonValue(line);
    const object = asObject(value ?? undefined);
    if (!object) {
      onEvent({ type: "raw", line });
      return;
    }
    handleObject(object);
  }

  function handleObject(object: JsonObject): void {
    const type = asString(object.type);
    if (type === "system" && object.subtype === "init") {
      const model = asString(object.model) ?? undefined;
      onEvent({ type: "status", label: "initializing", ...(model ? { model } : {}) });
      return;
    }
    if (type === "system" && object.subtype === "status") {
      onEvent({ type: "status", label: asString(object.status) ?? "working" });
      return;
    }
    if (type === "stream_event") {
      const event = asObject(object.event);
      if (event) {
        handleStreamEvent(event);
      }
      return;
    }
    if (type === "assistant") {
      const message = asObject(object.message);
      if (!message) {
        return;
      }
      currentMessageId = asString(message.id) ?? currentMessageId;
      const alreadyStreamed = currentMessageId !== null && textStreamedMessageId === currentMessageId;
      for (const content of asArray(message.content)) {
        const block = asObject(content);
        if (!block) {
          continue;
        }
        if (block.type === "tool_use") {
          onEvent({
            type: "tool_use",
            id: asString(block.id) ?? "",
            name: asString(block.name) ?? "",
            input: block.input ?? null
          });
        } else if (!alreadyStreamed && block.type === "text") {
          const text = asString(block.text);
          if (text && text.length > 0) {
            onEvent({ type: "text_delta", delta: text });
          }
        } else if (!alreadyStreamed && block.type === "thinking") {
          const thinking = asString(block.thinking);
          if (thinking && thinking.length > 0) {
            onEvent({ type: "thinking_delta", delta: thinking });
          }
        }
      }
      return;
    }
    if (type === "user") {
      const message = asObject(object.message);
      for (const content of asArray(message?.content)) {
        const block = asObject(content);
        if (block?.type === "tool_result") {
          onEvent({
            type: "tool_result",
            toolUseId: asString(block.tool_use_id) ?? "",
            content: stringifyToolResult(block.content),
            isError: asBoolean(block.is_error) ?? false
          });
        }
      }
      return;
    }
    if (type === "result") {
      const usage = asObject(object.usage);
      onEvent({
        type: "usage",
        ...(usage
          ? {
              usage: {
                ...(asNumber(usage.input_tokens) !== null ? { input_tokens: asNumber(usage.input_tokens) ?? undefined } : {}),
                ...(asNumber(usage.output_tokens) !== null ? { output_tokens: asNumber(usage.output_tokens) ?? undefined } : {})
              }
            }
          : {}),
        ...(asNumber(object.total_cost_usd) !== null ? { costUsd: asNumber(object.total_cost_usd) ?? undefined } : {}),
        ...(asNumber(object.duration_ms) !== null ? { durationMs: asNumber(object.duration_ms) ?? undefined } : {})
      });
    }
  }

  function handleStreamEvent(event: JsonObject): void {
    const type = asString(event.type);
    if (type === "message_start") {
      const message = asObject(event.message);
      currentMessageId = asString(message?.id);
      const ttftMs = asNumber(event.ttft_ms);
      onEvent({ type: "status", label: "streaming", ...(ttftMs !== null ? { ttftMs } : {}) });
      return;
    }
    if (type === "content_block_start") {
      const index = asNumber(event.index);
      const block = asObject(event.content_block);
      if (index === null || !block) {
        return;
      }
      blocks.set(blockKey(index), {
        type: asString(block.type) ?? "",
        id: asString(block.id) ?? undefined,
        name: asString(block.name) ?? undefined,
        input: ""
      });
      if (block.type === "thinking") {
        onEvent({ type: "thinking_start" });
      }
      return;
    }
    if (type === "content_block_delta") {
      const index = asNumber(event.index);
      const delta = asObject(event.delta);
      if (index === null || !delta) {
        return;
      }
      const state = blocks.get(blockKey(index));
      if (delta.type === "text_delta") {
        const text = asString(delta.text);
        if (text !== null) {
          if (currentMessageId) {
            textStreamedMessageId = currentMessageId;
          }
          onEvent({ type: "text_delta", delta: text });
        }
        return;
      }
      if (delta.type === "thinking_delta") {
        const thinking = asString(delta.thinking);
        if (thinking !== null) {
          if (currentMessageId) {
            textStreamedMessageId = currentMessageId;
          }
          onEvent({ type: "thinking_delta", delta: thinking });
        }
        return;
      }
      if (delta.type === "input_json_delta" && state?.type === "tool_use") {
        state.input += asString(delta.partial_json) ?? "";
      }
      return;
    }
    if (type === "content_block_stop") {
      const index = asNumber(event.index);
      if (index !== null) {
        blocks.delete(blockKey(index));
      }
    }
  }

  return { feed, flush };
}

export function parseClaudeStreamJsonLines(source: string): DaemonAgentPayload[] {
  const events: DaemonAgentPayload[] = [];
  const parser = createClaudeStreamParser((event) => events.push(event));
  parser.feed(source);
  parser.flush();
  return events;
}
