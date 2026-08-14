package config

import (
	"time"

	cosmosmath "cosmossdk.io/math"
)

const (
	// Local governance deliberately uses short periods so a complete proposal
	// lifecycle can be rehearsed without weakening any future public network.
	// Public activation requires a fresh genesis and security review under #127.
	LocalGovernanceMaxDepositPeriod      = 30 * time.Second
	LocalGovernanceVotingPeriod          = 20 * time.Second
	LocalGovernanceExpeditedVotingPeriod = 10 * time.Second

	LocalGovernanceMinDepositBaseUnits          = "10000000000000000000"
	LocalGovernanceExpeditedMinDepositBaseUnits = "50000000000000000000"
	LocalGovernanceQuorum                       = "0.667000000000000000"
	LocalGovernanceThreshold                    = "0.500000000000000000"
	LocalGovernanceExpeditedThreshold           = "0.667000000000000000"
	LocalGovernanceVetoThreshold                = "0.334000000000000000"
	LocalGovernanceMinInitialDepositRatio       = "1.000000000000000000"
	LocalGovernanceProposalCancelRatio          = "0.500000000000000000"
	LocalGovernanceMinDepositRatio              = "1.000000000000000000"
)

var (
	LocalGovernanceMinDeposit          = cosmosmath.NewIntWithDecimal(10, 18)
	LocalGovernanceExpeditedMinDeposit = cosmosmath.NewIntWithDecimal(50, 18)
)
