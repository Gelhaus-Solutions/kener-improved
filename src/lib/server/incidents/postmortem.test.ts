import { describe, it, expect } from "vitest";
import { parseActionItems, parseTimeline, isPostmortemStatus, isTimelineSource } from "./postmortem.js";

describe("parseActionItems", () => {
  it("keeps a well-formed item", () => {
    expect(parseActionItems([{ text: "Fix it", owner: "Platform", due_at: 1000, status: "IN_PROGRESS" }])).toEqual([
      { text: "Fix it", owner: "Platform", due_at: 1000, status: "IN_PROGRESS" },
    ]);
  });

  it("drops an item with no text, and keeps the rest", () => {
    // The editor adds a blank row when somebody clicks Add and then changes
    // their mind. Refusing the whole list for it would lose the nine real ones.
    const items = parseActionItems([{ text: "Real" }, { text: "   " }, { text: "" }, { text: "Also real" }]);
    expect(items.map((i) => i.text)).toEqual(["Real", "Also real"]);
  });

  it("coerces an unrecognised status to OPEN rather than refusing", () => {
    expect(parseActionItems([{ text: "x", status: "WHATEVER" }])[0].status).toBe("OPEN");
  });

  it("normalises a blank owner to null", () => {
    expect(parseActionItems([{ text: "x", owner: "  " }])[0].owner).toBeNull();
  });

  it("drops a nonsense due date", () => {
    expect(parseActionItems([{ text: "x", due_at: "soon" }])[0].due_at).toBeNull();
    expect(parseActionItems([{ text: "x", due_at: -5 }])[0].due_at).toBeNull();
  });

  it("accepts the stored JSON string as well as the array", () => {
    expect(parseActionItems('[{"text":"From the column","status":"DONE"}]')).toEqual([
      { text: "From the column", owner: null, due_at: null, status: "DONE" },
    ]);
  });

  it("returns nothing for a column that will not parse", () => {
    // Written by an older shape or by hand. Treating it as empty loses the
    // content; throwing would take the page down with it.
    expect(parseActionItems("{not json")).toEqual([]);
    expect(parseActionItems(null)).toEqual([]);
    expect(parseActionItems({ text: "not an array" })).toEqual([]);
  });
});

describe("parseTimeline", () => {
  it("sorts oldest first, so the stored order is the reading order", () => {
    const entries = parseTimeline([
      { at: 300, text: "third" },
      { at: 100, text: "first" },
      { at: 200, text: "second" },
    ]);
    expect(entries.map((e) => e.text)).toEqual(["first", "second", "third"]);
  });

  it("drops an entry with no usable timestamp", () => {
    // An undated line in a timeline has nowhere to go.
    expect(parseTimeline([{ at: 0, text: "x" }, { text: "y" }, { at: 100, text: "z" }])).toEqual([
      { at: 100, text: "z" },
    ]);
  });

  it("drops an entry with no text", () => {
    expect(parseTimeline([{ at: 100, text: "  " }])).toEqual([]);
  });

  it("accepts the stored JSON string", () => {
    expect(parseTimeline('[{"at":5,"text":"hi"}]')).toEqual([{ at: 5, text: "hi" }]);
  });
});

describe("the closed sets", () => {
  it("recognises the statuses", () => {
    expect(isPostmortemStatus("PUBLISHED")).toBe(true);
    expect(isPostmortemStatus("published")).toBe(false);
    expect(isPostmortemStatus(undefined)).toBe(false);
  });

  it("recognises the timeline sources", () => {
    expect(isTimelineSource("CUSTOM")).toBe(true);
    expect(isTimelineSource("COMMENTS")).toBe(true);
    expect(isTimelineSource("OTHER")).toBe(false);
  });
});
