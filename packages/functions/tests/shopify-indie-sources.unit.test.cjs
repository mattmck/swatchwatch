const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  ShopifyGenericConnector,
  SHOPIFY_SOURCE_BASE_URLS,
  SHOPIFY_SOURCES_PENDING_APPROVAL,
  isShopifySourceEnabledByDefault,
  resolveShopifyVendor,
} = require("../dist/lib/connectors/shopify-generic");
const { SUPPORTED_SOURCES } = require("../dist/lib/connectors/generated-types");

const REPO_ROOT = resolve(__dirname, "../../..");
const SEED_SQL = readFileSync(resolve(REPO_ROOT, "docs/seed_data_sources.sql"), "utf8");
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

/** The VALUES tuple for `name` in a data_source INSERT, as raw SQL text. */
function seedTuple(sql, name) {
  const start = sql.indexOf(`'${name}',`);
  assert.notEqual(start, -1, `${name} missing`);
  return sql.slice(start, sql.indexOf("::jsonb", start));
}

describe("indie Shopify sources (#273, #328)", () => {
  const SIGNED_OFF = {
    PahlishShopify: "https://pahlish.com",
    EmilyDeMollyShopify: "https://emilydemolly.com",
    CirqueColorsShopify: "https://cirquecolors.com",
  };

  it("any source still pending approval is a supported source, auto-provisioned disabled and seeded disabled", () => {
    for (const source of SHOPIFY_SOURCES_PENDING_APPROVAL) {
      assert.ok(SUPPORTED_SOURCES.includes(source), `${source} not in generated SUPPORTED_SOURCES`);
      assert.match(SHOPIFY_SOURCE_BASE_URLS[source] ?? "", /^https:\/\//, `${source} has no base URL`);
      assert.equal(isShopifySourceEnabledByDefault(source), false, source);
      const tuple = seedTuple(SEED_SQL, source);
      assert.match(tuple, /,\s*false,\s*'\{/, `${source} must be seeded with enabled=false`);
      assert.match(tuple, /"pendingApproval": true/, source);
    }
  });

  it("enables approved sources: Night Owl Lacquer (decision D2)", () => {
    assert.equal(SHOPIFY_SOURCES_PENDING_APPROVAL.has("NightOwlLacquerShopify"), false);
    assert.equal(isShopifySourceEnabledByDefault("NightOwlLacquerShopify"), true);
    const tuple = seedTuple(SEED_SQL, "NightOwlLacquerShopify");
    assert.match(tuple, /,\s*true,\s*'\{/, "NightOwlLacquerShopify must be seeded enabled");
    assert.doesNotMatch(tuple, /"pendingApproval"/);
  });

  it("enables the three stores that signed off on 2026-10-19", () => {
    for (const [source, baseUrl] of Object.entries(SIGNED_OFF)) {
      assert.ok(SUPPORTED_SOURCES.includes(source), source);
      assert.equal(SHOPIFY_SOURCE_BASE_URLS[source], baseUrl, source);
      assert.equal(SHOPIFY_SOURCES_PENDING_APPROVAL.has(source), false, source);
      assert.equal(isShopifySourceEnabledByDefault(source), true, source);
      const tuple = seedTuple(SEED_SQL, source);
      assert.match(tuple, /,\s*true,\s*'\{/, `${source} must be seeded enabled`);
      assert.doesNotMatch(tuple, /"pendingApproval"/, source);
      assert.match(tuple, /acceptable use confirmed: the owner reports the store signed off on 2026-10-19/, source);
      assert.doesNotMatch(tuple, /Disabled pending|not yet confirmed/, source);
    }
  });

  it("a migration inserts the indie sources disabled and another enables the signed-off ones", () => {
    const read = (suffix) =>
      readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith(suffix))
        .map((file) => readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"))
        .map((migration) => migration.slice(0, migration.indexOf("-- Down Migration")))[0];
    for (const suffix of ["_add-indie-shopify-sources.sql", "_add-more-indie-shopify-sources.sql"]) {
      const up = read(suffix);
      assert.ok(up, `${suffix} missing`);
      assert.match(up, /enabled\s+=\s+false/, "an existing row must be disabled on conflict");
    }
    const enable = read("_enable-signed-off-indie-sources.sql");
    assert.ok(enable, "enable migration missing");
    assert.match(enable, /enabled = true/);
    for (const source of Object.keys(SIGNED_OFF)) {
      assert.ok(enable.includes(`'${source}'`), `${source} not enabled by the migration`);
    }
    assert.match(enable, /metadata->>'pendingApproval' = 'true'/, "must only touch rows still pending");
    const down = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith("_enable-signed-off-indie-sources.sql"))
      .map((file) => readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"))[0];
    assert.match(
      down.slice(down.indexOf("-- Down Migration")),
      /metadata->>'enabledByMigration' = '20261019020000000'/,
      "down must only revert rows this migration enabled"
    );
  });

  it("rolling back the first indie migration deletes only the rows it inserted", () => {
    const files = readdirSync(MIGRATIONS_DIR).sort();
    const addIndie = files.find((file) => file.endsWith("_add-indie-shopify-sources.sql"));
    const guard = files.find((file) => file.endsWith("_guard-indie-shopify-sources-rollback.sql"));
    assert.ok(addIndie && guard, "migrations missing");
    assert.ok(guard > addIndie, "the guard must be rolled back before the migration it protects");
    const split = (file) => {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
      const at = sql.search(/^\s*--[\s-]*down\s+migration/im);
      return { up: sql.slice(0, at), down: sql.slice(at) };
    };
    const addIndieDown = split(addIndie).down;
    const deleted = addIndieDown.match(/DELETE FROM data_source AS ds\s+WHERE ds\.name IN \(([^)]*)\)/);
    assert.ok(deleted, "the original rollback DELETE changed; re-check the guard");
    const deletedNames = deleted[1].match(/'[^']+'/g);

    const { up, down } = split(guard);
    const marker = `'{"insertedByMigration": "${addIndie.split("_")[0]}"}'`;
    // Up marks only rows the original migration inserted: found by its own pgmigrations row,
    // created in the seconds before it was recorded, and never an auto-provisioned row.
    assert.ok(up.includes(marker), "up must stamp the marker");
    assert.ok(up.includes(`m.name = '${addIndie.replace(/\.sql$/, "")}'`), "up must read the original's run_on");
    assert.match(up, /NOT COALESCE\(ds\.metadata \? 'autoProvisioned', false\)/);
    assert.match(up, /ds\.created_at <= m\.run_on\s+AND ds\.created_at > m\.run_on - interval '10 seconds'/);
    for (const name of deletedNames) assert.ok(up.includes(name), `${name} not marked`);

    // Down leaves a guard that skips the delete of every unmarked row the original DELETE targets.
    assert.match(down, /CREATE TRIGGER data_source_keep_preexisting_nightowl_pahlish_rows\s+BEFORE DELETE ON data_source\s+FOR EACH ROW/);
    const when = down.match(/WHEN \(([\s\S]*?)\)\s+EXECUTE FUNCTION/);
    assert.ok(when, "guard needs a WHEN clause");
    for (const name of deletedNames) assert.ok(when[1].includes(name), `${name} not guarded`);
    assert.match(
      when[1],
      new RegExp(`\\(OLD\\.metadata->>'insertedByMigration'\\) IS DISTINCT FROM '${addIndie.split("_")[0]}'`),
      "only unmarked rows may be kept"
    );
    assert.match(down, /RETURN NULL;/, "the guard must skip the delete, not fail the rollback");
    assert.doesNotMatch(down, /DROP FUNCTION|- 'insertedByMigration'/, "down must keep the guard and the marker");
  });
});

describe("resolveShopifyVendor", () => {
  it("keeps a real vendor", () => {
    assert.equal(resolveShopifyVendor("Night Owl Lacquer", "Fallback"), "Night Owl Lacquer");
  });

  it("falls back to the source brand for missing or placeholder vendors", () => {
    for (const vendor of [null, undefined, "", "  ", "vendor-unknown", "Vendor-Unknown", "Default Vendor"]) {
      assert.equal(resolveShopifyVendor(vendor, "Night Owl Lacquer"), "Night Owl Lacquer", String(vendor));
    }
  });
});

describe("generic Shopify connector with a placeholder vendor", () => {
  let originalFetch;
  let originalEndpoint;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_ENDPOINT; // keep color-name detection offline
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          products: [
            {
              id: 1,
              title: "Seance Wine",
              handle: "seance-wine",
              vendor: "vendor-unknown",
              product_type: "Polish",
              tags: ["Fall", "Halloween"],
              published_at: "2026-10-01T00:00:00Z",
              variants: [{ id: 11, title: "Default Title", option1: "Default Title" }],
              images: [],
            },
          ],
        }),
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = originalEndpoint;
  });

  it("uses the brand derived from the source name", async () => {
    const result = await new ShopifyGenericConnector("NightOwlLacquerShopify").pullProducts({
      searchTerm: "",
      page: 1,
      pageSize: 50,
      maxRecords: 50,
    });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].normalized.brand, "Night Owl Lacquer");
    assert.equal(result.records[0].normalized.productUrl, "https://nightowllacquer.com/products/seance-wine");
  });
});
