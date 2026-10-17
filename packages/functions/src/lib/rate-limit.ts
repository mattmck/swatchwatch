/**
 * Best-effort in-memory token-bucket rate limiting.
 *
 * Each Functions instance keeps its own buckets, so on the Consumption plan (which scales out
 * and recycles instances) the effective limit is "per instance" and resets on cold start. That
 * is enough to blunt scraping/hammering of anonymous endpoints without a shared store; Redis is
 * not wired for this. Do not rely on it for anything security-critical.
 *
 * Memory is bounded: when `maxKeys` is reached, buckets that have refilled completely (i.e. are
 * indistinguishable from a fresh bucket) are swept, and if that is not enough the least recently
 * touched bucket is evicted (Map iteration order = insertion order; touching re-inserts).
 */

export interface TokenBucketOptions {
  /** Burst size: the most requests a key can make at once. */
  capacity: number;
  /** Steady-state refill rate, in tokens per second. */
  refillPerSecond: number;
  /** Upper bound on tracked keys (default 10 000). */
  maxKeys?: number;
  /** Clock override (epoch ms) for tests. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until one token is available again (0 when allowed). */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    if (!(options.capacity >= 1) || !(options.refillPerSecond > 0)) {
      throw new Error("TokenBucketLimiter needs capacity >= 1 and refillPerSecond > 0");
    }
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerSecond / 1000;
    this.maxKeys = Math.max(1, options.maxKeys ?? 10_000);
    this.now = options.now ?? Date.now;
  }

  /** Take one token for `key`. */
  take(key: string): RateLimitDecision {
    const now = this.now();
    const bucket = this.refill(this.buckets.get(key), now);

    // Re-insert so iteration order tracks recency for eviction.
    this.buckets.delete(key);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.store(key, bucket, now);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    this.store(key, bucket, now);
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  /** Number of tracked keys (tests/diagnostics). */
  get size(): number {
    return this.buckets.size;
  }

  /** Forget every bucket (tests). */
  reset(): void {
    this.buckets.clear();
  }

  private refill(existing: Bucket | undefined, now: number): Bucket {
    if (!existing) return { tokens: this.capacity, updatedAt: now };
    const elapsed = Math.max(0, now - existing.updatedAt);
    return {
      tokens: Math.min(this.capacity, existing.tokens + elapsed * this.refillPerMs),
      updatedAt: now,
    };
  }

  private store(key: string, bucket: Bucket, now: number): void {
    if (this.buckets.size >= this.maxKeys) {
      this.sweep(now);
    }
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    this.buckets.set(key, bucket);
  }

  /** Drop buckets that have fully refilled; they carry no state a fresh bucket would not. */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (this.refill(bucket, now).tokens >= this.capacity) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * Best-effort client IP for rate limiting. Uses the right-most `X-Forwarded-For` entry, which is
 * the one appended by the nearest proxy (the Azure front end) rather than a value the client can
 * pre-seed, and strips a trailing `:port` (Azure includes it). Falls back to `"unknown"`, which
 * means all such requests share one bucket.
 */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for");
  const candidate =
    forwarded
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .pop() ??
    headers.get("x-client-ip")?.trim() ??
    "";
  return normalizeIp(candidate) || "unknown";
}

function normalizeIp(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  // [IPv6]:port or [IPv6]
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1].toLowerCase();
  // IPv4:port
  const v4WithPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4WithPort) return v4WithPort[1];
  return value.toLowerCase().slice(0, 64);
}
