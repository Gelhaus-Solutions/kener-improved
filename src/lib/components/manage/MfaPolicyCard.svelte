<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as RadioGroup from "$lib/components/ui/radio-group/index.js";
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
  import * as Alert from "$lib/components/ui/alert/index.js";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { toast } from "svelte-sonner";
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";

  interface Coverage {
    policy: string;
    total: number;
    covered: number;
    uncovered: number;
    caller_covered: boolean;
  }

  const OPTIONS = [
    {
      value: "none",
      label: "Not required",
      detail: "Users may enable two-factor authentication, but nobody has to."
    },
    {
      value: "local_only",
      label: "Required for password accounts (recommended)",
      detail:
        "Users who sign in with a password must enrol. Single sign-on users are exempt, because their factors are the identity provider's business."
    },
    {
      value: "all",
      label: "Required for everyone",
      detail:
        "Every user must enrol, including single sign-on users. An SSO session that already cleared a factor at the provider counts."
    }
  ];

  let coverage = $state<Coverage | null>(null);
  let selected = $state("local_only");
  let loading = $state(true);
  let saving = $state(false);
  let confirmOpen = $state(false);

  const changed = $derived(!!coverage && selected !== coverage.policy);

  // How many people this choice would newly require a factor from. `local_only`
  // and `all` differ only in whether SSO users are counted, and the coverage
  // query does not break the uncovered figure down by provider, so this is the
  // upper bound in both cases and is labelled as "up to" in the copy.
  const wouldBlock = $derived(selected === "none" ? 0 : (coverage?.uncovered ?? 0));

  async function callApi(action: string, payload: unknown) {
    const response = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data: payload })
    });
    const result = await response.json();
    if (!response.ok || result?.error) throw new Error(result?.error || "Something went wrong");
    return result;
  }

  async function load() {
    loading = true;
    try {
      coverage = await callApi("getMfaCoverage", {});
      selected = coverage!.policy;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the two-factor policy");
    } finally {
      loading = false;
    }
  }

  async function save() {
    saving = true;
    try {
      const result = await callApi("setMfaPolicy", { policy: selected });
      coverage = result.coverage;
      toast.success("Two-factor policy updated");
    } catch (e) {
      // The most likely failure is the server refusing to let an operator
      // without a factor require one. Surfacing the message verbatim is right:
      // it says exactly what to do about it.
      toast.error(e instanceof Error ? e.message : "Could not update the policy");
      if (coverage) selected = coverage.policy;
    } finally {
      saving = false;
      confirmOpen = false;
    }
  }

  onMount(load);
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Two-factor authentication policy</Card.Title>
    <Card.Description>
      Who must hold a second factor. Users who owe one are sent to enrolment on their next request and can reach nothing
      else until they finish.
    </Card.Description>
  </Card.Header>
  <Card.Content class="flex flex-col gap-4">
    {#if loading}
      <div class="flex justify-center py-6"><Spinner class="h-5 w-5" /></div>
    {:else if coverage}
      <div class="text-muted-foreground text-sm">
        {coverage.covered} of {coverage.total} active users have a second factor.
        {#if coverage.uncovered > 0}
          <span class="font-medium">{coverage.uncovered} do not.</span>
        {/if}
      </div>

      {#if !coverage.caller_covered}
        <Alert.Root>
          <TriangleAlert class="h-4 w-4" />
          <Alert.Description>
            You do not have a second factor yet. You cannot require one of others until you do, because the change would
            lock you out on your next request.
          </Alert.Description>
        </Alert.Root>
      {/if}

      <RadioGroup.Root bind:value={selected} class="gap-3">
        {#each OPTIONS as option (option.value)}
          <div class="flex items-start gap-3">
            <RadioGroup.Item value={option.value} id={`mfa-policy-${option.value}`} class="mt-1" />
            <Label for={`mfa-policy-${option.value}`} class="font-normal">
              <span class="font-medium">{option.label}</span>
              <span class="text-muted-foreground block text-xs">{option.detail}</span>
            </Label>
          </div>
        {/each}
      </RadioGroup.Root>

      <div>
        <Button
          disabled={!changed || saving}
          onclick={() => {
            // Tightening can lock people out, so it is confirmed with a count.
            // Loosening cannot, so it saves straight away.
            if (wouldBlock > 0) confirmOpen = true;
            else save();
          }}
        >
          {#if saving}<Spinner class="h-4 w-4" />{/if}
          Save policy
        </Button>
      </div>
    {/if}
  </Card.Content>
</Card.Root>

<AlertDialog.Root bind:open={confirmOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Require two-factor authentication?</AlertDialog.Title>
      <AlertDialog.Description>
        Up to {wouldBlock}
        {wouldBlock === 1 ? "user has" : "users have"} no second factor. They will be sent to enrolment on their next request
        and will not be able to use anything else, including the API, until they finish.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={saving}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={save} disabled={saving}>
        {#if saving}<Spinner class="h-4 w-4" />{/if}
        Require it
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
