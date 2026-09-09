import { describe, it, expect } from "vitest";
import { parseVariables, parseComponents, templateVariableNames } from "./templates.js";

describe("parseVariables", () => {
  it("fills in what a declaration leaves out", () => {
    // Only `key` is genuinely required; everything else has a sane answer, and
    // refusing a declaration for a missing label would make the quick case hard.
    expect(parseVariables([{ key: "service" }])).toEqual([
      { key: "service", label: "service", type: "text", required: false, default: "", options: [] },
    ]);
  });

  it("drops a declaration with no key", () => {
    // `{{}}` resolves to nothing, so a declaration without a key can never be
    // referenced and only clutters the form.
    expect(parseVariables([{ label: "Nameless" }, { key: "  " }, { key: "real" }]).map((v) => v.key)).toEqual(["real"]);
  });

  it("coerces an unrecognised type to text", () => {
    expect(parseVariables([{ key: "x", type: "colourpicker" }])[0].type).toBe("text");
  });

  it("keeps only string options", () => {
    expect(parseVariables([{ key: "x", type: "select", options: ["a", 2, "", null, "b"] }])[0].options).toEqual([
      "a",
      "b",
    ]);
  });

  it("treats required as strictly true", () => {
    // "yes" and 1 are the kind of thing a hand-written payload sends, and
    // treating them as truthy would make a variable required by accident.
    expect(parseVariables([{ key: "x", required: "yes" }])[0].required).toBe(false);
    expect(parseVariables([{ key: "x", required: true }])[0].required).toBe(true);
  });

  it("accepts the stored JSON string", () => {
    expect(parseVariables('[{"key":"a"}]')[0].key).toBe("a");
  });

  it("returns nothing for a column that will not parse", () => {
    expect(parseVariables("{not json")).toEqual([]);
    expect(parseVariables(null)).toEqual([]);
  });
});

describe("parseComponents", () => {
  it("keeps a component with a recognised impact", () => {
    expect(parseComponents([{ monitor_tag: "api", component_impact: "PARTIAL_OUTAGE" }])).toEqual([
      { monitor_tag: "api", component_impact: "PARTIAL_OUTAGE" },
    ]);
  });

  it("attaches at MAJOR_OUTAGE rather than dropping an unrecognised impact", () => {
    // A template naming a component clearly means to attach it. Losing it is
    // invisible until a customer asks why their service was not listed; the
    // wrong severity is visible on the incident and fixed in seconds.
    expect(parseComponents([{ monitor_tag: "api", component_impact: "VERY_BROKEN" }])[0].component_impact).toBe(
      "MAJOR_OUTAGE",
    );
  });

  it("drops an entry with no tag", () => {
    expect(parseComponents([{ component_impact: "MAJOR_OUTAGE" }, { monitor_tag: "  " }])).toEqual([]);
  });
});

describe("templateVariableNames", () => {
  it("collects interpolations", () => {
    expect(templateVariableNames("{{service}} is down, {{provider}} says so").sort()).toEqual(["provider", "service"]);
  });

  it("deduplicates", () => {
    expect(templateVariableNames("{{a}} and {{a}} again")).toEqual(["a"]);
  });

  it("collects the unescaped form too", () => {
    expect(templateVariableNames("{{&raw}}")).toEqual(["raw"]);
  });

  it("ignores sections and comments", () => {
    // A section name is control flow, not a value somebody types into a form.
    expect(templateVariableNames("{{#when}}x{{/when}}{{! a note }}")).toEqual([]);
  });

  it("finds nothing in plain text", () => {
    expect(templateVariableNames("Nothing to interpolate")).toEqual([]);
  });
});
