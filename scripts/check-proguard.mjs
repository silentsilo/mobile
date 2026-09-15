// Rust reaches Kotlin by name: plugins registered by class name and classes
// looked up over JNI. R8 renames or removes whatever no rule keeps, and a
// release build then fails at runtime only, on the feature that needed the
// class. A security key class missing from these rules got that far once.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = path.join(root, "src-tauri", "src");
const rules = readFileSync(path.join(root, "src-tauri", "gen", "android", "app", "proguard-rules.pro"), "utf8");

const named = new Set();
for (const file of readdirSync(sources).filter((f) => f.endsWith(".rs"))) {
  const text = readFileSync(path.join(sources, file), "utf8");
  for (const m of text.matchAll(/find_class\("com\/silentsilo\/mobile\/(\w+)"\)/g)) named.add(m[1]);
  for (const m of text.matchAll(/register_android_plugin\(\s*"com\.silentsilo\.mobile",\s*"(\w+)"/g)) named.add(m[1]);
}
// Kotlin's entry point into Rust, whose external functions JNI resolves by name.
named.add("Native");

const missing = [...named].filter((name) => !rules.includes(`-keep class com.silentsilo.mobile.${name} `));
if (missing.length) {
  console.error(`proguard-rules.pro does not keep classes Rust calls by name: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`proguard-rules.pro keeps all ${named.size} classes Rust calls by name.`);
