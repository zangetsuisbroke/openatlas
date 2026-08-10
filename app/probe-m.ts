import { assets } from "./ui-assets.ts";
console.log("keys:", Object.keys(assets).length, "first size:", Bun.file(assets["/index.html"]).size);
