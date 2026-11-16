/**
 * The retry message id, checked without touching Redis or QStash.
 *
 * QStash answers `{"error":"DeduplicationId cannot contain ':'"}` with a 400,
 * which would have turned every quota retry into a 500 and lost the URL. Cheap
 * to keep an eye on.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { requeueDedupeId } from "../api/_lib/jobs.js";

const ID = "b53m9e4vSSXZrWb8aoIF5w";

test("the retry id never contains a colon", () => {
  for (const index of [0, 7, 49]) {
    for (const attempt of [1, 2, 5]) {
      const value = requeueDedupeId(ID, index, attempt);
      assert.ok(!value.includes(":"), `no colon in ${value}`);
      assert.match(value, /^[A-Za-z0-9_-]+$/, "only characters QStash accepts");
    }
  }
});

test("every attempt gets its own id", () => {
  const ids = [1, 2, 3, 4, 5].map((attempt) => requeueDedupeId(ID, 3, attempt));
  assert.equal(new Set(ids).size, ids.length, "a retry is never deduplicated away");
});

test("different URLs of the same batch get their own id", () => {
  assert.notEqual(requeueDedupeId(ID, 0, 1), requeueDedupeId(ID, 1, 1));
  assert.notEqual(requeueDedupeId(ID, 1, 1), requeueDedupeId("anotherJobIdHere12345", 1, 1));
});
