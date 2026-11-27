import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path/posix";
import { registerDetector } from "../registry.js";
import type { Candidate, Skip } from "../types.js";

/** Joins `\` continuations and drops comments, keeping the first physical line number of each instruction. */
function instructions(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let pending: { line: number; text: string } | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!pending && (trimmed === "" || trimmed.startsWith("#"))) return;
    if (pending && trimmed.startsWith("#")) return;
    const continued = trimmed.endsWith("\\");
    const piece = continued ? trimmed.slice(0, -1).trim() : trimmed;
    pending = pending
      ? { line: pending.line, text: `${pending.text} ${piece}`.trim() }
      : { line: index + 1, text: piece };
    if (!continued) {
      out.push(pending);
      pending = null;
    }
  });
  if (pending) out.push(pending);
  return out;
}

type DockerfileCommand = { form: "exec"; argv: string[] } | { form: "shell"; text: string };

function parseCommand(args: string): DockerfileCommand {
  if (args.startsWith("[")) {
    try {
      const parsed = JSON.parse(args);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
        return { form: "exec", argv: parsed };
      }
    } catch {
      // not exec form after all: fall through and keep the text
    }
  }
  return { form: "shell", text: args };
}

function execToString(argv: string[]): string {
  return argv.join(" ");
}

function commandToString(command: DockerfileCommand): string {
  return command.form === "exec" ? execToString(command.argv) : command.text;
}

/**
 * The command Docker runs, in the text form the detector already uses for CMD. Docker appends CMD
 * to an exec ENTRYPOINT. A shell CMD becomes a `/bin/sh -c` argument in that append. A shell
 * ENTRYPOINT already runs through the shell, so Docker does not use CMD with it.
 */
function combinedCommand(
  entrypoint: DockerfileCommand | undefined,
  cmd: DockerfileCommand | undefined,
): string | undefined {
  if (!entrypoint) {
    const command = cmd ? commandToString(cmd) : undefined;
    return command || undefined;
  }
  if (entrypoint.form === "shell") return entrypoint.text || undefined;
  if (!cmd) return execToString(entrypoint.argv) || undefined;
  if (cmd.form === "exec") return execToString([...entrypoint.argv, ...cmd.argv]) || undefined;
  return execToString([...entrypoint.argv, "/bin/sh", "-c", cmd.text]) || undefined;
}

registerDetector({
  id: "dockerfile",
  claim: (relPath) => basename(relPath) === "Dockerfile",
  parse(absPath, relPath) {
    const dir = dirname(relPath) === "." ? "" : dirname(relPath);
    let skips: Skip[] = [];
    // Only the last build stage is the image that runs.
    let ports: number[] = [];
    let entrypoint: DockerfileCommand | undefined;
    let cmd: DockerfileCommand | undefined;
    for (const ins of instructions(readFileSync(absPath, "utf8"))) {
      const [keyword = "", ...rest] = ins.text.split(/\s+/);
      const args = rest.join(" ");
      switch (keyword.toUpperCase()) {
        case "FROM":
          ports = [];
          skips = [];
          entrypoint = undefined;
          cmd = undefined;
          break;
        case "EXPOSE":
          for (const token of rest) {
            if (!token) continue;
            const rawPort = token.split("/")[0] ?? "";
            const port = /^\d+$/.test(rawPort) ? Number.parseInt(rawPort, 10) : Number.NaN;
            if (Number.isInteger(port) && port > 0 && port < 65536) {
              ports.push(port);
            } else {
              skips.push({
                file: relPath,
                detector: "dockerfile",
                line: ins.line,
                reason: "EXPOSE uses a variable; port not imported",
              });
            }
          }
          break;
        case "ENTRYPOINT":
          entrypoint = parseCommand(args);
          break;
        case "CMD":
          cmd = parseCommand(args);
          break;
      }
    }
    const distinct = [...new Set(ports)];
    if (distinct.length > 1) {
      skips.push({
        file: relPath,
        detector: "dockerfile",
        reason: `EXPOSE lists several ports (${distinct.join(", ")}); port not imported`,
      });
    }
    const command = combinedCommand(entrypoint, cmd);
    const candidate: Candidate = {
      kind: "service",
      dir,
      dockerfile: "Dockerfile",
      ...(distinct.length === 1 ? { port: distinct[0] } : {}),
      ...(command ? { command } : {}),
      confidence: "high",
      sources: [{ file: relPath, detector: "dockerfile" }],
    };
    return { candidates: [candidate], skips };
  },
});
