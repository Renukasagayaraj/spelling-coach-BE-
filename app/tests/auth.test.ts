import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { authenticateRequest } from "../auth.js";

function request(authorization?: string) {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = authorization ? { authorization } : {};
  return req;
}

test.beforeEach(() => {
  process.env.SUPABASE_URL = "https://auth.test";
  process.env.SUPABASE_PUBLISHABLE_KEY = "key";
});

test("authentication validates bearer headers and configuration", async () => {
  await assert.rejects(authenticateRequest(request()), /missing bearer token/);
  await assert.rejects(authenticateRequest(request("Basic token")), /missing bearer token/);
  await assert.rejects(authenticateRequest(request("Bearer")), /missing bearer token/);
  delete process.env.SUPABASE_URL;
  await assert.rejects(authenticateRequest(request("Bearer token")), /auth is not configured/);
});

test("authentication returns valid users and normalizes non-string email", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (_url, options) => {
      assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer token");
      return new Response(JSON.stringify({ id: "user", email: 42 }), { status: 200 });
    };
    assert.deepEqual(await authenticateRequest(request("Bearer token")), { id: "user", email: null });
  } finally {
    global.fetch = originalFetch;
  }
});

test("authentication handles rejected responses, unreadable bodies, and malformed users", async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    global.fetch = async () => ({
      ok: false, status: 401, text: async () => { throw new Error("unreadable"); },
    }) as unknown as Response;
    await assert.rejects(authenticateRequest(request("Bearer bad")), /invalid or expired/);

    global.fetch = async () => new Response(JSON.stringify({ email: "missing@example.com" }), { status: 200 });
    await assert.rejects(authenticateRequest(request("Bearer malformed")), /did not resolve to a user/);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
  }
});
