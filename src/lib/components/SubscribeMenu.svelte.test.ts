import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import SubscribeMenu from "./SubscribeMenu.svelte";

function mockFetchByUrl(handlers: Record<string, () => Promise<unknown>>) {
  return vi.fn(async (url: string) => {
    const match = Object.keys(handlers).find((key) => url.includes(key));
    if (!match) throw new Error(`Unhandled fetch in test: ${url}`);
    const body = await handlers[match]();
    return { ok: true, json: async () => body } as Response;
  });
}

describe("SubscribeMenu — captcha gating", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables Continue until the captcha reports a token when a provider is configured", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({ "captcha-config.json": async () => ({ provider: "turnstile", siteKey: "site-key-123" }) }),
    );

    const screen = await render(SubscribeMenu, {});
    await screen.getByRole("button", { name: "Subscribe" }).click();

    await expect.element(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("leaves Continue enabled when no captcha provider is configured", async () => {
    vi.stubGlobal("fetch", mockFetchByUrl({ "captcha-config.json": async () => ({ provider: null, siteKey: null }) }));

    const screen = await render(SubscribeMenu, {});
    await screen.getByRole("button", { name: "Subscribe" }).click();

    await expect.element(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled();
  });

  it("shows the server's specific error message instead of a generic one when login fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("captcha-config.json")) {
        return { ok: true, json: async () => ({ provider: null, siteKey: null }) } as Response;
      }
      if (url.includes("dashboard-apis/subscription")) {
        return { ok: false, json: async () => ({ message: "Captcha verification failed" }) } as Response;
      }
      throw new Error(`Unhandled fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const screen = await render(SubscribeMenu, {});
    await screen.getByRole("button", { name: "Subscribe" }).click();

    await screen.getByLabelText("Email address").fill("test@example.com");
    await screen.getByRole("button", { name: "Continue" }).click();

    await expect.element(screen.getByText("Captcha verification failed")).toBeInTheDocument();
  });

  it("resets the captcha widget after a rejected token so the user can solve it again", async () => {
    const resetSpy = vi.fn();
    const renderSpy = vi.fn((_container: HTMLElement, opts: { callback: (t: string) => void }) => {
      opts.callback("solved-token-1");
      return "widget-id-1";
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).turnstile = { render: renderSpy, reset: resetSpy };

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("captcha-config.json")) {
        return { ok: true, json: async () => ({ provider: "turnstile", siteKey: "site-key-123" }) } as Response;
      }
      if (url.includes("dashboard-apis/subscription")) {
        return { ok: false, json: async () => ({ message: "Captcha verification failed" }) } as Response;
      }
      throw new Error(`Unhandled fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const screen = await render(SubscribeMenu, {});
    await screen.getByRole("button", { name: "Subscribe" }).click();

    const continueButton = screen.getByRole("button", { name: "Continue" });
    // Widget "solves" immediately per the renderSpy mock above.
    await expect.element(continueButton).not.toBeDisabled();

    await screen.getByLabelText("Email address").fill("test@example.com");
    await continueButton.click();

    await vi.waitFor(() => expect(resetSpy).toHaveBeenCalledWith("widget-id-1"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).turnstile;
  });

  it("sends the user back to solve a fresh captcha on Resend instead of replaying the consumed token", async () => {
    const renderSpy = vi.fn((_container: HTMLElement, opts: { callback: (t: string) => void }) => {
      opts.callback("solved-token-1");
      return "widget-id-1";
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).turnstile = { render: renderSpy, reset: vi.fn() };

    const loginCalls: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("captcha-config.json")) {
        return { ok: true, json: async () => ({ provider: "turnstile", siteKey: "site-key-123" }) } as Response;
      }
      if (url.includes("dashboard-apis/subscription")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        loginCalls.push(body);
        return { ok: true, json: async () => ({ success: true, message: "Verification code sent" }) } as Response;
      }
      throw new Error(`Unhandled fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const screen = await render(SubscribeMenu, {});
    await screen.getByRole("button", { name: "Subscribe" }).click();

    const continueButton = screen.getByRole("button", { name: "Continue" });
    await expect.element(continueButton).not.toBeDisabled();

    await screen.getByLabelText("Email address").fill("test@example.com");
    await continueButton.click();

    // Now on the OTP view -- Resend has no captcha widget to solve here.
    const resendButton = screen.getByRole("button", { name: /resend/i });
    await expect.element(resendButton).toBeInTheDocument();
    await resendButton.click();

    // Should go back to the login view for a fresh solve, not silently
    // replay the already-consumed token from the first submission.
    await expect.element(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(loginCalls.length).toBe(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).turnstile;
  });
});

// E1b: the page and component pickers.
//
// The point of the mode control is that it is *not* cosmetic - scopes are OR'd
// server-side, so a picker that adds a scope without narrowing changes nothing at
// all. These tests pin the two things the dialog itself is responsible for:
// offering "Only what I choose" only once there is something chosen, and sending
// the narrowing gesture when the first scope is added.
describe("SubscribeMenu — scope pickers", () => {
  const PREFS = {
    success: true,
    email: "someone@example.com",
    subscriptions: { incidents: true, maintenances: false },
    minSeverity: "ANY",
    scopes: [],
    scopeMode: { incidents: "ALL", maintenances: "ALL" },
    scopeOptions: {
      page: { id: 4, title: "Public Status" },
      components: [
        { tag: "api", name: "Public API" },
        { tag: "db", name: "Primary Database" },
      ],
    },
    availableSubscriptions: { incidents: true, maintenances: true },
  };

  /** Signed in, with whatever preferences payload the test needs. */
  function signedIn(prefs: unknown, onCall?: (body: Record<string, unknown>) => void) {
    localStorage.setItem("subscriber_token", "a-token");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("captcha-config.json")) {
        return { ok: true, json: async () => ({ provider: null, siteKey: null }) } as Response;
      }
      if (url.includes("dashboard-apis/subscription")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        onCall?.(body);
        if (body.action === "getPreferences") return { ok: true, json: async () => prefs } as Response;
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      throw new Error(`Unhandled fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("offers this page and its components once signed in", async () => {
    signedIn(PREFS);
    const screen = await render(SubscribeMenu, {});
    await screen.getByRole("button", { name: "Subscribe" }).click();

    await expect.element(screen.getByRole("button", { name: /Everything on Public Status/ })).toBeVisible();
    await expect.element(screen.getByRole("option", { name: "Public API" })).toBeInTheDocument();
  });

  it("cannot narrow before anything is chosen, so the dialog cannot mute a subscriber", async () => {
    signedIn(PREFS);
    const screen = await render(SubscribeMenu, {});
    await screen.getByRole("button", { name: "Subscribe" }).click();

    // Narrowing with an empty set would mean matching nothing at all. The server
    // refuses it; the dialog must not offer it either.
    await expect.element(screen.getByRole("option", { name: "Only what I choose" })).toBeDisabled();
  });

  it("narrows when the first scope is added, because adding alone would do nothing", async () => {
    const calls: Array<Record<string, unknown>> = [];
    signedIn(PREFS, (body) => calls.push(body));
    const screen = await render(SubscribeMenu, {});
    await screen.getByRole("button", { name: "Subscribe" }).click();
    await screen.getByRole("button", { name: /Everything on Public Status/ }).click();

    await vi.waitFor(() => {
      expect(calls.some((c) => c.action === "updateScope" && c.scope_type === "PAGE" && c.scope_id === "4")).toBe(true);
      // The assertion that matters: the scope was added *and* the mode changed.
      // Without the second call the subscriber still receives everything.
      expect(calls.some((c) => c.action === "setScopeMode" && c.mode === "NARROW")).toBe(true);
    });
  });

  it("lists existing scopes by name, with a way to remove each", async () => {
    signedIn({
      ...PREFS,
      scopeMode: { incidents: "NARROW", maintenances: "ALL" },
      scopes: [{ event_class: "incidents", scope_type: "COMPONENT", scope_id: "api", label: "Public API" }],
    });
    const screen = await render(SubscribeMenu, {});
    await screen.getByRole("button", { name: "Subscribe" }).click();

    await expect.element(screen.getByText("Public API")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Remove" })).toBeVisible();
  });

  it("shows no picker at all where the page offers nothing", async () => {
    // An events or maintenance page: the server answers with no options, and the
    // dialog has to keep working rather than render an empty control.
    signedIn({ ...PREFS, scopeOptions: { page: null, components: [] } });
    const screen = await render(SubscribeMenu, {});
    await screen.getByRole("button", { name: "Subscribe" }).click();

    await expect.element(screen.getByText("Incident Updates")).toBeVisible();
    await expect.element(screen.getByRole("option", { name: "Only what I choose" })).not.toBeInTheDocument();
  });
});
