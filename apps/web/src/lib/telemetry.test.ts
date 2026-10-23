import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DistributedTracingModes, type ITelemetryItem } from "@microsoft/applicationinsights-web";
import {
  apiHostFrom,
  buildTelemetryConfig,
  clearUser,
  initTelemetry,
  isTelemetryEnabled,
  parseSamplingPercentage,
  redactImageProxyIds,
  redactImageUrlsInitializer,
  redactWishlistTokens,
  setUser,
  trackEvent,
  trackException,
} from "./telemetry";

const CONNECTION_STRING =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.in.applicationinsights.azure.com/";

describe("telemetry no-op path", () => {
  it("is disabled on the server / without a connection string", async () => {
    assert.equal(isTelemetryEnabled(), false);
    await initTelemetry();
    assert.doesNotThrow(() => {
      trackEvent("test.event", { count: 1 });
      trackException(new Error("boom"), { boundary: "test" });
      trackException("not an error");
      setUser("42");
      clearUser();
    });
  });

  it("builds no config when the connection string is unset or blank", () => {
    assert.equal(buildTelemetryConfig({}), null);
    assert.equal(buildTelemetryConfig({ connectionString: "   " }), null);
  });
});

describe("buildTelemetryConfig", () => {
  it("restricts W3C correlation headers to the API host", () => {
    const config = buildTelemetryConfig({
      connectionString: CONNECTION_STRING,
      apiUrl: "https://swatchwatch-dev-func-abc123.azurewebsites.net/api",
    });
    assert.ok(config);
    assert.equal(config.connectionString, CONNECTION_STRING);
    assert.equal(config.enableAutoRouteTracking, true);
    assert.equal(config.enableUnhandledPromiseRejectionTracking, true);
    assert.equal(config.distributedTracingMode, DistributedTracingModes.W3C);
    assert.equal(config.enableCorsCorrelation, true);
    assert.deepEqual(config.correlationHeaderDomains, [
      "swatchwatch-dev-func-abc123.azurewebsites.net",
    ]);
    assert.equal(config.samplingPercentage, 100);
    assert.equal(config.disableCookiesUsage, false);
  });

  it("falls back to the local Functions host like lib/api.ts", () => {
    const config = buildTelemetryConfig({ connectionString: CONNECTION_STRING });
    assert.deepEqual(config?.correlationHeaderDomains, ["localhost:7071"]);
  });

  it("disables CORS correlation for a relative (same-origin) API URL", () => {
    const config = buildTelemetryConfig({ connectionString: CONNECTION_STRING, apiUrl: "/api" });
    assert.equal(config?.enableCorsCorrelation, false);
    assert.deepEqual(config?.correlationHeaderDomains, []);
  });

  it("reads the sampling percentage", () => {
    const config = buildTelemetryConfig({ connectionString: CONNECTION_STRING, sampling: "25" });
    assert.equal(config?.samplingPercentage, 25);
  });
});

describe("parseSamplingPercentage", () => {
  it("defaults to 100 for missing or out-of-range values", () => {
    for (const raw of [undefined, "", "  ", "abc", "0", "-5", "150", "NaN"]) {
      assert.equal(parseSamplingPercentage(raw), 100, `raw=${String(raw)}`);
    }
  });

  it("accepts values in (0, 100]", () => {
    assert.equal(parseSamplingPercentage("100"), 100);
    assert.equal(parseSamplingPercentage(" 12.5 "), 12.5);
  });
});

describe("apiHostFrom", () => {
  it("keeps non-default ports and drops default ones", () => {
    assert.equal(apiHostFrom("http://localhost:7071/api"), "localhost:7071");
    assert.equal(apiHostFrom("https://API.example.com:443/api"), "api.example.com");
  });

  it("returns null for relative URLs", () => {
    assert.equal(apiHostFrom("/api"), null);
  });
});

