// F23-0C: local toolset v1 for GenericAgentBackend — chimera's own tool executor for
// providers with no agentic SDK (no sandboxing, no built-in file/shell tools). Every
// call here is gated by GenericAgentBackend's permission check BEFORE execution; this
// module only implements the mechanics once a call has been allowed.
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { boundToolResultText, wrapUntrustedToolResult } from "./tool-result.js";

const execFileAsync = promisify(execFile);

export type GenericToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type GenericToolResult = { text: string; isError?: boolean };

// Permission classification (GenericAgentBackend's readOnly-profile gate): every tool that
// can mutate the host (run arbitrary shell, write, edit) vs. pure inspection.
export const MUTATING_TOOLS = new Set(["bash", "write_file", "edit_file"]);

const BASH_TIMEOUT_MS = 120_000;
const BASH_MAX_BUFFER = 4 * 1024 * 1024;

export const GENERIC_TOOL_DEFS: GenericToolDef[] = [
  {
    name: "bash",
    description: "Execute a shell command in the agent's working directory and return its combined stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "the shell command to run" },
        timeout: { type: "number", description: "timeout in milliseconds (default 120000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read a file's contents as text.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "file path, absolute or relative to the working directory" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write text content to a file, creating or overwriting it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path, absolute or relative to the working directory" },
        content: { type: "string", description: "the full file content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace one exact, unique occurrence of oldText with newText in a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path, absolute or relative to the working directory" },
        oldText: { type: "string", description: "exact text to find (must occur exactly once)" },
        newText: { type: "string", description: "replacement text" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "list_dir",
    description: "List entries in a directory (non-recursive).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "directory path, defaults to the working directory" } },
    },
  },
  {
    name: "grep",
    description: "Search recursively for a regex pattern across files.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "regex pattern to search for" },
        path: { type: "string", description: "file or directory to search, defaults to the working directory" },
      },
      required: ["pattern"],
    },
  },
];

function resolvePath(cwd: string, path: unknown): string {
  const p = typeof path === "string" && path !== "" ? path : ".";
  return isAbsolute(p) ? p : join(cwd, p);
}

async function runBash(input: Record<string, unknown>, cwd: string): Promise<GenericToolResult> {
  const command = typeof input["command"] === "string" ? input["command"] : "";
  if (command === "") return { text: "bash: missing required \"command\"", isError: true };
  const timeout = typeof input["timeout"] === "number" ? input["timeout"] : BASH_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], { cwd, timeout, maxBuffer: BASH_MAX_BUFFER });
    const combined = [stdout, stderr].filter((s) => s !== "").join("\n");
    // PROMPT-INJECTION-FRAMING (tool-result.ts): command output can carry attacker-planted
    // content (a compromised dependency, a poisoned file in the repo) — this text becomes the
    // model-facing tool result directly (GenericAgentBackend owns this loop).
    return { text: wrapUntrustedToolResult(boundToolResultText(combined === "" ? "(no output)" : combined)) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const combined = [e.stdout, e.stderr].filter((s): s is string => typeof s === "string" && s !== "").join("\n");
    return { text: boundToolResultText(combined !== "" ? combined : e.message), isError: true };
  }
}

async function readFileTool(input: Record<string, unknown>, cwd: string): Promise<GenericToolResult> {
  const path = resolvePath(cwd, input["path"]);
  try {
    // PROMPT-INJECTION-FRAMING (tool-result.ts): file content is attacker-controllable.
    return { text: wrapUntrustedToolResult(boundToolResultText(await readFile(path, "utf8"))) };
  } catch (err) {
    return { text: `read_file failed: ${(err as Error).message}`, isError: true };
  }
}

async function writeFileTool(input: Record<string, unknown>, cwd: string): Promise<GenericToolResult> {
  const path = resolvePath(cwd, input["path"]);
  const content = typeof input["content"] === "string" ? input["content"] : "";
  try {
    await writeFile(path, content, "utf8");
    return { text: `wrote ${content.length} bytes to ${path}` };
  } catch (err) {
    return { text: `write_file failed: ${(err as Error).message}`, isError: true };
  }
}

async function editFileTool(input: Record<string, unknown>, cwd: string): Promise<GenericToolResult> {
  const path = resolvePath(cwd, input["path"]);
  const oldText = typeof input["oldText"] === "string" ? input["oldText"] : "";
  const newText = typeof input["newText"] === "string" ? input["newText"] : "";
  if (oldText === "") return { text: "edit_file: oldText must be non-empty", isError: true };
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    return { text: `edit_file failed: ${(err as Error).message}`, isError: true };
  }
  const first = content.indexOf(oldText);
  if (first === -1) return { text: "edit_file failed: oldText not found in file", isError: true };
  if (content.indexOf(oldText, first + 1) !== -1) {
    return { text: "edit_file failed: oldText is not unique in file — include more surrounding context", isError: true };
  }
  const updated = content.slice(0, first) + newText + content.slice(first + oldText.length);
  try {
    await writeFile(path, updated, "utf8");
    return { text: `edited ${path}` };
  } catch (err) {
    return { text: `edit_file failed: ${(err as Error).message}`, isError: true };
  }
}

async function listDirTool(input: Record<string, unknown>, cwd: string): Promise<GenericToolResult> {
  const path = resolvePath(cwd, input["path"]);
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const lines = entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`);
    // PROMPT-INJECTION-FRAMING (tool-result.ts): entry names are attacker-controllable.
    return { text: wrapUntrustedToolResult(boundToolResultText(lines.join("\n") || "(empty directory)")) };
  } catch (err) {
    return { text: `list_dir failed: ${(err as Error).message}`, isError: true };
  }
}

async function grepTool(input: Record<string, unknown>, cwd: string): Promise<GenericToolResult> {
  const pattern = typeof input["pattern"] === "string" ? input["pattern"] : "";
  if (pattern === "") return { text: "grep: missing required \"pattern\"", isError: true };
  const path = resolvePath(cwd, input["path"]);
  try {
    const { stdout } = await execFileAsync("grep", ["-rn", "-E", pattern, path], { cwd, maxBuffer: BASH_MAX_BUFFER });
    // PROMPT-INJECTION-FRAMING (tool-result.ts): matched file content is attacker-controllable.
    return { text: wrapUntrustedToolResult(boundToolResultText(stdout === "" ? "(no matches)" : stdout)) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; message: string };
    // grep exits 1 for "no matches" — not a real failure.
    if (e.code === 1) return { text: "(no matches)" };
    return { text: `grep failed: ${e.stdout || e.message}`, isError: true };
  }
}

export async function executeGenericTool(name: string, input: Record<string, unknown>, cwd: string): Promise<GenericToolResult> {
  switch (name) {
    case "bash": return runBash(input, cwd);
    case "read_file": return readFileTool(input, cwd);
    case "write_file": return writeFileTool(input, cwd);
    case "edit_file": return editFileTool(input, cwd);
    case "list_dir": return listDirTool(input, cwd);
    case "grep": return grepTool(input, cwd);
    default: return { text: `unknown tool "${name}"`, isError: true };
  }
}
