import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestIdentityError,
  signGuestToken,
  verifyGuestToken,
} from "../guestIdentity.js";

const TEST_SECRET = "guest-token-test-secret-at-least-32-characters";
const GUEST_ID = "f3373a5c-3d24-4d14-a214-1adcb34dc908";

test("guest tokens preserve a valid guest UUID", () => {
  const token = signGuestToken(GUEST_ID, TEST_SECRET);
  assert.deepEqual(verifyGuestToken(token, TEST_SECRET), {
    version: 1,
    guestId: GUEST_ID,
  });
});

test("guest tokens reject modified signatures and payloads", () => {
  const token = signGuestToken(GUEST_ID, TEST_SECRET);
  const [payload, signature] = token.split(".");

  assert.throws(
    () => verifyGuestToken(`${payload}.${signature.slice(0, -1)}x`, TEST_SECRET),
    (error) => error instanceof GuestIdentityError && error.code === "INVALID_GUEST_TOKEN",
  );
  assert.throws(
    () => verifyGuestToken("not-a-valid-token", TEST_SECRET),
    (error) => error instanceof GuestIdentityError && error.statusCode === 401,
  );
});
