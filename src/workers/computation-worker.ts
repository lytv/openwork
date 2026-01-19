import type { Part, ToolPart, StepStartPart, StepFinishPart, ReasoningPart, TextPart, ToolStateCompleted } from "@opencode-ai/sdk/v2/client";
import { expose } from "comlink";

/**
 * Type guard for ToolStateCompleted
 */
function isToolStateCompleted(state: unknown): state is ToolStateCompleted {
  return (
    typeof state === "object" &&
    state !== null &&
    "status" in state &&
    (state as Record<string, unknown>).status === "completed"
  );
}

/**
 * Derived artifact result
 */
export interface DerivedArtifact {
  name: string;
  content: string;
  kind: "file" | "text";
  dependencies: string[];
}

/**
 * Batch processing result for parts
 */
export interface BatchProcessResult {
  partId: string;
  derivedText: string;
  hasArtifacts: boolean;
  artifacts: DerivedArtifact[];
}

/**
 * LRU Cache entry
 */
interface CacheEntry<T> {
  value: T;
  lastAccessed: number;
}

/**
 * LRU Cache with max size and eviction
 */
class LRUCache<T, K = string> {
  private cache = new Map<K, CacheEntry<T>>();
  private readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Get value from cache
   */
  get(key: K): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Update access time for LRU
    entry.lastAccessed = Date.now();
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Set value in cache
   */
  set(key: K, value: T): void {
    // Remove oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictOldest(Math.floor(this.maxSize * 0.1));
    }

    this.cache.set(key, {
      value,
      lastAccessed: Date.now(),
    });
  }

  /**
   * Check if key exists in cache
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Evict oldest entries
   */
  private evictOldest(count: number): void {
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)
      .slice(0, count);

    for (const [key] of entries) {
      this.cache.delete(key);
    }
  }
}

/**
 * Type guard for TextPart
 */
function isTextPart(part: Part): part is TextPart {
  return part.type === "text";
}

/**
 * Type guard for ToolPart
 */
function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
}

/**
 * Type guard for StepStartPart
 */
function isStepStartPart(part: Part): part is StepStartPart {
  return part.type === "step-start";
}

/**
 * Type guard for StepFinishPart
 */
function isStepFinishPart(part: Part): part is StepFinishPart {
  return part.type === "step-finish";
}

/**
 * Type guard for ReasoningPart
 */
function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === "reasoning";
}

/**
 * Computation Worker for heavy processing off the main thread
 * Handles artifact derivation, regex processing, and batch operations
 */
export class ComputationWorker {
  // Cache for derived artifacts (LRU with max 1000 entries)
  private artifactCache = new LRUCache<DerivedArtifact, string>();
  // Cache for processed parts
  private partCache = new LRUCache<BatchProcessResult, string>();

  private readonly MAX_CACHE_SIZE = 1000;

  constructor() {
    // Initialize with default size
    this.artifactCache = new LRUCache<DerivedArtifact>(this.MAX_CACHE_SIZE);
    this.partCache = new LRUCache<BatchProcessResult>(this.MAX_CACHE_SIZE);
  }

  /**
   * Derive artifacts from message parts
   * Uses caching to avoid redundant computation
   */
  deriveArtifacts(parts: Part[], messageId: string): DerivedArtifact[] {
    const cacheKey = `${messageId}:${this.hashParts(parts)}`;

    // Check cache first
    const cached = this.artifactCache.get(cacheKey);
    if (cached) {
      return [cached];
    }

    const artifacts: DerivedArtifact[] = [];

    for (const part of parts) {
      // Tool parts may create artifacts based on tool output
      if (isToolPart(part)) {
        const artifact = this.extractArtifactFromTool(part, messageId);
        if (artifact) {
          artifacts.push(artifact);
        }
      }
    }

    // Cache the result
    if (artifacts.length > 0) {
      this.artifactCache.set(cacheKey, artifacts[0]);
    }

    return artifacts;
  }

  /**
   * Extract artifact content from tool call
   * ToolPart has 'tool' (name), 'state', 'callID', 'metadata' but not 'text'
   * The actual output might be in metadata or we derive from the tool name
   */
  private extractArtifactFromTool(part: ToolPart, messageId: string): DerivedArtifact | null {
    // For tool calls, check if completed and extract output
    if (part.tool && isToolStateCompleted(part.state)) {
      return {
        name: `artifact-${messageId}-${part.id}`,
        content: `[Tool: ${part.tool}] - ${part.state.output || "Completed successfully"}`,
        kind: "text",
        dependencies: [],
      };
    }
    return null;
  }

  /**
   * Batch process multiple parts for efficient computation
   */
  batchProcessParts(parts: Array<{ id: string; part: Part }>): BatchProcessResult[] {
    const results: BatchProcessResult[] = [];

    for (const { id, part } of parts) {
      // Check cache first
      const cached = this.partCache.get(id);
      if (cached) {
        results.push(cached);
        continue;
      }

      // Process the part
      const result = this.processSinglePart(id, part);
      results.push(result);

      // Cache the result
      this.partCache.set(id, result);
    }

    return results;
  }

  /**
   * Process a single part based on its type
   */
  private processSinglePart(partId: string, part: Part): BatchProcessResult {
    let derivedText = "";
    let hasArtifacts = false;
    const artifacts: DerivedArtifact[] = [];

    if (isTextPart(part)) {
      derivedText = part.text || "";
    } else if (isReasoningPart(part)) {
      derivedText = part.text || "";
    } else if (isToolPart(part)) {
      // Tool parts derive text from tool name and state
      derivedText = `[${part.tool}] ${part.state}`;
      // Check metadata for artifact content
      if (part.metadata && typeof part.metadata === "object") {
        const metadataContent = (part.metadata as Record<string, unknown>).output;
        if (typeof metadataContent === "string" && metadataContent.length > 50) {
          hasArtifacts = true;
          artifacts.push({
            name: `tool-artifact-${partId}`,
            content: metadataContent,
            kind: "text",
            dependencies: [],
          });
        }
      }
    } else if (isStepStartPart(part)) {
      // Step parts use snapshot if available
      derivedText = part.snapshot || `[Step started]`;
    } else if (isStepFinishPart(part)) {
      derivedText = part.snapshot || `${part.reason} (cost: ${part.cost})`;
    }

    return {
      partId,
      derivedText,
      hasArtifacts,
      artifacts,
    };
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.artifactCache.clear();
    this.partCache.clear();
  }

  /**
   * Clear cache for specific session
   */
  clearSessionCache(_sessionId: string): void {
    // For more targeted eviction, we'd need session-based keys
    // For now, clear all
    this.clearCache();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { artifactCacheSize: number; partCacheSize: number; maxSize: number } {
    return {
      artifactCacheSize: this.artifactCache.size(),
      partCacheSize: this.partCache.size(),
      maxSize: this.MAX_CACHE_SIZE,
    };
  }

  /**
   * Simple hash function for parts to create cache keys
   */
  private hashParts(parts: Part[]): string {
    let hash = 0;
    const str = JSON.stringify(parts);
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }
}

// Expose the worker via Comlink for RPC
const worker = new ComputationWorker();
expose(worker);

export default ComputationWorker;
