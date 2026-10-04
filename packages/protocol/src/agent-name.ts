// Shared with the desktop's deterministic fallback: voice must introduce the
// same agent name the operator sees, not the account/provider name.
const adjectives = "amber brisk clever cosmic dapper eager fuzzy gentle glossy jolly keen lucky mellow nimble plucky quiet rapid sly spry sunny swift tidy vivid witty zesty bold brave crisp frosty lively merry wily".split(" ");
const animals = "otter lynx heron falcon badger marten ferret tapir gecko raven finch bison koala panda dingo civet lemur quokka wombat narwhal ibex okapi puffin walrus weasel yak zebu stoat shrew vole newt krill".split(" ");
export function voiceAgentName(agentId: string, label?: string | null, conductor = false, projectId?: string): string {
  if (label?.trim()) return label.trim().slice(0, 200);
  if (conductor) return projectId ?? "main";
  let h = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) { h ^= agentId.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h >>>= 0;
  return `${adjectives[h % adjectives.length]}-${animals[Math.floor(h / adjectives.length) % animals.length]}`;
}
