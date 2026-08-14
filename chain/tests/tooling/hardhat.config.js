import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: {
    version: "0.8.30",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    toriumLocalnet: {
      type: "http",
      chainType: "l1",
      url: process.env.RPC_URL ?? "http://127.0.0.1:8545",
    },
  },
});
