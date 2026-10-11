/**
 * Copies the generated IDL out of the WSL Anchor workspace into `idl/sale.json`.
 *
 *   npm run sync-idl
 *
 * This was an inline `node -e` one-liner in package.json with a quadruple-escaped UNC
 * path. It worked from some shells and silently became `C:\wsl$\...` under PowerShell —
 * an ENOENT for a path nobody wrote, on the one step whose whole job is to stop the client
 * running against a stale IDL. A file has no escaping layers, so it cannot rot that way.
 *
 * ⚠️ `cargo build-sbf` does NOT emit an IDL — only `anchor build` does. If this copies an
 * IDL older than your last instruction change, the fix is `anchor-build-devnet.sh` in WSL,
 * not this script.
 */

import fs from "fs";
import os from "node:os";
import path from "path";

// WSL home folder of the Linux user (override with WSL_USER if it differs from your Windows user).
const WSL_USER = process.env.WSL_USER ?? os.userInfo().username.toLowerCase();
const SRC = String.raw`\\wsl$\Ubuntu-24.04\home\${WSL_USER}\antirugdex\sale\target\idl\sale.json`;
const DEST = path.join(process.cwd(), "idl", "sale.json");

if (!fs.existsSync(SRC)) {
  console.error(
    `\nNo IDL at ${SRC}\n` +
      `  cargo build-sbf does not emit one. Run this inside WSL first:\n` +
      `    wsl.exe -d Ubuntu-24.04 -- bash ~/antirugdex/sale/anchor-build-devnet.sh\n`,
  );
  process.exit(1);
}

const before = fs.existsSync(DEST) ? fs.statSync(DEST).size : 0;
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.copyFileSync(SRC, DEST);
const after = fs.statSync(DEST).size;

const idl = JSON.parse(fs.readFileSync(DEST, "utf8"));
const ixs: string[] = (idl.instructions ?? []).map((i: { name: string }) => i.name);

console.log(`\nidl/sale.json updated  (${before} -> ${after} bytes)`);
console.log(`  address      : ${idl.address}`);
console.log(`  instructions : ${ixs.length} — ${ixs.join(", ")}`);
// The scaffold parses fine and describes the wrong program. Name it here too.
if (!ixs.includes("initialize_sale"))
  console.error(
    `\n  🔴 This is the Anchor template scaffold, NOT the sale program.\n` +
      `     Run anchor-build-devnet.sh in WSL and sync again.\n`,
  );
console.log("");
