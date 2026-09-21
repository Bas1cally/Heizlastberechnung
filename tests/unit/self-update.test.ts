import { describe, expect, it } from "vitest";
import { createUpdateCheck } from "../../src/app/self-update.js";

describe("createUpdateCheck", () => {
  it("reports a newer remote commit, rate-limits fetches, and turns git failures into 'no'", () => {
    let remote = "aaaaaaa1";
    const calls: string[] = [];
    const git = (args: string[]) => {
      calls.push(args[0]!);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature";
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "aaaaaaa1";
      if (args[0] === "rev-parse") return remote;
      throw new Error("unexpected");
    };
    const check = createUpdateCheck(1000, git);
    expect(check(0)).toMatchObject({ available: false, local: "aaaaaaa", remote: "aaaaaaa" });
    remote = "bbbbbbb2";
    expect(check(500).available).toBe(false); // inside the interval: no fetch
    expect(calls.filter((c) => c === "fetch")).toHaveLength(1);
    expect(check(1000)).toMatchObject({ available: true, remote: "bbbbbbb" });

    const broken = createUpdateCheck(0, () => { throw new Error("fatal: unable to access"); });
    expect(broken(0)).toMatchObject({ available: false, error: "fatal: unable to access" });
  });

  it("compares the remote with the commit the process started on, not with a HEAD another runner already pulled", () => {
    let head = "aaaaaaa1", remote = "aaaaaaa1";
    const git = (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature";
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return head;
      if (args[0] === "rev-parse") return remote;
      throw new Error("unexpected");
    };
    const check = createUpdateCheck(0, git);
    // Another process pulled: the checkout is at the new commit, this process is not.
    head = remote = "bbbbbbb2";
    expect(check(0)).toMatchObject({ available: true, local: "aaaaaaa", remote: "bbbbbbb" });
  });
});
