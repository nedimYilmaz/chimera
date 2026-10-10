import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type RpcMessage = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
export type RpcProcessFactory = (command: string, args: string[], env: Record<string, string>) => ChildProcessWithoutNullStreams;

// Bound client memory per wire frame, not per stdout chunk or native session.
// A transport limit says nothing about whether the model's context is full.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

// Explicit server rejection is safe to recover from; a lost/late response is
// ambiguous and must not cause the caller to replay an accepted user message.
export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export class CodexRpc {
  get processPid(): number | null { return this.exited ? null : this.child.pid ?? null; }
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private child: ChildProcessWithoutNullStreams;
  private closed = false;
  private buffer = "";
  private stderr = "";
  private exited = false;
  onNotification: (method: string, params: Record<string, any>) => void = () => {};
  onRequest: (method: string, params: Record<string, any>, id: string | number) => Promise<unknown> = async () => { throw new Error("Unsupported Codex request"); };
  onFailure: (error: Error) => void = () => {};

  constructor(command: string, args: string[], env: Record<string, string>, factory?: RpcProcessFactory, private timeoutMs = 30_000) {
    this.child = factory ? factory(command, args, env) : spawn(command, args, { env, stdio: "pipe", detached: process.platform !== "win32" });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.stdout.on("data", (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        if (Buffer.byteLength(this.buffer.slice(0, end + 1), "utf8") > MAX_FRAME_BYTES)
          return this.fail(new Error(`Codex app-server JSONL frame exceeded ${MAX_FRAME_BYTES / (1024 * 1024)} MiB`));
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        try { this.receive(JSON.parse(line)); } catch { this.fail(new Error("Invalid Codex app-server JSONL message")); }
        if (this.closed) return;
      }
      if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES)
        this.fail(new Error(`Codex app-server JSONL frame exceeded ${MAX_FRAME_BYTES / (1024 * 1024)} MiB`));
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      if (!this.closed) this.fail(new Error(`Codex app-server exited (${code ?? signal}); ${this.stderr}`));
    });
  }

  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex app-server connection closed"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void { this.send({ method, params }); }

  private send(message: RpcMessage): void {
    if (this.closed) return;
    const line = `${JSON.stringify(message)}\n`;
    // Reject oversized writes before handing any bytes to the server. Recovery
    // must retain the native session: starting fresh cannot shrink this payload.
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      this.fail(new Error(`Codex app-server JSONL frame exceeded ${MAX_FRAME_BYTES / (1024 * 1024)} MiB (outbound)`));
      return;
    }
    this.child.stdin.write(line);
  }

  private receive(message: RpcMessage): void {
    if (message.method) {
      if (message.id !== undefined) {
        void this.onRequest(message.method, message.params ?? {}, message.id).then(
          (result) => this.send({ id: message.id, result }),
          () => this.send({ id: message.id, error: { code: -32601, message: "Unsupported or cancelled client request" } }),
        );
      } else this.onNotification(message.method, message.params ?? {});
    } else if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexRpcError(message.error.code, message.error.message));
      else pending.resolve(message.result);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.onFailure(error);
    this.close(error);
  }

  close(reason = new Error("Codex app-server connection closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = "";
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(reason); }
    this.pending.clear();
    this.child.stdin.end();
    const terminate = (signal: NodeJS.Signals) => {
      if (this.exited) return;
      try {
        if (this.child.pid && process.platform !== "win32") process.kill(-this.child.pid, signal);
        else this.child.kill(signal);
      } catch { this.child.kill(signal); }
    };
    terminate("SIGTERM");
    setTimeout(() => terminate("SIGKILL"), 1000).unref();
  }
}

// Encode nested values as TOML inline tables. Quoted keys preserve MCP names
// containing dots instead of accidentally creating additional nesting levels.
export function codexConfigArgs(config: Record<string, unknown> = {}): string[] {
  const toml = (value: unknown): string => {
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(",")}}`;
    throw new Error("Unsupported Codex configuration value");
  };
  return Object.entries(config).filter(([, v]) => v !== undefined).flatMap(([key, value]) => {
    // CLI -c parses the left side as a dotted path, not a TOML document key;
    // quoting it creates a literal quoted key and silently misses the setting.
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`Unsupported Codex configuration key: ${key}`);
    return ["-c", `${key}=${toml(value)}`];
  });
}
