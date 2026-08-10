import index from "./app/ui/dist/index.html" with { type: "file" };
console.log("URL:", index);
console.log("size:", Bun.file(index).size);
