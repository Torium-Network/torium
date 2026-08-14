package config

import (
	clienthelpers "cosmossdk.io/client/v2/helpers"
	serverconfig "github.com/cosmos/cosmos-sdk/server/config"
	cosmosevmserverconfig "github.com/cosmos/evm/server/config"
)

func MustGetDefaultNodeHome() string {
	defaultNodeHome, err := clienthelpers.GetNodeHomeDirectory(NodeHomeName)
	if err != nil {
		panic(err)
	}
	return defaultNodeHome
}

// InitAppConfig helps to override default appConfig template and configs.
// return "", nil if no custom configuration is required for the application.
func InitAppConfig() (string, interface{}) {
	policy := MustLocalFeeAndResourcePolicy()
	// Optionally allow the chain developer to overwrite the SDK's default
	// server config.
	srvCfg := serverconfig.DefaultConfig()
	// The SDK's default minimum gas price is set to "" (empty value) inside
	// app.toml. If left empty by validators, the node will halt on startup.
	// However, the chain developer can set a default app.toml value for their
	// validators here.
	//
	// In summary:
	// - if you leave srvCfg.MinGasPrices = "", all validators MUST tweak their
	//   own app.toml config,
	// - if you set srvCfg.MinGasPrices non-empty, validators CAN tweak their
	//   own app.toml to override, or use this default value.
	//
	// Torium local development permits a zero validator minimum while the
	// protocol fee market still enforces its configured base fee.
	srvCfg.MinGasPrices = policy.ValidatorMinimumGasPrice
	srvCfg.Mempool.MaxTxs = policy.CosmosMempoolMaxTransactions

	evmCfg := cosmosevmserverconfig.DefaultEVMConfig()
	evmCfg.EVMChainID = LocalEVMChainID
	if err := ApplyEVMFeeAndMempoolPolicy(evmCfg, policy); err != nil {
		panic(err)
	}

	jsonRPCConfig := cosmosevmserverconfig.DefaultJSONRPCConfig()
	jsonRPCConfig.AllowInsecureUnlock = false
	jsonRPCConfig.BatchRequestLimit = 100
	jsonRPCConfig.GasCap = policy.JSONRPCCallGasCap

	customAppConfig := EVMAppConfig{
		Config:  *srvCfg,
		EVM:     *evmCfg,
		JSONRPC: *jsonRPCConfig,
		TLS:     *cosmosevmserverconfig.DefaultTLSConfig(),
	}

	return EVMAppTemplate, customAppConfig
}

type EVMAppConfig struct {
	serverconfig.Config

	EVM     cosmosevmserverconfig.EVMConfig
	JSONRPC cosmosevmserverconfig.JSONRPCConfig
	TLS     cosmosevmserverconfig.TLSConfig
}

const EVMAppTemplate = serverconfig.DefaultConfigTemplate + cosmosevmserverconfig.DefaultEVMConfigTemplate
