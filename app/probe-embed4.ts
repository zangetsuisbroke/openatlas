import { assets } from "./ui-assets.ts";
for (const [k, v] of Object.entries(assets)) console.log(k, "->", Bun.file(v).size);
