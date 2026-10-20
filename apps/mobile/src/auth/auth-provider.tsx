import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as WebBrowser from "expo-web-browser";
import {
  AuthRequest,
  CodeChallengeMethod,
  exchangeCodeAsync,
  ResponseType,
  resolveDiscoveryAsync,
  type DiscoveryDocument,
} from "expo-auth-session";
import { AUTH_MODE, DEV_USER_ID, ENTRA_SETTINGS, isEntraConfigured, type AuthMode, type EntraSettings } from "@/config/env";
import { errorMessage, validateAuth, type AuthValidateResponse } from "@/api/client";
import {
  bearerFor,
  devBearer,
  isExpired,
  refreshTokens,
  setDevSignedIn,
  setSessionExpiredHandler,
  setSessionExtras,
  setTokens,
  tokensFromResponse,
} from "./auth-token";
import { clearStoredAuth, loadStoredAuth, saveStoredAuth, type StoredAuth, type StoredTokens } from "./token-store";
import { entraApiScopes, entraExtraParams, entraIssuer, entraLoginScopes, entraRedirectUri } from "./entra-config";
import { clearApiCache } from "@/lib/api-cache";
import { clearPrivateImages } from "@/lib/private-image-loader";
import { claimString, decodeJwtPayload } from "./jwt";

// Completes a pending auth popup when the web preview reloads on the redirect URI.
WebBrowser.maybeCompleteAuthSession();

export interface AuthUser {
  /** Internal SwatchWatch user id from `/api/auth/validate`. */
  userId: number;
  name: string;
  email?: string;
  role: "admin" | "user";
}

export type AuthStatus = "loading" | "signedOut" | "signedIn";

export interface AuthContextValue {
  mode: AuthMode;
  status: AuthStatus;
  user: AuthUser | null;
  /** Last sign-in / validation error, shown on the sign-in screen. */
  error: string | null;
  busy: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

/** Turn a validate response into a user, or an error string. */
export function userFromValidation(
  result: AuthValidateResponse,
  claims: { name?: string; email?: string } = {},
): AuthUser | string {
  if (!result.valid || typeof result.userId !== "number") {
    if (result.code === "account_suspended") return "This account is suspended. Contact SwatchWatch support.";
    return result.error || "Sign-in was not accepted by the API.";
  }
  const email = result.email ?? claims.email;
  return {
    userId: result.userId,
    name: claims.name ?? email ?? `User ${result.userId}`,
    email,
    role: result.role === "admin" ? "admin" : "user",
  };
}

/** Picks the provider for `AUTH_MODE` (a build-time constant), like the web's AuthProvider. */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (AUTH_MODE === "dev-bypass") return <DevBypassAuthProvider>{children}</DevBypassAuthProvider>;
  if (AUTH_MODE === "entra" && isEntraConfigured(ENTRA_SETTINGS)) {
    return <EntraAuthProvider settings={ENTRA_SETTINGS}>{children}</EntraAuthProvider>;
  }
  return <UnconfiguredAuthProvider>{children}</UnconfiguredAuthProvider>;
}

// ── Dev bypass ──────────────────────────────────────────────────────────────

function DevBypassAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Validate `Bearer dev:<id>` against the API; only then count as signed in. */
  const validate = useCallback(async (): Promise<AuthUser | null> => {
    const result = await validateAuth(devBearer());
    const next = userFromValidation(result, { name: `Dev user ${DEV_USER_ID}` });
    if (typeof next === "string") {
      setError(`${next} Is the local Functions host running with AUTH_DEV_BYPASS=true?`);
      return null;
    }
    setDevSignedIn(true);
    setUser(next);
    setError(null);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadStoredAuth();
      if (stored?.mode === "dev-bypass") {
        try {
          if (await validate()) {
            if (!cancelled) setStatus("signedIn");
            return;
          }
        } catch (err) {
          if (stored.user) {
            // API unreachable: open the saved data; requests work again once it is back.
            setDevSignedIn(true);
            if (!cancelled) {
              setUser(stored.user);
              setStatus("signedIn");
            }
            return;
          }
          if (!cancelled) setError(errorMessage(err));
        }
      }
      if (!cancelled) setStatus("signedOut");
    })();
    return () => {
      cancelled = true;
    };
  }, [validate]);

  const signIn = useCallback(async () => {
    setBusy(true);
    try {
      const signedIn = await validate();
      if (signedIn) {
        await saveStoredAuth({ mode: "dev-bypass", user: signedIn }).catch(() => undefined);
        setStatus("signedIn");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [validate]);

  const signOut = useCallback(async () => {
    setDevSignedIn(false);
    setUser(null);
    await clearStoredAuth();
    clearPrivateImages();
    await clearApiCache();
    setStatus("signedOut");
  }, []);

  // A 401 from the API: the local host lost dev bypass or the user; back to sign-in.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setError("The API stopped accepting the dev session. Sign in again.");
      void signOut();
    });
    return () => setSessionExpiredHandler(null);
  }, [signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({ mode: "dev-bypass", status, user, error, busy, signIn, signOut }),
    [status, user, error, busy, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ── Entra External ID (authorization code + PKCE) ───────────────────────────

function EntraAuthProvider({ settings, children }: { settings: EntraSettings; children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const discoveryRef = useRef<DiscoveryDocument | null>(null);

  const redirectUri = useMemo(() => entraRedirectUri(), []);
  const extraParams = useMemo(() => entraExtraParams(settings), [settings]);

  const loadDiscovery = useCallback(async (): Promise<DiscoveryDocument> => {
    if (!discoveryRef.current) {
      discoveryRef.current = await resolveDiscoveryAsync(entraIssuer(settings));
    }
    return discoveryRef.current;
  }, [settings]);

  /** Adopt a token set: validate it with the API, then persist it and mark signed in. */
  const adopt = useCallback(
    async (tokens: StoredTokens, knownTokenEndpoint?: string): Promise<boolean> => {
      const tokenEndpoint = knownTokenEndpoint ?? (await loadDiscovery()).tokenEndpoint ?? "";
      setTokens(tokens, {
        clientId: settings.clientId,
        tokenEndpoint,
        scopes: entraApiScopes(settings),
        extraParams,
      });
      const result = await validateAuth(bearerFor(tokens.accessToken));
      const claims = decodeJwtPayload(tokens.idToken);
      const next = userFromValidation(result, {
        name: claimString(claims, "name", "given_name"),
        email: claimString(claims, "email", "emails", "preferred_username"),
      });
      if (typeof next === "string") {
        setTokens(null);
        setError(next);
        return false;
      }
      setSessionExtras({ user: next, tokenEndpoint });
      // Persisting can fail on a device (e.g. a rejected oversized value); the session still
      // works for this run, the next launch just asks to sign in again.
      await saveStoredAuth({ mode: "entra", tokens, user: next, tokenEndpoint }).catch((err: unknown) => {
        console.warn("[Auth] Couldn't save the session", err);
      });
      setUser(next);
      setError(null);
      setStatus("signedIn");
      return true;
    },
    [extraParams, loadDiscovery, settings],
  );

  // Restore a stored session on launch (refreshing it when the access token expired).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let stored: StoredAuth | null = null;
      try {
        stored = await loadStoredAuth();
        if (stored?.mode === "entra" && stored.tokens) {
          const tokenEndpoint = stored.tokenEndpoint ?? (await loadDiscovery()).tokenEndpoint ?? "";
          setTokens(stored.tokens, {
            clientId: settings.clientId,
            tokenEndpoint,
            scopes: entraApiScopes(settings),
            extraParams,
          });
          // Before any refresh: it re-saves the session and must keep the saved identity.
          setSessionExtras({ user: stored.user, tokenEndpoint });
          const fresh = isExpired(stored.tokens) ? await refreshTokens() : stored.tokens;
          if (fresh && (await adopt(fresh, tokenEndpoint))) return;
          await clearStoredAuth();
        }
      } catch (err) {
        if (stored?.mode === "entra" && stored.tokens && stored.user) {
          // Offline or the identity service is unreachable: keep the session and open the
          // saved data. Requests refresh the token themselves once the connection is back.
          setSessionExtras({ user: stored.user, tokenEndpoint: stored.tokenEndpoint });
          if (!cancelled) {
            setUser(stored.user);
            setStatus("signedIn");
          }
          return;
        }
        if (!cancelled) setError(errorMessage(err));
      }
      if (!cancelled) setStatus((current) => (current === "signedIn" ? current : "signedOut"));
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt, extraParams, loadDiscovery, settings]);

  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const discovery = await loadDiscovery();
      const request = new AuthRequest({
        clientId: settings.clientId,
        redirectUri,
        scopes: entraLoginScopes(settings),
        responseType: ResponseType.Code,
        usePKCE: true,
        codeChallengeMethod: CodeChallengeMethod.S256,
        extraParams,
      });
      const result = await request.promptAsync(discovery);
      if (result.type !== "success") {
        if (result.type === "error") setError(result.error?.message ?? "Sign-in failed.");
        return;
      }
      const code = result.params.code;
      if (!code || !request.codeVerifier) {
        setError("Sign-in returned no authorization code.");
        return;
      }
      const response = await exchangeCodeAsync(
        {
          clientId: settings.clientId,
          code,
          redirectUri,
          scopes: entraLoginScopes(settings),
          extraParams: { ...extraParams, code_verifier: request.codeVerifier },
        },
        discovery,
      );
      await adopt(tokensFromResponse(response));
    } catch (err) {
      setError(errorMessage(err, "Sign-in failed."));
    } finally {
      setBusy(false);
    }
  }, [adopt, extraParams, loadDiscovery, redirectUri, settings]);

  const signOut = useCallback(async () => {
    const idToken = (await loadStoredAuth())?.tokens?.idToken;
    setTokens(null);
    setUser(null);
    clearPrivateImages();
    await clearStoredAuth();
    await clearApiCache();
    setStatus("signedOut");
    // Best effort: end the Entra browser session too, so the next sign-in can pick an account.
    const endSession = discoveryRef.current?.endSessionEndpoint;
    if (endSession) {
      const params = new URLSearchParams({ post_logout_redirect_uri: redirectUri });
      if (idToken) params.set("id_token_hint", idToken);
      await WebBrowser.openAuthSessionAsync(`${endSession}?${params.toString()}`, redirectUri).catch(() => undefined);
    }
  }, [redirectUri]);

  // Refresh token rejected or a 401 mid-session: clear it and return to sign-in.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setTokens(null);
      setUser(null);
      setError("Your session expired. Sign in again.");
      setStatus("signedOut");
      void clearStoredAuth();
      void clearApiCache();
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ mode: "entra", status, user, error, busy, signIn, signOut }),
    [status, user, error, busy, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ── Not configured ──────────────────────────────────────────────────────────

function UnconfiguredAuthProvider({ children }: { children: ReactNode }) {
  const value = useMemo<AuthContextValue>(
    () => ({
      mode: "unconfigured",
      status: "signedOut",
      user: null,
      error: null,
      busy: false,
      signIn: async () => {
        console.warn("[Auth] Cannot sign in: sign-in is not configured for this build");
      },
      signOut: async () => {},
    }),
    [],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
