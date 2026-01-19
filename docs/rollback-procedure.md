# Emergency Rollback Procedures

This document describes the procedures for quickly disabling new features if issues arise during the microservices refactoring rollout.

## Quick Rollback Steps

### Phase 1 Features (Enabled by Default)

Phase 1 features are core performance improvements that should be stable. If issues occur:

1. **Parallel Connection (PARALLEL_CONNECTION)**
   - Location: `src/app/workspace.ts`
   - Rollback: The connection logic already has try/catch for individual operations
   - No action needed - failures are gracefully handled

2. **Debounced Scroll (DEBOUNCED_SCROLL)**
   - Location: `src/views/SessionView.tsx`
   - To disable: Remove the debounce timer logic (lines 84-95)
   - The scroll will use direct `scrollIntoView` without debouncing

3. **Batch Updates (BATCH_UPDATES)**
   - Location: `src/app/session.ts`
   - To disable: Remove `batch()` wrappers around SSE event handlers
   - Events will be processed synchronously without batching

### Phase 2 Features (Disabled by Default)

Phase 2 features are controlled by feature flags in `src/config/features.ts`:

```typescript
// To enable workers (not recommended for rollback):
setFeatureFlags({
  SSE_WORKER: true,
  COMPUTATION_WORKER: true
});

// To disable workers (already the default):
setFeatureFlags({
  SSE_WORKER: false,
  COMPUTATION_WORKER: false
});
```

**Rollback for Phase 2:**
- Workers are already disabled by default
- The session store falls back to main-thread processing automatically
- No code changes required

### Phase 3 Features (Disabled by Default)

Phase 3 features require specific configuration:

- **RUST_CHANNELS**: Backend async processing via Tauri commands
- **SHARED_ARRAY_BUFFER**: Requires cross-origin isolation headers

Both are disabled by default and require explicit enablement.

## Full Feature Disable Procedure

If you need to completely disable all new features:

1. **Keep feature flags at defaults** (all Phase 1 enabled, Phase 2/3 disabled)

2. **Session store uses main thread** - No workers are initialized

3. **Connection uses parallel flow** - Already has graceful fallback

4. **Scroll uses debounce** - Can be removed if needed

5. **Batch updates active** - Can be removed if SSE performance issues occur

## Re-enabling After Rollback

To re-enable features after fixing issues:

1. For feature flags: Use `enableFeature()` at runtime
2. For code changes: Merge the fix and redeploy
3. For workers: Ensure feature flags are set before worker initialization

## Monitoring

After any rollback or re-enablement:

1. Check browser console for errors
2. Monitor connection timing
3. Verify SSE event processing
4. Test message rendering performance

## Contact

For critical issues, contact the development team.
