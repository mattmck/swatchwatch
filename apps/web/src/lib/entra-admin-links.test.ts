import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { entraUserAdminUrl, passwordResetInstructions } from "./entra-admin-links";

const TENANT = "2bff1c8d-f022-45ed-91bf-7485529ba989";
const OID = "fc7e714a-e750-4d2e-b8f3-3307c7ab68c7";

describe("entraUserAdminUrl", () => {
  it("links to the user's profile in the given tenant", () => {
    assert.equal(
      entraUserAdminUrl(TENANT, OID),
      `https://entra.microsoft.com/${TENANT}/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${OID}`
    );
  });

  it("trims surrounding whitespace", () => {
    assert.equal(entraUserAdminUrl(` ${TENANT} `, ` ${OID}\n`), entraUserAdminUrl(TENANT, OID));
  });

  it("returns null without a tenant id", () => {
    assert.equal(entraUserAdminUrl(undefined, OID), null);
    assert.equal(entraUserAdminUrl("  ", OID), null);
  });

  it("returns null for ids that are not GUIDs (dev bypass, legacy B2C tenant names)", () => {
    assert.equal(entraUserAdminUrl(TENANT, "dev-user-1"), null);
    assert.equal(entraUserAdminUrl("devswatchwatch", OID), null);
    assert.equal(entraUserAdminUrl(TENANT, `${OID}/../x`), null);
    assert.equal(entraUserAdminUrl(TENANT, undefined), null);
  });
});

describe("passwordResetInstructions", () => {
  it("covers the email + password path and the federated providers", () => {
    const text = passwordResetInstructions();
    assert.match(text, /Forgot password\?/);
    assert.match(text, /Google or Facebook/);
    assert.doesNotMatch(text, /https?:\/\//, "no links an attacker could imitate");
  });
});
