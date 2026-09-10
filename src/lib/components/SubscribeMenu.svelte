<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as InputOTP from "$lib/components/ui/input-otp/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";

  import Mail from "@lucide/svelte/icons/mail";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import LogOut from "@lucide/svelte/icons/log-out";
  import Loader2 from "@lucide/svelte/icons/loader-2";
  import Bell from "@lucide/svelte/icons/bell";
  import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
  import Wrench from "@lucide/svelte/icons/wrench";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import { page } from "$app/state";
  import { t } from "$lib/stores/i18n";
  import trackEvent from "$lib/beacon";
  import ICONS from "$lib/icons";
  import Captcha from "./Captcha.svelte";

  interface Props {
    compact?: boolean;
  }

  let { compact = false }: Props = $props();
  let open = $state(false);

  const STORAGE_KEY = "subscriber_token";

  // UI States
  type View = "loading" | "login" | "otp" | "preferences" | "error";
  let currentView = $state<View>("loading");
  let isSubmitting = $state(false);
  let errorMessage = $state("");

  // Form data
  let email = $state("");
  let otpValue = $state("");
  let captchaRequired = $state(false);
  let captchaToken = $state<string | null>(null);
  let captchaRef: { reset: () => void } | undefined = $state();

  // Preferences data
  let subscriberEmail = $state("");
  let incidentsEnabled = $state(false);
  let maintenancesEnabled = $state(false);
  // The severity floor on incident mail (E1). ANY is what every inherited
  // subscription means, so a subscriber who never touches this keeps receiving
  // exactly what they did before.
  let minSeverity = $state("ANY");
  const SEVERITY_FLOORS: Array<{ value: string; label: string }> = [
    { value: "ANY", label: "Everything" },
    { value: "MINOR", label: "Minor and above" },
    { value: "MAJOR", label: "Major and above" },
    { value: "CRITICAL", label: "Critical only" }
  ];
  let availableSubscriptions = $state<{ incidents: boolean; maintenances: boolean }>({
    incidents: false,
    maintenances: false
  });

  // --- scoping (E1b) -------------------------------------------------------
  //
  // Scopes are OR'd together by the delivery query and every subscriber holds an
  // ALL row, so a component subscription means nothing while that row is live.
  // "Everything" versus "Only what I choose" is therefore not a display choice:
  // it is whether the ALL row is active, and it is what makes the pickers do
  // anything at all.
  interface Scope {
    event_class: string;
    scope_type: string;
    scope_id: string;
    label: string;
  }
  interface ScopeOptions {
    page: { id: number; title: string } | null;
    components: Array<{ tag: string; name: string }>;
  }

  let scopes = $state<Scope[]>([]);
  let scopeMode = $state<{ incidents: "ALL" | "NARROW"; maintenances: "ALL" | "NARROW" }>({
    incidents: "ALL",
    maintenances: "ALL"
  });
  let scopeOptions = $state<ScopeOptions>({ page: null, components: [] });
  let scopeBusy = $state(false);
  let componentToAdd = $state("");

  /**
   * The page path the dialog is standing on.
   *
   * Read from the router rather than threaded down as a prop, which is what let
   * this ship without touching every call site: the dialog already knows its own
   * URL. `undefined` for a route that is not a status page - an events or
   * maintenance page - and the server answers that with no pickers rather than an
   * error, so those screens keep working exactly as before. The home page is
   * stored with an empty path, hence the empty string rather than undefined.
   */
  const currentPagePath = $derived.by(() => {
    const params = page.params;
    if (typeof params.page_path === "string") return params.page_path;
    if (params.monitor_tag !== undefined) return undefined;
    // The status page root. `page.route.id` distinguishes it from every other
    // route that renders this menu without a page of its own.
    return page.route.id === "/(kener)" ? "" : undefined;
  });

  const incidentScopes = $derived(scopes.filter((s) => s.event_class === "incidents"));

  /** Components on this page the subscriber has not already picked. */
  const addableComponents = $derived(
    scopeOptions.components.filter(
      (c) => !incidentScopes.some((s) => s.scope_type === "COMPONENT" && s.scope_id === c.tag)
    )
  );
  const pageAlreadyScoped = $derived(
    scopeOptions.page !== null &&
      incidentScopes.some((s) => s.scope_type === "PAGE" && s.scope_id === String(scopeOptions.page?.id))
  );

  // Check token on mount
  onMount(() => {
    checkExistingToken();
  });

  // Also check when dialog opens
  $effect(() => {
    if (open) {
      checkExistingToken();
    }
  });

  async function checkExistingToken() {
    const token = localStorage.getItem(STORAGE_KEY);
    if (!token) {
      currentView = "login";
      return;
    }

    currentView = "loading";
    try {
      const response = await fetch(clientResolver(resolve, "/dashboard-apis/subscription"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "getPreferences", token, page_path: currentPagePath })
      });

      if (!response.ok) {
        // Token invalid or expired
        localStorage.removeItem(STORAGE_KEY);
        currentView = "login";
        return;
      }

      const data = await response.json();
      subscriberEmail = data.email || "";
      incidentsEnabled = data.subscriptions?.incidents || false;
      minSeverity = data.minSeverity || "ANY";
      maintenancesEnabled = data.subscriptions?.maintenances || false;
      availableSubscriptions = data.availableSubscriptions || { incidents: false, maintenances: false };
      scopes = data.scopes ?? [];
      scopeMode = data.scopeMode ?? { incidents: "ALL", maintenances: "ALL" };
      scopeOptions = data.scopeOptions ?? { page: null, components: [] };
      componentToAdd = "";
      currentView = "preferences";
    } catch (err) {
      localStorage.removeItem(STORAGE_KEY);
      currentView = "login";
    }
  }

  async function handleLogin() {
    if (!email.trim()) {
      errorMessage = $t("Please enter a valid email address");
      return;
    }

    isSubmitting = true;
    errorMessage = "";

    try {
      const response = await fetch(clientResolver(resolve, "/dashboard-apis/subscription"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", email: email.trim(), captchaToken })
      });

      if (!response.ok) {
        const data = await response.json();
        errorMessage = data?.message || $t("Failed to send verification code");
        captchaToken = null;
        captchaRef?.reset();
        return;
      }

      trackEvent("subscribe_login_sent", { source: "subscribe_menu" });

      // The token is single-use and has now been consumed by the provider
      // regardless of which UI path sent it -- clear it so nothing can
      // accidentally resubmit it later.
      captchaToken = null;
      currentView = "otp";
      otpValue = "";
    } catch (err) {
      errorMessage = $t("Network error. Please try again.");
    } finally {
      isSubmitting = false;
    }
  }

  function handleResend() {
    if (captchaRequired) {
      // The OTP view has no captcha widget to produce a fresh token, and
      // the one from the original submission is already consumed -- send
      // the user back to solve a new challenge instead of silently
      // replaying a token the provider will reject.
      handleBackToEmail();
      return;
    }
    handleLogin();
  }

  async function handleVerifyOTP() {
    if (otpValue.length !== 6) {
      errorMessage = $t("Please enter the 6-digit verification code");
      return;
    }

    isSubmitting = true;
    errorMessage = "";

    try {
      const response = await fetch(clientResolver(resolve, "/dashboard-apis/subscription"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", email: email.trim(), code: otpValue })
      });

      if (!response.ok) {
        const data = await response.json();
        errorMessage = $t("Verification failed");
        return;
      }

      const data = await response.json();
      localStorage.setItem(STORAGE_KEY, data.token);
      trackEvent("subscribe_otp_verified", { source: "subscribe_menu" });
      await checkExistingToken();
    } catch (err) {
      errorMessage = $t("Network error. Please try again.");
    } finally {
      isSubmitting = false;
    }
  }

  async function handlePreferenceChange(type: "incidents" | "maintenances", value: boolean) {
    const token = localStorage.getItem(STORAGE_KEY);
    if (!token) {
      currentView = "login";
      return;
    }

    try {
      const response = await fetch(clientResolver(resolve, "/dashboard-apis/subscription"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "updatePreferences",
          token,
          [type]: value
        })
      });

      if (!response.ok) {
        const data = await response.json();
        errorMessage = $t("Failed to update preference");
        // Revert the toggle
        if (type === "incidents") {
          incidentsEnabled = !value;
        } else {
          maintenancesEnabled = !value;
        }
        return;
      }

      // Update local state
      if (type === "incidents") {
        incidentsEnabled = value;
      } else {
        maintenancesEnabled = value;
      }

      trackEvent("subscribe_pref_toggled", { source: "subscribe_menu", type, value });
    } catch (err) {
      errorMessage = $t("Network error. Please try again.");
      // Revert the toggle
      if (type === "incidents") {
        incidentsEnabled = !value;
      } else {
        maintenancesEnabled = !value;
      }
    }
  }

  /** One call, one reload: the server owns the invariants, the dialog re-reads them. */
  async function scopeCall(payload: Record<string, unknown>): Promise<boolean> {
    const token = localStorage.getItem(STORAGE_KEY);
    if (!token) {
      currentView = "login";
      return false;
    }
    scopeBusy = true;
    errorMessage = "";
    try {
      const response = await fetch(clientResolver(resolve, "/dashboard-apis/subscription"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, token })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        errorMessage = data?.message || $t("Failed to update preference");
        return false;
      }
      // Re-read rather than patch local state. Several of these operations move
      // more than they name - removing the last scope widens back to everything -
      // and guessing which would be a second implementation of the server's rules.
      await checkExistingToken();
      return true;
    } catch (err) {
      errorMessage = $t("Network error. Please try again.");
      return false;
    } finally {
      scopeBusy = false;
    }
  }

  /** Adds a scope. The first one added also narrows, so the pick takes effect. */
  async function addScope(scopeType: "PAGE" | "COMPONENT", scopeId: string) {
    const wasEverything = scopeMode.incidents === "ALL";
    const added = await scopeCall({
      action: "updateScope",
      event_class: "incidents",
      scope_type: scopeType,
      scope_id: scopeId
    });
    if (!added) return;
    // Adding a scope while still on "everything" would change nothing at all,
    // because the two are OR'd. Narrowing is the point of having added it.
    if (wasEverything) {
      await scopeCall({ action: "setScopeMode", event_class: "incidents", mode: "NARROW" });
    }
    trackEvent("subscribe_scope_added", { source: "subscribe_menu", scope_type: scopeType });
  }

  async function removeScope(scope: Scope) {
    await scopeCall({
      action: "removeScope",
      event_class: scope.event_class,
      scope_type: scope.scope_type,
      scope_id: scope.scope_id
    });
    trackEvent("subscribe_scope_removed", { source: "subscribe_menu", scope_type: scope.scope_type });
  }

  async function setScopeMode(mode: "ALL" | "NARROW") {
    if (mode === scopeMode.incidents) return;
    await scopeCall({ action: "setScopeMode", event_class: "incidents", mode });
  }

  /** Narrows incident mail to a severity floor. */
  async function handleSeverityChange(value: string) {
    const token = localStorage.getItem(STORAGE_KEY);
    if (!token) {
      currentView = "login";
      return;
    }
    const previous = minSeverity;
    minSeverity = value;
    try {
      const response = await fetch(clientResolver(resolve, "/dashboard-apis/subscription"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "updateScope",
          token,
          event_class: "incidents",
          scope_type: "ALL",
          min_severity: value
        })
      });
      if (!response.ok) {
        minSeverity = previous;
        errorMessage = $t("Failed to update preference");
        return;
      }
      trackEvent("subscribe_severity_set", { source: "subscribe_menu", value });
    } catch (err) {
      minSeverity = previous;
      errorMessage = $t("Network error. Please try again.");
    }
  }

  function handleLogout() {
    localStorage.removeItem(STORAGE_KEY);
    email = "";
    otpValue = "";
    subscriberEmail = "";
    incidentsEnabled = false;
    maintenancesEnabled = false;
    minSeverity = "ANY";
    errorMessage = "";
    currentView = "login";
    trackEvent("subscribe_logout", { source: "subscribe_menu" });
  }

  function handleBackToEmail() {
    currentView = "login";
    otpValue = "";
    errorMessage = "";
  }

  function handleClose() {
    open = false;
    errorMessage = "";
  }

  // Google reCAPTCHA's expanded image-challenge renders as a second iframe
  // appended outside this Dialog's own DOM subtree (unlike the basic
  // checkbox, which nests inside it). Bits UI's outside-interaction
  // detection sees clicks/focus landing on that iframe as "outside" and
  // dismisses the dialog, orphaning the still-open challenge. Any outside
  // interaction targeting an iframe is treated as captcha-challenge traffic
  // and kept open — nothing else in this dialog renders a bare iframe.
  function ignoreCaptchaIframeInteraction(event: PointerEvent | FocusEvent) {
    if (event.target instanceof HTMLIFrameElement) {
      event.preventDefault();
    }
  }
