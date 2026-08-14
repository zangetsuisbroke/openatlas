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

## MCP round-2 adversarial audit + fixes (2026-08-12, committed 0667eb7)
Second independent audit of the MCP layer (distrust of round-1). Found + fixed:
- **Stale `imports` links never pruned.** `scan.ts` recomputes imports for changed files only,
  but `mergeScanNodes` never deleted old `imports` links for a file whose imports changed, so
  removing an import left a phantom edge forever. Fix: `scanNow()` returns `rescanFiles[]`;
  `mergeScanNodes` drops every `imports` link whose source is a rescan file, then re-adds the
  fresh ones. Verified on a fixture: stale a→c link gone after c removed.
- **Stale `dep:`/`git:` nodes never pruned.** Node prune only covered `w:` nodes, so a dep
  dropped from package.json (or a git branch removed) stayed in the graph forever. Fix: prune
  now covers `dep:` and `git:` too. Verified `dep:react` gone after removal.
- **`tools/call` error codes + prototype-chain lookup.** `msg.params` was destructured without
  validation (null/array crashed or returned garbage); tool lookup used `TOOLS[name]` so
  `name: "constructor"` (or any prototype name) returned a fake success. Fix: params/name/
  arguments validated → `-32602`; lookup via `Object.hasOwn` → `-32601` for unknown; empty
  batch `[]` is Invalid Request `-32600`; message with no `method` is `-32600` not a
  notification. Verified: typecheck clean, bun test baseline (54/2/2), bundle clean.
- Committed `0667eb7`. Server exe + desktop portable rebuilt with all fixes.

## First-run dialog: why the packaged server sometimes "didn't start" (2026-08-12)
- Observed: freshly launched portable showed the window but no `atlas-workspace.exe` child,
  nothing listening on localhost, empty `--enable-logging` output. Manual exe run worked fine.
- Root cause: with no `prefs.json`, `main.js` first-run shows a MODAL "Choose workspace folder"
  dialog (showOpenDialogSync) and BLOCKS `startServer()` until a folder is picked. In an
  unattended/automated launch nothing clicks it → app sits there forever. By design, not a bug.
- Additional footgun: if the user CANCELS the dialog, the old code returned and fell through to
  scanning `app.getPath("home")` — the exact home-dir scan the prompt was added to prevent.
- Fix (desktop/main.js): `pickWorkspace()` now returns false on cancel; on first-run cancel the
  app shows a short notice and quits instead of silently scanning home. `node --check` clean.
- Automation can bypass the dialog via `ATLAS_WORKSPACE` env var (already supported).

## Final fresh-extraction verify (packaged portable, 15:10 build) — PASS
- Launch: `ATLAS_WORKSPACE=D:\ggggggggggg\OpenAtlas` (bypasses first-run dialog). Server child
  `atlas-workspace.exe` spawned (~247MB private, settled to 218.7MB after GC). PID 6616.
- Root returns 200 on packaged server port 50992.
- `pty-stress.mjs <port> 8` × 3 rounds → **8/8 completed, 8/8 exited cleanly each round**
  (4543ms/4529ms/4424ms); pty host `node.exe` still alive after all rounds.
- Compute monitor (30s sample, idle): TOTAL app-tree RSS ~595MB. Breakdown:
  server 81.5MB RSS / 218.7MB priv; pty host 231.2MB RSS / 363.8MB priv (post-stress, still
  under the 350MB RSS self-restart cap — no false restarts, WS/RSS 239.6MB < 350MB);
  Electron renderers 93.9 / 82.3 / 79.8 / 24.3MB; bootstrap stub 12.5MB.
- Compare vs. pre-optimization: single server alone was 671MB private at boot. App tree now
  ~595MB RSS TOTAL including server, host, and all Electron renderers.

## TERMINAL LATENCY — root cause fixed (2026-08-14)
- User: "the terminal is so slow". Measured + fixed with the autonomous loop.
- **BEFORE (clean A/B, same probe, ATLAS_WORKSPACE set)**: the knowledge-graph scan
  (`server/scan.ts` `scanNow()`) used sync `readdirSync`/`statSync` per file. A 106-file
  scan = 2277ms of **uninterrupted event-loop blocking** (`maybeYield` only fires every
  200 files, and 106 < 200), so WS pings during boot scan hit **max 2282ms with 4 spikes**
  (~2.3s of dead time). Every keystroke, output frame, and WS message froze seconds at a
  time on boot and on every stale re-scan — that is the "slow terminal".
- **FIX** (`66550bc`): `server/scan.ts` → async `node:fs/promises` (`readdir`, `stat`,
  `readFile`) so stats run on the thread pool; the once-per-scan `execSync("git …")`
  became async `execFile` (Bun lacks `node:child_process/promises`, so a small
  promisified wrapper is used). No batching/coalescing changes needed.
- **AFTER (same probe, same method)**: WS ping during boot scan **max 14ms, zero spikes**
  (compiled exe: **max 5ms**). Bonus: the scan itself got ~10x faster — 2277ms → **238ms**
  (source) / **214ms** (compiled exe) because async stat beats sync stat on this box.
- Keystroke echo after fix ≈ 15–33ms. Remaining latency is native, not app:
  * Isolated node-pty test (no app in path, sparse single-char) = **20.6ms** — the
    Windows 10 1809 ConPTY/cmd cold-input floor.
  * Burst of 10 chars through the full app echoes each in **4–5ms** — app path overhead
    is ≤5ms, input path is direct/sync (`shell.ts` `write()` → host stdin, no batching).
  * Output throughput through the app: 5000 python lines in 46ms (~5.3MB/s); `echo`
    command round-trip 19ms; WS ping 0.5ms avg.
  * Conclusion: app adds no meaningful overhead; ~20ms of the residual is native ConPTY
    cold-input latency on this OS. The visible "slow terminal" was the scan freeze.
- Supporting changes (`7b0d787`): `server/pty-host.mjs` — added `useConpty` env toggle
  (`ATLAS_PTY_USE_CONPTY=0` to force winpty) as a diagnostic knob; removed the
  temporary `[prof]` instrumentation from the host; `embedded-assets.ts` regenerated.
- Shipped: `workspace/atlas-workspace.exe` rebuilt (bun --compile) with the fix and
  verified (ping max 5ms, scan 214ms); check-clean gate passed for bundle and exe.
  NOTE: desktop portable bundle (`desktop/dist/AtlasWorkspace 0.1.0.exe`) still embeds
  the pre-fix server — rebuild via `cd desktop && npx electron-builder --win portable`
  (electron-builder run was aborted; the vite UI rebuild is separately broken with a
  pre-existing html-inline-proxy error unrelated to this fix).
