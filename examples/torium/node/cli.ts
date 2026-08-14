import { createToriumPublicClient } from "@torium-network/sdk/clients";
import {
  createToriumWalletClient,
  sendToriumTransactionOnce,
  waitForToriumTransaction,
} from "@torium-network/sdk/wallet";
import {
  formatToriumAmount,
  normalizeToriumEvmAddress,
  normalizeToriumHash,
} from "@torium-network/sdk/utils";
import { http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { confirmToriumPreflight } from "./confirm.js";
import {
  assertToriumExampleChain,
  getToriumExampleChain,
  parseToriumExampleRpcUrl,
} from "../shared/config.js";

const rpcUrl = parseToriumExampleRpcUrl(process.env.TORIUM_RPC_URL);
const chain = getToriumExampleChain(rpcUrl);
const publicClient = createToriumPublicClient({
  chain,
  transport: http(rpcUrl),
});
const [command = "status", argument, amount = "0.000001"] =
  process.argv.slice(2);

await assertToriumExampleChain(publicClient);

switch (command) {
  case "status": {
    const status = await publicClient.getToriumNetworkStatus({
      requireReady: true,
    });
    console.log(
      JSON.stringify(
        {
          network: status.environment,
          chainId: status.observedChainId,
          blockNumber: status.blockNumber.toString(),
          clientVersion: status.clientVersion,
          listening: status.listening,
          peers: status.peerCount.toString(),
        },
        null,
        2
      )
    );
    break;
  }
  case "balance": {
    const address = requireAddress(argument, "Usage: pnpm node balance 0x...");
    const balance = await publicClient.getBalance({ address });
    console.log(`${address}: ${formatToriumAmount(balance)} tTOR`);
    break;
  }
  case "transfer": {
    const to = requireAddress(
      argument,
      "Usage: pnpm node transfer 0x... [amount]"
    );
    const signerKey = requireLocalSignerKey(
      process.env.TORIUM_EXAMPLE_SIGNER_KEY
    );
    const account = privateKeyToAccount(signerKey);
    const walletClient = createToriumWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });
    const acknowledgement = await sendToriumTransactionOnce(
      walletClient,
      publicClient,
      { account, to, value: parseEther(amount) },
      {
        authorize: (preflight) =>
          confirmToriumPreflight(
            preflight,
            `Transfer ${amount} tTOR; maximum cost ${formatToriumAmount(preflight.maximumCost)} tTOR.`
          ),
      }
    );
    console.log(`RPC acknowledged ${acknowledgement.hash}`);
    const result = await waitForToriumTransaction(publicClient, {
      hash: acknowledgement.hash,
    });
    console.log(JSON.stringify(result, bigintJson, 2));
    break;
  }
  case "receipt": {
    if (!argument) throw new Error("Usage: pnpm node receipt 0x...");
    const result = await waitForToriumTransaction(publicClient, {
      hash: normalizeToriumHash(argument),
    });
    console.log(JSON.stringify(result, bigintJson, 2));
    break;
  }
  default:
    throw new Error(
      "Commands: status, balance <address>, transfer <address> [amount], receipt <hash>"
    );
}

function requireAddress(value: string | undefined, usage: string): Address {
  if (!value) throw new Error(usage);
  return normalizeToriumEvmAddress(value);
}

function requireLocalSignerKey(value: string | undefined): Hex {
  if (!value || !/^0x[0-9a-f]{64}$/iu.test(value)) {
    throw new Error(
      "TORIUM_EXAMPLE_SIGNER_KEY must be a 32-byte 0x key for a disposable localnet account."
    );
  }
  return value as Hex;
}

function bigintJson(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}