describe("image proxy id redaction", () => {
  const signedId = "v2.MTIzNDU2.Zm9vYmFyLXNpZ25hdHVyZQ";

  it("redacts the id segment and keeps the query", () => {
    assert.equal(
      redactImageProxyIds(`https://api.example.com/api/images/${signedId}?w=96&h=96`),
      "https://api.example.com/api/images/[redacted]?w=96&h=96",
    );
    assert.equal(redactImageProxyIds(`GET /api/images/${signedId}`), "GET /api/images/[redacted]");
  });

  it("leaves other URLs alone", () => {
    const url = "https://api.example.com/api/polishes/12?include=images";
    assert.equal(redactImageProxyIds(url), url);
  });

  it("redacts dependency, page view and custom fields on a telemetry item", () => {
    const item: ITelemetryItem = {
      name: "Microsoft.ApplicationInsights.RemoteDependency",
      baseType: "RemoteDependencyData",
      baseData: {
        name: `GET /api/images/${signedId}`,
        target: "api.example.com",
        data: `https://api.example.com/api/images/${signedId}?w=96`,
        uri: `https://app.example.com/api/images/${signedId}`,
        properties: { imageUrl: `/api/images/${signedId}`, count: 3 },
      },
      data: { src: `/api/images/${signedId}` },
    };

    assert.equal(redactImageUrlsInitializer(item), true);
    assert.equal(item.baseData?.name, "GET /api/images/[redacted]");
    assert.equal(item.baseData?.target, "api.example.com");
    assert.equal(item.baseData?.data, "https://api.example.com/api/images/[redacted]?w=96");
    assert.equal(item.baseData?.uri, "https://app.example.com/api/images/[redacted]");
    assert.deepEqual(item.baseData?.properties, { imageUrl: "/api/images/[redacted]", count: 3 });
    assert.deepEqual(item.data, { src: "/api/images/[redacted]" });
    assert.ok(!JSON.stringify(item).includes(signedId));
  });

  it("tolerates items without baseData", () => {
    assert.equal(redactImageUrlsInitializer({ name: "x" }), true);
  });
});

describe("wishlist share token redaction", () => {
  const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

  it("redacts the API path segment and the public page query parameter", () => {
    assert.equal(
      redactWishlistTokens(`https://api.example.com/api/wishlist/${token}`),
      "https://api.example.com/api/wishlist/[redacted]",
    );
    assert.equal(
      redactWishlistTokens(`https://app.example.com/w/?token=${token}&x=1`),
      "https://app.example.com/w/?token=[redacted]&x=1",
    );
  });

  it("redacts page views and dependencies through the initializer", () => {
    const item: ITelemetryItem = {
      name: "Microsoft.ApplicationInsights.PageView",
      baseData: {
        name: "Wishlist",
        uri: `https://app.example.com/w/?token=${token}`,
        refUri: `https://app.example.com/w/?token=${token}`,
        properties: { target: `GET /api/wishlist/${token}` },
      },
      tags: { "ai.operation.name": `/w/?token=${token}` },
    };
    assert.equal(redactImageUrlsInitializer(item), true);
    assert.ok(!JSON.stringify(item).includes(token));
  });

  it("leaves the owner share endpoint alone", () => {
    const url = "https://api.example.com/api/wishlist-share/rotate";
    assert.equal(redactWishlistTokens(url), url);
  });

  it("redacts shared-look tokens too, but not the owner look routes", () => {
    assert.equal(
      redactWishlistTokens(`https://api.example.com/api/look/${token}`),
      "https://api.example.com/api/look/[redacted]",
    );
    assert.equal(
      redactWishlistTokens(`https://app.example.com/l/?token=${token}`),
      "https://app.example.com/l/?token=[redacted]",
    );
    for (const url of ["https://api.example.com/api/looks", "https://api.example.com/api/look-share?key=glazed-donut:1,-"]) {
      assert.equal(redactWishlistTokens(url), url);
    }
  });
});
