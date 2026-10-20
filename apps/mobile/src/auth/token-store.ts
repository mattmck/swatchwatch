import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Persisted auth state. Native builds keep it in the Keychain / Android Keystore via
 * expo-secure-store; the web preview (`expo start --web`, used for local checks only) falls
 * back to localStorage because SecureStore has no web implementation.
 */
const KEY = "swatchwatch.auth.v1";

export interface StoredTokens {
  accessToken: string;
  /** Epoch seconds. */
  expiresAt?: number;
  refreshToken?: string;
  idToken?: string;
}

export interface StoredAuth {
  mode: "dev-bypass" | "entra";
  tokens?: StoredTokens;
}

export async function loadStoredAuth(): Promise<StoredAuth | null> {
  try {
    const raw =
      Platform.OS === "web" ? globalThis.localStorage?.getItem(KEY) ?? null : await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuth;
    return parsed && (parsed.mode === "dev-bypass" || parsed.mode === "entra") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Writes run one at a time, in call order: a refresh's save can never land after (and undo) a
 * sign-out's clear, and a slow save never overwrites a newer one.
 */
let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite(write: () => Promise<void>): Promise<void> {
  const result = writeQueue.then(write);
  writeQueue = result.catch(() => undefined);
  return result;
}

export function saveStoredAuth(auth: StoredAuth): Promise<void> {
  return enqueueWrite(() => writeStoredAuth(auth));
}

export function clearStoredAuth(): Promise<void> {
  return enqueueWrite(removeStoredAuth);
}

async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  const raw = JSON.stringify(auth);
  if (Platform.OS === "web") {
    globalThis.localStorage?.setItem(KEY, raw);
    return;
  }
  await SecureStore.setItemAsync(KEY, raw, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

async function removeStoredAuth(): Promise<void> {
  if (Platform.OS === "web") {
    globalThis.localStorage?.removeItem(KEY);
    return;
  }
  await SecureStore.deleteItemAsync(KEY);
}
