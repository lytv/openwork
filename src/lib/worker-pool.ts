import * as Comlink from "comlink";
import type { SSEWorker } from "../workers/sse-worker";
import type { ComputationWorker } from "../workers/computation-worker";

/**
 * Remote worker types (Comlink-wrapped)
 */
export type RemoteSSEWorker = Comlink.Remote<SSEWorker>;
export type RemoteComputationWorker = Comlink.Remote<ComputationWorker>;

/**
 * Worker Pool for managing lifecycle of web workers
 * Provides lazy initialization and proper cleanup
 */
export class WorkerPool {
  private sseWorker: RemoteSSEWorker | null = null;
  private sseWorkerInstance: Worker | null = null;
  private computationWorker: RemoteComputationWorker | null = null;
  private computationWorkerInstance: Worker | null = null;
  private _isInitialized = false;

  /**
   * Initialize the SSE Worker (lazy initialization)
   * Returns a Comlink-wrapped remote worker
   */
  async initSSEWorker(): Promise<RemoteSSEWorker> {
    if (this.sseWorker) {
      return this.sseWorker;
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
