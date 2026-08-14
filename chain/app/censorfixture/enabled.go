//go:build toriumcensorfixture

package censorfixture

import (
	"os"

	"cosmossdk.io/log/v2"

	abci "github.com/cometbft/cometbft/abci/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

// Enabled marks a fixture build. Only chain/app's `container-censor-fixture`
// target produces one, and it is tagged `toriumd:censor-fixture` so it can
// never be confused with the release image.
const Enabled = true

// LogMessage is the exact line a drill greps for. It is deliberately stable and
// distinctive: the drill's proof that a proposer censored is this proposer's own
// audit record, not an inference from block contents.
const LogMessage = "torium-censor-fixture dropped transactions from its own proposal"

// Wrap returns a PrepareProposal handler that drops the transactions its policy
// selects from the proposal THIS node makes. It never touches blocks proposed by
// anyone else, and it never rejects a block in ProcessProposal — a censoring
// proposer omits transactions, it does not produce invalid blocks.
func Wrap(handler sdk.PrepareProposalHandler, logger log.Logger) sdk.PrepareProposalHandler {
	policy, err := ParsePolicy(os.Getenv(EnvironmentVariable))
	if err != nil {
		// A misconfigured drill must fail loudly at startup rather than run as
		// a silent no-op and report a false negative.
		panic(err)
	}
	if policy.Mode == ModeOff {
		logger.Info(
			"torium-censor-fixture build is present but inert",
			"switch", EnvironmentVariable,
			"policy", policy.Describe(),
		)
		return handler
	}
	logger.Info(
		"torium-censor-fixture build is ACTIVE; this node censors its own proposals",
		"switch", EnvironmentVariable,
		"policy", policy.Describe(),
	)
	return func(
		ctx sdk.Context, request *abci.RequestPrepareProposal,
	) (*abci.ResponsePrepareProposal, error) {
		response, handlerErr := handler(ctx, request)
		if handlerErr != nil || response == nil {
			return response, handlerErr
		}
		kept := make([][]byte, 0, len(response.Txs))
		dropped := 0
		for _, transaction := range response.Txs {
			if policy.Censors(transaction) {
				dropped++
				continue
			}
			kept = append(kept, transaction)
		}
		if dropped > 0 {
			logger.Info(
				LogMessage,
				"height", ctx.BlockHeight(),
				"policy", policy.Describe(),
				"dropped", dropped,
				"kept", len(kept),
			)
		}
		response.Txs = kept
		return response, nil
	}
}
