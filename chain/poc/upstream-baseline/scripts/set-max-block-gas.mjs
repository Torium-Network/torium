import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [testnetsDirectory, maxGas] = process.argv.slice(2);

if (!testnetsDirectory || !/^[1-9][0-9]*$/u.test(maxGas ?? "")) {
  throw new Error(
    "usage: node set-max-block-gas.mjs <testnets-directory> <positive-max-gas>"
  );
}

for (let validator = 0; validator < 4; validator += 1) {
  const genesisPath = join(
    testnetsDirectory,
    `node${validator}`,
    "evmd",
    "config",
    "genesis.json"
  );
  const genesis = JSON.parse(await readFile(genesisPath, "utf8"));
  const current = genesis.consensus?.params?.block?.max_gas;
  if (current !== "-1") {
    throw new Error(
      `expected unlimited generated max_gas in ${genesisPath}, received ${current}`
    );
  }
  genesis.consensus.params.block.max_gas = maxGas;
  await writeFile(genesisPath, `${JSON.stringify(genesis, null, 2)}\n`);
}
