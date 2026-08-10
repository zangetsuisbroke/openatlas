import fs from "node:fs";
const css = fs.readFileSync("scripts/fonts.css", "utf8");
const blocks = css.split("@font-face").slice(1);
const seen = new Set();
let count = 0;

(async () => {
  for (const b of blocks) {
    const fam = /font-family: '([^']+)'/.exec(b)?.[1];
    const weight = /font-weight: (\d+)/.exec(b)?.[1];
    const style = /font-style: (normal|italic)/.exec(b)?.[1] ?? "normal";
    const subset = /\/\* ([a-z-]+) \*\//.exec(b)?.[1];
    const url = /url\((https:\/\/[^)]+\.woff2)\)/.exec(b)?.[1];
    if (!fam || !url || !subset) continue;
    if (subset !== "latin") continue; // only basic latin to stay lightweight
    if (style === "italic") continue;
    const key = fam + weight;
    if (seen.has(key)) continue;
    seen.add(key);
    const outName = fam.replace(/ /g, "-").toLowerCase() + "-" + weight + ".woff2";
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync("public/fonts/" + outName, buf);
    console.log(outName, buf.length);
    count++;
  }
  console.log("downloaded", count);
})();
