//go:build toriumcensorfixture

package censorfixture

import (
	"testing"

	"cosmossdk.io/log/v2"

	abci "github.com/cometbft/cometbft/abci/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

func handlerReturning(transactions ...[]byte) sdk.PrepareProposalHandler {
	return func(_ sdk.Context, _ *abci.RequestPrepareProposal) (*abci.ResponsePrepareProposal, error) {
		return &abci.ResponsePrepareProposal{Txs: transactions}, nil
	}
}

// The fixture build must censor exactly what its switch selects, and nothing
// when the switch is unset — a fixture image left running without the switch
// must behave like a normal validator.
func TestFixtureBuildCensorsOnlyWhatTheSwitchSelects(t *testing.T) {
	if !Enabled {
		t.Fatal("the tagged build does not report a fixture build")
	}
	target := []byte{0x0a, 0xde, 0xad, 0xbe, 0xef}
	bystander := []byte{0x0a, 0x11, 0x22, 0x33, 0x44}

	t.Run("inert without the switch", func(t *testing.T) {
		t.Setenv(EnvironmentVariable, "")
		response, err := Wrap(handlerReturning(target, bystander), log.NewNopLogger())(
			sdk.Context{}, &abci.RequestPrepareProposal{},
		)
		if err != nil {
			t.Fatal(err)
		}
		if len(response.Txs) != 2 {
			t.Fatalf("an unconfigured fixture build dropped %d transactions", 2-len(response.Txs))
		}
	})

	t.Run("targeted needle drops only its match", func(t *testing.T) {
		t.Setenv(EnvironmentVariable, "hex:deadbeef")
		response, err := Wrap(handlerReturning(target, bystander), log.NewNopLogger())(
			sdk.Context{}, &abci.RequestPrepareProposal{},
		)
		if err != nil {
			t.Fatal(err)
		}
		if len(response.Txs) != 1 || string(response.Txs[0]) != string(bystander) {
			t.Fatalf("targeted censorship kept %v", response.Txs)
		}
	})

	t.Run("all drops everything", func(t *testing.T) {
		t.Setenv(EnvironmentVariable, "all")
		response, err := Wrap(handlerReturning(target, bystander), log.NewNopLogger())(
			sdk.Context{}, &abci.RequestPrepareProposal{},
		)
		if err != nil {
			t.Fatal(err)
		}
		if len(response.Txs) != 0 {
			t.Fatalf("full censorship kept %v", response.Txs)
		}
	})

	// A misconfigured switch must panic at wrap time rather than silently
	// running as a no-op and producing a false negative.
	t.Run("misconfiguration panics", func(t *testing.T) {
		t.Setenv(EnvironmentVariable, "everything")
		defer func() {
			if recover() == nil {
				t.Fatal("an invalid switch value was accepted")
			}
		}()
		Wrap(handlerReturning(target), log.NewNopLogger())
	})
}
