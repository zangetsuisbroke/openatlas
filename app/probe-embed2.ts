let UI_ASSETS: Record<string, string> = {};
try { ({ assets: UI_ASSETS } = await import("./ui-assets.ts")); console.log("import OK keys:", Object.keys(UI_ASSETS).length); }
catch (e) { console.log("import FAILED:", String(e)); }
const url = UI_ASSETS["/index.html"];
console.log("index url:", url, "size:", url ? Bun.file(url).size : "n/a");
