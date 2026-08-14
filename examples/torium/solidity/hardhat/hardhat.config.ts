import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: {
    version: "0.8.30",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  paths: {
    sources: "./solidity/contracts",
    artifacts: "./solidity/hardhat/artifacts",
    cache: "./solidity/hardhat/cache",
  },
  networks: {
    toriumLocalnet: {
      type: "http",
      chainType: "l1",
      url: process.env.TORIUM_RPC_URL ?? "http://127.0.0.1:8545",
    },
  },
});
