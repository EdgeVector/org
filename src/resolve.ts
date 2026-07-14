/**
 * Pure write-target resolution (SDK-bound algorithm).
 * No network, no org package imports beyond shared locator types.
 */

import { resolve as pathResolve } from "node:path";

import {
  type DbHandle,
  type OrgDbHandle,
  orgDb,
  parseDbLocator,
  personalDb,
} from "./db-handle.ts";

export type PathBinding = {
  /** Absolute filesystem root. */
  root: string;
  orgSlug: string;
  dbSlug: string;
  orgHash?: string;
};

export class ResolveError extends Error {
  readonly code: string;
  readonly matches?: PathBinding[];

  constructor(code: string, message: string, matches?: PathBinding[]) {
    super(message);
    this.name = "ResolveError";
    this.code = code;
    this.matches = matches;
  }
}

export type ResolveInput = {
  /** Prefer this path for place matching (cwd or git root). */
  cwd?: string;
  /** Explicit locator / shorthand — always wins when set. */
  explicit?: string;
  /** Session pin locator from `org use`. */
  sessionPin?: string;
  /** Registered path bindings (from org registry). */
  bindings?: PathBinding[];
  /** When true (default), no match → personal. */
  defaultPersonal?: boolean;
};

/**
 * Resolve which DB handle applies.
 * Order: explicit → place (longest root prefix) → session pin → personal → refuse.
 */
export function resolveWriteTarget(input: ResolveInput): DbHandle {
  if (input.explicit && input.explicit.trim().length > 0) {
    return parseDbLocator(input.explicit);
  }

  const cwd = input.cwd ? normalizePath(input.cwd) : undefined;
  const bindings = (input.bindings ?? []).map((b) => ({
    ...b,
    root: normalizePath(b.root),
  }));

  if (cwd && bindings.length > 0) {
    const matches = bindings.filter((b) => isUnderRoot(cwd, b.root));
    if (matches.length === 1) {
      return bindingToHandle(matches[0]!);
    }
    if (matches.length > 1) {
      // Longest root prefix wins.
      matches.sort((a, b) => b.root.length - a.root.length);
      const best = matches[0]!;
      const tied = matches.filter((m) => m.root.length === best.root.length);
      if (tied.length > 1) {
        // Same length different roots (symlink edge) or identical — if same target OK
        const keys = new Set(tied.map((t) => `${t.orgSlug}/${t.dbSlug}`));
        if (keys.size > 1) {
          throw new ResolveError(
            "ambiguous",
            `ambiguous write target for ${cwd}: ${tied
              .map((t) => `${t.root} → ${t.orgSlug}/${t.dbSlug}`)
              .join("; ")}`,
            tied,
          );
        }
      }
      return bindingToHandle(best);
    }
  }

  if (input.sessionPin && input.sessionPin.trim().length > 0) {
    return parseDbLocator(input.sessionPin);
  }

  if (input.defaultPersonal !== false) {
    return personalDb();
  }

  throw new ResolveError(
    "unresolved",
    "could not resolve write target (no explicit DB, no path match, no session pin)",
  );
}

function bindingToHandle(b: PathBinding): OrgDbHandle {
  return orgDb(b.orgSlug, b.dbSlug, b.orgHash);
}

export function normalizePath(p: string): string {
  // Resolve to absolute; keep trailing-slash free for prefix compares.
  let n = pathResolve(p);
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}

export function isUnderRoot(path: string, root: string): boolean {
  const p = normalizePath(path);
  const r = normalizePath(root);
  if (p === r) return true;
  return p.startsWith(r + "/");
}
