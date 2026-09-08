<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import * as Alert from "$lib/components/ui/alert/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import AlertCircleIcon from "@lucide/svelte/icons/alert-circle";
  import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import { resolve } from "$app/paths";
  import type { PageProps } from "./$types";

  let { form }: PageProps = $props();

  let loading = $state(false);
  // Recovery is a separate mode rather than one field that accepts either, so
  // the server knows which it is being given and the user is not left guessing
  // whether their backup code belongs in a box labelled "authenticator code".
  let useRecovery = $state(false);
  let code = $state("");
</script>

<svelte:head>
  <title>Two-Factor Authentication</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center p-4">
  <Card.Root class="kener-card w-full max-w-md">
    <Card.Header>
      <Card.Title class="flex items-center gap-2">
        <ShieldCheckIcon class="size-5" />
        Two-Factor Authentication
      </Card.Title>
      <Card.Description>
        {useRecovery
          ? "Enter one of the recovery codes you saved when you turned on two-factor authentication."
          : "Enter the 6-digit code from your authenticator app."}
      </Card.Description>
    </Card.Header>

    <Card.Content>
      {#if form?.error}
        <Alert.Root variant="destructive" class="mb-4">
          <AlertCircleIcon class="size-4" />
          <Alert.Description>{form.error}</Alert.Description>
        </Alert.Root>
      {/if}

      <form
        method="POST"
        action={resolve("/account/mfa")}
        onsubmit={() => {
          loading = true;
        }}
      >
        <input type="hidden" name="mode" value={useRecovery ? "recovery" : "totp"} />

        <Field.Set>
          <Field.Field>
            <Field.Label for="code">{useRecovery ? "Recovery code" : "Authentication code"}</Field.Label>
            <Input
              id="code"
              name="code"
              bind:value={code}
              placeholder={useRecovery ? "XXXXX-XXXXX" : "000000"}
              autocomplete={useRecovery ? "off" : "one-time-code"}
              inputmode={useRecovery ? "text" : "numeric"}
              autocapitalize={useRecovery ? "characters" : "off"}
              spellcheck={false}
              required
              autofocus
            />
          </Field.Field>
        </Field.Set>

        <Button type="submit" class="mt-4 w-full" disabled={loading || !code.trim()}>
          {loading ? "Verifying…" : "Verify"}
        </Button>
      </form>

      <div class="mt-4 flex flex-col gap-2 text-center text-sm">
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground inline-flex items-center justify-center gap-1 underline"
          onclick={() => {
            useRecovery = !useRecovery;
            code = "";
          }}
        >
          <KeyRoundIcon class="size-3" />
          {useRecovery ? "Use my authenticator app instead" : "I cannot use my authenticator app"}
        </button>
        <a href={resolve("/account/signin")} class="text-muted-foreground hover:text-foreground underline">
          Back to sign in
        </a>
      </div>
    </Card.Content>
  </Card.Root>
</div>
