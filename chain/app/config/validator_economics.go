package config

import (
	"time"

	cosmosmath "cosmossdk.io/math"
)

const (
	// ValidatorUnbondingTime keeps stake slashable well beyond the canonical
	// 48-hour evidence duration used by the local protocol contract.
	ValidatorUnbondingTime = 21 * 24 * time.Hour
	ValidatorMaxActive     = uint32(100)
	ValidatorMaxEntries    = uint32(7)
	ValidatorHistory       = uint32(10_000)

	MinimumValidatorSelfDelegationBaseUnits = "1000000000000000000"

	SignedBlocksWindow   = int64(100)
	DowntimeJailDuration = 10 * time.Minute
	EvidenceMaxAgeBlocks = int64(100_000)
	EvidenceMaxAge       = 48 * time.Hour
	EvidenceMaximumBytes = int64(1_048_576)
)

var (
	MinimumValidatorSelfDelegation = cosmosmath.NewIntWithDecimal(1, 18)
	MinimumValidatorCommissionRate = cosmosmath.LegacyMustNewDecFromStr("0.05")
	MaximumValidatorCommissionRate = cosmosmath.LegacyMustNewDecFromStr("0.20")
	MaximumCommissionChangeRate    = cosmosmath.LegacyMustNewDecFromStr("0.01")
	MinimumSignedPerWindow         = cosmosmath.LegacyMustNewDecFromStr("0.50")
	SlashFractionDoubleSign        = cosmosmath.LegacyMustNewDecFromStr("0.05")
	SlashFractionDowntime          = cosmosmath.LegacyMustNewDecFromStr("0.01")
	DistributionCommunityTax       = cosmosmath.LegacyMustNewDecFromStr("0.02")
)
