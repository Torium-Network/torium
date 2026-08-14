package config

import (
	"context"

	errorsmod "cosmossdk.io/errors"

	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

// NativeAssetMintingRestriction makes atorium genesis-capped and
// non-inflationary. Generic module mint permissions remain available for
// governance-approved non-native representations, but no module can create
// additional native TOR after InitChain.
func NativeAssetMintingRestriction(_ context.Context, coins sdk.Coins) error {
	if amount := coins.AmountOf(BaseDenom); amount.IsPositive() {
		return errorsmod.Wrapf(
			sdkerrors.ErrUnauthorized,
			"post-genesis minting of native denom %s is disabled (attempted %s)",
			BaseDenom,
			amount,
		)
	}
	return nil
}
