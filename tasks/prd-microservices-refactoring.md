# PRD: OpenWork Microservices Architecture Refactoring

## Introduction

Refactor OpenWork from a single-threaded architecture to a distributed architecture using Web Workers, Comlink, and parallel processing patterns. The goal is to improve performance during AI streaming, reduce connection time, and eliminate frame drops caused by blocking operations on the main thread.

## Goals

- Reduce connection time from ~13s to <5s (worst case)
- Maintain 60fps during AI streaming (up from 30-45fps)
- Reduce input latency from 100-200ms to <50ms
- Eliminate main thread blocking during SSE processing
- Enable horizontal scaling of computation via worker pool

## User Stories

### Phase 1: Quick Wins (Low Risk)

### US-001: Implement parallel connection flow
**Description:** As a user, I want connection operations to run in parallel so that I can connect to the server faster.

**Acceptance Criteria:**
- [ ] `waitForHealthy`, `loadSessions`, `refreshPermissions`, and `fetchProviders` run concurrently via `Promise.allSettled`
- [ ] Connection timeout reduced from 12s to 5s
- [ ] Individual failures don't block successful requests (each wrapped in try/catch)
- [ ] Debounce rapid connect attempts to prevent connection storms
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-002: Add debounced scroll to message list
**Description:** As a user, I want smooth scrolling during AI streaming so that the UI doesn't jitter or lag.

**Acceptance Criteria:**
- [ ] `scrollToBottom` function debounced at 100ms
- [ ] Smooth scrolling behavior maintained
- [ ] Typecheck passes
- [ ] Verify in browser during active streaming

### US-003: Enable SolidJS batch updates for SSE events
**Description:** As a user, I want batched state updates during SSE streaming so that the UI only re-renders once per event batch.

**Acceptance Criteria:**
- [ ] All SSE event handlers wrapped in `batch()` from solid-js
- [ ] Multiple state updates (messages, todos, sessionStatus) happen in single render
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

---

### Phase 2: Worker Integration (Medium Risk)

### US-004: Add Comlink dependencies and Vite configuration
**Description:** As a developer, I need Comlink installed and configured so that I can use Web Workers with a clean RPC API.

**Acceptance Criteria:**
- [ ] `pnpm add comlink` completes successfully
- [ ] `pnpm add -D vite-plugin-comlink` completes successfully
- [ ] Vite config updated with comlink plugin
- [ ] Vite worker plugins configured
- [ ] Typecheck passes

### US-005: Create SSE Worker for event stream processing
**Description:** As a developer, I need an SSE Worker that processes events off the main thread so that UI remains responsive during streaming.

**Acceptance Criteria:**
- [ ] Worker created at `src/workers/sse-worker.ts`
- [ ] Worker implements `connect()`, `onBatch()`, `disconnect()` methods
- [ ] Events buffered and flushed every 16ms (60fps sync)
- [ ] Events batched by type (messages, parts, sessions, todos, permissions)
- [ ] Queue overflow handled with warning when events arrive faster than flush interval
- [ ] Handle partial SSE events correctly (reassembly of split events)
- [ ] Worker initialization wrapped in try/catch with error callback
- [ ] Typecheck passes

### US-006: Create Computation Worker for heavy processing
**Description:** As a developer, I need a Computation Worker that handles artifact derivation and regex processing so that expensive computations don't block the UI.

**Acceptance Criteria:**
- [ ] Worker created at `src/workers/computation-worker.ts`
- [ ] Implements `deriveArtifacts()` with caching
- [ ] Implements `batchProcessParts()` for batch processing
- [ ] Implements `clearCache()` for cache management
- [ ] Cache has max size limit (e.g., 1000 entries) with LRU eviction
- [ ] Typecheck passes

### US-007: Create Worker Pool Manager
**Description:** As a developer, I need a Worker Pool Manager to manage worker lifecycle so that workers are lazily initialized and properly cleaned up.

**Acceptance Criteria:**
- [ ] Worker pool created at `src/lib/worker-pool.ts`
- [ ] `initSSEWorker()` returns Comlink-wrapped remote worker
- [ ] `initComputationWorker()` returns Comlink-wrapped remote worker
- [ ] `terminate()` cleans up all workers
- [ ] Typecheck passes

### US-008: Integrate SSE Worker with session store
**Description:** As a user, I want SSE events processed via Worker so that streaming doesn't block my interactions.

**Acceptance Criteria:**
- [ ] Session store (`src/app/session.ts`) initializes SSE Worker on connect
- [ ] Worker batches events and sends to main thread via Comlink
- [ ] Main thread uses `batch()` to process batched events
- [ ] Worker disconnected on cleanup
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-009: Integrate Computation Worker with message processing
**Description:** As a user, I want message artifact derivation to happen in a Worker so that message rendering stays smooth.

**Acceptance Criteria:**
- [ ] Message processing calls Computation Worker via Comlink
- [ ] Artifacts cached in worker to avoid redundant computation
- [ ] Cache cleared on new session or manual trigger
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

---

### Phase 3: Rust Backend Enhancement (High Effort)

