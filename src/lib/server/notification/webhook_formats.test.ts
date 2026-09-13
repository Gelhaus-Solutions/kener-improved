import { describe, expect, it } from "vitest";
import {
  MAX_TEMPLATE_LENGTH,
  allowedMentionsFor,
  colourFor,
  formatEnvelope,
  formatEnvelopeBatch,
  isWebhookFormat,
  normaliseTemplate,
  parseFormat,
  renderTemplate,
  toDiscordBody,
} from "./webhook_formats.js";
import type { WebhookEnvelope } from "./webhook_delivery.js";

function envelope(over: Partial<WebhookEnvelope> = {}): WebhookEnvelope {
  return {
    id: "evt_1",
    type: "incident.created",
    api_version: "2026-09-08",
    occurred_at: 1768485600, // 2026-01-15T14:00:00Z
    seq: 42,
    data: { object: { title: "Checkout is down", severity: "MAJOR", status: "DOWN" }, previous: null },
    diff: null,
    ...over,
  };
}

describe("allowedMentions: what Discord is permitted to ping", () => {
  it("permits a role the template itself names", () => {
    expect(allowedMentionsFor("<@&12345> incident!")).toEqual({ parse: [], roles: ["12345"], users: [] });
  });

  it("permits a user the template names", () => {
    expect(allowedMentionsFor("ping <@999>")).toEqual({ parse: [], roles: [], users: ["999"] });
    expect(allowedMentionsFor("ping <@!999>")).toEqual({ parse: [], roles: [], users: ["999"] });
  });

  it("does not confuse a role mention for a user mention", () => {
    const got = allowedMentionsFor("<@&111> and <@222>");
    expect(got.roles).toEqual(["111"]);
    expect(got.users).toEqual(["222"]);
  });

  it("blocks everyone and here unless the template asked for them", () => {
    expect(allowedMentionsFor("just an update").parse).toEqual([]);
    expect(allowedMentionsFor("@everyone get up").parse).toEqual(["everyone"]);
    // Discord spells @here's permission "everyone" too.
    expect(allowedMentionsFor("@here").parse).toEqual(["everyone"]);
  });

  it("deduplicates, because a repeated mention is one permission", () => {
    expect(allowedMentionsFor("<@&7> <@&7> <@&7>").roles).toEqual(["7"]);
  });
});

describe("mention injection through a variable", () => {
  // THE SECURITY PROPERTY. An incident title is operator-supplied text that
  // lands in the same string as the mentions. Without allowed_mentions being
  // derived from the template, anyone who can title an incident can notify a
  // whole Discord server from the status page.
  const hostile = envelope({
    data: { object: { title: "@everyone <@&999999> everything is on fire" }, previous: null },
  });

  it("does not permit a role that only appears in the payload", () => {
    const body = toDiscordBody(hostile, "<@&111> incident: {{object.title}}");

    expect(body.content).toContain("999999"); // it is rendered, visibly
    expect(body.allowed_mentions.roles).toEqual(["111"]); // but it cannot ping
    expect(body.allowed_mentions.parse).toEqual([]);
  });

  it("does not permit everyone just because the payload said it", () => {
    const body = toDiscordBody(hostile, "Incident: {{object.title}}");

    expect(body.content).toContain("@everyone");
    expect(body.allowed_mentions.parse).toEqual([]);
  });

  it("still permits everyone when the template is the thing that said it", () => {
    expect(toDiscordBody(hostile, "@everyone {{object.title}}").allowed_mentions.parse).toEqual(["everyone"]);
  });
});

describe("renderTemplate", () => {
  it("substitutes envelope variables", () => {
    expect(renderTemplate("{{type}} / {{object.title}}", envelope())).toBe("incident.created / Checkout is down");
  });

  it("does not HTML-escape, so mention syntax and ampersands survive", () => {
    // Mustache escapes by default, which would turn <@&1> into &lt;@&amp;1&gt;
    // and break the one thing this feature exists for.
    const got = renderTemplate(
      "<@&1> {{object.title}}",
      envelope({ data: { object: { title: "A & B" }, previous: null } }),
    );
    expect(got).toBe("<@&1> A & B");
  });

  it("falls back to the event type rather than failing the delivery", () => {
    expect(renderTemplate("{{#unclosed}}", envelope())).toBe("incident.created");
  });

  it("renders a missing variable as empty rather than the word undefined", () => {
    expect(renderTemplate("[{{object.nope}}]", envelope())).toBe("[]");
  });
});

describe("toDiscordBody", () => {
  it("puts the template in content and the detail in an embed", () => {
    const body = toDiscordBody(envelope(), "<@&5> {{object.title}}");

    expect(body.content).toBe("<@&5> Checkout is down");
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toBe("Checkout is down");
    expect(body.embeds[0].timestamp).toBe("2026-01-15T14:00:00.000Z");
  });

  it("surfaces the fields an operator scans for", () => {
    const names = (toDiscordBody(envelope(), null).embeds[0].fields ?? []).map((f) => f.name);
    expect(names).toEqual(["Status", "Severity"]);
  });

  it("uses a default template when the endpoint has none", () => {
    for (const empty of [null, "", "   "]) {
      expect(toDiscordBody(envelope(), empty).content).toBe("**incident.created**");
    }
  });

  it("clamps content to Discord's limit instead of earning a 400", () => {
    const body = toDiscordBody(envelope(), "x".repeat(5000));
    expect(body.content).toHaveLength(2000);
  });

  it("omits an embed description when there is nothing to say", () => {
    expect(toDiscordBody(envelope(), null).embeds[0].description).toBeUndefined();
  });
});

