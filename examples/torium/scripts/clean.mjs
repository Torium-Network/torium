import { rm } from "node:fs/promises";

for (const directory of [
  "dist",
  "solidity/hardhat/artifacts",
  "solidity/hardhat/cache",
  "solidity/foundry/out",
  "solidity/foundry/cache",
]) {
  await rm(new URL(`../${directory}`, import.meta.url), {
    force: true,
    recursive: true,
  });
}
