export type IgnoreRecord = {
  id: string;
  repositoryRoot: string;
  relativePath: string;
  active: boolean;
  createdAt: number;
};

export function createRecordId(
  repositoryRoot: string,
  relativePath: string,
): string {
  return `${repositoryRoot}\0${relativePath}`;
}

export function upsertActiveRecord(
  records: IgnoreRecord[],
  repositoryRoot: string,
  relativePath: string,
  createdAt = Date.now(),
): IgnoreRecord[] {
  const id = createRecordId(repositoryRoot, relativePath);
  const existing = records.find((record) => record.id === id);

  if (existing) {
    return records.map((record) =>
      record.id === id ? { ...record, active: true } : record,
    );
  }

  return [
    ...records,
    {
      id,
      repositoryRoot,
      relativePath,
      active: true,
      createdAt,
    },
  ];
}

export function disableRecord(
  records: IgnoreRecord[],
  id: string,
): IgnoreRecord[] {
  return records.map((record) =>
    record.id === id ? { ...record, active: false } : record,
  );
}

export function removeRecord(
  records: IgnoreRecord[],
  id: string,
): IgnoreRecord[] {
  return records.filter((record) => record.id !== id);
}

export function isIgnoreRecord(value: unknown): value is IgnoreRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<IgnoreRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.repositoryRoot === "string" &&
    typeof record.relativePath === "string" &&
    typeof record.active === "boolean" &&
    typeof record.createdAt === "number"
  );
}
