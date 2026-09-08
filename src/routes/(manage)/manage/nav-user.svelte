<script lang="ts">
  import CreditCardIcon from "@lucide/svelte/icons/credit-card";
  import DotsVerticalIcon from "@lucide/svelte/icons/ellipsis-vertical";
  import LogoutIcon from "@lucide/svelte/icons/log-out";
  import NotificationIcon from "@lucide/svelte/icons/bell";
  import UserCircleIcon from "@lucide/svelte/icons/user-circle";
  import CheckIcon from "@lucide/svelte/icons/check";
  import LoaderIcon from "@lucide/svelte/icons/loader";

  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import type { UserRecordPublic } from "$lib/server/types/db";
  import { toggleMode, mode } from "mode-watcher";
  import Sun from "@lucide/svelte/icons/sun";
  import Moon from "@lucide/svelte/icons/moon";
  import clientResolver from "$lib/client/resolver.js";

  let user = $state<UserRecordPublic>(page.data.userDb);
  let nameAbbr = $derived(
    user.name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .slice(0, 2)
      .toUpperCase()
  );

  const sidebar = Sidebar.useSidebar();

  // Account dialog state
  let accountDialogOpen = $state(false);
  let myName = $state(user.name);
  let myPassword = $state("");
  let plainPassword = $state("");
  let savingName = $state(false);
  let resettingPass = $state(false);
  let nameError = $state("");
  let passwordError = $state("");
  let nameSuccess = $state(false);
  let passwordSuccess = $state(false);

  // Password validation
  let hasDigit = $derived(/\d/.test(myPassword));
  let hasLowercase = $derived(/[a-z]/.test(myPassword));
  let hasUppercase = $derived(/[A-Z]/.test(myPassword));
  let hasLetter = $derived(/[a-zA-Z]/.test(myPassword));
  let hasMinLength = $derived(myPassword.length >= 8);
  let passwordsMatch = $derived(myPassword === plainPassword && myPassword !== "");
  let isPasswordValid = $derived(
    hasDigit && hasLowercase && hasUppercase && hasLetter && hasMinLength && passwordsMatch
  );

  // Role badge styling
  let roleBadgeClass = $derived.by(() => {
    if (user.role_ids.includes("admin")) {
      return "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300";
    } else if (user.role_ids.includes("editor")) {
      return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300";
    } else if (user.role_ids.includes("member")) {
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300";
    } else {
      return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300";
    }
  });

  async function saveName() {
    savingName = true;
    nameError = "";
    nameSuccess = false;
    try {
      const response = await fetch(clientResolver(resolve, "/manage/api"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "updateUser",
          data: { updateValue: myName, updateKey: "name" }
        })
      });
      const resp = await response.json();
      if (resp.error) {
        nameError = resp.error;
      } else {
        user.name = myName;
        nameSuccess = true;
        setTimeout(() => (nameSuccess = false), 2000);
      }
    } catch {
      nameError = "Error while saving name";
    } finally {
      savingName = false;
    }
  }

  async function updatePassword() {
    resettingPass = true;
    passwordError = "";
    passwordSuccess = false;
    try {
      const response = await fetch(clientResolver(resolve, "/manage/api"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "updatePassword",
          data: { newPassword: myPassword, newPlainPassword: plainPassword }
        })
      });
      const resp = await response.json();
      if (resp.error) {
        passwordError = resp.error;
      } else {
        myPassword = "";
        plainPassword = "";
        passwordSuccess = true;
        setTimeout(() => (passwordSuccess = false), 2000);
      }
    } catch {
      passwordError = "Error while updating password";
    } finally {
      resettingPass = false;
    }
  }

  // --- Active sessions -----------------------------------------------------
  // Every device signed in as this user. Shown here rather than on a screen of
  // its own because "is somebody else using my account" is a question about
  // your account, and this dialog is already where you answer those.
  interface SessionRow {
    id: string;
    issued_at: number;
    last_seen_at: number;
    expires_at: number;
    revoked_at: number | null;
    revoked_reason: string | null;
    mfa_level: string;
    ip: string | null;
    user_agent: string | null;
  }

  let sessions = $state<SessionRow[]>([]);
  let currentSessionId = $state<string | null>(null);
  let sessionsLoading = $state(false);
  let sessionsError = $state("");
  let revoking = $state<string | null>(null);

  // Revoked and expired rows are kept in the database for a month so an incident
  // can be reconstructed, but they are noise to the person reading this list.
  let activeSessions = $derived(
    sessions.filter((s) => s.revoked_at === null && s.expires_at > Math.floor(Date.now() / 1000))
  );
  let otherSessionCount = $derived(activeSessions.filter((s) => s.id !== currentSessionId).length);

  async function callApi(action: string, data: Record<string, unknown>) {
    const response = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    const resp = await response.json();
    if (resp.error) throw new Error(resp.error);
    return resp;
  }

  async function loadSessions() {
    sessionsLoading = true;
    sessionsError = "";
    try {
      const resp = await callApi("getMySessions", {});
      sessions = resp.sessions ?? [];
      currentSessionId = resp.current_session_id ?? null;
    } catch (e) {
      sessionsError = e instanceof Error ? e.message : "Could not load your sessions";
    } finally {
      sessionsLoading = false;
    }
  }

  async function revokeSession(id: string) {
    revoking = id;
    sessionsError = "";
    try {
      await callApi("revokeMySession", { id });
      await loadSessions();
    } catch (e) {
      sessionsError = e instanceof Error ? e.message : "Could not sign that device out";
    } finally {
      revoking = null;
    }
  }

  async function revokeOtherSessions() {
    revoking = "all";
    sessionsError = "";
    try {
      await callApi("revokeMySession", { all_others: true });
      await loadSessions();
    } catch (e) {
      sessionsError = e instanceof Error ? e.message : "Could not sign the other devices out";
    } finally {
      revoking = null;
    }
  }

  const relative = (ts: number) => {
    const seconds = Math.floor(Date.now() / 1000) - ts;
    if (seconds < 90) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return `${Math.floor(seconds / 86400)} d ago`;
  };

  // A readable device name, not the raw string. The user agent is 200 characters
  // of version numbers and the useful part is "which browser, which machine".
  function describeDevice(ua: string | null): string {
    if (!ua) return "Unknown device";
    const browser = /Edg\//.test(ua)
      ? "Edge"
      : /OPR\//.test(ua)
        ? "Opera"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /Firefox\//.test(ua)
              ? "Firefox"
              : "Browser";
    const os = /Windows/.test(ua)
      ? "Windows"
      : /Macintosh|Mac OS/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad/.test(ua)
            ? "iOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
    return os ? `${browser} on ${os}` : browser;
  }

  function openAccountDialog() {
    myName = user.name;
    myPassword = "";
    plainPassword = "";
    nameError = "";
    passwordError = "";
    nameSuccess = false;
    passwordSuccess = false;
    accountDialogOpen = true;
    loadSessions();
  }
