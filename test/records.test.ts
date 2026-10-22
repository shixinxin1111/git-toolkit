import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecordId,
  disableRecord,
  removeRecord,
  upsertActiveRecord,
} from "../src/records";

const repositoryRoot = "/workspace/project";
const relativePath = "src/config.ts";

test("creates one active record for a new file", () => {
  const records = upsertActiveRecord(
    [],
    repositoryRoot,
    relativePath,
    123,
  );

  assert.deepEqual(records, [
    {
      id: createRecordId(repositoryRoot, relativePath),
      repositoryRoot,
      relativePath,
      active: true,
      createdAt: 123,
    },
  ]);
});

test("re-enables a disabled record without creating a duplicate", () => {
  const id = createRecordId(repositoryRoot, relativePath);
  const records = upsertActiveRecord(
    [
      {
        id,
        repositoryRoot,
        relativePath,
        active: false,
        createdAt: 123,
      },
    ],
    repositoryRoot,
    relativePath,
    456,
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].active, true);
  assert.equal(records[0].createdAt, 123);
});

test("disables a record without removing it", () => {
  const id = createRecordId(repositoryRoot, relativePath);
  const records = disableRecord(
    [
      {
        id,
        repositoryRoot,
        relativePath,
        active: true,
        createdAt: 123,
      },
    ],
    id,
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].active, false);
});

test("removes only the selected record", () => {
  const selectedId = createRecordId(repositoryRoot, relativePath);
  const retainedId = createRecordId(repositoryRoot, "src/other.ts");
  const records = removeRecord(
    [
      {
        id: selectedId,
        repositoryRoot,
        relativePath,
        active: true,
        createdAt: 123,
      },
      {
        id: retainedId,
        repositoryRoot,
        relativePath: "src/other.ts",
        active: false,
        createdAt: 456,
      },
    ],
    selectedId,
  );

  assert.deepEqual(
    records.map((record) => record.id),
    [retainedId],
  );
});
