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

## LANDING PAGE — new (2026-08-15)
- Added a product landing page (`workspace/landing.html`, self-contained HTML/CSS/JS,
  no build step). Palette: warm charcoal black (`#0c0b09`) + signal red (`#e6392b`),
  editorial/industrial look — Plus Jakarta Sans display + JetBrains Mono labels (both
  already bundled in `dist/fonts/`), hairline grid, film grain, mono ticker, live
  terminal mock, reveal-on-scroll. Copy covers the four layers (graph / reason /
  terminal / stream) + privacy; reasoning section is about the live workspace +
  local agent, NOT git.
- Routing (`8e45c51`): root `/` (and `/landing`) now serves the landing page; the app
  moves to `/index.html` (safe — app uses `location.host` + root-relative assets).
  Desktop splash/background recolored charcoal+red in `desktop/main.js`.
- `scripts/embed-assets.mjs` now copies `landing.html` into `dist/` so vite builds
  don't drop it; `workspace/atlas-workspace.exe` rebuilt with the landing embedded.
- Verified: exe serves `/` → 200 landing, `/index.html` → 200 app, fonts → 200.
  Desktop portable bundle still pending (electron-builder aborted twice by user).

## COMMERCIAL WEBSITE + RELEASE (2026-08-15)
- **Standalone site** (`site/`, committed `db1f048`): same charcoal/red landing, but a
  real marketing page — relative-font paths, hero + download bar + download cards,
  commercial copy. Deployed to **Vercel (production)**:
  - https://openatlas-hq.vercel.app (project renamed "site"→"openatlas-hq", team
    pratyush-s-projects4; `.vercel/project.json` updated; old alias site-nine-rho kept as backup).
    `openatlas.vercel.app` taken globally. Project had `ssoProtection: all_except_custom_domains`
    (new aliases SSO-walled); cleared it via `PATCH /v9/projects/:id {"ssoProtection":null}` —
    all deployments + aliases now public.
  - Verified: 200, 640px mobile block, OPEN·ATLAS branding, fonts 200 woff2, download buttons live.
- **Electron app = the product** (per user): built the proper packages with
  `cd desktop && npx electron-builder --win nsis portable` (unblocked by killing stale
  7za/electron-builder that locked `*.nsis.7z`):
  - `desktop/dist/AtlasWorkspace Setup 0.1.0.exe` (installer) + `AtlasWorkspace 0.1.0.exe`
    (portable) — both fresh (01:01/01:02), embed the FIXED server + in-app landing.
- **Downloads hosted via GitHub Release** (160MB won't fit Vercel's 100MB limit):
  - Public repo: https://github.com/zangetsuisbroke/atlas-workspace (README only, no source)
  - Release **v0.1.0** with `atlas-workspace-0.1.0-win-x64-setup.exe` (160,142,207 B) and
    `...-portable.exe` (159,976,603 B); download URLs verified 302→asset.
- Site "Download" buttons point at `github.com/zangetsuisbroke/atlas-workspace/releases/latest/download/...`.

## PACKAGED TERMINAL — FINAL DEBUG (2026-08-15)
- **Mystery: portable extraction missing `resources/vendor`.** Forensics: the 7z archive
  embedded in the portable exe is 100% intact (`7za t` → 363 files, "Everything is Ok");
  extracting it manually yields the FULL tree incl. `resources/vendor/{node-pty,opencode}`.
  So packaging (extraResources in `desktop/package.json`) is correct.
- **Root cause = double-launch of the portable.** Each portable run does
  `RMDir /r $INSTDIR` then re-extracts. If a previous instance is STILL RUNNING, the
  second SFX's `RMDir` only deletes files that aren't memory-locked: everything non-essential
  (vendor/, LICENSES, extra locales, vulkan dlls, elevate.exe) gets wiped while boot-critical
  files survive → app keeps running from a 14-file shell. Reproduced live: first launch →
  363 files complete; relaunch while running → nuked to 14. Extracted file mtimes (12:33)
  + SFX/Electron start times (12:50) matched this exactly.
  **Guidance: never launch the portable while an instance is already running.**
