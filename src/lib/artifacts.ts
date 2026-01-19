import type { MessageWithParts } from "../app/types";
import type { DerivedArtifact } from "../workers/computation-worker";
import { getWorkerPool } from "./worker-pool";

/**
 * Get computed artifacts from the Computation Worker
 * Uses caching to avoid redundant computation
 */
export async function getArtifacts(messages: MessageWithParts[]): Promise<DerivedArtifact[]> {
  const pool = getWorkerPool();
  const worker = await pool.initComputationWorker();

  // Flatten parts from all messages for batch processing
  const parts = messages.flatMap((msg) =>
    msg.parts.map((part) => ({
      id: `${msg.info.id}-${part.id}`,
      part,
    }))
  );

  // Use batchProcessParts for efficient processing
  const results = await worker.batchProcessParts(parts);

  // Collect artifacts from all results
  const artifacts: DerivedArtifact[] = [];
  for (const result of results) {
    if (result.hasArtifacts) {
      artifacts.push(...result.artifacts);
    }
  }

  return artifacts;
}

/**
 * Get cache statistics from the Computation Worker
 */
export async function getArtifactCacheStats(): Promise<{
  artifactCacheSize: number;
  partCacheSize: number;
  maxSize: number;
}> {
  const pool = getWorkerPool();
  const worker = await pool.initComputationWorker();
  return worker.getCacheStats();
}

/**
 * Clear the artifact cache in the Computation Worker
 */
export async function clearArtifactCache(): Promise<void> {
  const pool = getWorkerPool();
  const worker = await pool.initComputationWorker();
  return worker.clearCache();
}
