package localnet

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/cometbft/cometbft/types"
	"github.com/ethereum/go-ethereum/common"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"

	cosmosmath "cosmossdk.io/math"
	"github.com/cosmos/cosmos-sdk/client"
	clienttx "github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/cosmos/cosmos-sdk/codec"
	ed25519 "github.com/cosmos/cosmos-sdk/crypto/keys/ed25519"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	signingtypes "github.com/cosmos/cosmos-sdk/types/tx/signing"
	authsigning "github.com/cosmos/cosmos-sdk/x/auth/signing"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	genutiltypes "github.com/cosmos/cosmos-sdk/x/genutil/types"
	govtypes "github.com/cosmos/cosmos-sdk/x/gov/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	ethsecp256k1 "github.com/cosmos/evm/crypto/ethsecp256k1"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

const (
	genesisFileName          = "genesis.json"
	manifestFileName         = "manifest.json"
	checksumFileName         = "SHA256SUMS"
	genesisValidatorGasLimit = uint64(250_000)
)

// Generator contains the exact application codecs and module defaults used by
// toriumd. It avoids hand-maintained copies of module genesis JSON.
type Generator struct {
	Codec        codec.Codec
	TxConfig     client.TxConfig
	BasicModules module.BasicManager
}

// Artifact is the complete public localnet genesis artifact. It intentionally
// contains no signing material; issue #95 will write disposable runtime files
// only into ignored local state directories.
type Artifact struct {
	Genesis   []byte
	Manifest  []byte
	Checksums []byte
}

type accountMaterial struct {
	fixture      AccountFixture
	account      sdk.AccAddress
	operator     sdk.ValAddress
	accountKey   *ethsecp256k1.PrivKey
	consensusKey *ed25519.PrivKey
	allocation   cosmosmath.Int
	delegation   cosmosmath.Int
}

type publicManifest struct {
	GeneratedBy     string                `json:"generated_by"`
	Source          string                `json:"source"`
	DoNotEdit       bool                  `json:"do_not_edit"`
	SchemaVersion   int                   `json:"schema_version"`
	Warning         string                `json:"warning"`
	FixturePolicy   string                `json:"fixture_policy"`
	ParameterPolicy string                `json:"parameter_policy"`
	GenesisSHA256   string                `json:"genesis_sha256"`
	GenesisTime     string                `json:"genesis_time"`
	CosmosChainID   string                `json:"cosmos_chain_id"`
	EVMChainID      uint64                `json:"evm_chain_id"`
	NativeAsset     publicNativeAsset     `json:"native_asset"`
	Consensus       publicConsensus       `json:"consensus"`
	ValidatorPolicy publicValidatorPolicy `json:"validator_policy"`
	Validators      []publicValidator     `json:"validators"`
	Development     []publicAccount       `json:"development_accounts"`
}

type canonicalGenesis struct {
	GeneratedBy string `json:"generated_by"`
	Source      string `json:"source"`
	DoNotEdit   bool   `json:"do_not_edit"`
	genutiltypes.AppGenesis
}

type publicNativeAsset struct {
	BaseDenom                    string `json:"base_denom"`
	DisplayDenom                 string `json:"display_denom"`
	Decimals                     uint32 `json:"decimals"`
	TotalSupplyBaseUnits         string `json:"total_supply_base_units"`
	PowerReduction               string `json:"power_reduction"`
	CanonicalLedger              string `json:"canonical_ledger"`
	IssuanceModel                string `json:"issuance_model"`
	PostGenesisNativeMintAllowed bool   `json:"post_genesis_native_mint_allowed"`
	SolidityPrecompileAddress    string `json:"solidity_precompile_address"`
	DuplicateWrappedSupply       bool   `json:"duplicate_wrapped_supply"`
	ValueStatus                  string `json:"value_status"`
}

type publicConsensus struct {
	MaxBlockBytes     int64 `json:"max_block_bytes"`
	MaxBlockGas       int64 `json:"max_block_gas"`
	ValidatorCount    int   `json:"validator_count"`
	TotalVotingPower  int64 `json:"total_voting_power"`
	CommitQuorumPower int64 `json:"commit_quorum_power"`
}

