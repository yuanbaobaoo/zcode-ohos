---
name: ohos-dev
description: "Use when developing, building, signing, installing, or debugging a HarmonyOS app from this device session: scaffolding a new ArkTS project, choosing between devecocli and a direct hvigorw invocation, generating debug signing material, installing a HAP through ohos_hdc, reading hilog, dumping or driving the UI of an app you just built with uitest, and the sandbox traps (home paths, exec bits, writable directories) that break a naive build."
when_to_use: "Only for HarmonyOS app development loops on this device. General desktop control belongs to Computer Use."
---

# Developing HarmonyOS apps on this device

You are running inside the ZCode app on a HarmonyOS PC. Every step below was verified
on-device (2026-11-05 dogfood run); the traps are real, not hypothetical.

## Environment facts (read first)

- `~` is ambiguous: check `echo $HOME` — `/storage/Users/...` = real user home (authorized),
  `/data/storage/...` = app sandbox (user files may be unreadable until the user grants
  access; effective on restart). `env | grep ZCODE_OHOS_FULL_DISK_ACCESS` shows the
  full-disk permission snapshot (`1`/`0`) taken when this process started — it can change
  in system settings, and new sessions pick up the change. User files live under
  `/storage/Users/currentUser/...` — use full paths either way.
- New folders work under `Documents`, fail with EPERM under `Desktop`. Do not fight it.
- `/data/local/tmp` in your shell is an app-private empty view, not the device-wide one.
- Bundled `rg`/`find`/`ugrep` lack the exec bit: use `/bin/grep` and `/usr/bin/find`.
- A user-installed command-line-tools tree may ship `node` without the exec bit —
  `chmod +x <clt>/node/bin/node` once before the first build.
- The `hdc` CLI cannot work (no hdc server in this sandbox). `devecocli run` and anything
  that shells out to `hdc` report no devices. Device access goes through the `ohos_hdc`
  tool (TCP straight to hdcd) or through devecocli for build/sign only.

## Scaffold → build → sign → install → debug loop

1. **Scaffold**: `devecocli create --project-path ./Demo --app-name Demo --bundle-name com.example.demo`
   (CLT resolved via `DEVECO_CLI_CLT_PATH` / `COMMAND_LINE_TOOL_PATH`, already in your env).
2. **Build + sign**: `cd <project> && devecocli build --build-mode debug` produces
   `entry/build/default/outputs/default/entry-default-signed.hap`.
   If `devecocli build` misbehaves, invoke hvigorw directly (verified recipe):

   ```bash
   CLT=<value of DEVECO_CLI_CLT_PATH or the user CLT under /storage/Users/currentUser/local/>
   DEVECO_SDK_HOME=$CLT/sdk HVIGOR_USER_HOME=$HOME/.hvigor \
     $CLT/node/bin/node $CLT/hvigor/bin/hvigorw.js --no-daemon assembleHap \
     --mode module -p module=entry@default -p product=default -p buildMode=debug \
     --analyze=off --parallel --incremental
   ```

   Signing: `devecocli build` signs automatically with local debug material; for manual
   material use `devecocli signature` (`devecocli signature --help`). Missing-material
   errors from devecocli usually disappear after the direct hvigorw run above.
3. **Install + launch**: `ohos_hdc` action `install` with `hapPath` (and optional
   `bundleName`/`ability`), or fall back to `ohos_hdc` `shell`:
   `bm install -r -d <hap-on-device>` after `file_send`, then
   `aa start -a EntryAbility -b <bundle>`. Prefer the `install` action.
4. **Logs**: `ohos_hdc` `shell` → `hilog -x | grep <bundle>`; for a fresh start,
   `aa force-stop <bundle>` first (onCreate logs only fire on cold start).
5. **UI debugging (workspace-built apps only)**:
   - View tree: `ohos_hdc` `shell` → `uitest dumpLayout -p /data/local/tmp/layout.json`,
     then `file_recv` it. Coordinates come from this tree; `snapshot_display` gives
     the pixel screenshot (scale its 3120×2080 to your click space).
   - Input: `uitest uiInput click <x> <y>` / `uitest uiInput text '<ascii>'`
     (long non-ASCII text is unreliable — prefer short ASCII or app-side triggers).
   - Scope guard: this channel is for apps you built in this workspace. Driving
     unrelated apps or system UI is Computer Use's job, not yours.

## Known failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `hdc list targets` empty | sandbox cannot host the hdc server | use `ohos_hdc`; never debug this |
| devecocli reports no devices | it shells out to `hdc` | build/sign with devecocli, deploy with `ohos_hdc` |
| node/hvigorw "permission denied" | exec bit missing on CLT binaries | `chmod +x` the binary once |
| ArkTS compile errors on `any`/object literals | ArkTS strict mode (no implicit any, no `A & B`) | explicit types; unbound `catch {}` when unused |
| install ok but app exits at once | unsigned or wrong-mode HAP | check `entry-default-signed.hap` and `--build-mode debug` |
| clicks do nothing in your app | window focus or wrong coordinate space | re-dump layout; verify with `snapshot_display` |

## Escalation

If the loop above blocks on something environmental (EPERM where Documents works, hdcd
refusing connections), stop and report the exact error to the user instead of inventing
workarounds — most walls here are deliberate sandbox policy.
