import type { Client } from "../app/types";
import type { OpencodeEvent } from "../app/types";
import type { Event } from "@opencode-ai/sdk/v2/client";

/**
 * Batched event types for optimization
 */
export interface BatchedEvents {
  messages: OpencodeEvent[];
  parts: OpencodeEvent[];
  sessions: OpencodeEvent[];
  todos: OpencodeEvent[];
  permissions: OpencodeEvent[];
  other: OpencodeEvent[];
}

/**
 * Event batch callback type
 */
export type EventBatchCallback = (events: BatchedEvents) => void;

/**
 * Convert SDK Event to OpencodeEvent format
 */
function toOpencodeEvent(event: Event): OpencodeEvent {
  // Extract type and properties based on event discriminant
  if ("serverConnected" in event) {
    return { type: "server.connected", properties: event.serverConnected };
  }
  if ("sessionCreated" in event) {
    return { type: "session.created", properties: event.sessionCreated };
  }
  if ("sessionUpdated" in event) {
    return { type: "session.updated", properties: event.sessionUpdated };
  }
  if ("sessionDeleted" in event) {
    return { type: "session.deleted", properties: event.sessionDeleted };
  }
  if ("sessionStatus" in event) {
    return { type: "session.status", properties: event.sessionStatus };
  }
  if ("sessionIdle" in event) {
    return { type: "session.idle", properties: event.sessionIdle };
  }
  if ("messageUpdated" in event) {
    return { type: "message.updated", properties: event.messageUpdated };
  }
  if ("messageRemoved" in event) {
    return { type: "message.removed", properties: event.messageRemoved };
  }
  if ("messagePartUpdated" in event) {
    return { type: "message.part.updated", properties: event.messagePartUpdated };
  }
  if ("messagePartRemoved" in event) {
    return { type: "message.part.removed", properties: event.messagePartRemoved };
  }
  if ("permissionAsked" in event) {
    return { type: "permission.asked", properties: event.permissionAsked };
  }
  if ("permissionReplied" in event) {
    return { type: "permission.replied", properties: event.permissionReplied };
  }
  if ("todoUpdated" in event) {
    return { type: "todo.updated", properties: event.todoUpdated };
  }

  // Handle other event types - use type branding from SDK
  const type = (event as unknown as { type: string }).type;
  return { type, properties: event };
}

/**
 * SSE Worker for processing event streams off the main thread
 * Uses Comlink for RPC communication with main thread
 */
export class SSEWorker {
  private client: Client | null = null;
  private controller: AbortController | null = null;
  private isRunning = false;
  private batchCallback: EventBatchCallback | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  // Event buffer for batching
  private eventBuffer: OpencodeEvent[] = [];
  private readonly MAX_BUFFER_SIZE = 1000;
  private readonly FLUSH_INTERVAL_MS = 16; // ~60fps sync

  /**
   * Connect to the SSE stream
   */
  async connect(
    getClient: () => Client | null,
    onBatch: EventBatchCallback,
    onError?: (error: Error) => void
  ): Promise<void> {
    try {
      this.batchCallback = onBatch;
      this.isRunning = true;
      this.client = null;

      // Start the flush timer for batching
      this.startFlushTimer();

      // Subscribe to events
      this.controller = new AbortController();

      const client = getClient();
      if (!client) {
        throw new Error("Client not available");
      }
      this.client = client;

      // Access the internal SDK client for event subscription
      // The OpencodeClient has event.subscribe method
      const sdkClient = (client as unknown as { event: { subscribe: (filter?: unknown, options?: { signal?: AbortSignal }) => { stream: AsyncIterable<Event> } } }).event;
      if (!sdkClient?.subscribe) {
        throw new Error("Event subscription not available");
      }

      const sub = await sdkClient.subscribe(undefined, { signal: this.controller.signal });

      for await (const raw of sub.stream) {
        if (!this.isRunning) break;

        const event = toOpencodeEvent(raw);
        this.addEvent(event);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.isRunning) {
        onError?.(err);
      }
    }
  }

  /**
   * Add event to buffer with overflow handling
   */
  private addEvent(event: OpencodeEvent): void {
    if (this.eventBuffer.length >= this.MAX_BUFFER_SIZE) {
      console.warn(`[SSE Worker] Queue overflow: ${this.eventBuffer.length} events, dropping oldest`);
      // Remove oldest 10% of buffer to make room
      const removeCount = Math.floor(this.MAX_BUFFER_SIZE * 0.1);
      this.eventBuffer.splice(0, removeCount);
    }
    this.eventBuffer.push(event);
  }

  /**
   * Start the flush timer for batching
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushBuffer();
    }, this.FLUSH_INTERVAL_MS);
  }

  /**
   * Flush the event buffer and call batch callback
   */
  private flushBuffer(): void {
    if (this.eventBuffer.length === 0 || !this.batchCallback) return;

    // Group events by type
    const batched: BatchedEvents = {
      messages: [],
      parts: [],
      sessions: [],
      todos: [],
      permissions: [],
      other: [],
    };

    for (const event of this.eventBuffer) {
      if (event.type.startsWith("message.")) {
        if (event.type === "message.part.updated" || event.type === "message.part.removed") {
          batched.parts.push(event);
        } else {
          batched.messages.push(event);
        }
      } else if (event.type.startsWith("session.")) {
        batched.sessions.push(event);
      } else if (event.type === "todo.updated") {
        batched.todos.push(event);
      } else if (event.type.startsWith("permission.")) {
        batched.permissions.push(event);
      } else {
        batched.other.push(event);
      }
    }

    // Clear buffer
    this.eventBuffer = [];

    // Send batch to main thread
    this.batchCallback(batched);
  }

  /**
   * Called when batch is processed - enables flow control if needed
   */
  onBatchProcessed(): void {
    // Could be used for flow control in future iterations
  }

  /**
   * Disconnect from SSE stream
   */
  disconnect(): void {
    this.isRunning = false;

    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Abort controller
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }

    // Clear buffer
    this.eventBuffer = [];
    this.batchCallback = null;
    this.client = null;
  }

  /**
   * Check if worker is running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

export default SSEWorker;
