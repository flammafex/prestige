/**
 * Privacy utilities for Enhanced Privacy Mode
 * Provides timing obfuscation, request batching, and privacy-preserving helpers
 */

export interface PrivacyConfig {
  /** Enable enhanced privacy mode */
  enabled: boolean;
  /** Minimum delay in milliseconds for timing obfuscation */
  minDelayMs: number;
  /** Maximum delay in milliseconds for timing obfuscation */
  maxDelayMs: number;
  /** Target response time for normalization (0 = disabled) */
  normalizedResponseMs: number;
  /** Enable request batching (process votes in batches) */
  batchingEnabled: boolean;
  /** Batch processing interval in milliseconds */
  batchIntervalMs: number;
}

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  enabled: false,
  minDelayMs: 100,
  maxDelayMs: 2000,
  normalizedResponseMs: 0,
  batchingEnabled: false,
  batchIntervalMs: 5000,
};

/**
 * Add a random delay to obfuscate timing
 * @param minMs Minimum delay in milliseconds
 * @param maxMs Maximum delay in milliseconds
 */
export async function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Add a random delay using privacy config
 */
export async function privacyDelay(config: PrivacyConfig): Promise<void> {
  if (!config.enabled) return;
  await randomDelay(config.minDelayMs, config.maxDelayMs);
}

/**
 * Execute a function with normalized response time
 * Ensures the total execution time is at least targetMs
 * @param fn The async function to execute
 * @param targetMs Target execution time in milliseconds
 */
export async function withNormalizedTiming<T>(
  fn: () => Promise<T>,
  targetMs: number
): Promise<T> {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;

  if (elapsed < targetMs) {
    await new Promise(resolve => setTimeout(resolve, targetMs - elapsed));
  }

  return result;
}

/**
 * Jitter a timestamp to prevent timing correlation
 * @param timestamp Original timestamp
 * @param maxJitterMs Maximum jitter in milliseconds
 */
export function jitterTimestamp(timestamp: number, maxJitterMs: number): number {
  const jitter = Math.floor(Math.random() * maxJitterMs * 2) - maxJitterMs;
  return timestamp + jitter;
}

/**
 * Request batcher for processing requests in batches
 * Reduces timing correlation by processing multiple requests together
 */
export class RequestBatcher<T, R> {
  private queue: Array<{
    request: T;
    resolve: (result: R) => void;
    reject: (error: Error) => void;
  }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;

  constructor(
    private processor: (requests: T[]) => Promise<R[]>,
    private intervalMs: number,
    private maxBatchSize: number = 100
  ) {}

  /**
   * Add a request to the batch queue
   */
  async add(request: T): Promise<R> {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });

      // Process immediately if batch is full
      if (this.queue.length >= this.maxBatchSize) {
        this.processBatch();
      } else if (!this.timer) {
        // Start timer for batch processing
        this.timer = setTimeout(() => this.processBatch(), this.intervalMs);
      }
    });
  }

  /**
   * Process all queued requests
   */
  private async processBatch(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const batch = this.queue.splice(0, this.maxBatchSize);
    const requests = batch.map(item => item.request);

    try {
      const results = await this.processor(requests);

      // Resolve each request with its result
      batch.forEach((item, index) => {
        if (index < results.length) {
          item.resolve(results[index]);
        } else {
          item.reject(new Error('Batch processing returned fewer results than requests'));
        }
      });
    } catch (error) {
      // Reject all requests in batch
      batch.forEach(item => {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      });
    } finally {
      this.processing = false;

      // Process remaining queue if any
      if (this.queue.length > 0) {
        this.timer = setTimeout(() => this.processBatch(), this.intervalMs);
      }
    }
  }

  /**
   * Get current queue size
   */
  get queueSize(): number {
    return this.queue.length;
  }

  /**
   * Flush the queue immediately
   */
  async flush(): Promise<void> {
    await this.processBatch();
  }
}

/**
 * Parse privacy configuration from environment variables
 */
export function parsePrivacyConfig(env: NodeJS.ProcessEnv): PrivacyConfig {
  return {
    enabled: env.PRIVACY_MODE === 'true' || env.PRIVACY_MODE === '1',
    minDelayMs: parseInt(env.PRIVACY_MIN_DELAY_MS || '100', 10),
    maxDelayMs: parseInt(env.PRIVACY_MAX_DELAY_MS || '2000', 10),
    normalizedResponseMs: parseInt(env.PRIVACY_NORMALIZED_RESPONSE_MS || '0', 10),
    batchingEnabled: env.PRIVACY_BATCHING === 'true' || env.PRIVACY_BATCHING === '1',
    batchIntervalMs: parseInt(env.PRIVACY_BATCH_INTERVAL_MS || '5000', 10),
  };
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do the comparison to maintain constant time
    // but we know the result will be false
    let result = 1;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Shuffle array using Fisher-Yates algorithm
 * Used to randomize processing order
 */
export function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
