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

## Verification results (append)
- Real-key CDP: 1 term:input per physical key (PASS, no duplication).
- Auto-focus: terminal focused on create without clicking (PASS).
- WS echo on new build: `echo WS_ECHO_OK` → shell echoes `WS_ECHO_OK` (PASS).
- xterm 5.5.0 vs 6.0.0 both double under synthetic keypress; not the bug; no upgrade needed.
