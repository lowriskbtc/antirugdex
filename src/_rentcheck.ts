/** Sanity check: how much headroom does 05's UpdateField actually need? */
import { pack } from "@solana/spl-token-metadata";
import { PublicKey } from "@solana/web3.js";
import { TOKEN, ADDITIONAL_METADATA, POST_LOCK_METADATA } from "./config.js";
import { TYPE_SIZE, LENGTH_SIZE } from "@solana/spl-token";

const build = (extra: [string, string][]) => ({
  mint: PublicKey.default,
  name: TOKEN.name,
  symbol: TOKEN.symbol,
  uri: TOKEN.uri,
  additionalMetadata: extra,
});

const launchOnly = TYPE_SIZE + LENGTH_SIZE + pack(build(ADDITIONAL_METADATA)).length;
const withPost = TYPE_SIZE + LENGTH_SIZE + pack(build([...ADDITIONAL_METADATA, ...POST_LOCK_METADATA])).length;

console.log("metadataLen, launch pairs only :", launchOnly);
console.log("metadataLen, incl. post-lock   :", withPost);
console.log("headroom 05 requires           :", withPost - launchOnly, "bytes");
console.log(
  withPost > launchOnly
    ? "-> 01 MUST size rent from the union, or 05's UpdateField breaks rent-exemption and the whole lock tx fails."
    : "-> no extra headroom needed.",
);
