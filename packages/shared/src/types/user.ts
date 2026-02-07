export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  authProvider: AuthProvider;
  createdAt: string;
  updatedAt: string;
}

export type AuthProvider = "apple" | "facebook" | "google" | "email";

export interface AuthConfig {
  authority: string;
  clientId: string;
  knownAuthorities: string[];
  redirectUri: string;
  scopes: string[];
}
