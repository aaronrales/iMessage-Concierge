/**
 * API contract drift test.
 *
 * Boots the real Express app against the database and validates live
 * responses from every spec-covered non-parametric GET endpoint against the zod schemas
 * generated from lib/api-spec/openapi.yaml. If a route's output shape drifts
 * from the spec (e.g. a field is removed or renamed, or a response-parse call
 * is deleted from a route), this test fails loudly instead of the dashboard
 * breaking silently.
 *
 * Runs in the integration project (requires DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { ZodTypeAny } from "zod";
import {
  HealthCheckResponse,
  ListUsersResponse,
  ListThreadsResponse,
  ListBookingsResponse,
  ListVenuesResponse,
  GetDeliveryHealthResponse,
  GetActivationSummaryResponse,
  GetAgentConfigResponse,
  ListEmulatorThreadsResponse,
  ListJITDestinationExtractionsResponse,
  ListVenuePopulationRunsResponse,
} from "@workspace/api-zod";
import app from "../app";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

/** Spec-covered GET endpoints and the generated schema each must satisfy. */
const CASES: Array<{ path: string; schema: ZodTypeAny }> = [
  { path: "/api/healthz", schema: HealthCheckResponse },
  { path: "/api/users", schema: ListUsersResponse },
  { path: "/api/threads", schema: ListThreadsResponse },
  { path: "/api/bookings", schema: ListBookingsResponse },
  { path: "/api/venues", schema: ListVenuesResponse },
  { path: "/api/operations/delivery-health", schema: GetDeliveryHealthResponse },
  { path: "/api/operations/delivery-health?windowHours=48", schema: GetDeliveryHealthResponse },
  { path: "/api/activation-summary", schema: GetActivationSummaryResponse },
  { path: "/api/agent-config", schema: GetAgentConfigResponse },
  { path: "/api/emulator/threads", schema: ListEmulatorThreadsResponse },
  { path: "/api/jit-destination-extractions", schema: ListJITDestinationExtractionsResponse },
  { path: "/api/venue-population-runs", schema: ListVenuePopulationRunsResponse },
];

describe("API contract drift", () => {
  for (const { path, schema } of CASES) {
    it(`GET ${path} matches the OpenAPI-generated schema`, async () => {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new Error(`Response for ${path} drifted from spec:\n${parsed.error.message}`);
      }
    });
  }

  it("rejects an out-of-range delivery-health windowHours with 400", async () => {
    const res = await fetch(`${baseUrl}/api/operations/delivery-health?windowHours=9999`);
    expect(res.status).toBe(400);
  });

  it("PUT /api/agent-config acks with the spec's WebhookAck shape", async () => {
    // Empty body is valid (both fields optional) and writes nothing.
    const res = await fetch(`${baseUrl}/api/agent-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });
});
