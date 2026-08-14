import { createToriumPublicClient } from "@torium-network/sdk/clients";
import {
  createToriumWalletClient,
  sendToriumTransactionOnce,
  waitForToriumTransaction,
  type ToriumTransactionPreflight,
} from "@torium-network/sdk/wallet";
import { http, type Account, type Address } from "viem";

import {
  assertToriumExampleChain,
  defaultToriumLocalnetRpcUrl,
  getToriumExampleChain,
} from "../shared/config.js";

/** Implement this boundary with the host app's native protected storage. */
export interface PlatformAccountProvider {
  getUnlockedAccount(): Promise<Account>;
}

export async function runReactNativeCompatibilityFixture(
  platformAccounts: PlatformAccountProvider,
  destination: Address,
  review: (preflight: ToriumTransactionPreflight) => Promise<boolean>
) {
  const chain = getToriumExampleChain();
  const account = await platformAccounts.getUnlockedAccount();
  const publicClient = createToriumPublicClient({
    chain,
    transport: http(defaultToriumLocalnetRpcUrl),
  });
  const walletClient = createToriumWalletClient({
    account,
    chain,
    transport: http(defaultToriumLocalnetRpcUrl),
  });

  await assertToriumExampleChain(publicClient);
  const acknowledgement = await sendToriumTransactionOnce(
    walletClient,
    publicClient,
    { account, to: destination, value: 0n },
    { authorize: review }
  );
  return waitForToriumTransaction(publicClient, { hash: acknowledgement.hash });
}
