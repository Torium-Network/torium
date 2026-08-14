//go:build !toriumcensorfixture

package censorfixture

import (
	"cosmossdk.io/log/v2"

	sdk "github.com/cosmos/cosmos-sdk/types"
)

// Enabled is a compile-time constant. In every build that is not explicitly
// tagged `toriumcensorfixture` — which includes every release build, the
// container image, and `make build` — the censoring code below is the identity
// function, and the code that could drop a transaction is not compiled in at
// all.
const Enabled = false

// Wrap returns the handler unchanged. A release binary has no censorship path.
func Wrap(handler sdk.PrepareProposalHandler, _ log.Logger) sdk.PrepareProposalHandler {
	return handler
}