type publicValidatorPolicy struct {
	PowerReduction                 string `json:"power_reduction"`
	MinimumSelfDelegationBaseUnits string `json:"minimum_self_delegation_base_units"`
	MaximumActiveValidators        uint32 `json:"maximum_active_validators"`
	MaximumEntries                 uint32 `json:"maximum_entries"`
	HistoricalEntries              uint32 `json:"historical_entries"`
	UnbondingTimeSeconds           int64  `json:"unbonding_time_seconds"`
	MinimumCommissionRate          string `json:"minimum_commission_rate"`
	MaximumCommissionRate          string `json:"maximum_commission_rate"`
	MaximumCommissionChangeRate    string `json:"maximum_commission_change_rate"`
	SignedBlocksWindow             int64  `json:"signed_blocks_window"`
	MinimumSignedPerWindow         string `json:"minimum_signed_per_window"`
	DowntimeJailDurationSeconds    int64  `json:"downtime_jail_duration_seconds"`
	SlashFractionDowntime          string `json:"slash_fraction_downtime"`
	SlashFractionDoubleSign        string `json:"slash_fraction_double_sign"`
	DistributionCommunityTax       string `json:"distribution_community_tax"`
	RewardFunding                  string `json:"reward_funding"`
	EvidenceMaxAgeBlocks           int64  `json:"evidence_max_age_blocks"`
	EvidenceMaxAgeDurationSeconds  int64  `json:"evidence_max_age_duration_seconds"`
	EvidenceMaxBytesPerBlock       int64  `json:"evidence_max_bytes_per_block"`
}

type publicAccount struct {
	Name                string `json:"name"`
	AccountNumber       uint64 `json:"account_number"`
	Bech32Address       string `json:"bech32_address"`
	EVMAddress          string `json:"evm_address"`
	AllocationBaseUnits string `json:"allocation_base_units"`
}

type publicValidator struct {
	publicAccount
	OperatorAddress                    string `json:"operator_address"`
	ConsensusAddress                   string `json:"consensus_address"`
	ConsensusPublicKeyType             string `json:"consensus_public_key_type"`
	ConsensusPublicKeyBase64           string `json:"consensus_public_key_base64"`
	SelfDelegationBaseUnits            string `json:"self_delegation_base_units"`
	GenesisTransactionFeeBaseUnits     string `json:"genesis_transaction_fee_base_units"`
	PostGenesisAccountBalanceBaseUnits string `json:"post_genesis_account_balance_base_units"`
	VotingPower                        int64  `json:"voting_power"`
}

// Generate creates byte-stable genesis, public manifest, and checksums from
// the embedded fixture and the node's real module defaults.
func (generator Generator) Generate() (Artifact, error) {
	fixture, err := LoadFixture()
	if err != nil {
		return Artifact{}, err
	}
	return generator.GenerateFixture(fixture)
}

