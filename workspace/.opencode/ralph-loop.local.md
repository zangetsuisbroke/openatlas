---
active: true
iteration: 0
maxIterations: 100
---

Fix/complete the Atlas Workspace (OpenAtlas) to a shippable exe by midnight. Full task list A→H:
A. Logging module (done, wired into server/shell/opencode-serve).
B. MCP graph-context: scan.ts, mcp.ts, opencode-config.ts, skill (code written, needs build+test).
C. Performance pass on bottlenecks.
D. Multi-agent code audits.
E. PDF stress-test agent.
F. Log triage + fix errors.
G. Privacy: scan-exe gate + fresh clean dist-package (no personal data, user just signs in).
H. Rebuild exe, bare-dir smoke, pw2 regression, copy to dist-package, report.
Deliverable: D:\ggggggggggg\OpenAtlas\dist-package\atlas-workspace.exe. Stale instances on 4819/4099 must be killed before tests. Skip tsc (embedded-assets.ts 237MB). Verif: pw2.mjs 11-step at C:\Users\admin\AppData\Local\Temp\opencode\atlas-ui-test\pw2.mjs.
