package config

import "fmt"

const (
	// ApplicationName is the public node binary name.
	ApplicationName = "toriumd"
	// NodeHomeName is the default local data directory.
	NodeHomeName = ".toriumd"
	// Bech32Prefix is shared by account, validator, and consensus addresses.
	Bech32Prefix = "torium"
	// HDPath uses the standard EVM coin type.
	HDPath          = "m/44'/60'/0'/0/0"
	CoinType uint32 = 60

	// LocalCosmosChainID and LocalEVMChainID are the canonical localnet IDs.
	LocalCosmosChainID        = "torium-localnet-1"
	LocalEVMChainID    uint64 = 1_414_484_556
	LocalEVMChainIDHex        = "0x544f524c"
	DevCosmosChainID          = "torium-devnet-1"
	DevEVMChainID      uint64 = 1_414_484_548
	TestCosmosChainID         = "torium-testnet-1"
	TestEVMChainID     uint64 = 1_414_484_564
	MainCosmosChainID         = "torium-1"
	MainEVMChainID     uint64 = 5_525_330

	BaseDenom                = "atorium"
	DisplayDenom             = "TOR"
	LocalDisplayDenom        = "tTOR"
	Decimals          uint32 = 18

	// NativeTORPrecompileAddress is the canonical WERC20-compatible Solidity
	// facade over the x/bank native balance. It never owns a second supply.
	NativeTORPrecompileAddress = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
)

var canonicalNetworkPairs = map[string]uint64{
	LocalCosmosChainID: LocalEVMChainID,
	DevCosmosChainID:   DevEVMChainID,
	TestCosmosChainID:  TestEVMChainID,
	MainCosmosChainID:  MainEVMChainID,
}

// ValidateEVMChainID rejects upstream example IDs and unknown replay domains.
func ValidateEVMChainID(chainID uint64) error {
	for _, expected := range canonicalNetworkPairs {
		if chainID == expected {
			return nil
		}
	}
	return fmt.Errorf("unsupported Torium EVM chain ID %d", chainID)
}

// ValidateNetworkPair prevents a Cosmos and EVM replay domain mismatch.
func ValidateNetworkPair(cosmosChainID string, evmChainID uint64) error {
	expected, ok := canonicalNetworkPairs[cosmosChainID]
	if !ok {
		return fmt.Errorf("unsupported Torium Cosmos chain ID %q", cosmosChainID)
	}
	if expected != evmChainID {
		return fmt.Errorf(
			"torium chain ID mismatch: Cosmos %q requires EVM %d, got %d",
			cosmosChainID,
			expected,
			evmChainID,
		)
	}
	return nil
}
