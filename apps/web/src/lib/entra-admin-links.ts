/**
 * Password reset hand-off to Microsoft Entra (issue #45).
 *
 * SwatchWatch stores no passwords. Each Entra External ID user has exactly one sign-in method
 * (Entra sends a second sign-up with the same email to the existing method), so a reset always
 * happens in that method's own flow: "Forgot password?" on the Entra sign-in page for email +
 * password accounts, or Google / Facebook for federated ones. Admins can additionally reset an
 * email + password account in the Entra admin center, which records it in Entra's audit log.
 */

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Entra admin center link to one user's profile (where "Reset password" lives), scoped to the
 * External ID tenant. Returns `null` unless both ids are GUIDs, which also hides the link for
 * dev-bypass identities.
 */
export function entraUserAdminUrl(tenantId: string | undefined, externalId: string | undefined): string | null {
  const tenant = tenantId?.trim();
  const oid = externalId?.trim();
  if (!tenant || !oid || !GUID_PATTERN.test(tenant) || !GUID_PATTERN.test(oid)) return null;
  return `https://entra.microsoft.com/${tenant}/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${oid}`;
}

/** Tenant id of the External ID tenant the web app signs in against (build-time env). */
export function configuredEntraTenantId(): string | undefined {
  return process.env.NEXT_PUBLIC_B2C_TENANT_ID?.trim() || undefined;
}

/** Plain-text reset instructions an admin can paste into a message to the user. */
export function passwordResetInstructions(): string {
  return [
    "To reset your SwatchWatch password:",
    "• If you sign in with your email and a password: open SwatchWatch, choose Sign in, enter your email, then choose “Forgot password?”. Microsoft emails you a code; enter it and pick a new password.",
    "• If you sign in with Google or Facebook: SwatchWatch has no password for you. Reset it with Google or Facebook, then sign in with the same button as before.",
  ].join("\n");
}
