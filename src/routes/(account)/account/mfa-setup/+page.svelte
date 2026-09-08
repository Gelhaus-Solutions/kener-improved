<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Alert from "$lib/components/ui/alert/index.js";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  // Three steps: prove presence, scan the code, write down the recovery codes.
  let password = $state("");
  let code = $state("");
  let busy = $state(false);
  let errorMessage = $state("");
  let enrolment = $state<{ secret: string; qrDataUrl: string } | null>(null);
  // Shown exactly once. There is deliberately no way to retrieve them later:
  // they are stored only as bcrypt hashes.
  let recoveryCodes = $state<string[] | null>(null);
  let copied = $state(false);

  async function callApi(action: string, payload: unknown) {
    const response = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data: payload })
    });
    const result = await response.json();
    if (!response.ok || result?.error) {
      throw new Error(result?.error || "Something went wrong");
    }
    return result;
  }

  async function begin() {
    busy = true;
    errorMessage = "";
    try {
      const resp = await callApi("beginMfaEnrolment", { password });
      enrolment = { secret: resp.secret, qrDataUrl: resp.qrDataUrl };
      password = "";
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : "Could not start enrolment";
    } finally {
      busy = false;
    }
  }

  async function confirm() {
    busy = true;
    errorMessage = "";
    try {
      const resp = await callApi("confirmMfaEnrolment", { code });
      recoveryCodes = resp.recoveryCodes ?? [];
      enrolment = null;
      code = "";
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : "Could not confirm the code";
    } finally {
      busy = false;
    }
  }

  function copyCodes() {
    if (!recoveryCodes) return;
    navigator.clipboard.writeText(recoveryCodes.join("\n"));
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<div class="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-4 p-4">
  <Card.Root>
    <Card.Header>
      <Card.Title class="flex items-center gap-2">
        <ShieldCheck class="h-5 w-5" />
        Two-factor authentication required
      </Card.Title>
      <Card.Description>
        {#if recoveryCodes}
          Save these recovery codes before you continue.
        {:else}
          This site requires a second factor on every account. Set one up for
          <strong>{data.email}</strong> to continue.
        {/if}
      </Card.Description>
    </Card.Header>

    <Card.Content class="flex flex-col gap-4">
      {#if errorMessage}
        <Alert.Root variant="destructive">
          <TriangleAlert class="h-4 w-4" />
          <Alert.Description>{errorMessage}</Alert.Description>
        </Alert.Root>
      {/if}

      {#if recoveryCodes}
        <!-- Step 3. This is the only time these are ever readable. -->
        <Alert.Root>
          <TriangleAlert class="h-4 w-4" />
          <Alert.Description>
            These are shown once and cannot be retrieved later. Store them somewhere you can reach without this account.
          </Alert.Description>
        </Alert.Root>
        <div class="grid grid-cols-2 gap-2 rounded-md border p-3 font-mono text-sm">
          {#each recoveryCodes as recoveryCode (recoveryCode)}
            <span>{recoveryCode}</span>
          {/each}
        </div>
        <div class="flex gap-2">
          <Button variant="outline" onclick={copyCodes}>
            {#if copied}
              <Check class="h-4 w-4 text-green-500" />
            {:else}
              <Copy class="h-4 w-4" />
            {/if}
            Copy
          </Button>
          <Button href={clientResolver(resolve, "/manage/app/site-configurations")} class="flex-1">
            I have saved them, continue
          </Button>
        </div>
      {:else if enrolment}
        <!-- Step 2. -->
        <p class="text-muted-foreground text-sm">
          Scan this with your authenticator app, then enter the six-digit code it shows.
        </p>
        <div class="flex justify-center">
          <img src={enrolment.qrDataUrl} alt="Two-factor QR code" class="rounded-md border" />
        </div>
        <p class="text-muted-foreground text-center text-xs">
          Cannot scan it? Enter this key instead:
          <code class="block break-all select-all">{enrolment.secret}</code>
        </p>
        <form
          class="flex flex-col gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
        >
          <Label for="code">Six-digit code</Label>
          <Input id="code" bind:value={code} inputmode="numeric" autocomplete="one-time-code" placeholder="000000" />
          <Button type="submit" disabled={busy}>
            {#if busy}<Spinner class="h-4 w-4" />{/if}
            Confirm and finish
          </Button>
        </form>
      {:else}
        <!-- Step 1. An OIDC account has no password to prove presence with, so
             the field is not rendered and the live SSO session stands in. -->
        <form
          class="flex flex-col gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            begin();
          }}
        >
          {#if data.needsPassword}
            <Label for="password">Confirm your password</Label>
            <Input id="password" type="password" bind:value={password} autocomplete="current-password" />
          {/if}
          <Button type="submit" disabled={busy}>
            {#if busy}<Spinner class="h-4 w-4" />{/if}
            Set up two-factor authentication
          </Button>
        </form>
      {/if}
    </Card.Content>

    <Card.Footer>
      <!-- Always reachable. A user who cannot complete enrolment must still be
           able to leave, and /account/logout is outside the guard. -->
      <a href={clientResolver(resolve, "/account/logout")} class="text-muted-foreground text-xs underline">
        Sign out instead
      </a>
    </Card.Footer>
  </Card.Root>
</div>
