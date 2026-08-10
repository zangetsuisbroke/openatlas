let UI_ASSETS: Record<string, string> = {};
try {
  const mod = await import("./ui-assets.ts");
  console.log("import OK, keys:", Object.keys((mod as any).assets ?? {}).length);
  UI_ASSETS = (mod as any).assets ?? {};
} catch (e) {
  console.log("import FAILED:", String(e));
}
const first = Object.values(UI_ASSETS)[0];
console.log("first url:", first, "size:", first ? Bun.file(first as string).size : "n/a");
