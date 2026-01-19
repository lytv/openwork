import * as Comlink from "comlink";
import type { Client } from "../app/types";
import type { OpencodeEvent } from "../app/types";
import type { Event } from "@opencode-ai/sdk/v2/client";
import type { SSEWorker } from "../workers/sse-worker";
import type { ComputationWorker } from "../workers/computation-worker";
import { isFeatureEnabled } from "../config/features";

/**
 * Remote worker types (Comlink-wrapped)
 */
export type RemoteSSEWorker = Comlink.Remote<SSEWorker>;
export type RemoteComputationWorker = Comlink.Remote<ComputationWorker>;

/**
 * Interface for SSE event processors
 * Both worker-based and main thread implementations conform to this
 */
export interface SSEProcessor {
  /**
   * Connect to SSE stream
   */
  connect(
    getClient: () => Client | null,
    onBatch: (events: {
      messages: OpencodeEvent[];
      parts: OpencodeEvent[];
      sessions: OpencodeEvent[];
      todos: OpencodeEvent[];
      permissions: OpencodeEvent[];
      other: OpencodeEvent[];
    }) => void,
    onError: (error: Error) => void
  ): Promise<void>;

  /**
   * Disconnect from SSE stream
   */
  disconnect(): Promise<void>;
}

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
 * Check if cross-origin isolation is enabled
 * Required for SharedArrayBuffer which is used in Phase 3
 */
export function isCrossOriginIsolated(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.crossOriginIsolated === true ||
    // Check for the presence of SharedArrayBuffer (requires isolation)
    typeof window.SharedArrayBuffer !== "undefined"
  );
}

/**
 * Check if SharedArrayBuffer is available (required for some worker features)
 * This indicates cross-origin isolation is properly configured
 */
export function isSharedArrayBufferAvailable(): boolean {
  return typeof SharedArrayBuffer !== "undefined";
}

/**
 * Check if web workers are available in the current environment
 */
export function areWorkersAvailable(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof Worker === "undefined") return false;

  // Check if we're in a context that supports workers
  try {
    // Some environments block worker creation
    const testWorker = new Worker("data:text/javascript,1");
    testWorker.terminate();
    return true;
  } catch {
    return false;
  }
}

/**
 * Main thread SSE Processor fallback
 * Processes SSE events directly on the main thread when workers are unavailable
 */
export class MainThreadSSEProcessor implements SSEProcessor {
  private onBatch: ((events: {
    messages: OpencodeEvent[];
    parts: OpencodeEvent[];
    sessions: OpencodeEvent[];
    todos: OpencodeEvent[];
    permissions: OpencodeEvent[];
    other: OpencodeEvent[];
  }) => void) = () => {};
  private onError: (error: Error) => void = () => {};
  private disconnected = false;
  private controller: AbortController | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  // Event buffer for batching
  private eventBuffer: OpencodeEvent[] = [];

