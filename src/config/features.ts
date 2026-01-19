/**
 * Feature flags for gradual rollout of microservices architecture
 * Phase 1: Features enabled by default
 * Phase 2: Features disabled by default (requires explicit enable)
 * Phase 3: Features disabled by default (advanced features)
 */

export interface FeatureFlags {
  // Phase 1: Core performance improvements (enabled)
  PARALLEL_CONNECTION: boolean;
  DEBOUNCED_SCROLL: boolean;
  BATCH_UPDATES: boolean;

  // Phase 2: Worker-based architecture (disabled by default)
  SSE_WORKER: boolean;
  COMPUTATION_WORKER: boolean;

  // Phase 3: Advanced features (disabled by default)
  RUST_CHANNELS: boolean;
  SHARED_ARRAY_BUFFER: boolean;
}

const defaultFlags: FeatureFlags = {
  // Phase 1: Core performance improvements - enabled
  PARALLEL_CONNECTION: true,
  DEBOUNCED_SCROLL: true,
  BATCH_UPDATES: true,

  // Phase 2: Worker-based architecture - disabled
  SSE_WORKER: false,
  COMPUTATION_WORKER: false,

  // Phase 3: Advanced features - disabled
  RUST_CHANNELS: false,
  SHARED_ARRAY_BUFFER: false,
};

/**
 * Get current feature flags
 * Can be overridden by environment variables for testing
 */
export function getFeatureFlags(): FeatureFlags {
  // Check for environment variable overrides
  // Format: OPENWORK_FEATURE_NAME=true|false
  const overrides: Partial<FeatureFlags> = {};

  for (const key of Object.keys(defaultFlags) as Array<keyof FeatureFlags>) {
    const envKey = `OPENWORK_FEATURE_${key}`;
    const envValue = process.env[envKey];
    if (envValue !== undefined) {
      overrides[key] = envValue.toLowerCase() === "true";
    }
  }

  return {
    ...defaultFlags,
    ...overrides,
  };
}

/**
 * Check if a specific feature is enabled
 */
export function isFeatureEnabled(feature: keyof FeatureFlags): boolean {
  const flags = getFeatureFlags();
  return flags[feature];
}

/**
 * Get the phase of a feature
 */
export function getFeaturePhase(feature: keyof FeatureFlags): 1 | 2 | 3 {
  if (feature === "PARALLEL_CONNECTION" || feature === "DEBOUNCED_SCROLL" || feature === "BATCH_UPDATES") {
    return 1;
  }
  if (feature === "SSE_WORKER" || feature === "COMPUTATION_WORKER") {
    return 2;
  }
  return 3;
}

/**
 * Feature flag toggle for development/testing
 */
export function createFeatureToggle() {
  let flags = { ...defaultFlags };

  return {
    get: () => flags,
    set: (newFlags: Partial<FeatureFlags>) => {
      flags = { ...flags, ...newFlags };
    },
    enable: (feature: keyof FeatureFlags) => {
      flags[feature] = true;
    },
    disable: (feature: keyof FeatureFlags) => {
      flags[feature] = false;
    },
    reset: () => {
      flags = { ...defaultFlags };
    },
  };
}

// Export for use in the app
export const featureFlags = getFeatureFlags();
