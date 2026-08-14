package torium

import (
	"context"
	"strings"
	"testing"

	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	consensustypes "github.com/cosmos/cosmos-sdk/x/consensus/types"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"
)

const testGovernanceAuthority = "torium1governance"

type consensusMsgServerRecorder struct {
	called bool
}

func (recorder *consensusMsgServerRecorder) UpdateParams(
	_ context.Context,
	_ *consensustypes.MsgUpdateParams,
) (*consensustypes.MsgUpdateParamsResponse, error) {
	recorder.called = true
	return &consensustypes.MsgUpdateParamsResponse{}, nil
}

func TestToriumConsensusMsgServerPinsGlobalAuthorityToGovernance(t *testing.T) {
	tests := []struct {
		name      string
		message   *consensustypes.MsgUpdateParams
		wantError string
		delegated bool
	}{
		{name: "nil message", wantError: "message is required"},
		{
			name:      "wrong message authority",
			message:   &consensustypes.MsgUpdateParams{Authority: "torium1rogue"},
			wantError: "immutable governance account",
		},
		{
			name: "empty consensus authority transfer",
			message: &consensustypes.MsgUpdateParams{
				Authority: testGovernanceAuthority,
				Auth:      &cmtproto.AuthorityParams{},
			},
			wantError: "cannot change",
		},
		{
			name: "rogue consensus authority transfer",
			message: &consensustypes.MsgUpdateParams{
				Authority: testGovernanceAuthority,
				Auth:      &cmtproto.AuthorityParams{Authority: "torium1rogue"},
			},
			wantError: "cannot change",
		},
		{
			name: "omitted consensus authority",
			message: &consensustypes.MsgUpdateParams{
				Authority: testGovernanceAuthority,
			},
			delegated: true,
		},
		{
			name: "unchanged consensus authority",
			message: &consensustypes.MsgUpdateParams{
				Authority: testGovernanceAuthority,
				Auth:      &cmtproto.AuthorityParams{Authority: testGovernanceAuthority},
			},
			delegated: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := &consensusMsgServerRecorder{}
			server := toriumConsensusMsgServer{delegate: recorder, authority: testGovernanceAuthority}
			_, err := server.UpdateParams(context.Background(), test.message)
			if test.wantError == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if test.wantError != "" && (err == nil || !strings.Contains(err.Error(), test.wantError)) {
				t.Fatalf("error=%v, expected %q", err, test.wantError)
			}
			if recorder.called != test.delegated {
				t.Fatalf("delegate called=%v, expected %v", recorder.called, test.delegated)
			}
		})
	}
}

type upgradeMsgServerRecorder struct {
	softwareUpgradeCalled bool
	cancelUpgradeCalled   bool
}

func (recorder *upgradeMsgServerRecorder) SoftwareUpgrade(
	_ context.Context,
	_ *upgradetypes.MsgSoftwareUpgrade,
) (*upgradetypes.MsgSoftwareUpgradeResponse, error) {
	recorder.softwareUpgradeCalled = true
	return &upgradetypes.MsgSoftwareUpgradeResponse{}, nil
}

func (recorder *upgradeMsgServerRecorder) CancelUpgrade(
	_ context.Context,
	_ *upgradetypes.MsgCancelUpgrade,
) (*upgradetypes.MsgCancelUpgradeResponse, error) {
	recorder.cancelUpgradeCalled = true
	return &upgradetypes.MsgCancelUpgradeResponse{}, nil
}

func TestToriumUpgradeMsgServerEnforcesAuthorityAndLeadTime(t *testing.T) {
	recorder := &upgradeMsgServerRecorder{}
	server := toriumUpgradeMsgServer{
		delegate:          recorder,
		authority:         testGovernanceAuthority,
		minimumLeadBlocks: toriumMinimumSchedulingLeadBlocks,
	}
	ctx := sdk.Context{}.WithBlockHeight(100)

	for _, test := range []struct {
		name      string
		message   *upgradetypes.MsgSoftwareUpgrade
		wantError string
	}{
		{name: "nil message", wantError: "message is required"},
		{
			name:      "wrong authority",
			message:   &upgradetypes.MsgSoftwareUpgrade{Authority: "torium1rogue", Plan: upgradetypes.Plan{Height: 110}},
			wantError: "governance account",
		},
		{
			name:      "nine blocks is too short",
			message:   &upgradetypes.MsgSoftwareUpgrade{Authority: testGovernanceAuthority, Plan: upgradetypes.Plan{Height: 109}},
			wantError: "minimum 110",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder.softwareUpgradeCalled = false
			_, err := server.SoftwareUpgrade(ctx, test.message)
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("error=%v, expected %q", err, test.wantError)
			}
			if recorder.softwareUpgradeCalled {
				t.Fatal("rejected software upgrade reached upstream server")
			}
		})
	}

	_, err := server.SoftwareUpgrade(ctx, &upgradetypes.MsgSoftwareUpgrade{
		Authority: testGovernanceAuthority,
		Plan:      upgradetypes.Plan{Height: 110},
	})
	if err != nil || !recorder.softwareUpgradeCalled {
		t.Fatalf("exact minimum lead was not delegated: called=%v error=%v", recorder.softwareUpgradeCalled, err)
	}
}

func TestToriumUpgradeMsgServerPinsCancellationAuthority(t *testing.T) {
	recorder := &upgradeMsgServerRecorder{}
	server := toriumUpgradeMsgServer{delegate: recorder, authority: testGovernanceAuthority}

	for _, message := range []*upgradetypes.MsgCancelUpgrade{
		nil,
		{Authority: "torium1rogue"},
	} {
		recorder.cancelUpgradeCalled = false
		if _, err := server.CancelUpgrade(context.Background(), message); err == nil {
			t.Fatal("unauthorized cancellation was accepted")
		}
		if recorder.cancelUpgradeCalled {
			t.Fatal("rejected cancellation reached upstream server")
		}
	}

	_, err := server.CancelUpgrade(context.Background(), &upgradetypes.MsgCancelUpgrade{
		Authority: testGovernanceAuthority,
	})
	if err != nil || !recorder.cancelUpgradeCalled {
		t.Fatalf("governance cancellation was not delegated: called=%v error=%v", recorder.cancelUpgradeCalled, err)
	}
}
