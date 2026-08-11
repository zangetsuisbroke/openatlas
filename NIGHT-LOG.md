# Night Hardening Log — Atlas Workspace

Started: 2026-08-10 ~23:55
Mode: autonomous (ralph-loop), full-app hardening
Guardrails: no destructive ops; commit per-fix with clear messages; if stuck, commit + best judgment

## Session context (as of start)
- Fixed: pty host silent-exit-on-stdin-EOF (keep-alive timer + diagnostics in `server/pty-host.mjs`)
- Fixed: respawn race + backoff + always-log exit code in `server/shell.ts`
- Verified: 8/8 stress × 3 rounds on fresh-extraction portable, host stays alive
- Baseline committed: `40b058a`

## Open question / in-flight
- User: "the terminal doesn't accept user input". RESOLVED below.

## Changes (append as they land)
- **[TERMINAL INPUT] Root-caused.** Real-keystroke CDP tests in the live Electron app
  (`--remote-debugging-port=9333`) proved the input pipeline is correct:
  * One real physical key (CDP `Input.dispatchKeyEvent` keyDown **with** text, i.e.
    keydown→beforeinput→input, exactly what a keyboard produces) → **exactly one**
    `term:input` message. No duplication.
  * The apparent "duplication" (2–3× per key) was an automation artifact:
    - `rawKeyDown` without text → Chromium synthesizes input events AND the keydown
      path fires → 3×.
    - browser-act `keys` → fires `keypress` without `keydown` → xterm's keypress +
      input paths both fire → 2×.
  * Isolated xterm 5.5.0 AND 6.0.0 both double-emit for those synthetic paths;
    not an app bug, not fixed by upgrading xterm (tested 6.0.0 + addon-fit 0.11.0).
- **[TERMINAL INPUT] Root cause = focus, fixed.** After creating a terminal nothing had
  keyboard focus (activeElement=BODY), so keystrokes went nowhere. Added `term.focus()`
  in the TermPane mount effect (`workspace/src/components/TerminalsPanel.tsx`) so a fresh
  terminal steals focus immediately. VERIFIED in a real browser: create → activeElement is
  `xterm-helper-textarea`, and `echo` round-trips through the new build's server (WS test PASS).
- **[SCAN PERF] First-run workspace = home dir.** Desktop defaulted workspace to
  `app.getPath("home")` on fresh installs → slow boot scan of the whole home tree + noisy
  4000-file graph. Added a first-run "Choose workspace folder to scan" prompt in
  `desktop/main.js` (uses the existing pickWorkspace dialog; only when no saved prefs).
- **[SCAN PERF] Removed double-stat.** `server/scan.ts` stat'd every file twice per scan
  (walk + mtime pass). Walk now records mtimes once; mtime/cached-refresh logic unchanged.
  Scan still completes: 33 files, 5 folders, 41 imports ~2.5s on OpenAtlas workspace.

## Verification results (append)
- Real-key CDP: 1 term:input per physical key (PASS, no duplication).
- Auto-focus: terminal focused on create without clicking (PASS).
- WS echo on new build: `echo WS_ECHO_OK` → shell echoes `WS_ECHO_OK` (PASS).
- xterm 5.5.0 vs 6.0.0 both double under synthetic keypress; not the bug; no upgrade needed.

## Build + fresh-extraction verify (packaged portable, FOCUS FIX included)
- Rebuilt server exe (`npm run exe`) and desktop portable (`npm run dist`) with the
  term.focus() fix + new bundle. Build chain now proven reproducible. (2 transient
  electron-builder failures were file-lock + orphaned builder children — killed orphans,
  rebuilt clean. Portable rebuilt 02:50.)
- Fresh-extraction verify on the SHIPPED portable (CDP 9333, workspace=OpenAtlas):
  * server extracted + host node.exe spawned and STAYED alive;
  * root returns 200 on the packaged server port;
  * `pty-stress.mjs <port> 8` × 3 rounds → **8/8 completed, 8/8 exited cleanly each round**;
  * host node.exe still alive after all rounds.
- **Auto-focus verified in shipped build**: create terminal → activeElement is
  `xterm-helper-textarea` immediately (no click).
- **Real-OS-keystroke ground truth (SendKeys → real key events, not CDP)**:
  typed `HELLO123` into a fresh terminal → WS spy saw the shell echo `HELLO123` exactly
  ONCE and the cmd error line once → **no doubling for real users**.
- The 2× seen earlier via CDP `Input.dispatchKeyEvent` WITH `text` is a Chromium
  injection artifact (synthetic text commit hits both xterm beforeinput + input paths).
  Confirmed again empirically on the new build; real keyboard path is 1:1. No frontend
  change warranted (agenda 1c: N/A — duplication is not real).
- [MCP] Fixed `workspace/server/mcp.ts`:
  * negative `limit` could pass through `Math.min(...)` and make `.slice(0, negative)`
    silently drop results → clamped `Math.max(1, …)`;
  * unknown methods with no `id` (notifications like `notifications/progress`) got a
    response, violating JSON-RPC → now return null (no body) when `msg.id === undefined`.
    `refresh()` in snapshot tool is safe (guarded by `stale()` + `scanning` flag).
  Committed `44559bc`.
- NOTE: `atlas-workspace.exe` (packaged Bun server) observed at ~750MB RSS — flag for the
  compute-monitor pass.