### US-010: Define Rust Command enum and processor
**Description:** As a backend developer, I need a Command pattern for Rust backend so that async operations can be queued and processed efficiently.

**Acceptance Criteria:**
- [ ] Command enum defined in `src-tauri/src/lib.rs` with HealthCheck, LoadSessions, RefreshPermissions variants
- [ ] CommandProcessor struct with `new()` and `send()` methods
- [ ] One-shot channels for request-response patterns
- [ ] Typecheck passes (Rust compilation)

### US-011: Implement command processing loop
**Description:** As a backend developer, I need a command processing loop so that queued commands are executed asynchronously.

**Acceptance Criteria:**
- [ ] `process_commands()` async function spawned on app startup
- [ ] Commands processed via Tauri async runtime
- [ ] Response sent back via oneshot channel
- [ ] Typecheck passes (Rust compilation)

### US-012: Add mpsc/broadcast channel support
**Description:** As a backend developer, I need proper channel infrastructure so that parallel command processing works correctly.

**Acceptance Criteria:**
- [ ] mpsc channel configured with 100-element buffer
- [ ] Broadcast channel for pub/sub events (optional)
- [ ] Watch channel for single-sender multi-receiver patterns (optional)
- [ ] Typecheck passes (Rust compilation)

### US-013: Add feature flags for gradual rollout
**Description:** As a developer, I need feature flags so that new features can be toggled without code changes.

**Acceptance Criteria:**
- [ ] Feature flags file created at `src/config/features.ts`
- [ ] Phase 1 features enabled: PARALLEL_CONNECTION, DEBOUNCED_SCROLL, BATCH_UPDATES
- [ ] Phase 2 features disabled by default: SSE_WORKER, COMPUTATION_WORKER
- [ ] Phase 3 features disabled by default: RUST_CHANNELS, SHARED_ARRAY_BUFFER
- [ ] Typecheck passes

### US-014: Implement fallback for unavailable workers
**Description:** As a user, I want the app to work even if Workers are unavailable so that I can still use basic features.

**Acceptance Criteria:**
- [ ] `getSSEProcessor()` checks for worker availability
- [ ] Falls back to MainThreadSSEProcessor if workers unavailable
- [ ] Cross-origin isolation check for SharedArrayBuffer
- [ ] Typecheck passes
- [ ] Verify fallback works in browser

### US-015: Create rollback procedure documentation
**Description:** As a developer, I need documented rollback procedures so that I can quickly disable features if issues arise.

**Acceptance Criteria:**
- [ ] Emergency rollback documented in `docs/rollback-procedure.md`
- [ ] Feature flags can disable all new features
- [ ] Session store automatically falls back to main thread processing
- [ ] Documentation includes steps for each phase

---

## Functional Requirements

- FR-1: Connection operations must complete in <5s (worst case)
- FR-2: UI must maintain 60fps during AI streaming
- FR-3: Input latency must be <50ms during streaming
- FR-4: All SSE events must be batched and processed in single render
- FR-5: Workers must be lazily initialized (created on first use)
- FR-6: Workers must be properly terminated on cleanup
- FR-7: Fallback to main thread processing when workers unavailable
- FR-8: Rust command processing must use async channels

## Non-Goals

- No changes to OpenCode API protocol
- No database schema changes
- No authentication flow changes
- No cross-browser compatibility (target modern browsers only)
- No offline-first functionality for this phase
- No real-time collaboration features

## Technical Considerations

- **Browser Support:** Workers require modern browser (ES2020+)
- **Cross-Origin Isolation:** Required for SharedArrayBuffer (if used later)
- **Comlink:** Abstracts postMessage complexity, uses Proxies
- **SolidJS Batch:** Native batching via `batch()` function
- **Tokio Channels:** mpsc for command queue, broadcast for pub/sub
- **Transferables:** Use transferable objects for zero-copy data transfer

## Security Considerations

- Worker messages should not contain sensitive data in plaintext
- Input validation must happen in main thread before sending to workers
- Error messages must not leak internal details to UI
- Workers cannot access DOM directly (security benefit)

## Success Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Connection Time (worst) | ~13s | <5s | Manual timing |
| FPS during streaming | 30-45 | 60 | DevTools Performance |
| Input latency | 100-200ms | <50ms | DevTools Performance |
| Memory growth/min | Unknown | <5MB | Task Manager |
| Time to First Render | ~3s | <1s | Lighthouse |

## Rollout Plan

| Week | Changes | Risk |
|------|---------|------|
| 1 | Phase 1 features enabled | Low |
| 2 | SSE Worker (internal testing) | Medium |
| 3 | Computation Worker (internal testing) | Medium |
| 4 | Workers enabled for all users | Medium |
| 6-8 | Rust channels (if needed) | High |

## Open Questions

- Should we implement SharedArrayBuffer for zero-copy data transfer? (requires cross-origin isolation)
- What's the optimal batch interval for SSE events? (16ms vs 32ms vs dynamic)
- How many workers should be in the pool? (fixed vs dynamic sizing)
