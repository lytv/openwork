# OpenWork Performance Analysis Report

**Date:** 2026-01-19  
**Version:** 0.1.22  
**Status:** Analysis Complete - Pending Fixes

---

## Executive Summary

Báo cáo này phân tích các nguyên nhân gốc rễ (root causes) gây ra hiện tượng hệ thống OpenWork tương tác chậm. Các vấn đề được xác định chủ yếu liên quan đến:

1. SSE (Server-Sent Events) processing bottleneck
2. Excessive UI re-renders do state updates không được batch
3. Blocking API calls trong connection flow
4. Heavy computation trong render path

---

## Table of Contents

- [1. Architecture Overview](#1-architecture-overview)
- [2. Critical Issues](#2-critical-issues)
- [3. High Priority Issues](#3-high-priority-issues)
- [4. Medium Priority Issues](#4-medium-priority-issues)
- [5. Recommended Solutions](#5-recommended-solutions)
- [6. Implementation Priority](#6-implementation-priority)

---

## 1. Architecture Overview

### Tech Stack
- **Frontend Framework:** SolidJS
- **Desktop Runtime:** Tauri 2.x
- **Build Tool:** Vite
- **Backend Communication:** OpenCode SDK via SSE

### Data Flow
```
OpenCode Server
      ↓ (SSE)
  SDK Client
      ↓ (Events)
 Session Store
      ↓ (Signals)
   UI Components
```

### Key Files Analyzed
| File | Purpose |
|------|---------|
| `src/app/session.ts` | Session state management & SSE handling |
| `src/app/workspace.ts` | Workspace & connection management |
| `src/lib/opencode.ts` | OpenCode SDK wrapper |
| `src/views/SessionView.tsx` | Main chat/session UI |
| `src/App.tsx` | Root component & state orchestration |
| `src/app/utils.ts` | Utility functions including derived state |

---

## 2. Critical Issues

### 2.1 SSE Event Processing Bottleneck

**Location:** `src/app/session.ts` (lines 144-337)

**Problem:**
SSE stream xử lý events **tuần tự** trong một async loop. Mỗi event trigger state updates ngay lập tức, không có batching mechanism.

**Code Example:**
```typescript
createEffect(() => {
  const c = options.client();
  if (!c) return;

  (async () => {
    const sub = await c.event.subscribe(undefined, { signal: controller.signal });

    for await (const raw of sub.stream) {
      // Each event processed sequentially
      if (event.type === "message.part.updated") {
        setMessages((current) => upsertPart(current, part));
        // ⚠️ Triggers re-render immediately
      }
    }
  })();
});
```

**Impact:**
- Khi AI streaming response, có thể có **100-500 events/second**
- Mỗi event → 1 state update → 1 potential re-render
- UI bị lag, input responsiveness giảm đáng kể

**Metrics to Monitor:**
- Event processing time per event
- Re-render count during streaming
- Main thread blocking duration

---

### 2.2 Excessive scrollIntoView Calls

**Location:** `src/views/SessionView.tsx` (lines 85-89)

**Problem:**
Effect tự động scroll đến cuối message list được trigger mỗi khi `messages` hoặc `todos` thay đổi.

**Code Example:**
```typescript
createEffect(() => {
  props.messages.length;  // Reactive dependency
  props.todos.length;     // Reactive dependency
  messagesEndEl?.scrollIntoView({ behavior: "smooth" });
});
```

**Impact:**
- `scrollIntoView({ behavior: "smooth" })` trigger browser **reflow + repaint**
- Khi streaming: hàng trăm scroll operations liên tiếp
- Browser animation frame budget bị exhaust → jank

**Browser DevTools Evidence:**
- Long tasks in Performance panel
- Layout thrashing warnings
- High "Recalculate Style" times

---

## 3. High Priority Issues

### 3.1 Sequential API Calls in Connection Flow

**Location:** `src/app/workspace.ts` (lines 199-311)

**Problem:**
`connectToServer()` thực hiện nhiều API calls **tuần tự** thay vì song song.

**Call Sequence:**
```
1. waitForHealthy()           → up to 12 seconds timeout
2. loadSessions()             → network round-trip
3. refreshPendingPermissions() → network round-trip
4. provider.list()            → network round-trip
   └─ (fallback) config.providers() → another round-trip
5. session.create() (for new workspaces)
6. session.promptAsync()
7. loadSessions() again
8. selectSession()
9. refreshSkills()
```

**Worst Case Timing:**
```
12s (health) + 8 x 200ms (API calls) = ~13.6 seconds
```

**Code Example:**
```typescript
async function connectToServer(nextBaseUrl: string, directory?: string) {
  const health = await waitForHealthy(nextClient, { timeoutMs: 12_000 });
  // ⚠️ All calls are sequential
  await options.loadSessions(activeWorkspaceRoot().trim());
  await options.refreshPendingPermissions();
  
  try {
    const providerList = unwrap(await nextClient.provider.list());
    // ...
  } catch {
    // Fallback adds another round-trip
  }
}
```

---

### 3.2 Heavy Derived State Computation

**Location:** `src/app/utils.ts` (lines 466-510)

**Problem:**
`deriveArtifacts()` runs regex matching on **all messages** every time messages change.

**Code Example:**
```typescript
export function deriveArtifacts(list: MessageWithParts[]): ArtifactItem[] {
  const filePattern = /([\\w./\\-]+\\.(?:pdf|docx|doc|txt|md|csv|json|js|ts|tsx|xlsx|pptx|png|jpg|jpeg))/gi;

  list.forEach((message) => {
    message.parts.forEach((part) => {
      // Regex matching on every part
      const matches = Array.from(combined.matchAll(filePattern));
    });
  });

  return results;
}
```

**Complexity:** O(n × m × p)
- n = number of messages
- m = parts per message
- p = average text length

**Called From:** `src/App.tsx` (line 410)
```typescript
const artifacts = createMemo(() => deriveArtifacts(messages()));
```

---

## 4. Medium Priority Issues

### 4.1 Health Check Polling Configuration

**Location:** `src/lib/opencode.ts` (lines 27-51)

**Problem:**
`waitForHealthy()` uses long timeout with short poll interval.

**Current Config:**
```typescript
const timeoutMs = options?.timeoutMs ?? 10_000;  // 10 seconds default
const pollMs = options?.pollMs ?? 250;           // Poll every 250ms
```

**Issue:**
- 40 potential health check calls (10000 / 250)
- If server is slow to start, UI appears frozen

---

### 4.2 No Debouncing for State Updates

**Location:** Throughout `src/app/session.ts`

**Problem:**
State setters are called immediately without debouncing.

**Example Pattern:**
```typescript
if (event.type === "session.status") {
  setSessionStatusById((current) => ({
    ...current,
    [sessionID]: normalizeSessionStatus(record.status),
  }));
  // ⚠️ No debounce - fires on every event
}
```

---

## 5. Recommended Solutions

### 5.1 Batch SSE Event Processing

```typescript
// Proposed: Batch events before processing
const eventBuffer: OpencodeEvent[] = [];
let flushScheduled = false;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  
  requestAnimationFrame(() => {
    batch(() => {
      eventBuffer.forEach(processEvent);
      eventBuffer.length = 0;
    });
    flushScheduled = false;
  });
}

for await (const raw of sub.stream) {
  eventBuffer.push(normalizeEvent(raw));
  scheduleFlush();
}
```

### 5.2 Debounce scrollIntoView

```typescript
import { debounce } from './utils';

const debouncedScroll = debounce(() => {
  messagesEndEl?.scrollIntoView({ behavior: "smooth" });
}, 100);

createEffect(() => {
  props.messages.length;
  debouncedScroll();
});
```

### 5.3 Parallelize Connection API Calls

```typescript
async function connectToServer(nextBaseUrl: string, directory?: string) {
  const health = await waitForHealthy(nextClient, { timeoutMs: 5_000 });
  
  // Run independent operations in parallel
  const [sessions, permissions, providers] = await Promise.all([
    options.loadSessions(activeWorkspaceRoot().trim()),
    options.refreshPendingPermissions(),
    fetchProviders(nextClient),
  ]);
  
  // Continue with dependent operations...
}
```

### 5.4 Memoize Artifact Derivation

```typescript
// Use incremental computation instead of full recalculation
const artifactCache = new Map<string, ArtifactItem[]>();

export function deriveArtifactsIncremental(
  list: MessageWithParts[],
  cache: Map<string, ArtifactItem[]>
): ArtifactItem[] {
  const results: ArtifactItem[] = [];
  
  for (const message of list) {
    const msgId = message.info.id;
    
    if (cache.has(msgId)) {
      results.push(...cache.get(msgId)!);
    } else {
      const msgArtifacts = extractArtifactsFromMessage(message);
      cache.set(msgId, msgArtifacts);
      results.push(...msgArtifacts);
    }
  }
  
  return results;
}
```

### 5.5 Reduce Health Check Timeout

```typescript
// In connectToServer()
const health = await waitForHealthy(nextClient, { 
  timeoutMs: 5_000,  // Reduced from 12s
  pollMs: 500        // Less frequent polling
});
```

---

## 6. Implementation Priority

| Priority | Issue | Effort | Impact | Recommendation |
|----------|-------|--------|--------|----------------|
| 🔴 P0 | SSE batching | Medium | High | Implement first |
| 🔴 P0 | Debounce scroll | Low | High | Quick win |
| 🟠 P1 | Parallel API calls | Medium | Medium | Phase 2 |
| 🟠 P1 | Memoize artifacts | Medium | Medium | Phase 2 |
| 🟡 P2 | Health check config | Low | Low | Phase 3 |
| 🟡 P2 | State update debounce | Medium | Medium | Phase 3 |

---

## Appendix A: Files to Modify

```
src/
├── app/
│   ├── session.ts      ← SSE batching, state debouncing
│   ├── workspace.ts    ← Parallel API calls
│   └── utils.ts        ← Artifact memoization
├── views/
│   └── SessionView.tsx ← Scroll debouncing
└── lib/
    └── opencode.ts     ← Health check config
```

---

## Appendix B: Testing Recommendations

### Performance Metrics to Track
1. **Time to Interactive (TTI)** after connection
2. **Frame rate** during message streaming
3. **Input latency** while AI is responding
4. **Memory usage** growth over session lifetime

### Testing Scenarios
1. Connect with slow network (3G simulation)
2. Stream 1000+ character response
3. Rapid message sending (10 messages/second)
4. Switch between sessions during active stream

---

## Appendix C: Monitoring Setup

```typescript
// Add to session.ts for debugging
const perfMarker = (label: string) => {
  if (process.env.NODE_ENV === 'development') {
    performance.mark(label);
  }
};

// Usage in SSE loop
perfMarker('event-received');
// ... process event
perfMarker('event-processed');
performance.measure('event-processing', 'event-received', 'event-processed');
```

---

**Document prepared by:** Performance Analysis Tool  
**Review status:** Pending team review  
**Next steps:** Implement P0 fixes and measure improvement
