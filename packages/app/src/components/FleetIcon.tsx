type Kind = "spawn" | "options" | "seen" | "close" | "group" | "alert" | "unread" | "done" | "trash";
const paths: Record<Kind, string> = {
  spawn: "M12 5v14M5 12h14", options: "M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4",
  seen: "m3 12 4 4 8-9m-3 9 8-9", close: "M4 4h16v16H4zM8 8l8 8M8 16l8-8",
  group: "M3 7h7l2 3h9v10H3zM16 3v6M13 6h6", alert: "m12 3 10 18H2zM12 8v6M12 17v1",
  unread: "M3 6h18v13H3zM3 6l9 7 9-7", done: "m5 12 4 4 10-10",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
};
export function FleetIcon({ kind }: { kind: Kind }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
