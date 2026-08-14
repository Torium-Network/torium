package localnet

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	cosmosmath "cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

const fixtureDomain = "torium/localnet/valueless-fixture/v1"

var (
	//go:embed fixture.json
	fixtureJSON []byte

	// ErrZeroConsensusPower identifies a validator stake that truncates to no
	// CometBFT voting power under the 18-decimal PowerReduction.
	ErrZeroConsensusPower = errors.New("validator stake yields zero consensus power")
)

// Fixture is the sole reviewed input to the generated localnet genesis.
type Fixture struct {
	SchemaVersion                           int               `json:"schema_version"`
	Warning                                 string            `json:"warning"`
	GenesisTime                             string            `json:"genesis_time"`
	CosmosChainID                           string            `json:"cosmos_chain_id"`
	EVMChainID                              uint64            `json:"evm_chain_id"`
	BaseDenom                               string            `json:"base_denom"`
	DisplayDenom                            string            `json:"display_denom"`
	Decimals                                uint32            `json:"decimals"`
	TotalSupplyBaseUnits                    string            `json:"total_supply_base_units"`
	PowerReduction                          string            `json:"power_reduction"`
	MinimumValidatorSelfDelegationBaseUnits string            `json:"minimum_validator_self_delegation_base_units"`
	Consensus                               ConsensusFixture  `json:"consensus"`
	Commission                              CommissionFixture `json:"commission"`
	Accounts                                []AccountFixture  `json:"accounts"`
}

// ConsensusFixture pins the consensus values owned by the protocol contract.
type ConsensusFixture struct {
	MaxBlockBytes             int64 `json:"max_block_bytes"`
	MaxBlockGas               int64 `json:"max_block_gas"`
	ExpectedTotalPower        int64 `json:"expected_total_power"`
	ExpectedCommitQuorumPower int64 `json:"expected_commit_quorum_power"`
}

// CommissionFixture is the ratified local validator creation envelope.
type CommissionFixture struct {
	Rate              string `json:"rate"`
	MaximumRate       string `json:"maximum_rate"`
	MaximumChangeRate string `json:"maximum_change_rate"`
}

// AccountFixture describes a disposable, deterministically derived local account.
type AccountFixture struct {
	Name                    string `json:"name"`
	Role                    string `json:"role"`
	AccountNumber           uint64 `json:"account_number"`
	DerivationContext       string `json:"derivation_context"`
	AllocationBaseUnits     string `json:"allocation_base_units"`
	SelfDelegationBaseUnits string `json:"self_delegation_base_units,omitempty"`
	ExpectedVotingPower     int64  `json:"expected_voting_power,omitempty"`
}

// LoadFixture returns a fresh copy of the embedded, reviewed fixture.
func LoadFixture() (Fixture, error) {
	var fixture Fixture
	if err := json.Unmarshal(fixtureJSON, &fixture); err != nil {
		return Fixture{}, fmt.Errorf("decode embedded localnet fixture: %w", err)
	}
	return fixture, nil
}

// ConsensusPower applies the exact SDK conversion used by staking. Stakes
// above a whole tTOR retain their remainder in the ledger but CometBFT sees
// only the integer quotient. Stakes below one tTOR are rejected for validators.
func ConsensusPower(stake cosmosmath.Int) (int64, cosmosmath.Int, error) {
	if stake.IsNegative() {
		return 0, cosmosmath.ZeroInt(), fmt.Errorf("validator stake must not be negative")
	}
	quotient := stake.Quo(sdk.DefaultPowerReduction)
	remainder := stake.Mod(sdk.DefaultPowerReduction)
	if quotient.IsZero() {
		return 0, remainder, ErrZeroConsensusPower
	}
	if !quotient.IsInt64() {
		return 0, remainder, fmt.Errorf("validator voting power exceeds int64")
	}
	return quotient.Int64(), remainder, nil
}

