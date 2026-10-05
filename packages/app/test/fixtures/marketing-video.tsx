// Usage-video entry (scripts/marketing-video.mjs). Same real screens and the same synthetic "Atlas
// website" data as the screenshot entry, plus the video-only layer that makes the queue change state
// and the memory search filter. Import order is load-bearing: boot installs the RPC seam, the video
// layer wraps it, and only then does ./marketing pull in the real app store.
import "./marketing-boot";
import { installVideoHooks } from "./marketing-video-state";
import "./marketing";
import { appStore } from "../../src/state/store";

installVideoHooks(appStore as never);

// The screenshot stage mounts ONE screen per show(view) and never listens to the store, so a real click
// on a TopBar tab would change the highlighted tab but not the screen. The film needs real tab clicks,
// so route the store's activeTab back into the stage. show() itself dispatches selectTab (to the same
// tab), which is why the last routed tab is remembered instead of re-showing on every notification.
const viewForTab: Record<string, string> = { queues: "queue", memory: "memory", teams: "teams", agents: "workspace", projects: "projects", roles: "roles" };
const stage = (window as unknown as { __MARKETING__: { show(view: string): void } }).__MARKETING__;
let routed = appStore.getState().activeTab as string;
appStore.subscribe(() => {
  const tab = appStore.getState().activeTab as string;
  if (tab === routed) return;
  routed = tab;
  const view = viewForTab[tab];
  // Deferred: show() dispatches into the store, which must not happen inside a store notification.
  if (view) setTimeout(() => stage.show(view), 0);
});
