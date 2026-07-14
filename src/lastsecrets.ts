import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Thin shell-out to the LastSecrets CLI. Org never stores raw E2E keys in its
 * own records — only lastsecrets:// locators. See workspace AGENTS.md.
 */

export class LastSecretsCliError extends Error {
  readonly code: string;
  readonly stderr: string;

  constructor(code: string, message: string, stderr = "") {
    super(message);
    this.name = "LastSecretsCliError";
    this.code = code;
    this.stderr = stderr;
  }
}

export type LastSecretsCli = {
  put(opts: {
    slug: string;
    value: string;
    label: string;
    provider?: string;
    purpose?: string;
    environment?: string;
  }): void;
  get(slug: string): string;
  ref(slug: string): string;
};

export function resolveLastSecretsBin(override?: string): string {
  if (override && override.length > 0) return override;
  if (process.env.ORG_LASTSECRETS_BIN) return process.env.ORG_LASTSECRETS_BIN;

  const candidates = [
    "lastsecrets",
    join(homedir(), "code/edgevector/lastsecrets/src/cli.ts"),
    join(homedir(), "lastdb-apps/lastsecrets/src/cli.ts"),
    join(homedir(), ".local/bin/lastsecrets"),
  ];
  for (const c of candidates) {
    if (c === "lastsecrets") {
      const which = spawnSync("which", ["lastsecrets"], { encoding: "utf8" });
      if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
      continue;
    }
    if (existsSync(c)) return c;
  }
  throw new LastSecretsCliError(
    "lastsecrets_missing",
    "lastsecrets CLI not found. Install LastSecrets (`bun link` in the lastsecrets repo) or set ORG_LASTSECRETS_BIN.",
  );
}

export function newLastSecretsCli(opts: { bin?: string } = {}): LastSecretsCli {
  const bin = resolveLastSecretsBin(opts.bin);

  const run = (args: string[], stdin?: string): { stdout: string; stderr: string } => {
    const isTs = bin.endsWith(".ts");
    const cmd = isTs ? "bun" : bin;
    const fullArgs = isTs ? [bin, ...args] : args;
    const result = spawnSync(cmd, fullArgs, {
      encoding: "utf8",
      input: stdin,
      env: process.env,
    });
    if (result.error) {
      throw new LastSecretsCliError(
        "lastsecrets_spawn_failed",
        `failed to run lastsecrets: ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      throw new LastSecretsCliError(
        "lastsecrets_failed",
        `lastsecrets ${args[0] ?? ""} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim()}`,
        result.stderr ?? "",
      );
    }
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };

  return {
    put({ slug, value, label, provider = "org", purpose = "org-e2e-key", environment = "local" }) {
      run(
        [
          "put",
          slug,
          "--label",
          label,
          "--provider",
          provider,
          "--purpose",
          purpose,
          "--env",
          environment,
          "--value-stdin",
        ],
        value,
      );
    },
    get(slug: string) {
      const { stdout } = run(["get", slug]);
      // lastsecrets get prints the raw value; trim a single trailing newline if present
      return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    },
    ref(slug: string) {
      const { stdout } = run(["ref", slug]);
      return stdout.trim();
    },
  };
}
