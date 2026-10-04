import { invoke, isTauri } from "@tauri-apps/api/core";

export type ComputerUseCommand = "computer_use_status" | "computer_use_preview" | "computer_use_stop";
export type ComputerUseNative = (command: ComputerUseCommand, args?: Record<string, unknown>) => Promise<unknown>;

// One module for the Rust side of the desktop-control preview. The Chromium UI gate swaps this file
// (like rpc/bridge) so the in-transcript overlay is exercised without a Tauri runtime, and unit tests
// inject their own `request` instead of mocking `@tauri-apps/api`.
export const computerUseNative: ComputerUseNative = (command, args) => invoke(command, args);

/** A plain browser has no Rust commands to call; the overlay must stay inert there instead of polling errors. */
export const computerUseAvailable = (): boolean => isTauri();
