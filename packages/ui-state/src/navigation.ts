import type { DeepLink, UiState } from "./types.js";

export function pendingDeepLink(state: UiState): DeepLink | null {
  return state.navigation.target;
}

/** Resolve a task link's queue from its explicit hint or the live task
 * projection. Null means the app must fall back to bounded queue.status reads. */
export function taskQueueForDeepLink(state: UiState, target: DeepLink): string | null {
  if (target.kind !== "task") return null;
  return target.queue ?? state.tasks[target.taskId]?.queue ?? null;
}

export function selectedTaskId(state: UiState): string | null {
  const raw = state.queueDetail?.tasks[state.taskCursor]?.["taskId"];
  return typeof raw === "string" ? raw : null;
}