// GenerateFixture exists so invariant tests can prove invalid allocations are
// rejected before a genesis artifact is produced.
func (generator Generator) GenerateFixture(fixture Fixture) (Artifact, error) {
	if generator.Codec == nil || generator.TxConfig == nil || generator.BasicModules == nil {
		return Artifact{}, fmt.Errorf("localnet generator requires application codec, tx config, and module defaults")
	}
	if err := ValidateFixture(fixture); err != nil {
		return Artifact{}, err
	}

	materials, err := deriveAccountMaterials(fixture)
	if err != nil {
		return Artifact{}, err
	}
	appState, err := generator.buildAppState(fixture, materials)
	if err != nil {
		return Artifact{}, err
	}
	appStateJSON, err := json.Marshal(appState)
	if err != nil {
		return Artifact{}, fmt.Errorf("marshal application genesis state: %w", err)
	}

	genesisTime, err := time.Parse(time.RFC3339, fixture.GenesisTime)
	if err != nil {
		return Artifact{}, fmt.Errorf("parse deterministic genesis time: %w", err)
	}
	consensusParams := types.DefaultConsensusParams()
	consensusParams.Block.MaxBytes = fixture.Consensus.MaxBlockBytes
	consensusParams.Block.MaxGas = fixture.Consensus.MaxBlockGas
	consensusParams.Evidence.MaxAgeNumBlocks = toriumconfig.EvidenceMaxAgeBlocks
	consensusParams.Evidence.MaxAgeDuration = toriumconfig.EvidenceMaxAge
	consensusParams.Evidence.MaxBytes = toriumconfig.EvidenceMaximumBytes
	consensusParams.Authority = types.AuthorityParams{
		Authority: authtypes.NewModuleAddress(govtypes.ModuleName).String(),
	}
	genesis := genutiltypes.AppGenesis{
		AppName:       toriumconfig.ApplicationName,
		AppVersion:    "protocol-v1",
		GenesisTime:   genesisTime,
		ChainID:       fixture.CosmosChainID,
		InitialHeight: 1,
		AppHash:       nil,
		AppState:      appStateJSON,
		Consensus: &genutiltypes.ConsensusGenesis{
			Validators: []types.GenesisValidator{},
			Params:     consensusParams,
		},
	}
	if err := genesis.ValidateAndComplete(); err != nil {
		return Artifact{}, fmt.Errorf("validate top-level genesis: %w", err)
	}
	genesisJSON, err := marshalCanonical(canonicalGenesis{
		GeneratedBy: "go run ./cmd/torium-genesis",
		Source:      "chain/app/localnet/fixture.json plus toriumd module defaults",
		DoNotEdit:   true,
		AppGenesis:  genesis,
	})
	if err != nil {
		return Artifact{}, fmt.Errorf("marshal canonical genesis: %w", err)
	}
	genesisDigest := sha256.Sum256(genesisJSON)

	manifest := buildPublicManifest(fixture, materials, hex.EncodeToString(genesisDigest[:]))
	manifestJSON, err := marshalCanonical(manifest)
	if err != nil {
		return Artifact{}, fmt.Errorf("marshal public genesis manifest: %w", err)
	}
	manifestDigest := sha256.Sum256(manifestJSON)
	checksums := []byte(fmt.Sprintf(
		"# DO NOT EDIT — generated by go run ./cmd/torium-genesis\n%s  %s\n%s  %s\n",
		hex.EncodeToString(genesisDigest[:]), genesisFileName,
		hex.EncodeToString(manifestDigest[:]), manifestFileName,
	))

	return Artifact{Genesis: genesisJSON, Manifest: manifestJSON, Checksums: checksums}, nil
}

func (generator Generator) buildAppState(fixture Fixture, materials []accountMaterial) (map[string]json.RawMessage, error) {
	appState := generator.BasicModules.DefaultGenesis(generator.Codec)
	// Some runtime AppModuleBasic implementations expose a nil genesis value
	// while the keeper-free CLI manager omits the key entirely. Normalize both
	// surfaces to the same JSON so generation never depends on which manager
	// supplied the defaults.
	for moduleName, moduleGenesis := range appState {
		if len(moduleGenesis) == 0 || string(moduleGenesis) == "null" {
			delete(appState, moduleName)
		}
	}

	var authGenesis authtypes.GenesisState
	if err := generator.Codec.UnmarshalJSON(appState[authtypes.ModuleName], &authGenesis); err != nil {
		return nil, fmt.Errorf("decode default auth genesis: %w", err)
	}
	accounts := make(authtypes.GenesisAccounts, 0, len(materials))
	for _, material := range materials {
		accounts = append(accounts, authtypes.NewBaseAccount(
			material.account,
			material.accountKey.PubKey(),
			material.fixture.AccountNumber,
			0,
		))
	}
	packedAccounts, err := authtypes.PackAccounts(accounts)
	if err != nil {
		return nil, fmt.Errorf("pack localnet genesis accounts: %w", err)
	}
	authGenesis.Accounts = packedAccounts
	appState[authtypes.ModuleName] = generator.Codec.MustMarshalJSON(&authGenesis)

	var bankGenesis banktypes.GenesisState
	if err := generator.Codec.UnmarshalJSON(appState[banktypes.ModuleName], &bankGenesis); err != nil {
		return nil, fmt.Errorf("decode default bank genesis: %w", err)
	}
	bankGenesis.Balances = make([]banktypes.Balance, 0, len(materials))
	totalSupply := cosmosmath.ZeroInt()
	for _, material := range materials {
		coins := sdk.NewCoins(sdk.NewCoin(fixture.BaseDenom, material.allocation))
		bankGenesis.Balances = append(bankGenesis.Balances, banktypes.Balance{
			Address: material.account.String(),
			Coins:   coins,
		})
		totalSupply = totalSupply.Add(material.allocation)
	}
	bankGenesis.Supply = sdk.NewCoins(sdk.NewCoin(fixture.BaseDenom, totalSupply))
	appState[banktypes.ModuleName] = generator.Codec.MustMarshalJSON(&bankGenesis)

	minimumDelegation, err := parsePositiveAmount("minimum validator self-delegation", fixture.MinimumValidatorSelfDelegationBaseUnits)
	if err != nil {
		return nil, err
	}
	commission, err := fixture.commissionRates()
	if err != nil {
		return nil, err
	}
	genesisTransactions := make([]sdk.Tx, 0, 4)
	for _, material := range materials {
		if material.fixture.Role != "validator" {
			continue
		}
		message, messageErr := stakingtypes.NewMsgCreateValidator(
			material.operator.String(),
			material.consensusKey.PubKey(),
			sdk.NewCoin(fixture.BaseDenom, material.delegation),
			stakingtypes.NewDescription(material.fixture.Name, "", "", "", "Valueless Torium local development validator"),
			commission,
			minimumDelegation,
		)
		if messageErr != nil {
			return nil, fmt.Errorf("create genesis validator message for %s: %w", material.fixture.Name, messageErr)
		}
		transaction, transactionErr := generator.signGenesisTransaction(fixture, material, message)
		if transactionErr != nil {
			return nil, transactionErr
		}
		genesisTransactions = append(genesisTransactions, transaction)
	}
	genutilGenesis := genutiltypes.NewGenesisStateFromTx(generator.TxConfig.TxJSONEncoder(), genesisTransactions)
	appState[genutiltypes.ModuleName] = generator.Codec.MustMarshalJSON(genutilGenesis)

	if err := generator.BasicModules.ValidateGenesis(generator.Codec, generator.TxConfig, appState); err != nil {
		return nil, fmt.Errorf("validate module genesis: %w", err)
	}
	return appState, nil
}

