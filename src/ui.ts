// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// Tiny zero-dependency helpers for colored logging and interactive prompts.
import readline from "node:readline";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: unknown) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
  gray: wrap("90"),
};

export const log = {
  info: (msg: string) => console.error(msg),
  step: (msg: string) => console.error(`${c.cyan("›")} ${msg}`),
  ok: (msg: string) => console.error(`${c.green("✓")} ${msg}`),
  warn: (msg: string) => console.error(`${c.yellow("!")} ${msg}`),
  err: (msg: string) => console.error(`${c.red("✗")} ${msg}`),
  plain: (msg = "") => console.error(msg),
};

// Machine-readable results go to stdout so the human logs (on stderr) can be
// filtered out with `... 2>/dev/null` when piping.
export const out = (msg: string) => console.log(msg);

export function fail(msg: string, code = 1): never {
  log.err(msg);
  process.exit(code);
}

function question(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(query, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

export async function ask(query: string, fallback = ""): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const answer = (await question(query)).trim();
  return answer || fallback;
}

// Prompt for a positive integer, keeping `fallback` on an empty answer. Accepts
// grouping separators (commas/underscores) so "6,000,000" and "6000000" both
// work. Returns `fallback` when there's no interactive terminal.
export async function askNumber(query: string, fallback: number): Promise<number> {
  if (!process.stdin.isTTY) return fallback;
  while (true) {
    const raw = (await question(`${query} `)).trim();
    if (!raw) return fallback;
    const n = Number(raw.replace(/[_,]/g, ""));
    if (Number.isFinite(n) && n > 0) return Math.round(n);
    log.warn("Enter a positive number, or press Enter to keep the current value.");
  }
}

export async function confirm(query: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await question(`${query} ${hint} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

// Present a numbered list and return the chosen item.
export async function pick<T>(title: string, items: T[], render: (item: T) => string): Promise<T> {
  if (!process.stdin.isTTY) {
    fail(`${title} requires a selection, but no interactive terminal is available. Pass the value as a flag instead.`);
  }
  log.plain(c.bold(title));
  items.forEach((item, i) => {
    log.plain(`  ${c.cyan(String(i + 1).padStart(2))}. ${render(item)}`);
  });
  while (true) {
    const raw = await ask(`${c.dim("Enter number:")} `);
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]!;
    log.warn(`Please enter a number between 1 and ${items.length}.`);
  }
}

// Arrow-key selectable list. Redraws in place on ↑/↓/j/k, confirms on Enter,
// cancels on Esc or Ctrl-C. Falls back to the numbered `pick` prompt when the
// terminal can't enter raw mode (e.g. some CI shells). Rendered on stderr so
// stdout stays clean for scripting.
export async function selectArrow<T>(title: string, items: T[], render: (item: T) => string): Promise<T> {
  if (items.length === 0) fail(`${title}: nothing to select.`);
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return pick(title, items, render);
  }

  const write = (s: string) => process.stderr.write(s);
  let index = 0;

  const draw = (first: boolean) => {
    if (!first) write(`\x1b[${items.length + 1}A`); // move cursor up to redraw
    write(`${c.bold(title)}\x1b[K\n`);
    items.forEach((item, i) => {
      const selected = i === index;
      const pointer = selected ? c.cyan("❯") : " ";
      const label = selected ? c.cyan(render(item)) : render(item);
      write(`${pointer} ${label}\x1b[K\n`);
    });
  };

  write(`${c.dim("Use ↑/↓ to move, Enter to select, Esc to cancel.")}\n`);
  draw(true);

  return new Promise<T>((resolve) => {
    const cleanup = () => {
      stdin.setRawMode!(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === "\x1b[A" || key === "k") {              // up
        index = (index - 1 + items.length) % items.length;
        draw(false);
      } else if (key === "\x1b[B" || key === "j") {       // down
        index = (index + 1) % items.length;
        draw(false);
      } else if (key === "\r" || key === "\n") {          // enter
        cleanup();
        write("\n");
        resolve(items[index]!);
      } else if (key === "\x1b" || key === "\x03" || key === "q") { // esc / ctrl-c / q
        cleanup();
        write("\n");
        fail("Aborted.", 0);
      }
    };
    stdin.setRawMode!(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