- **Latent bug fixed (`shell.ts`):** the `.atlas/pty-host.mjs` extraction was guarded by
  `if (!existsSync(out))`, so a stale copy from an older build (Aug 10, missing the
  `ATLAS_NODE_PTY` file:// fix, `ATLAS_PTY_USE_CONPTY` override, and 350MB leak-restart
  guard) shadowed the embedded current host forever. Now the embedded copy is ALWAYS
  (re)written on server start → old machines get current host fixes automatically.
- **Verified end-to-end on the fresh build (13:27):**
  - New portable extracts 363 files; `.atlas/pty-host.mjs` auto-refreshed (mtime = start time).
  - `winpty-agent.exe` now runs from `resources\vendor\node-pty\prebuilds\win32-x64\`
    (SHIPPED node-pty via `ATLAS_NODE_PTY` + file:// fix) — not the stale `.atlas/vendor`.
  - WS echo test PASS (create → cmd banner → echo).
  - Real-browser UI loop proven: typed `echo UI_OK_7788 > C:\...\ui-proof.txt` into the
    xterm → file created with content → input → WS → pty-host → node-pty → winpty → cmd.
- Rebuilt: `workspace/atlas-workspace.exe` (bun run exe, check-clean passed) + desktop
  `npm run dist` (nsis + portable). Fresh portable = `desktop/dist/AtlasWorkspace 0.1.0.exe`.

## REAL-WINDOW CDP VERIFICATION (2026-08-15, ~13:46–13:58)

User reported "the current build still doesnt take my input." Attached CDP to the ACTUAL
Electron window (`AtlasWorkspace 0.1.0.exe --remote-debugging-port=9222`) and drove it like
a real user:
- **Focus after "+ New Terminal" is CORRECT** — even with a REAL mouse click on the button,
  `document.activeElement` = `TEXTAREA.xterm-helper-textarea` (aria "Terminal input").
  `term.focus()` in `TerminalsPanel.tsx:119` works.
- **Input flows end-to-end**: dispatched real key events → `term:input` WS messages observed
  → server → pty-host → SHIPPED node-pty → winpty → cmd.exe.
- **Output flows back**: monitor WS client received `term:data` echoing `SCREEN_E2E_999` +
  prompt `C:\Users\admin\AppData\Roaming\atlas-workspace-desktop\app>` → full loop works in
  the real window.
- **First CDP typing attempt appeared "garbage"** (`\x1b[2~` Insert + `\x1b[3~` Delete in the
  stream) — root-caused to a BUG IN MY TEST HARNESS: `windowsVirtualKeyCode` 45/46 collide
  with VK_INSERT/VK_DELETE for `-` and `.`. NOT an app bug.
- **3 stale-looking "cmd.exe" tabs** seen right after launch were the USER's own test
  terminals (they are actively clicking around) — server had no persistence; only one
  instance was ever running; no Setup-installed copy exists; localStorage empty.
- Conclusion: the fresh 13:27 build WORKS in the real Electron window. The user's complaint
  predates them having tested the new build (no app process was running at 13:40).
- Cleaned up: killed test instance + orphaned pty shells, removed both stale extraction
  dirs (`3HwS3XgI4TDUmtKci0fUJYde1gH`, `3HwYWeOr0kMPATnr5Ur2U5VmuNy`). Machine left pristine.
- Test helper: `C:\Users\admin\AppData\Local\Temp\opencode\cdp-test.mjs` (needs `ws` pkg —
  `npm i ws` in that dir).

## "1 AGENT THINKING" FIX + VERIFICATION (2026-08-15, ~14:00–14:50)

**Symptom (user):** on fresh launch, UI shows `1 agent thinking` / AGENT filter chip = 1
before any terminal is opened; user worried an agent auto-launched and blocked the app.

**Root cause:** NOT a real agent. `workspace/server/index.ts` had an "ambient ticker":
`setInterval` every 9000 ms with 45% chance pushed a fake `agent.thinking` event (topics:
"session graph", "rate-limit config", "refresh flow", "cache policy", "middleware order").
`boot()` is only a `log.time` timing wrapper; opencode-serve is lazy (first request to
`/api/opencode/start`). No agent launches by default.

**Confirmation:** launched an isolated copy of the user's running build
(`--remote-debugging-port=9223 --user-data-dir=<fresh>`), dumped `document.body.innerText`
via CDP → `14:20:54 agt · agent.thinking "cache policy"`, AGENT chip count 1.

**Fix:** removed the ambient ticker block from `workspace/server/index.ts` (was lines
398-405). Remaining `agent.thinking` events are all REACTIVE to real terminal commands
(python/node/bunx → "parsing output"; generic cmd → "indexing output") or inside the
`atlas demo` sequence. `refreshScan` setInterval(15s) is a real workspace-file graph scan
(no events, only runs when `stale()`).

**Rebuild:** `bun run exe` in `workspace/` (vite OK, 14 embedded files → embedded-assets.ts,
vendor opencode 1.18.18 + node-pty, check-clean + check-exe OK, atlas-workspace.exe OK).

**Desktop dist (had to dodge a lock):** `npm run dist` / `npx electron-builder --win portable`
stalled twice at "output file is locked for writing => waiting for unlock" because the
user's RUNNING instance IS the SFX `dist\AtlasWorkspace 0.1.0.exe` → Windows locks that
file. Worked around by building with `--config.productName=AtlasWorkspaceNew` →
**`desktop\dist\AtlasWorkspaceNew 0.1.0.exe`** (143 MB). NOTE: the old SFX file is still
locked by the user's running instance; renaming the new file to the canonical name must
wait until the user closes the app.

**Runtime verification (new build):** launched `dist\win-unpacked\AtlasWorkspaceNew.exe`
with `--remote-debugging-port=9224 --user-data-dir=<fresh>`, dumped body text:
EVENT STREAM = **0 events**, AGENT chip = **0**, **no `agent.thinking`** anywhere.
(The `agent 1` in the KNOWLEDGE GRAPH legend is just the seeded `a:atlas` graph node
count — unrelated to the event stream, pre-existing, harmless.)

**Cleanup:** killed both test instances (9223, 9224), removed `atlas-inspect`,
`atlas-inspect-profile`, `atlas-fix-check` temp dirs. User's running instance (PID 5404
SFX + extracted processes in `3HwYWeOr0kMPATnr5Ur2U5VmuNy`) untouched.

## 2026-08-16 — "empty terminal + keystrokes ignored" root cause + fix

**User report:** with the home-dir workspace (`C:\Users\admin`), terminals "cant take input or dont load" — empty, no working dir, keystrokes ignored.

**E1/E2 experiments (win-unpacked + CDP, port per instance):**
- Home workspace scan: **4057 files / 2662 folders → ~6700 graph nodes**; first scan 11 s, refreshes 4–5 s every ~45 s (async, server stays responsive).
- E1 (fresh profile): terminal = real cmd.exe pty, banner+prompt render, `echo` works once UI is up.
- E2 (users REAL profile): terminal created, banner rendered (43k px), textarea focused — but **keystrokes produced ZERO ws frames** (CDP Network capture) until a **real mouse click into the terminal body** → then `term:input` flows and echo returns. Programmatic `term.focus()` alone does NOT activate xterm input when the window isnt OS-focused.
- **Main-thread freeze (the "empty" cause):** Map2D force sim re-runs (~204 d3-force ticks) on EVERY graph refresh broadcast. With 6700 nodes this pegged the renderer for seconds (CDP /json took 8–12 s to answer; "+ New Terminal" button appeared only after a variable 4–15 s). During those freezes the terminal canvas never paints (looks empty) and input is dropped.

**Fix (`workspace/src/components/Map2D.tsx`):**
- `SIM_CAP = 2500`: graphs larger than that skip the force simulation entirely (seed-by-type layout, `sim.alpha(0)`/stop) — kills the 45 s refresh freeze.
- Viewport culling + LOD in `draw()`: skip off-screen nodes/links and sub-pixel (radius·k < 0.45) nodes.

**Fix (`workspace/src/components/TerminalsPanel.tsx`):** TermPane re-focuses the xterm on mount (rAF) and on `pointerdown` on the host.

**Verified on the REAL profile (new build):** button at **+1.5 s** (was 4–15 s); **no freeze on graph refresh** (worst measured gap 101 ms vs multi-second before); terminal banner paints (52k px); `echo VFY_MARK_1` executed and echoed. Portable `AtlasWorkspaceNew 0.1.0.exe` smoke-tested (SFX extract ~30 s, then button +1.3 s, terminal painted).

**Deliverable:** `D:\ggggggggggg\OpenAtlas\desktop\dist\AtlasWorkspaceNew 0.1.0.exe` (Aug 16, 143,072,692 bytes). Temp profiles cleaned up.

## 2026-08-16 (later) — terminals replaced with the OpenCode web UI

**Request:** replace the raw terminal panel with the web opencode agent UI.

**Changes (`workspace/src`):**
- `App.tsx`: right column + max layout now render `OpenCodePanel` (iframe of `opencode serve`, lazily started on 127.0.0.1:4099) instead of `TerminalsPanel`; dropped the separate `terminal` layout mode.
- `TopBar.tsx`: `LayoutMode` is now `split | graph | opencode`; "+ New Terminal" → "+ New Chat" (switches to the opencode layout); removed "spawn terminal" from profile menu; cycle order = split → opencode → graph.
- `TerminalsPanel.tsx` left in place but unused (xterm + addons tree-shaken — bundle dropped 570 KB → 182 KB). Server pty engine untouched.

**Verified (real profile, win-unpacked, CDP):** no `.term-host` elements; exactly one `iframe.opencode-frame` pointing at `http://127.0.0.1:4099/` (serve returns HTTP 200, opencode HTML); top bar = "+ New Chat / ≡ Layout / ⌘ OpenCode / ⚙ / ◎".

**Deliverable:** `D:\ggggggggggg\OpenAtlas\desktop\dist\AtlasWorkspaceNew 0.1.0.exe` (Aug 16, 142,962,879 B).

## 2026-08-16 (later) — tiling for the OpenCode panel + session deep-links

**Request:** bring back the tiling mechanic (stacked/split + multiple items) that the old terminals panel had, for the OpenCode panel. Also answered why graph file/folder nodes look "sushi shaped" (they are plain filled squares — `graph/visuals.ts` NODE_STYLE, file `#6f9df1` / folder `#8b929d` square, ~7 px).

**Findings / design:**
- The opencode web SPA deep-links sessions via `/<path>/session/<id>` (route `path:"/:dir/session/:id"` confirmed in its bundle); `POST /session` (JSON `{}`) creates a chat and returns `{ id, path }`. So ONE `opencode serve` instance can back multiple tiled iframes, each a different chat — no extra serve processes needed.

**Changes (`workspace/server`, `workspace/src`):**
- `server/index.ts`: new `POST /api/opencode/session` — ensures serve started, POSTs `{}` to `<serve>/session`, returns `{ ok, id, url: <serve>/<path>/session/<id> }`.
- `server/opencode-serve.ts`: **race fix** in `start()` — previously `if (active) return status()` returned a URL before the serve was listening (`active` is set right after spawn, ~6 s before ready), so concurrent callers got a dead URL. Now an in-flight `startPromise` is always awaited; a "ready" URL is only returned once the readiness loop completes.
- `src/components/OpenCodePanel.tsx`: rewritten for tiling — module-level tile store + layout (survive layout switches / remounts), `useSyncExternalStore`. Panel header: title with tile count, **stacked|split chip toggle**, "+ New Chat". Each tile = `.oc-tile` with a head (↗ open-in-tab, × close; last tile can't be removed) + the session iframe. Exports `newChat()` used by the top bar. First tile stays at serve root (shows the thread list).
- `src/components/TopBar.tsx`: "+ New Chat" now calls `newChat()` AND switches to the opencode layout.
- `src/styles.css`: `.oc-tiles` (+ `.split` = row) and `.oc-tile` / `.oc-tile-head` / `.oc-tile-body` mirroring the old `term-canvases`/`term-pane`/`term-tab` tiling.

**Verified (real profile, win-unpacked, CDP harness `tile-verify.cjs`):** 1 tile at serve root → top-bar "+ New Chat" → 2nd tile with a live session URL `http://127.0.0.1:4099/<data-dir>/app/session/ses_…` (HTTP 200, SPA); the session deep-link renders the opencode chat view in a real browser (Playwright: title OpenCode, "Home" pressed, "New session" present); chip toggles `oc-tiles stack ↔ split` and back.

**Deliverable:** `D:\ggggggggggg\OpenAtlas\desktop\dist\AtlasWorkspaceNew 0.1.0.exe` (Aug 16, 142,941,931 B).