describe("colourFor", () => {
  it("is red for a new incident and green once resolved", () => {
    expect(colourFor(envelope({ type: "incident.created" }))).toBe(0xe5484d);
    expect(colourFor(envelope({ type: "incident.resolved" }))).toBe(0x46a758);
  });

  it("reads the payload status when the type does not say", () => {
    const degraded = envelope({
      type: "monitor.status_changed",
      data: { object: { status: "DEGRADED" }, previous: null },
    });
    expect(colourFor(degraded)).toBe(0xf5a524);
  });

  it("is blue for maintenance, which is not a failure", () => {
    expect(colourFor(envelope({ type: "maintenance.started" }))).toBe(0x3b82f6);
  });
});

describe("formatEnvelope", () => {
  it("leaves GENERIC as the envelope itself, byte for byte", () => {
    const e = envelope();
    expect(formatEnvelope("GENERIC", e, "ignored")).toBe(e);
  });

  it("transforms for DISCORD", () => {
    expect(formatEnvelope("DISCORD", envelope(), null)).toHaveProperty("allowed_mentions");
  });

  it("validates the format name", () => {
    expect(isWebhookFormat("DISCORD")).toBe(true);
    expect(isWebhookFormat("TEAMS")).toBe(false);
  });
});

describe("parseFormat", () => {
  it("defaults to GENERIC when nothing was chosen", () => {
    for (const empty of [undefined, null, ""]) expect(parseFormat(empty)).toBe("GENERIC");
  });

  it("accepts a known format", () => {
    expect(parseFormat("DISCORD")).toBe("DISCORD");
  });

  it("refuses an unknown one rather than quietly sending the wrong shape", () => {
    // Coercing a typo to GENERIC would mean an operator who chose Discord
    // watches every delivery fail with no clue why.
    expect(() => parseFormat("discrod")).toThrow(/GENERIC, DISCORD/);
    expect(() => parseFormat("TEAMS")).toThrow();
  });

  it("is case sensitive, because the column stores exactly this", () => {
    expect(() => parseFormat("discord")).toThrow();
  });
});

describe("normaliseTemplate", () => {
  it("treats absent and blank as no template", () => {
    for (const empty of [undefined, null, "", "   ", "\n\t"]) expect(normaliseTemplate(empty)).toBeNull();
  });

  it("trims, so a stray newline does not count as authored content", () => {
    expect(normaliseTemplate("  <@&1> up  ")).toBe("<@&1> up");
  });

  it("bounds what is stored", () => {
    expect(normaliseTemplate("x".repeat(MAX_TEMPLATE_LENGTH + 500))).toHaveLength(MAX_TEMPLATE_LENGTH);
  });
});

/**
 * E11 part 4. The batched body.
 *
 * **The single-event case must be byte-identical to what it was**, and that is
 * the assertion that matters most here. An endpoint with no batch window is the
 * overwhelmingly common case, its receiver was written against the unwrapped
 * shape, and a batching feature that changed the payload of every unbatched
 * delivery would be a breaking change dressed up as an option.
 */
describe("formatEnvelopeBatch", () => {
  it("is byte for byte the unbatched body for a single event", () => {
    for (const format of ["GENERIC", "DISCORD"] as const) {
      const one = JSON.stringify(formatEnvelope(format, envelope(), "<@&7> {{type}}"));
      const batched = JSON.stringify(formatEnvelopeBatch(format, [envelope()], "<@&7> {{type}}"));
      expect(batched).toBe(one);
    }
  });

  // A receiver can tell a batch from a single event by SHAPE rather than by
  // counting, which is what lets it branch without guessing.
  it("wraps a real GENERIC batch in a batch key", () => {
    const body = formatEnvelopeBatch("GENERIC", [envelope(), envelope({ id: "evt_2" })], null) as {
      batch: unknown[];
    };
    expect(Array.isArray(body.batch)).toBe(true);
    expect(body.batch).toHaveLength(2);
  });

  // One message mentioning on-call once and listing what happened is the entire
  // point of batching a chat channel. Repeating the mention per event would be
  // the noise this exists to fix.
  it("sends one Discord message with one embed per event and one mention", () => {
    const body = formatEnvelopeBatch(
      "DISCORD",
      [envelope(), envelope({ id: "evt_2", type: "incident.resolved" })],
      "<@&7> alert",
    ) as { content: string; embeds: unknown[]; allowed_mentions: { roles: string[] } };

    expect(body.embeds).toHaveLength(2);
    expect(body.content).toBe("<@&7> alert");
    expect(body.allowed_mentions.roles).toEqual(["7"]);
  });

  // The delivery log will mark every event in the batch delivered, so the
  // message has to account for every one of them rather than silently truncate.
  it("accounts for events past Discord's ten-embed limit", () => {
    const many = Array.from({ length: 14 }, (_, i) => envelope({ id: `evt_${i}` }));
    const body = formatEnvelopeBatch("DISCORD", many, "<@&7>") as {
      embeds: { footer?: { text: string } }[];
    };

    expect(body.embeds).toHaveLength(10);
    expect(body.embeds[9].footer?.text).toContain("+4 more");
  });

  it("returns null for an empty batch rather than an empty message", () => {
    expect(formatEnvelopeBatch("GENERIC", [], null)).toBeNull();
  });
});
