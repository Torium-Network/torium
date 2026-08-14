import { readFile } from "node:fs/promises";

import { createToriumPublicClient } from "@torium-network/sdk/clients";
import {
  createToriumWalletClient,
  sendToriumTransactionOnce,
  waitForToriumTransaction,
} from "@torium-network/sdk/wallet";
import { encodeFunctionData, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { confirmToriumPreflight } from "../../node/confirm.js";
import {
  assertToriumExampleChain,
  getToriumExampleChain,
  parseToriumExampleRpcUrl,
} from "../../shared/config.js";

const rpcUrl = parseToriumExampleRpcUrl(process.env.TORIUM_RPC_URL);
const signerKey = requireLocalSignerKey(process.env.TORIUM_EXAMPLE_SIGNER_KEY);
const artifact = JSON.parse(
  await readFile(
    new URL(
      "./artifacts/solidity/contracts/Counter.sol/Counter.json",
      import.meta.url
    ),
    "utf8"
  )
) as { abi: Abi; bytecode: Hex };
const account = privateKeyToAccount(signerKey);
const chain = getToriumExampleChain(rpcUrl);
const transport = http(rpcUrl);
const publicClient = createToriumPublicClient({ chain, transport });
const walletClient = createToriumWalletClient({ account, chain, transport });

await assertToriumExampleChain(publicClient);
const deploymentAcknowledgement = await sendToriumTransactionOnce(
  walletClient,
  publicClient,
  { account, data: artifact.bytecode },
  {
    authorize: (preflight) =>
      confirmToriumPreflight(preflight, "Deploy Counter."),
  }
);
const deployment = await waitForToriumTransaction(publicClient, {
  hash: deploymentAcknowledgement.hash,
});
if (deployment.status !== "committed" || !deployment.receipt.contractAddress) {
  throw new Error("Deployment returned no address.");
}
const contractAddress = deployment.receipt.contractAddress;

const callData = encodeFunctionData({
  abi: artifact.abi,
  functionName: "setNumber",
  args: [42n],
});
const writeAcknowledgement = await sendToriumTransactionOnce(
  walletClient,
  publicClient,
  { account, to: contractAddress, data: callData },
  {
    authorize: (preflight) =>
      confirmToriumPreflight(preflight, "Set Counter.number to 42."),
  }
);
const write = await waitForToriumTransaction(publicClient, {
  hash: writeAcknowledgement.hash,
});
if (write.status !== "committed") {
  throw new Error(`Counter write did not commit: ${write.status}.`);
}
const number = await publicClient.readContract({
  abi: artifact.abi,
  address: contractAddress,
  functionName: "number",
});
if (number !== 42n) {
  throw new Error(`Counter returned ${String(number)}, expected 42.`);
}
console.log(
  JSON.stringify({ contract: contractAddress, number: String(number) }, null, 2)
);

function requireLocalSignerKey(value: string | undefined): Hex {
  if (!value || !/^0x[0-9a-f]{64}$/iu.test(value)) {
    throw new Error(
      "TORIUM_EXAMPLE_SIGNER_KEY must be a 32-byte 0x key for a disposable localnet account."
    );
  }
  return value as Hex;
}
