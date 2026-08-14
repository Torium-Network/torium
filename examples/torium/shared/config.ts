import {
  toriumLocalnet,
  withToriumRpcUrls,
  type ToriumHttpUrl,
} from "@torium-network/sdk/chains";

export const defaultToriumLocalnetRpcUrl = "http://127.0.0.1:8545" as const;
export const expectedToriumLocalnetChainId = toriumLocalnet.id;

export function getToriumExampleChain(
  rpcUrl: ToriumHttpUrl = defaultToriumLocalnetRpcUrl
) {
  return withToriumRpcUrls(toriumLocalnet, { http: [rpcUrl] });
}

export function parseToriumExampleRpcUrl(value: string | undefined) {
  const rpcUrl = value ?? defaultToriumLocalnetRpcUrl;
  const parsed = new URL(rpcUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("TORIUM_RPC_URL must use http:// or https://.");
  }
  return rpcUrl as ToriumHttpUrl;
}

export async function assertToriumExampleChain(client: {
  getChainId(): Promise<number>;
}): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== expectedToriumLocalnetChainId) {
    throw new Error(
      `Wrong chain: received ${actual}, expected Torium Localnet ${expectedToriumLocalnetChainId}.`
    );
  }
}