</script>

{#if compact}
  <Button
    variant="outline"
    size="icon-sm"
    class="bg-background/80 dark:bg-background/70 border-foreground/10 rounded-full border shadow-none backdrop-blur-md"
    aria-label={$t("Subscribe")}
    onclick={() => {
      open = true;
      trackEvent("subscribe_opened", { source: "theme_plus" });
    }}
  >
    <ICONS.Bell />
  </Button>
{:else}
  <Button
    variant="outline"
    size="sm"
    class="rounded-btn bg-background/80 dark:bg-background/70 border-foreground/10 border text-xs backdrop-blur-md"
    aria-label="Subscribe"
    onclick={() => {
      open = true;
      trackEvent("subscribe_opened", { source: "theme_plus" });
    }}
  >
    <ICONS.Bell class="" />
    {$t("Subscribe")}
  </Button>
{/if}

<Dialog.Root bind:open>
  <Dialog.Overlay class="backdrop-blur-[2px]" />
  <Dialog.Content
    class="max-w-sm rounded-3xl"
    onInteractOutside={ignoreCaptchaIframeInteraction}
    onFocusOutside={ignoreCaptchaIframeInteraction}
  >
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <Bell class="h-5 w-5" />
        {$t("Subscribe to Updates")}
      </Dialog.Title>
      <Dialog.Description>
        {#if currentView === "login"}
          {$t("Get notified about incidents and scheduled maintenance.")}
        {:else if currentView === "otp"}
          {$t("Enter the verification code sent to your email.")}
        {:else if currentView === "preferences"}
          {$t("Manage your notification preferences.")}
        {:else if currentView === "loading"}
          {$t("Loading your preferences...")}
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    <div class="py-4">
      {#if currentView === "loading"}
        <div class="flex items-center justify-center py-8">
          <Loader2 class="text-muted-foreground h-8 w-8 animate-spin" />
        </div>
      {:else if currentView === "login"}
        <!-- Login View -->
        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-2">
            <Label for="email">{$t("Email address")}</Label>
            <div class="relative">
              <Mail class="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                class="pl-10"
                bind:value={email}
                disabled={isSubmitting}
                onkeydown={(e) => e.key === "Enter" && handleLogin()}
              />
            </div>
          </div>

          <Captcha
            bind:this={captchaRef}
            onReady={(required) => (captchaRequired = required)}
            onVerify={(token) => (captchaToken = token)}
          />

          {#if errorMessage}
            <p class="text-destructive text-sm">{errorMessage}</p>
          {/if}

          <Button onclick={handleLogin} disabled={isSubmitting || (captchaRequired && !captchaToken)} class="w-full">
            {#if isSubmitting}
              <Loader2 class="mr-2 h-4 w-4 animate-spin" />
              {$t("Sending...")}
            {:else}
              {$t("Continue")}
            {/if}
          </Button>
        </div>
      {:else if currentView === "otp"}
        <!-- OTP View -->
        <div class="flex flex-col gap-4">
          <div class="flex flex-col items-center gap-4">
            <p class="text-muted-foreground text-center text-sm">
              {$t("We sent a 6-digit code to")} <strong class="text-foreground">{email}</strong>
            </p>

            <InputOTP.Root maxlength={6} bind:value={otpValue}>
              {#snippet children({ cells })}
                <InputOTP.Group>
                  {#each cells as cell, i (i)}
                    <InputOTP.Slot {cell} />
                  {/each}
                </InputOTP.Group>
              {/snippet}
            </InputOTP.Root>
          </div>

          {#if errorMessage}
            <p class="text-destructive text-center text-sm">{errorMessage}</p>
          {/if}

          <div class="flex gap-2">
            <Button variant="outline" onclick={handleBackToEmail} disabled={isSubmitting} class="flex-1">
              <ArrowLeft class="mr-2 h-4 w-4" />
              {$t("Back")}
            </Button>
            <Button onclick={handleVerifyOTP} disabled={isSubmitting || otpValue.length !== 6} class="flex-1">
              {#if isSubmitting}
                <Loader2 class="mr-2 h-4 w-4 animate-spin" />
                {$t("Verifying")}...
              {:else}
                {$t("Verify")}
              {/if}
            </Button>
          </div>

          <Button variant="link" onclick={handleResend} disabled={isSubmitting} class="text-xs">
            {$t("Didn't receive the code? Resend")}
          </Button>
        </div>
      {:else if currentView === "preferences"}
        <!-- Preferences View -->
        <div class="flex flex-col gap-6">
          <div class="rounded-lg border p-4">
            <div class="flex items-center justify-between gap-2">
              <div class="flex gap-2">
                <Mail class="text-muted-foreground h-4 w-4" />
                <span class="text-sm font-medium">{subscriberEmail}</span>
              </div>
              <Button variant="ghost" size="icon-sm" onclick={handleLogout} class="rounded-btn">
                <LogOut class="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div class="flex flex-col gap-4">
            {#if availableSubscriptions.incidents}
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <AlertTriangle class="h-5 w-5 text-orange-500" />
                  <div>
                    <Label class="font-medium">{$t("Incident Updates")}</Label>
                    <p class="text-muted-foreground text-xs">{$t("Get notified about incidents updates")}</p>
                  </div>
                </div>
                <Switch
                  checked={incidentsEnabled}
                  onCheckedChange={(value) => handlePreferenceChange("incidents", value)}
                />
              </div>

              {#if incidentsEnabled}
                <div class="flex flex-col gap-2 pl-8">
                  <Label class="text-xs font-medium">{$t("How much to send")}</Label>
                  <select
                    class="border-input bg-background h-9 rounded-md border px-2 text-sm"
                    value={minSeverity}
                    onchange={(e) => handleSeverityChange(e.currentTarget.value)}
                  >
                    {#each SEVERITY_FLOORS as floor (floor.value)}
                      <option value={floor.value}>{$t(floor.label)}</option>
                    {/each}
                  </select>
                  <p class="text-muted-foreground text-xs">
                    {$t("Scheduled maintenance is not affected by this setting.")}
                  </p>
                </div>

                <!--
                  Scoping (E1b). Only offered where there is something to scope
                  to: on an events or maintenance page the server sends no
                  options and this whole block stays out of the way, leaving the
                  dialog exactly as it was.
                -->
                {#if scopeOptions.page || incidentScopes.length > 0}
                  <div class="flex flex-col gap-2 pl-8">
                    <Label class="text-xs font-medium">{$t("What to send")}</Label>
                    <select
                      class="border-input bg-background h-9 rounded-md border px-2 text-sm"
                      value={scopeMode.incidents}
                      disabled={scopeBusy}
                      onchange={(e) => setScopeMode(e.currentTarget.value as "ALL" | "NARROW")}
                    >
                      <option value="ALL">{$t("Everything")}</option>
                      <option value="NARROW" disabled={incidentScopes.length === 0}>
                        {$t("Only what I choose")}
                      </option>
                    </select>

                    {#if incidentScopes.length > 0}
                      <ul class="flex flex-col gap-1">
                        {#each incidentScopes as scope (scope.scope_type + scope.scope_id)}
                          <li class="flex items-center justify-between rounded-md border px-2 py-1">
                            <span class="text-sm">
                              {scope.label}
                              <span class="text-muted-foreground text-xs">
                                {scope.scope_type === "PAGE" ? $t("Page") : $t("Component")}
                              </span>
                            </span>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              class="rounded-btn"
                              disabled={scopeBusy}
                              aria-label={$t("Remove")}
                              onclick={() => removeScope(scope)}
                            >
                              <X class="size-4" />
                            </Button>
                          </li>
                        {/each}
                      </ul>
                    {/if}

                    {#if scopeOptions.page && !pageAlreadyScoped}
                      <Button
                        variant="outline"
                        size="sm"
                        class="rounded-btn justify-start"
                        disabled={scopeBusy}
                        onclick={() => addScope("PAGE", String(scopeOptions.page?.id))}
                      >
                        <Plus class="size-4" />
                        {$t("Everything on %page", { page: scopeOptions.page.title })}
                      </Button>
                    {/if}

                    {#if addableComponents.length > 0}
                      <div class="flex items-end gap-2">
                        <select
                          class="border-input bg-background h-9 flex-1 rounded-md border px-2 text-sm"
                          bind:value={componentToAdd}
                          disabled={scopeBusy}
                        >
                          <option value="">{$t("Choose a component")}</option>
                          {#each addableComponents as component (component.tag)}
                            <option value={component.tag}>{component.name}</option>
                          {/each}
                        </select>
                        <Button
                          variant="outline"
                          size="sm"
                          class="rounded-btn"
                          disabled={scopeBusy || !componentToAdd}
                          onclick={() => addScope("COMPONENT", componentToAdd)}
                        >
                          <Plus class="size-4" />
                          {$t("Add")}
                        </Button>
                      </div>
                    {/if}

                    <p class="text-muted-foreground text-xs">
                      {scopeMode.incidents === "ALL"
                        ? $t("Switching to everything discards the list above.")
                        : $t("You will only hear about these.")}
                    </p>
                  </div>
                {/if}
              {/if}
            {/if}

            {#if availableSubscriptions.maintenances}
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <Wrench class="h-5 w-5 text-blue-500" />
                  <div>
                    <Label class="font-medium">{$t("Maintenance Updates")}</Label>
                    <p class="text-muted-foreground text-xs">{$t("Get notified about scheduled maintenance")}</p>
                  </div>
                </div>
                <Switch
                  checked={maintenancesEnabled}
                  onCheckedChange={(value) => handlePreferenceChange("maintenances", value)}
                />
              </div>
            {/if}
          </div>

          {#if errorMessage}
            <p class="text-destructive text-sm">{errorMessage}</p>
          {/if}
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
