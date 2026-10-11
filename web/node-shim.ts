/**
 * Browser shims for the Node globals `@solana/web3.js` and `@solana/spl-token` assume.
 *
 * esbuild `--inject:`s this into the bundle. Without it the build SUCCEEDS and the page
 * throws `ReferenceError: Buffer is not defined` at runtime on the first RPC call — a
 * failure that a passing build says nothing about, which is why the web grader is verified
 * by loading it in a real browser rather than by the bundler exiting 0.
 *
 * `buffer@6` is already in the tree as a transitive dependency of the Solana packages.
 */
import { Buffer } from "buffer";

// Some dependencies test for `global` rather than `globalThis`.
const globalShim = globalThis;

export { Buffer, globalShim as global };
