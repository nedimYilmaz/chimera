import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type UiStore } from "@chimera/ui-state";
import { cancelKeySequence, desktopKeymap, handleDesktopKey, KEYMAP, registerActionHandler } from "../src/keymap";
import { bindingConflict, parseKeyboardPreferences, resetKeyboardPreferences, saveKeyboardPreferences, sequenceSuffix } from "../src/state/keyboardPreferences";
const store = { getState: () => ({ ...initialState, activeTab: "agents" }), dispatch: vi.fn() } as unknown as UiStore;
const event = (key: string, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, repeat: false, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra });
beforeEach(() => { vi.stubGlobal("localStorage", {setItem: vi.fn(), getItem: () => null}); });
afterEach(() => { cancelKeySequence(); resetKeyboardPreferences(); vi.unstubAllGlobals(); });
describe.each(["MacIntel", "Win32", "Linux x86_64"])("desktop shortcuts on %s", platform => {
  const mod = platform === "MacIntel" ? {metaKey:true} : {ctrlKey:true};
  it("requires the leader, then runs an action exactly once from an input", () => {
    vi.stubGlobal("navigator", {platform});
    const run = vi.fn(); const off = registerActionHandler("agents.spawn", run);
    const target = {tagName:"INPUT"} as unknown as EventTarget;
    const leader = event("k", {...mod,target});
    expect(handleDesktopKey(leader, store)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    handleDesktopKey(event("n", {target}), store);
    handleDesktopKey(event("n", {target,repeat:true}), store);
    expect(run).toHaveBeenCalledTimes(1); off();
  });
  it("does not hijack native editing, OS/window shortcuts, or Tab", () => {
    vi.stubGlobal("navigator", {platform});
    for (const key of ["c","v","x","z","y","q","w","n"]) {
      const e = event(key, mod); handleDesktopKey(e, store); expect(e.preventDefault).not.toHaveBeenCalled();
    }
    const alt = event(" ",{altKey:true}); handleDesktopKey(alt,store); expect(alt.preventDefault).not.toHaveBeenCalled();
    const tab = event("Tab"); expect(handleDesktopKey(tab,store)).toBe(false); expect(tab.preventDefault).not.toHaveBeenCalled();
  });
  it("cancels on Escape or timeout without executing a destructive action", () => {
    vi.stubGlobal("navigator", {platform}); const run=vi.fn(); const off=registerActionHandler("agents.kill",run);
    handleDesktopKey(event("k",mod),store,100);
    handleDesktopKey(event("Escape"),store,101);
    handleDesktopKey(event("K",{shiftKey:true}),store,102);
    handleDesktopKey(event("k",mod),store,100);
    handleDesktopKey(event("K",{shiftKey:true}),store,3101);
    expect(run).not.toHaveBeenCalled(); off();
  });
  it("leaves IME composition alone", () => {
    vi.stubGlobal("navigator", {platform});
    const e=event("k",{...mod,isComposing:true}); expect(handleDesktopKey(e,store)).toBe(false); expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
it("has no conflicting default sequences on any screen", () => {
  const rows=desktopKeymap().filter(r=>r.chord.includes(" "));
  for(const a of rows) for(const b of rows) {
    if(a.action===b.action || a.scope!==b.scope && a.scope!=="global" && b.scope!=="global") continue;
    expect(a.chord, `${a.action} vs ${b.action}`).not.toBe(b.chord);
  }
});
it("validates bindings and lets an action be disabled", () => {
  expect(bindingConflict(KEYMAP,"agents.spawn","a")).toContain("accounts");
  expect(bindingConflict(KEYMAP,"agents.spawn","ctrl+alt+delete")).toContain("Use a letter");
  expect(bindingConflict(KEYMAP,"agents.spawn",null)).toBeNull();
  saveKeyboardPreferences({leader:"mod+k",bindings:{"agents.spawn":null}});
  expect(desktopKeymap().some(r=>r.action==="agents.spawn")).toBe(false);
});
it("rejects corrupt preferences and accepts only safe sequence suffixes", () => {
  expect(parseKeyboardPreferences("{" )).toEqual({leader:"mod+k",bindings:{}});
  expect(parseKeyboardPreferences(JSON.stringify({leader:"alt+space",bindings:{"agents.spawn":"alt+f4","system.palette":"space"}}))).toEqual({leader:"mod+k",bindings:{"system.palette":"space"}});
  expect(sequenceSuffix(KEYMAP.find(r=>r.action==="agents.spawn")!)).toBe("n");
});
it("ships no overlapping default leader bindings",()=>{
  const rows=desktopKeymap().filter(r=>r.chord.includes(" "));
  const conflicts=rows.flatMap((a,i)=>rows.slice(i+1).filter(b=>b.action!==a.action&&a.chord===b.chord&&(a.scope===b.scope||a.scope==="global"||b.scope==="global")).map(b=>`${a.action}/${b.action}: ${a.chord}`));
  expect(conflicts).toEqual([]);
});
