//go:build !toriumcensorfixture

package censorfixture

import (
	"os"
	"reflect"
	"testing"

	"cosmossdk.io/log/v2"

	abci "github.com/cometbft/cometbft/abci/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

// This file is compiled ONLY in the default build. It is the in-package proof
// that a release binary cannot censor: Enabled is false, Wrap is the identity
// function, and setting the runtime switch changes nothing. The complementary
// repository-level proof (that no release artifact passes the build tag) lives
// in chain/scripts/check-boundaries.mjs, and the compiled-artifact proof — that
// the release image does not contain the fixture's log string while the fixture
// image does — is produced by the #119 drill.
func TestReleaseBuildCannotCensor(t *testing.T) {
	if Enabled {
		t.Fatal("the default build reports a fixture build")
	}

	var received *abci.RequestPrepareProposal
	original := sdk.PrepareProposalHandler(
		func(_ sdk.Context, request *abci.RequestPrepareProposal) (*abci.ResponsePrepareProposal, error) {
			received = request
			return &abci.ResponsePrepareProposal{Txs: [][]byte{[]byte("keep-me"), []byte("keep-me-too")}}, nil
		},
	)

	// Even with the switch set to the most aggressive policy, the default build
	// must pass every transaction through.
	t.Setenv(EnvironmentVariable, "all")
	wrapped := Wrap(original, log.NewNopLogger())
	if reflect.ValueOf(wrapped).Pointer() != reflect.ValueOf(original).Pointer() {
		t.Fatal("the default build wrapped the proposal handler")
	}
	request := &abci.RequestPrepareProposal{Height: 7}
	response, err := wrapped(sdk.Context{}, request)
	if err != nil {
		t.Fatalf("wrapped handler failed: %v", err)
	}
	if received != request {
		t.Fatal("the request did not reach the original handler unchanged")
	}
	if len(response.Txs) != 2 {
		t.Fatalf("the default build dropped %d transactions", 2-len(response.Txs))
	}
	if os.Getenv(EnvironmentVariable) != "all" {
		t.Fatal("the test did not actually set the switch")
	}
}
