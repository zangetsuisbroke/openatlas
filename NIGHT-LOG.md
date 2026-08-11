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

## Resource optimization (2026-08-12)
- Root cause: embed-assets.mjs embedded opencode.exe (~178MB) + node-pty (~64MB) as base64 string literals; at boot they materialize in the heap and never get freed (JSC literal pool), so atlas-workspace.exe sat at 671MB private / 22MB WS idle.
- Fix (commit 6a7aae2): stop embedding vendor blobs by default (ATLAS_EMBED_VENDOR=1 restores fat mode); desktop ships vendor as resources and passes ATLAS_NODE_PTY/ATLAS_OPENCODE_DIR to the server; server resolves node-pty via env -> on-disk -> embedded, opencode via opencodeDir().
- Bug found+fixed while verifying: pty-host.mjs did await import(ATLAS_NODE_PTY) with a backslash Windows path -> dynamic import mangles escapes -> host crashed at boot (node-pty unavailable). Fixed by normalizing to file:// URL.
- Result (lean exe, env pointing at workspace/vendor): server private 671MB -> 252MB (WS 42MB), embedded-assets.ts 231MB -> 947KB, exe 324.7MB -> 94.2MB. pty-stress 8/8 with host alive.

## PTY worker-thread leak found + bounded (2026-08-12)
- Symptom: stress 3 extra rounds doubled pty host memory (364 -> 743MB) — ~9MB leaked per force-killed terminal.
- Root cause: node-pty 1.1.0 Windows ConPTY. Each pty spawns a conout worker thread blocked in a native pipe read. On force-kill the native ConPTY handle is never closed, the pipe never EOFs, so worker.terminate() hangs and the thread+isolate leak forever. Verified in isolation (driver -> host only): +75MB/round of 8 sessions, thread count 22 -> 65. JS-side socket-destroy patches did NOT help (native handle holds the pipe) — reverted.
- Fix: pty-host.mjs memory guard — when idle (0 sessions) and RSS > 350MB, emit leak-restart and exit 0. shell.ts treats exit 0 as a graceful self-restart: does NOT count against the crash-loop cap (5) and respawns after 500ms with sessions cleaned. Verified: guard fires at ~596MB, exits 0, driver respawns cleanly.

## MCP protocol audit + fixes (2026-08-12, sub-agent verified)
- mcp.ts notifications (no id) were answered with JSON-RPC responses — now 202/no body (guard moved to top of handleMessage).
- Batch framing: single-item batch now returns [array]; all-notification batch -> 202 no body; per-item errors carry id:null.
- GET /api/mcp now 405 + Allow: POST + MCP-Protocol-Version (was 200 parse-error).
- Verify agent: all 3 fixes confirmed correct end-to-end (live probes), typecheck clean, bun test baseline (54/2/2, pre-existing node-pty ps-list fails only), bundle clean. No new bugs.