func (generator Generator) signGenesisTransaction(
	fixture Fixture,
	material accountMaterial,
	message sdk.Msg,
) (sdk.Tx, error) {
	builder := generator.TxConfig.NewTxBuilder()
	if err := builder.SetMsgs(message); err != nil {
		return nil, fmt.Errorf("set genesis message for %s: %w", material.fixture.Name, err)
	}
	builder.SetMemo("valueless-localnet/" + material.fixture.Name)
	builder.SetGasLimit(genesisValidatorGasLimit)
	builder.SetFeeAmount(sdk.NewCoins(sdk.NewCoin(fixture.BaseDenom, genesisValidatorFeeAmount())))

	placeholder := signingtypes.SignatureV2{
		PubKey: material.accountKey.PubKey(),
		Data: &signingtypes.SingleSignatureData{
			SignMode:  signingtypes.SignMode_SIGN_MODE_DIRECT,
			Signature: nil,
		},
		Sequence: 0,
	}
	if err := builder.SetSignatures(placeholder); err != nil {
		return nil, fmt.Errorf("set genesis signer metadata for %s: %w", material.fixture.Name, err)
	}
	signerData := authsigning.SignerData{
		Address: material.account.String(),
		ChainID: fixture.CosmosChainID,
		// Cosmos SDK intentionally verifies every height-zero genesis
		// transaction with account number zero, independent of the account's
		// stored post-genesis number.
		AccountNumber: 0,
		Sequence:      0,
		PubKey:        material.accountKey.PubKey(),
	}
	signature, err := clienttx.SignWithPrivKey(
		context.Background(),
		signingtypes.SignMode_SIGN_MODE_DIRECT,
		signerData,
		builder,
		material.accountKey,
		generator.TxConfig,
		0,
	)
	if err != nil {
		return nil, fmt.Errorf("sign genesis transaction for %s: %w", material.fixture.Name, err)
	}
	if err := builder.SetSignatures(signature); err != nil {
		return nil, fmt.Errorf("attach genesis signature for %s: %w", material.fixture.Name, err)
	}
	return builder.GetTx(), nil
}

