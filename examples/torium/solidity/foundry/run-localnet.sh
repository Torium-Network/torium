#!/bin/sh
set -eu

rpc_url=${TORIUM_RPC_URL:-http://127.0.0.1:8545}
expected_chain_id=1414484556

case "${TORIUM_EXAMPLE_SIGNER_KEY:-}" in
  0x????????????????????????????????????????????????????????????????) ;;
  *)
    echo "TORIUM_EXAMPLE_SIGNER_KEY must be a 32-byte 0x key for a disposable localnet account." >&2
    exit 1
    ;;
esac

actual_chain_id=$(cast chain-id --rpc-url "$rpc_url")
if [ "$actual_chain_id" != "$expected_chain_id" ]; then
  echo "Wrong chain: received $actual_chain_id, expected Torium Localnet $expected_chain_id." >&2
  exit 1
fi

forge build
deployment=$(forge create Counter.sol:Counter \
  --rpc-url "$rpc_url" \
  --private-key "$TORIUM_EXAMPLE_SIGNER_KEY" \
  --broadcast \
  --json)
contract_address=$(printf '%s' "$deployment" | jq -er '.deployedTo')

cast send "$contract_address" "setNumber(uint256)" 42 \
  --rpc-url "$rpc_url" \
  --private-key "$TORIUM_EXAMPLE_SIGNER_KEY"
number=$(cast call "$contract_address" "number()(uint256)" --rpc-url "$rpc_url")
number_decimal=$(cast to-dec "$number")
if [ "$number_decimal" != "42" ]; then
  echo "Counter returned $number_decimal, expected 42." >&2
  exit 1
fi

printf '{"contract":"%s","number":"%s"}\n' "$contract_address" "$number_decimal"
