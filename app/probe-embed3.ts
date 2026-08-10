import { assets as UI_ASSETS } from "./ui-assets.ts";
console.log("static import keys:", Object.keys(UI_ASSETS).length);
const url = UI_ASSETS["/index.html"];
console.log("index url:", url, "size:", url ? Bun.file(url).size : "n/a");