func deriveAccountMaterials(fixture Fixture) ([]accountMaterial, error) {
	materials := make([]accountMaterial, 0, len(fixture.Accounts))
	addresses := make(map[string]string, len(fixture.Accounts))
	consensusAddresses := make(map[string]string, len(fixture.Accounts))
	for _, account := range fixture.Accounts {
		accountKey, err := deriveAccountKey(account.DerivationContext)
		if err != nil {
			return nil, fmt.Errorf("derive account fixture %s: %w", account.Name, err)
		}
		accountAddress := sdk.AccAddress(accountKey.PubKey().Address())
		if prior, duplicate := addresses[accountAddress.String()]; duplicate {
			return nil, fmt.Errorf("fixture accounts %s and %s derive the same address", prior, account.Name)
		}
		addresses[accountAddress.String()] = account.Name
		allocation, err := parsePositiveAmount("allocation for "+account.Name, account.AllocationBaseUnits)
		if err != nil {
			return nil, err
		}

		material := accountMaterial{
			fixture:    account,
			account:    accountAddress,
			operator:   sdk.ValAddress(accountAddress),
			accountKey: accountKey,
			allocation: allocation,
			delegation: cosmosmath.ZeroInt(),
		}
		if account.Role == "validator" {
			consensusKey := deriveConsensusKey(account.DerivationContext)
			consensusAddress := sdk.ConsAddress(consensusKey.PubKey().Address()).String()
			if prior, duplicate := consensusAddresses[consensusAddress]; duplicate {
				return nil, fmt.Errorf("fixture validators %s and %s derive the same consensus address", prior, account.Name)
			}
			consensusAddresses[consensusAddress] = account.Name
			delegation, delegationErr := parsePositiveAmount("self-delegation for "+account.Name, account.SelfDelegationBaseUnits)
			if delegationErr != nil {
				return nil, delegationErr
			}
			material.consensusKey = consensusKey
			material.delegation = delegation
		}
		materials = append(materials, material)
	}
	sort.Slice(materials, func(i, j int) bool {
		return materials[i].fixture.AccountNumber < materials[j].fixture.AccountNumber
	})
	return materials, nil
}

func deriveAccountKey(context string) (*ethsecp256k1.PrivKey, error) {
	digest := sha256.Sum256([]byte(fixtureDomain + "/account/" + context))
	if _, err := ethcrypto.ToECDSA(digest[:]); err != nil {
		return nil, fmt.Errorf("invalid deterministic secp256k1 scalar: %w", err)
	}
	keyBytes := make([]byte, len(digest))
	copy(keyBytes, digest[:])
	return &ethsecp256k1.PrivKey{Key: keyBytes}, nil
}

func deriveConsensusKey(context string) *ed25519.PrivKey {
	return ed25519.GenPrivKeyFromSecret([]byte(fixtureDomain + "/consensus/" + context))
}

func genesisValidatorFeeAmount() cosmosmath.Int {
	policy := toriumconfig.MustLocalFeeAndResourcePolicy()
	return cosmosmath.NewIntFromUint64(policy.MinimumBaseFeeBaseUnitsPerGas).
		MulRaw(int64(genesisValidatorGasLimit))
}

