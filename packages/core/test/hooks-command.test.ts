import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { splitCommand } from "@chimera/core/hooks";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

describe("hook command argument boundaries", () => {
  it("executes a shell-quoted script containing apostrophes as one argument", () => {
    // Same quoting as the ARC cleanup hooks, with a harmless program in place of cleanup.
    const script = "process.stdout.write(JSON.stringify(['task receipt', 'it\\'s intact']))";
    const [program, args] = splitCommand(`${quote(process.execPath)} -e ${quote(script)}`);
    expect(args).toEqual(["-e", script]);
    expect(JSON.parse(execFileSync(program, args, { encoding: "utf8" }))).toEqual(["task receipt", "it's intact"]);
  });

  it("joins adjacent quoted segments and preserves empty arguments", () => {
    expect(splitCommand(`tool --path="two words" pre' middle 'post '' ""`))
      .toEqual(["tool", ["--path=two words", "pre middle post", "", ""]]);
  });

  it("handles escaped spaces and double quotes without expanding shell expressions", () => {
    expect(splitCommand(String.raw`tool path\ with\ spaces "a\"b" "line\nnext" '$HOME' '$(touch nope)' |`))
      .toEqual(["tool", ["path with spaces", 'a"b', "line\\nnext", "$HOME", "$(touch nope)", "|"]]);
  });

  it.each(["tool 'unfinished", 'tool "unfinished', "tool trailing\\"])("rejects malformed quoting: %s", command => {
    expect(() => splitCommand(command)).toThrow(/hook command/);
  });
});
