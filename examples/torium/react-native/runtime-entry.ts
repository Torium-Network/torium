import { toriumLocalnet } from "@torium-network/sdk/chains";
import { createToriumPublicClient } from "@torium-network/sdk/clients";
import { createToriumWalletClient } from "@torium-network/sdk/wallet";
import { custom, http, type Address, type EIP1193Provider } from "viem";

/**
 * Metro/Hermes entry that proves the SDK can consume a host-owned EIP-1193
 * signer without importing Node shims or an account-storage implementation.
 */
export function createReactNativeToriumRuntime(
  provider: EIP1193Provider,
  account: Address
) {
  return {
    publicClient: createToriumPublicClient({
      chain: toriumLocalnet,
      transport: http(),
    }),
    walletClient: createToriumWalletClient({
      account,
      chain: toriumLocalnet,
      transport: custom(provider),
    }),
  };
}
