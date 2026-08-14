import { defineConfig } from "hardhat/config";

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";

export default defineConfig({
  solidity: {
    version: "0.8.30",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    cosmosEvm: {
      type: "http",
      chainType: "l1",
      url: rpcUrl,
    },
  },
});
