export interface User {
  id: string;
  externalId?: string;
  email?: string;
  displayName: string;
  avatarUrl?: string;
  authProvider: AuthProvider;
  createdAt: string;
  updatedAt: string;
}

export type AuthProvider = "apple" | "facebook" | "github" | "google" | "email";

export interface Auth0Config {
  issuerBaseUrl: string;
  audience: string;
  clientId?: string;
}

export interface StytchConfig {
  projectId: string;
  publicToken?: string;
}

export interface AuthConfig {
  provider: "auth0" | "stytch";
  auth0?: Auth0Config;
  stytch?: StytchConfig;
}
