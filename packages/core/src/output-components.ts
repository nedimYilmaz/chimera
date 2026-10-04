// F21/D17: the vocabulary cheatsheet injected into a fresh spawn's system prompt
// (supervisor.ts launch(), same choke point as the orchestration AWARENESS block)
// whenever the subscribing client declared the "ui.components" capability at
// subscribe (see @chimera/protocol's CLIENT_CAP_UI_COMPONENTS). A plain CLI client
// never declares it, so this never lands in its agents' prompts — no fences would
// ever get rendered there anyway. TOKEN-OPT-P6: compressed to a dense reference
// (no padding, no worked example) — the fence kind names/fields are unchanged, so
// rendering is byte-identical; only the prompt's token cost dropped.
export const OUTPUT_COMPONENTS_CHEATSHEET =
  `OUTPUT COMPONENTS: 12 fenced block kinds render as compact UI instead of plain ` +
  `text (fence info-string = kind name). Prefer one over prose for a list, ` +
  `comparison, metric, or status; plain text otherwise.

Line-based (1 item/line): status ok|warn|fail name·meta / checklist [x]|[ ]|[!] ` +
  `item—note (n/N header) / kv key: value / diffstat path +A -D (footer totals) / ` +
  `timeline HH:MM event / tree indented paths, A|M|D badges / links label (kind) / ` +
  `progress P%·step n/N·eta / callout tone via info string e.g. \`\`\`callout success

JSON (1 value in fence): metric [{label,value,delta?,dir?:"up"|"down",good?}] / ` +
  `test-report {pass,fail,skip,duration,failures:[{name,note}]} / compare ` +
  `{options:[...],criteria:[{name,values:[...]}],pick?,reason?}`;
