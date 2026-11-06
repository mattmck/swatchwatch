const test = require("node:test");
const assert = require("node:assert/strict");
const {
  INGESTED_BRAND_ID_SQL,
  findIngestedBrandId,
  findShadeForIngestedName,
  renameShadeToCleanName,
} = require("../dist/lib/ingestion-repo.js");

function fakeClient(responders) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      for (const r of responders) {
        const rows = r(text, values);
        if (rows) return { rows };
      }
      return { rows: [] };
    },
  };
}

const shadeNamed = (known) => (text, values) =>
  /FROM shade\b/.test(text) && /shade_name_canonical/.test(text)
    ? known[String(values[1]).toLowerCase()] !== undefined
      ? [{ shadeId: known[String(values[1]).toLowerCase()] }]
      : []
    : null;

test("brand id SQL matches the canonical name, then aliases, lowest id first", () => {
  const sql = INGESTED_BRAND_ID_SQL("$1");
  assert.match(sql, /lower\(b\.name_canonical\) = lower\(\$1\)/);
  assert.match(sql, /brand_alias/);
  assert.match(sql, /ORDER BY candidate\.rank, candidate\.brand_id/);
});

test("a brand found only through an alias returns its id and creates no brand", async () => {
  const client = fakeClient([(text) => (/brand_alias/.test(text) ? [{ brandId: 42 }] : null)]);
  assert.equal(await findIngestedBrandId(client, "Cracked"), 42);
  assert.ok(client.calls.every((c) => !/INSERT INTO brand/.test(c.text)));
});

test("no brand name or alias match returns null", async () => {
  assert.equal(await findIngestedBrandId(fakeClient([() => [{ brandId: null }]]), "Nope"), null);
});

test("a shade found by raw title is flagged and renamed with an alias", async () => {
  const client = fakeClient([shadeNamed({ "sniff test ppu": 7 })]);
  const found = await findShadeForIngestedName(client, {
    brandId: 1, name: "Sniff Test", rawTitle: "Sniff Test PPU", finish: "creme", collection: null,
  });
  assert.deepEqual(found, { shadeId: 7, matchedRaw: true });
  assert.equal(client.calls.length, 2);
  await renameShadeToCleanName(client, 7, "Sniff Test", "Sniff Test PPU");
  const update = client.calls[2];
  assert.match(update.text, /UPDATE shade SET shade_name_canonical/);
  assert.deepEqual(update.values, [7, "Sniff Test"]);
  const alias = client.calls[3];
  assert.match(alias.text, /INSERT INTO shade_alias[\s\S]*ON CONFLICT DO NOTHING/);
  assert.deepEqual(alias.values, [7, "Sniff Test PPU"]);
});

test("a shade found by the clean name is not flagged for rename", async () => {
  const client = fakeClient([shadeNamed({ "sniff test": 5 })]);
  const found = await findShadeForIngestedName(client, {
    brandId: 1, name: "Sniff Test", rawTitle: "Sniff Test PPU", finish: null, collection: null,
  });
  assert.deepEqual(found, { shadeId: 5, matchedRaw: false });
  assert.equal(client.calls.length, 1);
});

test("with both shades present the clean-name shade wins", async () => {
  const client = fakeClient([shadeNamed({ "sniff test": 5, "sniff test ppu": 7 })]);
  const found = await findShadeForIngestedName(client, {
    brandId: 1, name: "Sniff Test", rawTitle: "Sniff Test PPU", finish: null, collection: null,
  });
  assert.equal(found.shadeId, 5);
  assert.equal(found.matchedRaw, false);
});

test("a missing or identical raw title issues a single shade query", async () => {
  for (const rawTitle of [null, "sniff test"]) {
    const client = fakeClient([]);
    const found = await findShadeForIngestedName(client, {
      brandId: 1, name: "Sniff Test", rawTitle, finish: null, collection: null,
    });
    assert.equal(found, null);
    assert.equal(client.calls.length, 1);
  }
});
