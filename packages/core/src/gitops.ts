import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { GitStatus, GitFile } from "@chimera/protocol";

export class GitOpsError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}
export type GitExec = (root: string, args: string[], env?: NodeJS.ProcessEnv) => Buffer;
export function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0", ...extra };
}
// Isolated startup excludes cwd/PYTHONPATH modules and site hooks before the fixed helper runs.
const gitHelper = String.raw`
import os,sys,subprocess
d=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
for part in sys.argv[1].split('/'):
 if not part: continue
 next=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=d); os.close(d); d=next
os.fchdir(d); os.close(d)
top=subprocess.check_output(['git','-C','.','rev-parse','--show-toplevel'],stderr=subprocess.DEVNULL).decode().strip()
if os.path.realpath(top)!=os.getcwd():
 print('invalid_root: Git worktree root does not match the selected leased directory',file=sys.stderr);sys.exit(1)
os.execvpe('git',['git','-C','.',*sys.argv[2:]],os.environ)
`;
export const gitExec: GitExec = (root, args, env) => {
  if (process.platform === "win32") throw new GitOpsError("unsupported", "safe worktree operations require POSIX no-follow directory descriptors");
  try { return execFileSync("python3", ["-I", "-S", "-c", gitHelper, root, ...args], { env: gitEnvironment(env), maxBuffer: 4 * 1024 * 1024, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new GitOpsError("unsupported", "safe local worktree actions require python3 dir_fd support");
    throw err;
  }
};
const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
export function confinedPath(path: string): void {
  if (isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw new GitOpsError("invalid_path", "existing relative file required");
}

// dir_fd pins each no-follow directory on macOS and Linux; Node's path-only rename cannot
// protect against a parent directory being replaced by a symlink during an atomic save.
const fileHelper = String.raw`
import os, sys, json, hashlib, stat
p=json.loads(sys.stdin.read()); fds=[]; temp=None
try:
 d=os.open('/',os.O_RDONLY|os.O_DIRECTORY); fds.append(d)
 for part in p['root'].split('/'):
  if not part: continue
  d=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=d); fds.append(d)
 for part in p['path'].split('/')[:-1]:
  d=os.open(part, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=d); fds.append(d)
 name=p['path'].split('/')[-1]
 f=os.open(name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=d); fds.append(f)
 s=os.fstat(f)
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1: raise ValueError('unsupported_file: existing non-hardlinked regular file required')
 if s.st_size>262144: raise ValueError('unsupported_file: maximum 256 KiB')
 data=os.read(f,262145)
 if len(data)>262144 or b'\0' in data: raise ValueError('unsupported_file: binary or oversized file')
 text=data.decode('utf-8',errors='strict')
 def version(s,data): return hashlib.sha256((str(s.st_dev)+':'+str(s.st_ino)+':'+str(s.st_mtime_ns)+':'+str(s.st_ctime_ns)+':').encode()+data).hexdigest()
 v=version(s,data)
 if 'text' in p:
  new=p['text'].encode('utf-8',errors='strict')
  if len(new)>262144 or b'\0' in new: raise ValueError('unsupported_file: maximum 256 KiB UTF-8 text')
  if v!=p['expectedContentVersion']: raise ValueError('stale_content: file changed; keep your draft and reload')
  temp='.chimera-edit-'+os.urandom(16).hex()
  out=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,s.st_mode&0o777,dir_fd=d)
  try:
   with os.fdopen(out,'wb') as h: h.write(new); h.flush(); os.fsync(h.fileno())
  except: raise
  current=os.stat(name,dir_fd=d,follow_symlinks=False)
  os.lseek(f,0,0); latest=os.read(f,262145)
  if version(current,latest)!=v or version(os.fstat(f),latest)!=v: raise ValueError('stale_content: file changed during save')
  # The parent must still name the pinned directory before publishing the replacement.
  parent=os.stat(os.path.join(p['root'],os.path.dirname(p['path'])))
  pinned=os.fstat(d)
  if (parent.st_dev,parent.st_ino)!=(pinned.st_dev,pinned.st_ino): raise ValueError('stale_content: parent directory changed')
  os.rename(temp,name,src_dir_fd=d,dst_dir_fd=d); temp=None
  s=os.stat(name,dir_fd=d,follow_symlinks=False); v=version(s,new); text=p['text']; data=new
 print(json.dumps({'text':text,'contentVersion':v,'bytes':len(data)}))
except Exception as e:
 print(str(e),file=sys.stderr); sys.exit(1)
finally:
 if temp:
  try: os.unlink(temp,dir_fd=d)
  except: pass
 for fd in reversed(fds): os.close(fd)
`;

export class GitOps {
  constructor(private readonly exec: GitExec = gitExec) {}
  private run(root: string, args: string[], env?: NodeJS.ProcessEnv): Buffer { return this.exec(root, args, env); }
  private head(root: string): string | null {
    try { return this.run(root, ["rev-parse", "--verify", "HEAD"]).toString().trim(); } catch { return null; }
  }
  private indexPath(root: string): string { return resolve(root, this.run(root, ["rev-parse", "--git-path", "index"]).toString().trim()); }
  private fingerprint(root: string): string { const path = this.indexPath(root); return digest(existsSync(path) ? readFileSync(path) : "absent-index"); }
  status(root: string): GitStatus {
    const beforeHead = this.head(root), beforeIndex = this.fingerprint(root);
    const raw = this.run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]).toString("utf8");
    const files = raw.split("\0").filter(Boolean).slice(0, 1000).map(row => {
      const path = row.slice(3); confinedPath(path);
      return { path, index: row[0]!, worktree: row[1]!, staged: row[0] !== " " && row[0] !== "?" };
    });
    let branch: string | null = null;
    try { branch = this.run(root, ["symbolic-ref", "--short", "HEAD"]).toString().trim(); } catch { /* detached */ }
    if (this.head(root) !== beforeHead || this.fingerprint(root) !== beforeIndex) throw new GitOpsError("stale_index", "HEAD or index changed during status; refresh");
    return { branch, head: beforeHead, indexFingerprint: beforeIndex, files, truncated: raw.split("\0").length > 1001, writable: true, writeReason: null };
  }
  diff(root: string, path: string, staged: boolean, context: number, maxBytes: number) {
    confinedPath(path);
    const data = this.run(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", ...(staged ? ["--cached"] : []), `--unified=${context}`, "--", path]);
    return { hunks: data.subarray(0, maxBytes).toString("utf8"), binary: data.includes(Buffer.from("Binary files")), truncated: data.length > maxBytes };
  }
  private file(root: string, path: string, change?: { text: string; expectedContentVersion: string }): GitFile {
    if (process.platform === "win32") throw new GitOpsError("unsupported", "safe file editing requires POSIX no-follow directory descriptors");
    confinedPath(path);
    try {
      return JSON.parse(execFileSync("python3", ["-I", "-S", "-c", fileHelper], { input: JSON.stringify({ root, path, ...change }), env: gitEnvironment(), maxBuffer: 2 * 1024 * 1024, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }).toString()) as GitFile;
    } catch (err) {
      const detail = (err as { stderr?: Buffer; code?: string }).stderr?.toString().trim();
      if ((err as { code?: string }).code === "ENOENT") throw new GitOpsError("unsupported", "safe file editing requires local python3 dir_fd support");
      throw new GitOpsError(detail?.startsWith("stale_content") ? "stale_content" : "unsupported_file", detail ?? String(err));
    }
  }
  read(root: string, path: string): GitFile { return this.file(root, path); }
  write(root: string, path: string, text: string, expectedContentVersion: string) { return { contentVersion: this.file(root, path, { text, expectedContentVersion }).contentVersion }; }
  private mutate<T>(root: string, expectedHead: string | null, expectedIndex: string, operation: (env: NodeJS.ProcessEnv) => T): T {
    const index = this.indexPath(root), lock = `${index}.lock`, privateIndex = join(resolve(index, ".."), `chimera-index-${randomUUID()}`);
    let fd: number, published = false;
    try { fd = openSync(lock, "wx", 0o600); } catch { throw new GitOpsError("index_busy", "Git index is locked; refresh and retry"); }
    try {
      if (this.head(root) !== expectedHead || this.fingerprint(root) !== expectedIndex) throw new GitOpsError("stale_index", "HEAD or index changed; refresh and review again");
      if (existsSync(index)) writeFileSync(privateIndex, readFileSync(index), { flag: "wx", mode: 0o600 });
      const result = operation({ GIT_INDEX_FILE: privateIndex });
      // Git's own index lock excludes cooperating Git writers throughout the operation.
      if (this.fingerprint(root) !== expectedIndex) throw new GitOpsError("stale_index", "index changed during operation");
      writeFileSync(fd, readFileSync(privateIndex));
      closeSync(fd); fd = -1;
      renameSync(lock, index);
      published = true;
      return result;
    } finally {
      if (fd !== -1) closeSync(fd);
      if (!published) rmSync(lock, { force: true });
      rmSync(privateIndex, { force: true }); rmSync(`${privateIndex}.lock`, { force: true });
    }
  }
  stage(root: string, paths: string[], unstage: boolean, expectedHead: string | null, expectedIndex: string) {
    paths.forEach(confinedPath);
    for (const path of paths) {
      let current = root;
      for (const part of path.split("/")) {
        current = join(current, part);
        try { if (lstatSync(current).isSymbolicLink()) throw new GitOpsError("invalid_path", "symlink stage paths are refused"); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
      }
    }
    const status = this.status(root);
    if (paths.some(path => !status.files.some(f => f.path === path))) throw new GitOpsError("stale_index", "selected paths no longer occur in status");
    this.mutate(root, expectedHead, expectedIndex, env => {
      if (unstage) this.run(root, expectedHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "--", ...paths], env);
      else this.run(root, ["add", "--", ...paths], env);
      if (this.head(root) !== expectedHead) throw new GitOpsError("stale_index", "HEAD changed while staging");
    });
    return { indexFingerprint: this.fingerprint(root) };
  }
  commit(root: string, message: string, expectedHead: string | null, expectedIndex: string) {
    return this.mutate(root, expectedHead, expectedIndex, env => {
      this.run(root, ["commit", "-m", message], env);
      return { sha: this.head(root)! };
    });
  }
}