</script>

<Sidebar.Menu>
  <Sidebar.MenuItem>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Sidebar.MenuButton
            {...props}
            size="lg"
            class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <Avatar.Root class="size-8 rounded-lg grayscale">
              <Avatar.Fallback class="rounded-lg">
                {nameAbbr}
              </Avatar.Fallback>
            </Avatar.Root>
            <div class="grid flex-1 text-start text-sm leading-tight">
              <span class="truncate font-medium">{nameAbbr}</span>
              <span class="text-muted-foreground truncate text-xs">
                {user.email}
              </span>
            </div>
            <DotsVerticalIcon class="ms-auto size-4" />
          </Sidebar.MenuButton>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        class="w-(--bits-dropdown-menu-anchor-width) min-w-56 rounded-lg"
        side={sidebar.isMobile ? "bottom" : "right"}
        align="end"
        sideOffset={4}
      >
        <DropdownMenu.Label class="p-0 font-normal">
          <div class="flex items-center gap-2 px-1 py-1.5 text-start text-sm">
            <Avatar.Root class="size-8 rounded-lg">
              <Avatar.Fallback class="rounded-lg">{nameAbbr}</Avatar.Fallback>
            </Avatar.Root>
            <div class="grid flex-1 text-start text-sm leading-tight">
              <span class="truncate font-medium">{user.name}</span>
              <span class="text-muted-foreground truncate text-xs">
                {user.email}
              </span>
            </div>
          </div>
        </DropdownMenu.Label>
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Item onclick={openAccountDialog}>
            <UserCircleIcon />
            Account
          </DropdownMenu.Item>
          <DropdownMenu.Item class="relative" onclick={toggleMode}>
            <Sun class="absolute left-2  scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
            <Moon class="absolute left-2  scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
            <span class="pl-6">
              {mode.current === "light" ? "Light" : "Dark"}
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Item>
          {#snippet child({ props })}
            <form method="POST" action={clientResolver(resolve, "/account/logout")} class="w-full">
              <Button {...props} type="submit" variant="ghost" class="w-full justify-start">
                <LogoutIcon />
                Log out
              </Button>
            </form>
          {/snippet}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </Sidebar.MenuItem>
</Sidebar.Menu>

<Dialog.Root bind:open={accountDialogOpen}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title class="flex flex-col  justify-between">
        <span>Account Settings</span>
      </Dialog.Title>
      <Dialog.Description class="flex flex-col gap-2">
        <span> Manage your profile information. </span>
        <div class="flex items-center justify-between">
          <span class="text-foreground rounded-sm font-medium">
            {user.email}
          </span>
          <span class="text-foreground rounded-sm font-medium uppercase">
            {user.role_ids.join(", ")}
          </span>
        </div>
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-6 py-4">
      <!-- Name Section -->

      <form
        class="flex flex-col gap-3"
        onsubmit={(e) => {
          e.preventDefault();
          saveName();
        }}
      >
        <Label for="account-name">Name</Label>
        <div class="flex gap-2">
          <Input id="account-name" bind:value={myName} placeholder="Your name" disabled={savingName} class="flex-1" />
          <Button type="submit" disabled={savingName || !myName.trim()}>
            {#if savingName}
              <LoaderIcon class="size-4 animate-spin" />
            {:else if nameSuccess}
              <CheckIcon class="size-4" />
            {:else}
              Save
            {/if}
          </Button>
        </div>
        {#if nameError}
          <p class="text-destructive text-sm">{nameError}</p>
        {/if}
      </form>

      <hr />

      <!-- Password Section -->
      <form
        class="flex flex-col gap-3"
        onsubmit={(e) => {
          e.preventDefault();
          updatePassword();
        }}
      >
        <Label for="new-password">Change Password</Label>
        <Input
          id="new-password"
          type="password"
          bind:value={myPassword}
          placeholder="New Password"
          disabled={resettingPass}
        />
        <Input
          id="confirm-password"
          type="password"
          bind:value={plainPassword}
          placeholder="Confirm Password"
          disabled={resettingPass}
        />

        <div class="text-muted-foreground text-xs">
          <p class="mb-1 font-medium">Password requirements:</p>
          <ul class="grid grid-cols-2 gap-1">
            <li class:text-green-500={hasDigit}>
              {#if hasDigit}<CheckIcon class="inline size-3" />{/if} One digit
            </li>
            <li class:text-green-500={hasLowercase}>
              {#if hasLowercase}<CheckIcon class="inline size-3" />{/if} One lowercase
            </li>
            <li class:text-green-500={hasUppercase}>
              {#if hasUppercase}<CheckIcon class="inline size-3" />{/if} One uppercase
            </li>
            <li class:text-green-500={hasMinLength}>
              {#if hasMinLength}<CheckIcon class="inline size-3" />{/if} 8+ characters
            </li>
            <li class:text-green-500={passwordsMatch}>
              {#if passwordsMatch}<CheckIcon class="inline size-3" />{/if} Passwords match
            </li>
          </ul>
        </div>

        <Button type="submit" disabled={resettingPass || !isPasswordValid}>
          {#if resettingPass}
            <LoaderIcon class="size-4 animate-spin" />
            Updating...
          {:else if passwordSuccess}
            <CheckIcon class="size-4" />
            Updated!
          {:else}
            Update Password
          {/if}
        </Button>
        {#if passwordError}
          <p class="text-destructive text-sm">{passwordError}</p>
        {/if}
      </form>

      <!-- Active sessions -->
      <div class="flex flex-col gap-3 border-t pt-4">
        <div class="flex items-center justify-between">
          <Label>Signed in devices</Label>
          {#if otherSessionCount > 0}
            <Button variant="outline" size="sm" disabled={revoking !== null} onclick={() => revokeOtherSessions()}>
              {#if revoking === "all"}
                <LoaderIcon class="size-4 animate-spin" />
              {/if}
              Sign out {otherSessionCount} other{otherSessionCount === 1 ? "" : "s"}
            </Button>
          {/if}
        </div>

        {#if sessionsLoading}
          <p class="text-muted-foreground text-sm">Loading…</p>
        {:else if activeSessions.length === 0}
          <p class="text-muted-foreground text-sm">No active sessions.</p>
        {:else}
          <ul class="flex flex-col gap-2">
            {#each activeSessions as session (session.id)}
              <li class="flex items-start justify-between gap-2 text-sm">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="truncate font-medium">{describeDevice(session.user_agent)}</span>
                    {#if session.id === currentSessionId}
                      <span
                        class="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300"
                      >
                        This device
                      </span>
                    {/if}
                  </div>
                  <div class="text-muted-foreground text-xs">
                    {session.ip ?? "unknown IP"} · active {relative(session.last_seen_at)}
                  </div>
                </div>
                {#if session.id !== currentSessionId}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revoking !== null}
                    onclick={() => revokeSession(session.id)}
                  >
                    {#if revoking === session.id}
                      <LoaderIcon class="size-4 animate-spin" />
                    {:else}
                      Sign out
                    {/if}
                  </Button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if sessionsError}
          <p class="text-destructive text-sm">{sessionsError}</p>
        {/if}
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
