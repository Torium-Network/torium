// Package censorfixture provides the ONLY fault surface on this stack that can
// make a Torium proposer censor transactions, for the
// `local-proposer-censorship` resilience scenario (#119).
//
// It exists because none of the configuration-level routes work: with an
// application-side mempool, cosmos-sdk's default proposal handler forwards
// whatever CometBFT supplies, cosmos-evm refuses to start with the CometBFT
// mempool disabled, and suppressing transaction gossip does not stop other
// proposers from seeing the transactions. See chain/resilience/README.md.
//
// The fixture is gated behind the `toriumcensorfixture` build tag, so a
// release binary cannot contain a censoring proposer at all — not disabled by
// configuration, but absent from the compiled code. `Enabled` is a
// compile-time constant, and boundary_test.go asserts that the default build
// carries no censorship symbol.
package censorfixture

import (
	"encoding/hex"
	"fmt"
	"strings"
)

// EnvironmentVariable names the runtime switch. It is read by the fixture build
// only; in a release build nothing reads it.
const EnvironmentVariable = "TORIUM_CENSOR_PREPARE_PROPOSAL"

// Mode selects what a censoring proposer drops from its own proposals.
type Mode int

const (
	// ModeOff leaves proposals untouched. An unset or blank switch means off,
	// so even a fixture binary is inert unless explicitly configured.
	ModeOff Mode = iota
	// ModeAll drops every transaction from this proposer's proposals.
	ModeAll
	// ModeHexNeedle drops only transactions whose raw bytes contain a
	// hex-encoded needle, which lets a drill censor one identified transaction
	// (for example by a recipient address) and leave all other traffic alone.
	ModeHexNeedle
)

// Policy is the parsed censorship switch.
type Policy struct {
	Mode Mode
	// Needle is the lowercase hex fragment matched against each transaction's
	// hex-encoded bytes when Mode is ModeHexNeedle.
	Needle string
}

// ParsePolicy reads the switch value. An unrecognized value is an error rather
// than a silent no-op: a drill that believes it is censoring when it is not
// would produce a false negative, which is worse than a failed run.
func ParsePolicy(value string) (Policy, error) {
	trimmed := strings.TrimSpace(value)
	switch {
	case trimmed == "":
		return Policy{Mode: ModeOff}, nil
	case trimmed == "all":
		return Policy{Mode: ModeAll}, nil
	case strings.HasPrefix(trimmed, "hex:"):
		needle := strings.ToLower(strings.TrimPrefix(trimmed, "hex:"))
		if needle == "" {
			return Policy{}, fmt.Errorf("%s=hex: needs a hex fragment", EnvironmentVariable)
		}
		if _, err := hex.DecodeString(needle); err != nil {
			return Policy{}, fmt.Errorf("%s hex fragment %q is not hex: %w", EnvironmentVariable, needle, err)
		}
		return Policy{Mode: ModeHexNeedle, Needle: needle}, nil
	default:
		return Policy{}, fmt.Errorf(
			"%s must be empty, \"all\", or \"hex:<fragment>\", got %q",
			EnvironmentVariable, trimmed,
		)
	}
}

// Censors reports whether this policy drops the given raw transaction.
func (policy Policy) Censors(transaction []byte) bool {
	switch policy.Mode {
	case ModeAll:
		return true
	case ModeHexNeedle:
		return strings.Contains(hex.EncodeToString(transaction), policy.Needle)
	default:
		return false
	}
}

// Describe renders the policy for the audit log a drill reads back.
func (policy Policy) Describe() string {
	switch policy.Mode {
	case ModeAll:
		return "drop-every-transaction"
	case ModeHexNeedle:
		return "drop-transactions-containing-hex:" + policy.Needle
	default:
		return "off"
	}
}
