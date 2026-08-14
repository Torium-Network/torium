package config

import (
	"context"
	"errors"
	"testing"

	"cosmossdk.io/math"

	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

func TestNativeAssetMintingRestriction(t *testing.T) {
	native := sdk.NewCoins(sdk.NewCoin(BaseDenom, math.OneInt()))
	if err := NativeAssetMintingRestriction(context.Background(), native); !errors.Is(err, sdkerrors.ErrUnauthorized) {
		t.Fatalf("native mint restriction returned %v, expected unauthorized", err)
	}

	nonNative := sdk.NewCoins(sdk.NewCoin("factory/torium/test", math.OneInt()))
	if err := NativeAssetMintingRestriction(context.Background(), nonNative); err != nil {
		t.Fatalf("native-only mint restriction rejected an unrelated denom: %v", err)
	}
}
