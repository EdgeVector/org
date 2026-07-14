import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { formatDbLocator, LASTDB_DB_ENV, type DbHandle } from "./db-handle.ts";

export type WrapResult = {
  status: number;
  /** Set when the child binary was not found. */
  missing?: boolean;
};

/**
 * Run `<app> …` with LASTDB_DB + --db injected so the child sees an explicit handle.
 * Does not reimplement app verbs — pure context + exec.
 */
export function wrapApp(
  app: string,
  appArgs: string[],
  handle: DbHandle,
  opts: { env?: NodeJS.ProcessEnv; dryRun?: boolean } = {},
): WrapResult {
  if (!app || app.includes("/") || app.includes("..")) {
    throw new Error(`invalid app name: ${JSON.stringify(app)}`);
  }

  const locator = formatDbLocator(handle);
  const childArgs = injectDbFlag(appArgs, locator);
  const env = {
    ...(opts.env ?? process.env),
    [LASTDB_DB_ENV]: locator,
  };

  if (opts.dryRun) {
    return { status: 0 };
  }

  const resolved = resolveAppBinary(app, env);
  if (!resolved) {
    return { status: 127, missing: true };
  }

  const result = spawnSync(resolved.command, [...resolved.prefixArgs, ...childArgs], {
    env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  return { status: result.status ?? 1 };
}

/** Insert `--db <locator>` unless the child args already contain --db. */
export function injectDbFlag(args: string[], locator: string): string[] {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" || args[i]?.startsWith("--db=")) {
      return args.slice();
    }
  }
  return ["--db", locator, ...args];
}

function resolveAppBinary(
  app: string,
  env: NodeJS.ProcessEnv,
): { command: string; prefixArgs: string[] } | null {
  // Prefer PATH lookup
  const which = spawnSync("which", [app], { encoding: "utf8", env });
  if (which.status === 0 && which.stdout.trim()) {
    const path = which.stdout.trim();
    // Avoid wrapping ourselves
    if (path.endsWith("/org") || path.includes("/org/src/cli")) {
      return null;
    }
    return { command: path, prefixArgs: [] };
  }

  // Common EdgeVector checkouts
  const home = env.HOME ?? "";
  const candidates = [
    join(home, "code/edgevector", app, "src/cli.ts"),
    join(home, "lastdb-apps", app, "src/cli.ts"),
    join(home, ".local/bin", app),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      if (c.endsWith(".ts")) {
        return { command: env.BUN_BIN || "bun", prefixArgs: [c] };
      }
      return { command: c, prefixArgs: [] };
    }
  }
  return null;
}

export function isMetaCommand(command: string): boolean {
  return META_COMMANDS.has(command);
}

/** Built-in org verbs — not dispatched as app wrappers. */
export const META_COMMANDS = new Set([
  "help",
  "--help",
  "-h",
  "init",
  "create",
  "list",
  "show",
  "invite",
  "join",
  "db",
  "bind",
  "unbind",
  "bindings",
  "resolve",
  "use",
  "current",
  "unuse",
  "schema-json",
  "publish",
  "run", // explicit: org run kanban …
]);

export function usageWrapperLine(): string {
  return `  org <app> [args…]     resolve DB from cwd/pin, then run app with --db + ${LASTDB_DB_ENV}
  org run <app> [args…] same as org <app> (explicit form)
  org resolve            print resolved locator for cwd
  org bind <org> <db> --root PATH
  org use <locator>      session pin (override place)
  org current            show pin + resolved target
  org unuse              clear session pin
`;
}

// silence unused import in typecheck when tree-shaken
void dirname;
