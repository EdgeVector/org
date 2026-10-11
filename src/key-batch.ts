import type { QueryRow } from "./lastdb.ts";

export async function queryKnownKeys(keys: string[], load: (batch: string[]) => Promise<QueryRow[]>) {
  const unique = [...new Set(keys)];
  const batches: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += 1000) {
    batches.push(unique.slice(offset, offset + 1000));
  }
  const rows: QueryRow[] = [];
  for (let offset = 0; offset < batches.length; offset += 4) {
    const results = await Promise.all(batches.slice(offset, offset + 4).map(load));
    rows.push(...results.flat());
  }
  return rows;
}
