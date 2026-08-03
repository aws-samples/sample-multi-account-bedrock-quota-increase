// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// Minimal argv parser: supports `--flag value`, `--flag=value`, and `--bool`.
// The first non-flag token is treated as the subcommand.
export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

const BOOLEAN_FLAGS = new Set([
  "dry-run", "yes", "help", "version", "no-confirm", "no-subscribe", "subscribe-only",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else {
      positionals.push(tok);
    }
  }

  const command = positionals.shift() || "request";
  return { command, flags, positionals };
}

export function flagStr(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

export function flagInt(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flagStr(flags, name);
  if (v === undefined) return undefined;
  // Accept `_` and `,` digit-group separators (e.g. --tpm 30_000_000): strip
  // them first, since Number.parseInt would silently stop at the first `_`.
  const n = Number.parseInt(v.replace(/[_,]/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

// Accept commas and/or whitespace as separators for list-style flags.
export function flagList(flags: Record<string, string | boolean>, name: string): string[] {
  const v = flagStr(flags, name);
  if (!v) return [];
  return v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

// Parse a `Key=Value` tag flag: `--tag k1=v1,k2=v2`. Splits on commas, then on
// the FIRST `=` (values may themselves contain `=`). Entries with no `=` come
// back with an empty key so the caller can reject them via fail(). Whitespace
// around the key and value is trimmed.
export function flagTags(flags: Record<string, string | boolean>, name: string): { key: string; value: string }[] {
  const v = flagStr(flags, name);
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const eq = entry.indexOf("=");
    if (eq === -1) return { key: "", value: entry };
    return { key: entry.slice(0, eq).trim(), value: entry.slice(eq + 1).trim() };
  });
}