  async connect(
    getClient: () => Client | null,
    onBatch: (events: {
      messages: OpencodeEvent[];
      parts: OpencodeEvent[];
      sessions: OpencodeEvent[];
      todos: OpencodeEvent[];
      permissions: OpencodeEvent[];
      other: OpencodeEvent[];
    }) => void,
    onError: (error: Error) => void
  ): Promise<void> {
    this.onBatch = onBatch;
    this.onError = onError;
    this.disconnected = false;

    const client = getClient();
    if (!client) {
      onError(new Error("Client not available"));
      return;
    }

    // Start the flush timer for batching
    this.startFlushTimer();

    // Subscribe to events
    this.controller = new AbortController();

    try {
      // Access the internal SDK client for event subscription
      // The OpencodeClient has event.subscribe method
      const sdkClient = (client as unknown as {
        event: {
          subscribe: (filter?: unknown, options?: { signal?: AbortSignal }) => {
            stream: AsyncIterable<Event>;
          };
        };
      }).event;

      if (!sdkClient?.subscribe) {
        throw new Error("Event subscription not available");
      }

      const sub = await sdkClient.subscribe(undefined, { signal: this.controller.signal });

      // Process events asynchronously
      (async () => {
        try {
          for await (const raw of sub.stream) {
            if (this.disconnected) break;

            const event = toOpencodeEvent(raw);
            this.addEvent(event);
          }
        } catch (error) {
          if (!this.disconnected) {
            const err = error instanceof Error ? error : new Error(String(error));
            onError(err);
          }
        }
      })();
    } catch (error) {
      if (!this.disconnected) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Add event to buffer with overflow handling
   */
  private addEvent(event: OpencodeEvent): void {
    const MAX_BUFFER_SIZE = 1000;
    if (this.eventBuffer.length >= MAX_BUFFER_SIZE) {
      console.warn(`[MainThreadSSEProcessor] Queue overflow: ${this.eventBuffer.length} events, dropping oldest`);
      // Remove oldest 10% of buffer to make room
      const removeCount = Math.floor(MAX_BUFFER_SIZE * 0.1);
      this.eventBuffer.splice(0, removeCount);
    }
    this.eventBuffer.push(event);
  }

  /**
   * Start the flush timer for batching
   */
  private startFlushTimer(): void {
    const FLUSH_INTERVAL_MS = 16; // ~60fps sync
    this.flushTimer = setInterval(() => {
      this.flushBuffer();
    }, FLUSH_INTERVAL_MS);
  }

  /**
   * Flush the event buffer and call batch callback
   */
  private flushBuffer(): void {
    if (this.eventBuffer.length === 0 || !this.onBatch) return;

    // Group events by type
    const batched: {
      messages: OpencodeEvent[];
      parts: OpencodeEvent[];
      sessions: OpencodeEvent[];
      todos: OpencodeEvent[];
      permissions: OpencodeEvent[];
      other: OpencodeEvent[];
    } = {
      messages: [],
      parts: [],
      sessions: [],
      todos: [],
      permissions: [],
      other: [],
    };

    for (const event of this.eventBuffer) {
      // Categorize event by type
      if (event.type === "message.updated" || event.type === "message.removed") {
        batched.messages.push(event);
      } else if (event.type === "message.part.updated" || event.type === "message.part.removed") {
        batched.parts.push(event);
      } else if (
        event.type === "session.updated" ||
        event.type === "session.created" ||
        event.type === "session.deleted" ||
        event.type === "session.status" ||
        event.type === "session.idle"
      ) {
        batched.sessions.push(event);
      } else if (event.type === "todo.updated") {
        batched.todos.push(event);
      } else if (event.type === "permission.asked" || event.type === "permission.replied") {
        batched.permissions.push(event);
      } else {
        batched.other.push(event);
      }
    }

    this.onBatch(batched);
    this.eventBuffer = [];
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;

    // Stop the flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Abort the event subscription
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }
}

/**
 * Worker Pool for managing lifecycle of web workers
 * Provides lazy initialization, proper cleanup, and fallback for unavailable workers
 */
export class WorkerPool {
  private sseWorker: RemoteSSEWorker | null = null;
  private sseWorkerInstance: Worker | null = null;
  private computationWorker: RemoteComputationWorker | null = null;
  private computationWorkerInstance: Worker | null = null;
  private _isInitialized = false;
  private useFallback = false;

  /**
   * Check if workers should be used or if fallback mode is enabled
   */
  private shouldUseWorkers(): boolean {
    if (this.useFallback) {
      return false;
    }
    if (!areWorkersAvailable()) {
      console.warn("[WorkerPool] Web workers not available, using main thread fallback");
      this.useFallback = true;
      return false;
    }
    return true;
  }

  /**
   * Get the SSE processor - worker or main thread fallback
   * Returns a processor that can be used for SSE connections
   */
  async getSSEProcessor(): Promise<SSEProcessor> {
    if (!this.shouldUseWorkers()) {
      return new MainThreadSSEProcessor();
    }

    // Try to initialize the worker
    try {
      const worker = await this.initSSEWorker();
      // Return an adapter that conforms to SSEProcessor interface
      const processor: SSEProcessor = {
        connect: worker.connect.bind(worker),
        disconnect: worker.disconnect.bind(worker),
      };
      return processor;
    } catch (error) {
      console.warn("[WorkerPool] Failed to initialize SSE worker, falling back to main thread", error);
      this.useFallback = true;
      return new MainThreadSSEProcessor();
    }
  }

  /**
   * Initialize the SSE Worker (lazy initialization)
   * Returns a Comlink-wrapped remote worker
   */
  async initSSEWorker(): Promise<RemoteSSEWorker> {
    if (this.sseWorker) {
      return this.sseWorker;
    }

    // Check if workers are available before creating
    if (!areWorkersAvailable()) {
      throw new Error("Web workers not available");
    }

    // Create a new Worker instance from the worker file
    // Vite compiles worker files to be loadable via URL or as modules
    const workerPath = new URL("../workers/sse-worker.ts", import.meta.url).href;
    this.sseWorkerInstance = new Worker(workerPath, { type: "module" });

    // Wrap with Comlink for RPC
    this.sseWorker = Comlink.wrap(this.sseWorkerInstance) as unknown as RemoteSSEWorker;

    return this.sseWorker;
  }

  /**
   * Initialize the Computation Worker (lazy initialization)
   * Returns a Comlink-wrapped remote worker
   */
  async initComputationWorker(): Promise<RemoteComputationWorker> {
    if (this.computationWorker) {
      return this.computationWorker;
    }

    // Check if workers are available before creating
    if (!areWorkersAvailable()) {
      throw new Error("Web workers not available");
    }

    // Create a new Worker instance from the worker file
    const workerPath = new URL("../workers/computation-worker.ts", import.meta.url).href;
    this.computationWorkerInstance = new Worker(workerPath, { type: "module" });

    // Wrap with Comlink for RPC
    this.computationWorker = Comlink.wrap(this.computationWorkerInstance) as unknown as RemoteComputationWorker;

    return this.computationWorker;
  }

  /**
   * Get the SSE Worker if initialized
   */
  getSSEWorker(): RemoteSSEWorker | null {
    return this.sseWorker;
  }

  /**
   * Get the Computation Worker if initialized
   */
  getComputationWorker(): RemoteComputationWorker | null {
    return this.computationWorker;
  }

  /**
   * Check if workers have been initialized
   */
  getIsInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Terminate all workers and cleanup resources
   */
  async terminate(): Promise<void> {
    // Terminate SSE Worker
    if (this.sseWorker) {
      try {
        await this.sseWorker.disconnect();
      } catch {
        // Ignore errors during cleanup
      }
      this.sseWorker = null;
    }

    // Terminate the underlying Worker instance
    if (this.sseWorkerInstance) {
      this.sseWorkerInstance.terminate();
      this.sseWorkerInstance = null;
    }

    // Terminate Computation Worker
    if (this.computationWorker) {
      try {
        await this.computationWorker.clearCache();
      } catch {
        // Ignore errors during cleanup
      }
      this.computationWorker = null;
    }

    // Terminate the underlying Worker instance
    if (this.computationWorkerInstance) {
      this.computationWorkerInstance.terminate();
      this.computationWorkerInstance = null;
    }

    this._isInitialized = false;
  }
}

// Singleton instance for the worker pool
let poolInstance: WorkerPool | null = null;

/**
 * Get the singleton worker pool instance
 */
export function getWorkerPool(): WorkerPool {
  if (!poolInstance) {
    poolInstance = new WorkerPool();
  }
  return poolInstance;
}

/**
 * Initialize workers (convenience function)
 */
export async function initWorkers(): Promise<{
  sseWorker: RemoteSSEWorker;
  computationWorker: RemoteComputationWorker;
}> {
  const pool = getWorkerPool();
  const [sseWorker, computationWorker] = await Promise.all([
    pool.initSSEWorker(),
    pool.initComputationWorker(),
  ]);
  pool.getIsInitialized(); // Trigger setter side effect if needed
  return { sseWorker, computationWorker };
}

/**
 * Cleanup workers (convenience function)
 */
export async function cleanupWorkers(): Promise<void> {
  const pool = getWorkerPool();
  await pool.terminate();
}

/**
 * Get the appropriate SSE processor based on feature flags and environment
 * Falls back to MainThreadSSEProcessor if workers are unavailable
 */
export async function getSSEProcessor(): Promise<SSEProcessor> {
  // Check if SSE_WORKER feature is enabled
  if (!isFeatureEnabled("SSE_WORKER")) {
    return new MainThreadSSEProcessor();
  }

  // Check if workers are available in the environment
  if (!areWorkersAvailable()) {
    console.warn("Web Workers not available, falling back to main thread processor");
    return new MainThreadSSEProcessor();
  }

  // Check cross-origin isolation (important for SharedArrayBuffer features)
  if (isFeatureEnabled("SHARED_ARRAY_BUFFER") && !isCrossOriginIsolated()) {
    console.warn(
      "Cross-origin isolation required for SharedArrayBuffer, falling back to main thread processor"
    );
    return new MainThreadSSEProcessor();
  }

  // Use worker-based processor
  const pool = getWorkerPool();
  const worker = await pool.initSSEWorker();

  // Return a wrapper that adapts the worker interface to SSEProcessor
  return {
    connect: async (
      getClient: () => Client | null,
      onBatch: (events: {
        messages: OpencodeEvent[];
        parts: OpencodeEvent[];
        sessions: OpencodeEvent[];
        todos: OpencodeEvent[];
        permissions: OpencodeEvent[];
        other: OpencodeEvent[];
      }) => void,
      onError: (error: Error) => void
    ) => {
      await worker.connect(getClient, onBatch, onError);
    },
    disconnect: async () => {
      await worker.disconnect();
    },
  };
}
