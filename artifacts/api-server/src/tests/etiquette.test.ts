import { describe, it, expect } from "vitest";
import { detectMuteCommand, isAddressedToAgent, hasPlanningIntent, shouldRespondInGroup } from "../lib/agent/etiquette";

describe("detectMuteCommand", () => {
  it("returns 'mute' for explicit mute phrases", () => {
    expect(detectMuteCommand("mute yourself")).toBe("mute");
    expect(detectMuteCommand("mute the bot")).toBe("mute");
    expect(detectMuteCommand("be quiet")).toBe("mute");
    expect(detectMuteCommand("stop responding")).toBe("mute");
    expect(detectMuteCommand("pause yourself")).toBe("mute");
  });

  it("returns 'unmute' for unmute phrases", () => {
    expect(detectMuteCommand("unmute yourself")).toBe("unmute");
    expect(detectMuteCommand("unmute the bot")).toBe("unmute");
    expect(detectMuteCommand("start responding again")).toBe("unmute");
    expect(detectMuteCommand("you can talk again")).toBe("unmute");
  });

  it("returns null for unrelated messages", () => {
    expect(detectMuteCommand("hey everyone")).toBeNull();
    expect(detectMuteCommand("let's grab dinner")).toBeNull();
    expect(detectMuteCommand("")).toBeNull();
    expect(detectMuteCommand("muted sounds like a good idea")).toBeNull();
  });

  it("gives unmute priority over mute when both patterns could match", () => {
    // The unmute check runs first; "unmute the bot" contains the substring
    // "mute" but must be classified as unmute, not mute.
    expect(detectMuteCommand("unmute the bot")).toBe("unmute");
  });
});

describe("isAddressedToAgent", () => {
  it("matches direct handles", () => {
    expect(isAddressedToAgent("hey concierge, find us a spot")).toBe(true);
    expect(isAddressedToAgent("@concierge what about Friday?")).toBe(true);
    expect(isAddressedToAgent("hey bot, any ideas?")).toBe(true);
    expect(isAddressedToAgent("ok assistant go ahead")).toBe(true);
  });

  it("returns false for messages that don't address the agent", () => {
    expect(isAddressedToAgent("sounds good to me")).toBe(false);
    expect(isAddressedToAgent("I'm free Saturday")).toBe(false);
    expect(isAddressedToAgent("")).toBe(false);
  });
});

describe("hasPlanningIntent", () => {
  it("matches common planning keywords", () => {
    expect(hasPlanningIntent("let's get dinner")).toBe(true);
    expect(hasPlanningIntent("when should we meet?")).toBe(true);
    expect(hasPlanningIntent("anyone around this weekend?")).toBe(true);
    expect(hasPlanningIntent("brunch on Sunday?")).toBe(true);
    expect(hasPlanningIntent("book a reservation")).toBe(true);
    expect(hasPlanningIntent("next weekend works")).toBe(true);
    expect(hasPlanningIntent("birthday dinner")).toBe(true);
  });

  it("matches short-form triggers (drinks, coffee, who's free)", () => {
    expect(hasPlanningIntent("drinks?")).toBe(true);
    expect(hasPlanningIntent("coffee tomorrow?")).toBe(true);
    expect(hasPlanningIntent("who's around sat?")).toBe(true);
    expect(hasPlanningIntent("anyone free Friday?")).toBe(true);
    expect(hasPlanningIntent("anyone up for something?")).toBe(true);
  });

  it("returns false for idle chat", () => {
    expect(hasPlanningIntent("haha yes")).toBe(false);
    expect(hasPlanningIntent("same")).toBe(false);
    expect(hasPlanningIntent("lol")).toBe(false);
    expect(hasPlanningIntent("")).toBe(false);
    expect(hasPlanningIntent("sounds good")).toBe(false);
  });
});

describe("shouldRespondInGroup", () => {
  it("returns true when agent is directly addressed", () => {
    expect(shouldRespondInGroup("hey concierge, help us pick")).toBe(true);
  });

  it("returns true when there is planning intent", () => {
    expect(shouldRespondInGroup("where should we eat?")).toBe(true);
  });

  it("returns false for idle group chatter", () => {
    expect(shouldRespondInGroup("haha true")).toBe(false);
    expect(shouldRespondInGroup("I'll be there")).toBe(false);
  });
});
