# Admin password reset (#45) — decision record

**Decision (2026-10-18):** SwatchWatch doesn't reset passwords itself. It points people to the reset flow of each person's sign-in method. The admin user dialog has a **Password** section with:

- copyable instructions to send to the user;
- an "Open in Entra admin center" link for each linked identity;
- a reminder that **Suspend** is the way to lock someone out.

There are no Graph calls, tenant app registration, secrets or migration.

## How identity works here (tested in the dev tenant)

- SwatchWatch uses one Entra External ID (CIAM) tenant per environment (`devswatchwatch` `2bff1c8d-…`, `prodswatchwatch` `d5229a36-…`). Sign-in methods: **Email with password**, **Google**, **Facebook**.
- Every sign-up creates an Entra user (`oid`), including Google and Facebook sign-ups. Those users simply have no password in Entra.
- **One email address = one Entra user = one sign-in method.** Manual tests on 2026-10-18:
  - Email+password first, then Google or Facebook with the same address → "already have an account".
  - Google first, then email+password sign-up with the same Gmail → Entra checks the email with a code, then sends the user to Google. Graph confirms there's still one user, with only the `google.com` identity.
- Different email addresses are different Entra users, and so different SwatchWatch users. `getOrCreateUser` links a second identity only on a verified-email claim. The dev app registration doesn't emit one (`optionalClaims: null`). An admin can merge duplicates in User Management.

So password reset depends only on the sign-in method:

| Sign-in method | Who owns the password | Reset path |
|---|---|---|
| Email + password | Entra | User: "Forgot password?" on the Microsoft sign-in page (emailed code). Admin: Entra admin center → user → Reset password (temporary password; logged in Entra's audit log) |
| Google / Facebook | Google / Facebook | User resets with that provider. Nothing to reset in Entra or SwatchWatch |

## Options considered

- **Delegated Graph from the browser (`resetPassword`, rejected).** It's delegated-only (`UserAuthenticationMethod.ReadWrite.All`). Every SwatchWatch admin's own customer sign-in would need a tenant directory role (User/Password/Authentication Administrator). The browser would receive a temporary password, and our API couldn't prove the reset happened for the audit log.
- **App-only server reset (`PATCH /users/{id}` `passwordProfile` + `revokeSignInSessions`, deferred).** This needs, in each tenant:
  - an app registration with `User-PasswordProfile.ReadWrite.All`, `User.Read.All` and `User.RevokeSessions.All`;
  - its service principal holding the **User Administrator** role;
  - a client secret in Key Vault.

  It's only worth doing if we need an in-app "kill this password and sign them out everywhere" action for compromised accounts. Even then, Suspend plus the Entra admin center covers it by hand today. The secretless variant (a user-assigned MI federated to a multitenant app provisioned into the CIAM tenant) is unverified for external tenants.

References: [resetPassword](https://learn.microsoft.com/en-us/graph/api/authenticationmethod-resetpassword?view=graph-rest-1.0), [Update user](https://learn.microsoft.com/en-us/graph/api/user-update?view=graph-rest-1.0), [Manage customer accounts](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-manage-customer-accounts), [Customer SSPR](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-enable-password-reset-customers), [App trust of a managed identity](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity).

## Not verified

- The prod tenant's settings (no access from here).
- Whether self-service password reset ("Forgot password?") is enabled in either tenant. It needs the Email OTP method and the branding toggle.
- The Entra admin center deep-link format (`https://entra.microsoft.com/{tenantId}/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/{oid}`).
- Google first, then Facebook with the same address.

## Tenant issues found along the way (not fixed here)

- The dev enterprise app "SwatchWatch Dev" has **Assignment required = Yes** (`appRoleAssignmentRequired: true`), so every brand-new sign-up fails with AADSTS50105. Only admin-assigned users can sign in. Set it to No unless dev is meant to be invite-only, and check prod.
- Google's account chooser shows "ciamlogin.com". Set the branding in Google Cloud (app name, logo, authorized domain `ciamlogin.com`) and request brand verification, or add an External ID custom URL domain.