func buildPublicManifest(fixture Fixture, materials []accountMaterial, genesisDigest string) publicManifest {
	manifest := publicManifest{
		GeneratedBy:     "go run ./cmd/torium-genesis",
		Source:          "chain/app/localnet/fixture.json plus toriumd module defaults",
		DoNotEdit:       true,
		SchemaVersion:   1,
		Warning:         fixture.Warning,
		FixturePolicy:   "publicly reproducible and disposable local fixtures; never reuse on any public or valuable network",
		ParameterPolicy: "validator staking, distribution, slashing, and evidence values are explicit local protocol parameters; public activation remains separately gated",
		GenesisSHA256:   genesisDigest,
		GenesisTime:     fixture.GenesisTime,
		CosmosChainID:   fixture.CosmosChainID,
		EVMChainID:      fixture.EVMChainID,
		NativeAsset: publicNativeAsset{
			BaseDenom:                    fixture.BaseDenom,
			DisplayDenom:                 fixture.DisplayDenom,
			Decimals:                     fixture.Decimals,
			TotalSupplyBaseUnits:         fixture.TotalSupplyBaseUnits,
			PowerReduction:               fixture.PowerReduction,
			CanonicalLedger:              "Cosmos bank balance exposed directly to the EVM and native Solidity facade",
			IssuanceModel:                "genesis-capped-non-inflationary",
			PostGenesisNativeMintAllowed: false,
			SolidityPrecompileAddress:    toriumconfig.NativeTORPrecompileAddress,
			DuplicateWrappedSupply:       false,
			ValueStatus:                  "valueless-local-development-only",
		},
		Consensus: publicConsensus{
			MaxBlockBytes:     fixture.Consensus.MaxBlockBytes,
			MaxBlockGas:       fixture.Consensus.MaxBlockGas,
			ValidatorCount:    4,
			TotalVotingPower:  fixture.Consensus.ExpectedTotalPower,
			CommitQuorumPower: fixture.Consensus.ExpectedCommitQuorumPower,
		},
		ValidatorPolicy: publicValidatorPolicy{
			PowerReduction:                 sdk.DefaultPowerReduction.String(),
			MinimumSelfDelegationBaseUnits: toriumconfig.MinimumValidatorSelfDelegation.String(),
			MaximumActiveValidators:        toriumconfig.ValidatorMaxActive,
			MaximumEntries:                 toriumconfig.ValidatorMaxEntries,
			HistoricalEntries:              toriumconfig.ValidatorHistory,
			UnbondingTimeSeconds:           int64(toriumconfig.ValidatorUnbondingTime.Seconds()),
			MinimumCommissionRate:          toriumconfig.MinimumValidatorCommissionRate.String(),
			MaximumCommissionRate:          toriumconfig.MaximumValidatorCommissionRate.String(),
			MaximumCommissionChangeRate:    toriumconfig.MaximumCommissionChangeRate.String(),
			SignedBlocksWindow:             toriumconfig.SignedBlocksWindow,
			MinimumSignedPerWindow:         toriumconfig.MinimumSignedPerWindow.String(),
			DowntimeJailDurationSeconds:    int64(toriumconfig.DowntimeJailDuration.Seconds()),
			SlashFractionDowntime:          toriumconfig.SlashFractionDowntime.String(),
			SlashFractionDoubleSign:        toriumconfig.SlashFractionDoubleSign.String(),
			DistributionCommunityTax:       toriumconfig.DistributionCommunityTax.String(),
			RewardFunding:                  "transaction fees and existing bank balances only; no native mint",
			EvidenceMaxAgeBlocks:           toriumconfig.EvidenceMaxAgeBlocks,
			EvidenceMaxAgeDurationSeconds:  int64(toriumconfig.EvidenceMaxAge.Seconds()),
			EvidenceMaxBytesPerBlock:       toriumconfig.EvidenceMaximumBytes,
		},
		Validators:  make([]publicValidator, 0, 4),
		Development: make([]publicAccount, 0, len(materials)-4),
	}
	for _, material := range materials {
		genesisFee := genesisValidatorFeeAmount()
		account := publicAccount{
			Name:                material.fixture.Name,
			AccountNumber:       material.fixture.AccountNumber,
			Bech32Address:       material.account.String(),
			EVMAddress:          common.BytesToAddress(material.account).Hex(),
			AllocationBaseUnits: material.allocation.String(),
		}
		if material.fixture.Role == "development" {
			manifest.Development = append(manifest.Development, account)
			continue
		}
		manifest.Validators = append(manifest.Validators, publicValidator{
			publicAccount:                      account,
			OperatorAddress:                    material.operator.String(),
			ConsensusAddress:                   sdk.ConsAddress(material.consensusKey.PubKey().Address()).String(),
			ConsensusPublicKeyType:             ed25519.KeyType,
			ConsensusPublicKeyBase64:           base64.StdEncoding.EncodeToString(material.consensusKey.PubKey().Bytes()),
			SelfDelegationBaseUnits:            material.delegation.String(),
			GenesisTransactionFeeBaseUnits:     genesisFee.String(),
			PostGenesisAccountBalanceBaseUnits: material.allocation.Sub(material.delegation).Sub(genesisFee).String(),
			VotingPower:                        material.fixture.ExpectedVotingPower,
		})
	}
	return manifest
}

func marshalCanonical(value any) ([]byte, error) {
	contents, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(contents, '\n'), nil
}
