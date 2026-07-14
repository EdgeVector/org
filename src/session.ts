import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { formatDbLocator, parseDbLocator, type DbHandle } from "./db-handle.ts";

export function defaultSessionPath(): string {
  const override = process.env.ORG_SESSION;
  if (override && override.length > 0) return override;
  return join(homedir(), ".org", "session.json");
}

export type SessionState = {
  locator: string;
  setAt: string;
};

export function readSessionPin(path = defaultSessionPath()): DbHandle | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { locator?: string };
    if (typeof raw.locator !== "string" || raw.locator.length === 0) return null;
    return parseDbLocator(raw.locator);
  } catch {
    return null;
  }
}

export function writeSessionPin(handle: DbHandle, path = defaultSessionPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const state: SessionState = {
    locator: formatDbLocator(handle),
    setAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function clearSessionPin(path = defaultSessionPath()): void {
  if (existsSync(path)) unlinkSync(path);
}
