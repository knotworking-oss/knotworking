// Writes the package.json for the production API image: just the runtime
// externals from tsup.config.ts, pinned to the versions installed in this repo.
import { readFileSync } from "node:fs";

const externals = ["@electric-sql/pglite", "postgres", "nodemailer", "pdfkit"];
const dependencies = Object.fromEntries(
  externals.map((name) => {
    const pkg = new URL(`../node_modules/${name}/package.json`, import.meta.url);
    return [name, JSON.parse(readFileSync(pkg, "utf8")).version];
  }),
);
process.stdout.write(
  JSON.stringify({ name: "knotworking-api", private: true, type: "module", dependencies }, null, 2),
);
