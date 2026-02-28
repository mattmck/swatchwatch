import { createHash } from "crypto";
import { createClient } from "redis";
import { trackEvent, trackException } from "./telemetry";

const redisUrl = process.env.REDIS_URL?.trim();
const redisKey = process.env.REDIS_KEY?.trim();

const isConfigured = Boolean(redisUrl && redisKey);

type CacheClient = ReturnType<typeof createClient>;

let client: CacheClient | null = null;
let connectPromise: Promise<CacheClient | null> | null = null;

function safeKeyPrefix(key: string): string {
  const [prefix] = key.split(":");
  return prefix || "unknown";
}

async function getClient(): Promise<CacheClient | null> {
  if (!isConfigured) {
    return null;
  }

  if (client?.isOpen) {
    return client;
  }

  if (connectPromise) {
    return connectPromise;
  }

  const nextClient = createClient({
    url: redisUrl,
    password: redisKey,
  });

  nextClient.on("error", (error) => {
    trackException(error, { component: "redis", operation: "client.error" });
  });

  connectPromise = nextClient
    .connect()
    .then(() => {
      client = nextClient;
      trackEvent("cache.redis.connected");
      return nextClient;
    })
    .catch((error) => {
      trackException(error, { component: "redis", operation: "connect" });
      return null;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

export function hashCacheKey(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  const redis = await getClient();
  if (!redis) return null;

  try {
    const raw = await redis.get(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as T;
  } catch (error) {
    trackException(error, {
      component: "redis",
      operation: "get",
      keyPrefix: safeKeyPrefix(key),
    });
    return null;
  }
}

export async function cacheSetJson(
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  const redis = await getClient();
  if (!redis) return;

  try {
    const serialized = JSON.stringify(value);
    await redis.set(key, serialized, { EX: ttlSeconds });
  } catch (error) {
    trackException(error, {
      component: "redis",
      operation: "set",
      keyPrefix: safeKeyPrefix(key),
      ttlSeconds,
    });
  }
}

export async function cacheDelete(key: string): Promise<void> {
  const redis = await getClient();
  if (!redis) return;

  try {
    await redis.del(key);
  } catch (error) {
    trackException(error, {
      component: "redis",
      operation: "del",
      keyPrefix: safeKeyPrefix(key),
    });
  }
}

export async function cacheDeleteByPrefix(prefix: string): Promise<void> {
  const redis = await getClient();
  if (!redis) return;

  try {
    const keys: string[] = [];
    for await (const scanResult of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      const batch = Array.isArray(scanResult) ? scanResult : [scanResult];
      keys.push(...batch);
      if (keys.length >= 100) {
        await Promise.all(keys.map((key) => redis.del(key)));
        keys.length = 0;
      }
    }
    if (keys.length > 0) {
      await Promise.all(keys.map((key) => redis.del(key)));
    }
  } catch (error) {
    trackException(error, {
      component: "redis",
      operation: "scan-del",
      keyPrefix: safeKeyPrefix(prefix),
    });
  }
}
