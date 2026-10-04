import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_DIFF_LINES = 80;

function commandLabel(command, args) {
  return [command, ...args].join(" ");
}

function killOwnedProcess(child, signal) {
  if (!child.pid) return;
  try {
    // A POSIX group can outlive its leader and keep inherited pipes open. The
    // leader's exit status must not disable timeout escalation for that group.
    if (process.platform === "win32") {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function runSubprocess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal;

  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new Error(`Interrupted before running: ${commandLabel(command, args)}`));
      return;
    }

    let output = "";
    let errorOutput = "";
    let terminationError = null;
    let killTimer;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const append = (current, chunk) => {
      if (current.length >= MAX_CAPTURE_BYTES) return current;
      return `${current}${chunk}`.slice(0, MAX_CAPTURE_BYTES);
    };
    child.stdout.on("data", (chunk) => { output = append(output, chunk); });
    child.stderr.on("data", (chunk) => { errorOutput = append(errorOutput, chunk); });

    const terminate = (error) => {
      if (terminationError) return;
      terminationError = error;
      killOwnedProcess(child, "SIGTERM");
      killTimer = setTimeout(() => killOwnedProcess(child, "SIGKILL"), 500);
      killTimer.unref();
    };
    const abort = () => terminate(new Error(`Interrupted while running: ${commandLabel(command, args)}`));
    signal?.addEventListener("abort", abort, { once: true });

    const timeout = setTimeout(() => {
      terminate(new Error(`Timed out after ${timeoutMs}ms: ${commandLabel(command, args)}`));
    }, timeoutMs);
    timeout.unref();

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };

    child.once("error", (error) => {
      const wrapped = new Error(`Unable to run ${commandLabel(command, args)}: ${error.message}`);
      wrapped.cause = error;
      finish(wrapped);
    });
    child.once("close", (code, childSignal) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code !== 0) {
        const detail = errorOutput.trim() || output.trim();
        finish(new Error(
          `${commandLabel(command, args)} failed (${childSignal ? `signal ${childSignal}` : `exit ${code}`})${detail ? `:\n${detail}` : ""}`,
        ));
        return;
      }
      finish(null, { stdout: output, stderr: errorOutput });
    });
  });
}

function lineOperations(expected, actual) {
  const before = expected.endsWith("\n") ? expected.slice(0, -1).split("\n") : expected.split("\n");
  const after = actual.endsWith("\n") ? actual.slice(0, -1).split("\n") : actual.split("\n");
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));

  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = before[left] === after[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }

  const operations = [];
  let left = 0;
  let right = 0;
  let oldLine = 1;
  let newLine = 1;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      operations.push({ kind: " ", text: before[left], oldLine, newLine });
      left += 1;
      right += 1;
      oldLine += 1;
      newLine += 1;
    } else if (right < after.length && (left === before.length || lengths[left][right + 1] >= lengths[left + 1][right])) {
      operations.push({ kind: "+", text: after[right], oldLine, newLine });
      right += 1;
      newLine += 1;
    } else {
      operations.push({ kind: "-", text: before[left], oldLine, newLine });
      left += 1;
      oldLine += 1;
    }
  }
  return operations;
}

export function boundedUnifiedDiff(expected, actual, maxLines = MAX_DIFF_LINES) {
  const operations = lineOperations(expected, actual);
  const changed = operations.flatMap((operation, index) => operation.kind === " " ? [] : [index]);
  if (changed.length === 0) return "";

  const ranges = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(operations.length, index + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }

  const lines = ["--- packages/core/src/backends/codex-wire.generated.ts", "+++ generated Codex protocol subset"];
  for (const range of ranges) {
    const hunk = operations.slice(range.start, range.end);
    const oldCount = hunk.filter((operation) => operation.kind !== "+").length;
    const newCount = hunk.filter((operation) => operation.kind !== "-").length;
    lines.push(`@@ -${hunk[0].oldLine},${oldCount} +${hunk[0].newLine},${newCount} @@`);
    for (const operation of hunk) lines.push(`${operation.kind}${operation.text}`);
  }

  if (lines.length <= maxLines) return lines.join("\n");
  return `${lines.slice(0, maxLines - 1).join("\n")}\n... diff truncated at ${maxLines} lines ...`;
}

function manualRegenerationInstructions() {
  return [
    "Manual regeneration (review before committing):",
    "  codex app-server generate-ts --out <temporary-dir>",
    "  node scripts/codex-protocol-subset.mjs <temporary-dir> > <temporary-subset>",
    "  diff -u packages/core/src/backends/codex-wire.generated.ts <temporary-subset>",
    "  # After review: cp <temporary-subset> packages/core/src/backends/codex-wire.generated.ts",
  ].join("\n");
}

export async function checkCodexProtocol(options = {}) {
  const codexCommand = options.codexCommand ?? "codex";
  const expectedFile = options.expectedFile
    ?? join(repositoryRoot, "packages/core/src/backends/codex-wire.generated.ts");
  const subsetScript = options.subsetScript ?? join(scriptDirectory, "codex-protocol-subset.mjs");
  const tempParent = options.tempParent ?? tmpdir();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stdout = options.stdout ?? process.stdout;
  let generatedDirectory;

  try {
    const versionResult = await runSubprocess(codexCommand, ["--version"], {
      env: options.env ?? process.env,
      signal: options.signal,
      timeoutMs,
    });
    const version = versionResult.stdout.trim() || versionResult.stderr.trim();
    if (!version) throw new Error("Codex CLI returned an empty version");
    stdout.write(`Installed Codex CLI: ${version}\n`);

    generatedDirectory = await mkdtemp(join(tempParent, "chimera-codex-schema-"));
    options.onTempDirectory?.(generatedDirectory);
    await runSubprocess(codexCommand, ["app-server", "generate-ts", "--out", generatedDirectory], {
      env: options.env ?? process.env,
      signal: options.signal,
      timeoutMs,
    });
    const generated = await runSubprocess(process.execPath, [subsetScript, generatedDirectory], {
      env: options.env ?? process.env,
      signal: options.signal,
      timeoutMs,
    });
    const expected = await readFile(expectedFile, "utf8");

    if (expected !== generated.stdout) {
      throw new Error([
        `Codex protocol subset differs for ${version}.`,
        boundedUnifiedDiff(expected, generated.stdout),
        manualRegenerationInstructions(),
      ].join("\n"));
    }

    stdout.write("Codex protocol subset is an exact match.\n");
    return { version };
  } finally {
    if (generatedDirectory) await rm(generatedDirectory, { recursive: true, force: true });
  }
}

export async function runCodexProtocolCli(options = {}) {
  const controller = new AbortController();
  const signalSource = options.signalSource ?? process;
  const stderr = options.stderr ?? process.stderr;
  let interruptedBy = null;
  const interrupt = (signal) => {
    interruptedBy ??= signal;
    controller.abort();
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  signalSource.once("SIGINT", onSigint);
  signalSource.once("SIGTERM", onSigterm);

  try {
    await checkCodexProtocol({ ...options, signal: controller.signal });
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (interruptedBy === "SIGINT") return 130;
    if (interruptedBy === "SIGTERM") return 143;
    return 1;
  } finally {
    signalSource.removeListener("SIGINT", onSigint);
    signalSource.removeListener("SIGTERM", onSigterm);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await runCodexProtocolCli();
