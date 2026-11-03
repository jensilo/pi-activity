// Classification inputs only. These strings are never executed.

function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function fileClassifierCommand(tool: string, input: unknown, target: string): string {
  if (tool === "read") return `cat -- ${quote(target)}`;
  if (tool !== "grep") throw new Error("unsupported file classifier adapter");
  const args = input as Record<string, unknown> | undefined;
  if (typeof args?.pattern !== "string") throw new Error("grep pattern is missing");
  const flags = ["rg", "--json", "--line-number", "--color=never", "--hidden"];
  if (args.ignoreCase) flags.push("--ignore-case");
  if (args.literal) flags.push("--fixed-strings");
  if (typeof args.glob === "string" && args.glob) flags.push("--glob", quote(args.glob));
  // Pi renders surrounding lines itself. Represent that output semantics too.
  if (typeof args.context === "number" && Number.isFinite(args.context) && args.context > 0) {
    flags.push("--context", String(Math.ceil(args.context)));
  }
  flags.push("--", quote(args.pattern), quote(target));
  return flags.join(" ");
}
