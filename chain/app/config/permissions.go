package config

import (
	"maps"
	"sort"

	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	distrtypes "github.com/cosmos/cosmos-sdk/x/distribution/types"
	govtypes "github.com/cosmos/cosmos-sdk/x/gov/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	cosmosevmutils "github.com/cosmos/evm/utils"
	erc20types "github.com/cosmos/evm/x/erc20/types"
	feemarkettypes "github.com/cosmos/evm/x/feemarket/types"
	vmtypes "github.com/cosmos/evm/x/vm/types"
	corevm "github.com/ethereum/go-ethereum/core/vm"
)

// CustomPrecompileAddresses is the complete protocol-v1 custom precompile set.
var CustomPrecompileAddresses = []string{
	vmtypes.P256PrecompileAddress,
	vmtypes.Bech32PrecompileAddress,
	vmtypes.StakingPrecompileAddress,
	vmtypes.DistributionPrecompileAddress,
	vmtypes.BankPrecompileAddress,
	vmtypes.GovPrecompileAddress,
	vmtypes.SlashingPrecompileAddress,
}

// BlockedAddresses returns all the app's blocked account addresses.
//
// Note, this includes:
//   - module accounts
//   - Ethereum's native precompiled smart contracts
//   - Cosmos EVM' available static precompiled contracts
func BlockedAddresses() map[string]bool {
	blockedAddrs := make(map[string]bool)

	maccPerms := GetMaccPerms()
	accs := make([]string, 0, len(maccPerms))
	for acc := range maccPerms {
		accs = append(accs, acc)
	}
	sort.Strings(accs)

	for _, acc := range accs {
		blockedAddrs[authtypes.NewModuleAddress(acc).String()] = true
	}

	blockedPrecompilesHex := append([]string(nil), CustomPrecompileAddresses...)
	for _, addr := range corevm.PrecompiledAddressesPrague {
		blockedPrecompilesHex = append(blockedPrecompilesHex, addr.Hex())
	}

	for _, precompile := range blockedPrecompilesHex {
		blockedAddrs[cosmosevmutils.Bech32StringFromHexAddress(precompile)] = true
	}

	return blockedAddrs
}

// module account permissions
var maccPerms = map[string][]string{
	authtypes.FeeCollectorName:     nil,
	distrtypes.ModuleName:          nil,
	stakingtypes.BondedPoolName:    {authtypes.Burner, authtypes.Staking},
	stakingtypes.NotBondedPoolName: {authtypes.Burner, authtypes.Staking},
	govtypes.ModuleName:            {authtypes.Burner},

	// Cosmos EVM modules
	vmtypes.ModuleName:        {authtypes.Minter, authtypes.Burner},
	feemarkettypes.ModuleName: nil,
	erc20types.ModuleName:     {authtypes.Minter, authtypes.Burner},
}

// GetMaccPerms returns a copy of the module account permissions
func GetMaccPerms() map[string][]string {
	return maps.Clone(maccPerms)
}
