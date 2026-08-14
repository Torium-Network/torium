import { createToriumPublicClient } from "@torium-network/sdk/clients";
import {
  createToriumWalletClient,
  sendToriumTransactionOnce,
  waitForToriumTransaction,
} from "@torium-network/sdk/wallet";
import { custom, http, type Address, type EIP1193Provider } from "viem";

import {
  assertToriumExampleChain,
  defaultToriumLocalnetRpcUrl,
  getToriumExampleChain,
} from "../shared/config.js";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const chain = getToriumExampleChain();
const publicClient = createToriumPublicClient({
  chain,
  transport: http(defaultToriumLocalnetRpcUrl),
});
const output = requireElement("output");
const connectButton = requireButton("connect");
const transferButton = requireButton("transfer");
let connectedAddress: Address | undefined;

connectButton.addEventListener("click", () => void run(connect));
transferButton.addEventListener("click", () => void run(transferToSelf));

async function run(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    output.textContent =
      error instanceof Error ? error.message : "Unknown error.";
  }
}

async function connect() {
  const provider = requireProvider();
  await assertToriumExampleChain(publicClient);
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as Address[];
  const [account] = accounts;
  if (!account) throw new Error("The wallet returned no account.");

  const walletChainId = (await provider.request({
    method: "eth_chainId",
  })) as string;
  if (Number.parseInt(walletChainId, 16) !== chain.id) {
    throw new Error(
      `Wallet is on ${walletChainId}; switch it to ${chain.name}.`
    );
  }
  connectedAddress = account;
  transferButton.disabled = false;
  const balance = await publicClient.getBalance({ address: account });
  output.textContent = `${account} connected with ${balance} atorum.`;
}

async function transferToSelf() {
  const provider = requireProvider();
  const account = connectedAddress;
  if (!account) throw new Error("Connect the wallet first.");
  const walletClient = createToriumWalletClient({
    account,
    chain,
    transport: custom(provider),
  });
  const acknowledgement = await sendToriumTransactionOnce(
    walletClient,
    publicClient,
    { account, to: account, value: 0n },
    {
      authorize(preflight) {
        return window.confirm(
          `Review Torium Localnet transaction ${preflight.account} → ${preflight.to}; maximum cost ${preflight.maximumCost} atorum. Continue?`
        );
      },
    }
  );
  output.textContent = `Acknowledged ${acknowledgement.hash}; waiting for commit…`;
  const result = await waitForToriumTransaction(publicClient, {
    hash: acknowledgement.hash,
  });
  output.textContent = `${result.status}: ${result.hash}`;
}

function requireProvider(): EIP1193Provider {
  if (!window.ethereum) throw new Error("No injected EIP-1193 wallet found.");
  return window.ethereum;
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}.`);
  return element;
}

function requireButton(id: string): HTMLButtonElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLButtonElement))
    throw new Error(`#${id} is not a button.`);
  return element;
}
