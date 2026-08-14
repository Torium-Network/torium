package config

import "time"

const (
	// Localnet consensus timeouts are deterministic development inputs. They
	// remain unratified for public networks until the load and fault owners run.
	LocalTimeoutPropose        = 1 * time.Second
	LocalTimeoutProposeDelta   = 500 * time.Millisecond
	LocalTimeoutPrevote        = 500 * time.Millisecond
	LocalTimeoutPrevoteDelta   = 250 * time.Millisecond
	LocalTimeoutPrecommit      = 500 * time.Millisecond
	LocalTimeoutPrecommitDelta = 250 * time.Millisecond
	LocalTimeoutCommit         = 2 * time.Second

	LocalValidatorCount    = 4
	LocalValidatorPower    = 25
	LocalTotalVotingPower  = 100
	LocalCommitQuorumPower = 67
	LocalPortOffset        = 100
)