// ValidateFixture rejects drift from protocol v1 and supplies targeted
// diagnostics for supply or 18-decimal power failures.
func ValidateFixture(fixture Fixture) error {
	if fixture.SchemaVersion != 1 {
		return fmt.Errorf("unsupported localnet fixture schema %d", fixture.SchemaVersion)
	}
	if !strings.Contains(fixture.Warning, "VALUELESS LOCAL DEVELOPMENT") {
		return fmt.Errorf("localnet warning must identify the network as valueless local development")
	}
	if _, err := time.Parse(time.RFC3339, fixture.GenesisTime); err != nil {
		return fmt.Errorf("invalid deterministic genesis time: %w", err)
	}
	if err := toriumconfig.ValidateNetworkPair(fixture.CosmosChainID, fixture.EVMChainID); err != nil {
		return err
	}
	if fixture.CosmosChainID != toriumconfig.LocalCosmosChainID || fixture.EVMChainID != toriumconfig.LocalEVMChainID {
		return fmt.Errorf("fixture must use the canonical localnet replay domains")
	}
	if fixture.BaseDenom != toriumconfig.BaseDenom || fixture.DisplayDenom != toriumconfig.LocalDisplayDenom || fixture.Decimals != toriumconfig.Decimals {
		return fmt.Errorf("fixture native asset differs from protocol v1")
	}
	if fixture.PowerReduction != sdk.DefaultPowerReduction.String() {
		return fmt.Errorf("fixture PowerReduction %s does not match runtime %s", fixture.PowerReduction, sdk.DefaultPowerReduction)
	}
	feePolicy := toriumconfig.MustLocalFeeAndResourcePolicy()
	if fixture.Consensus.MaxBlockBytes != feePolicy.BlockMaxBytes || fixture.Consensus.MaxBlockGas != feePolicy.BlockMaxGas {
		return fmt.Errorf("fixture block limits differ from protocol v1")
	}
	if fixture.Consensus.ExpectedTotalPower != 100 || fixture.Consensus.ExpectedCommitQuorumPower != 67 {
		return fmt.Errorf("fixture authority power topology differs from the trust model")
	}

	minimumDelegation, err := parsePositiveAmount("minimum validator self-delegation", fixture.MinimumValidatorSelfDelegationBaseUnits)
	if err != nil {
		return err
	}
	if !minimumDelegation.Equal(toriumconfig.MinimumValidatorSelfDelegation) {
		return fmt.Errorf("minimum validator self-delegation must equal the protocol admission floor")
	}
	totalSupply, err := parsePositiveAmount("total supply", fixture.TotalSupplyBaseUnits)
	if err != nil {
		return err
	}
	if !totalSupply.Equal(cosmosmath.NewIntWithDecimal(1_000_000_000, int(fixture.Decimals))) {
		return fmt.Errorf("fixture total supply must equal 1 billion local tTOR")
	}

	commission, err := fixture.commissionRates()
	if err != nil {
		return err
	}
	if err := commission.Validate(); err != nil {
		return fmt.Errorf("invalid local validator commission: %w", err)
	}
	if !commission.Rate.Equal(toriumconfig.MinimumValidatorCommissionRate) ||
		!commission.MaxRate.Equal(toriumconfig.MaximumValidatorCommissionRate) ||
		!commission.MaxChangeRate.Equal(toriumconfig.MaximumCommissionChangeRate) {
		return fmt.Errorf("local validator commission differs from the protocol admission envelope")
	}

	names := make(map[string]struct{}, len(fixture.Accounts))
	accountNumbers := make(map[uint64]struct{}, len(fixture.Accounts))
	derivationContexts := make(map[string]struct{}, len(fixture.Accounts))
	allocationSum := cosmosmath.ZeroInt()
	validatorCount := 0
	developmentCount := 0
	totalPower := int64(0)
	for _, account := range fixture.Accounts {
		if strings.TrimSpace(account.Name) == "" || strings.TrimSpace(account.DerivationContext) == "" {
			return fmt.Errorf("fixture accounts require names and derivation contexts")
		}
		if _, duplicate := names[account.Name]; duplicate {
			return fmt.Errorf("duplicate fixture account name %q", account.Name)
		}
		names[account.Name] = struct{}{}
		if _, duplicate := accountNumbers[account.AccountNumber]; duplicate {
			return fmt.Errorf("duplicate fixture account number %d", account.AccountNumber)
		}
		accountNumbers[account.AccountNumber] = struct{}{}
		if _, duplicate := derivationContexts[account.DerivationContext]; duplicate {
			return fmt.Errorf("duplicate fixture derivation context %q", account.DerivationContext)
		}
		derivationContexts[account.DerivationContext] = struct{}{}

		allocation, amountErr := parsePositiveAmount("allocation for "+account.Name, account.AllocationBaseUnits)
		if amountErr != nil {
			return amountErr
		}
		allocationSum = allocationSum.Add(allocation)

		switch account.Role {
		case "development":
			developmentCount++
			if account.SelfDelegationBaseUnits != "" || account.ExpectedVotingPower != 0 {
				return fmt.Errorf("development account %s must not define validator power", account.Name)
			}
		case "validator":
			validatorCount++
			stake, stakeErr := parsePositiveAmount("self-delegation for "+account.Name, account.SelfDelegationBaseUnits)
			if stakeErr != nil {
				return stakeErr
			}
			power, remainder, powerErr := ConsensusPower(stake)
			if powerErr != nil {
				return fmt.Errorf("validator %s self-delegation %s: %w", account.Name, stake, powerErr)
			}
			if stake.LT(minimumDelegation) {
				return fmt.Errorf("validator %s self-delegation is below the selected minimum", account.Name)
			}
			if stake.GT(allocation) {
				return fmt.Errorf("validator %s self-delegation exceeds its allocation", account.Name)
			}
			if !remainder.IsZero() {
				return fmt.Errorf("validator %s self-delegation violates whole-power precision: remainder %s", account.Name, remainder)
			}
			if power != account.ExpectedVotingPower {
				return fmt.Errorf("validator %s produces power %d, expected %d", account.Name, power, account.ExpectedVotingPower)
			}
			if totalPower > math.MaxInt64-power {
				return fmt.Errorf("fixture validator power overflows int64")
			}
			totalPower += power
		default:
			return fmt.Errorf("account %s has unsupported role %q", account.Name, account.Role)
		}
	}
	if validatorCount != 4 {
		return fmt.Errorf("local authority fixture requires exactly four validators, got %d", validatorCount)
	}
	if developmentCount < 2 {
		return fmt.Errorf("localnet fixture requires prefunded developer accounts")
	}
	if totalPower != fixture.Consensus.ExpectedTotalPower {
		return fmt.Errorf("validator power sum is %d, expected %d", totalPower, fixture.Consensus.ExpectedTotalPower)
	}
	if !allocationSum.Equal(totalSupply) {
		return fmt.Errorf("allocation sum %s does not equal total supply %s", allocationSum, totalSupply)
	}

	expectedNumbers := make([]uint64, 0, len(fixture.Accounts))
	for number := range accountNumbers {
		expectedNumbers = append(expectedNumbers, number)
	}
	slices.Sort(expectedNumbers)
	for index, number := range expectedNumbers {
		if number != uint64(index) {
			return fmt.Errorf("fixture account numbers must be contiguous from zero")
		}
	}

	return nil
}

func (fixture Fixture) commissionRates() (stakingtypes.CommissionRates, error) {
	rate, err := cosmosmath.LegacyNewDecFromStr(fixture.Commission.Rate)
	if err != nil {
		return stakingtypes.CommissionRates{}, fmt.Errorf("invalid commission rate: %w", err)
	}
	maximumRate, err := cosmosmath.LegacyNewDecFromStr(fixture.Commission.MaximumRate)
	if err != nil {
		return stakingtypes.CommissionRates{}, fmt.Errorf("invalid maximum commission rate: %w", err)
	}
	maximumChangeRate, err := cosmosmath.LegacyNewDecFromStr(fixture.Commission.MaximumChangeRate)
	if err != nil {
		return stakingtypes.CommissionRates{}, fmt.Errorf("invalid maximum commission change rate: %w", err)
	}
	return stakingtypes.NewCommissionRates(rate, maximumRate, maximumChangeRate), nil
}

func parsePositiveAmount(label, value string) (cosmosmath.Int, error) {
	amount, ok := cosmosmath.NewIntFromString(value)
	if !ok || !amount.IsPositive() {
		return cosmosmath.Int{}, fmt.Errorf("%s must be a positive integer base-unit amount", label)
	}
	return amount, nil
}
