// Checks the built manifest before it's uploaded. Owlbear won't load an extension whose
// description is over 128 characters, so users would be locked out of it.
// Usage: node scripts/check-manifest.mjs
import { readFileSync } from "node:fs";

const MAX_DESCRIPTION = 128;
const path = "dist/manifest.json";
const { name, version, description = "" } = JSON.parse(readFileSync(path, "utf8"));
const length = [...description].length;

if (length > MAX_DESCRIPTION) {
  console.error(`${path}: description is ${length} characters, Owlbear allows ${MAX_DESCRIPTION}. Shorten it in public/manifest.json.`);
  process.exit(1);
}
console.log(`${path}: ${name} ${version}, description ${length}/${MAX_DESCRIPTION}`);
