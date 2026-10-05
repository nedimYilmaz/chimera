import type { GitFile } from "@chimera/protocol";

export type FileDraft = GitFile & { draft: string; cursor?: number };
const drafts = new Map<string, FileDraft>();
const prefix = "chimera.file-draft.v1:";
export function readFileDraft(key: string): FileDraft | null {
  if (drafts.has(key)) return drafts.get(key)!;
  try {
    const raw = localStorage.getItem(prefix + key);
    const value = raw ? JSON.parse(raw) as FileDraft : null;
    if (value && typeof value.text === "string" && typeof value.draft === "string" && value.draft.length <= 262144 && typeof value.contentVersion === "string") { drafts.set(key, value); return value; }
  } catch { /* unavailable storage keeps drafts in this session */ }
  return null;
}
export function saveFileDraft(key: string, value: FileDraft): void {
  drafts.set(key, value);
  try { localStorage.setItem(prefix + key, JSON.stringify(value)); } catch { /* preserve session draft when storage is full */ }
}
