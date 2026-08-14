import { createInterface } from "node:readline/promises";

import type { ToriumTransactionPreflight } from "@torium-network/sdk/wallet";

export async function confirmToriumPreflight(
  preflight: ToriumTransactionPreflight,
  purpose: string
): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(
      [
        purpose,
        `Chain ${preflight.chainId}`,
        `${preflight.account} -> ${preflight.to ?? "contract creation"}`,
        `nonce=${preflight.requestedNonce} gas=${preflight.gasLimit}`,
        `maxFeePerGas=${preflight.maxFeePerGas} maxPriorityFeePerGas=${preflight.maxPriorityFeePerGas}`,
        'Type "yes" to sign these exact fresh values: ',
      ].join("\n")
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    readline.close();
  }
}
