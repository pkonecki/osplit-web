import { describe, expect, it } from "vitest";
import { type IsolationState, shouldReloadForIsolation } from "./isolation";

const base: IsolationState = {
  isolated: false,
  controlled: true,
  busy: false,
  attempted: false,
};

describe("isolation reload", () => {
  it("reloads a controlled page that is not isolated yet", () => {
    expect(shouldReloadForIsolation(base)).toBe(true);
  });

  it.each<[string, Partial<IsolationState>]>([
    ["the page is already isolated", { isolated: true }],
    ["no service worker controls the page yet", { controlled: false }],
    ["a task is running", { busy: true }],
    ["a reload was already tried", { attempted: true }],
  ])("does not reload when %s", (_, change) => {
    expect(shouldReloadForIsolation({ ...base, ...change })).toBe(false);
  });
});
