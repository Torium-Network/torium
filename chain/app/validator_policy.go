package torium

import (
	"context"

	"cosmossdk.io/errors"
	cosmosmath "cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	errortypes "github.com/cosmos/cosmos-sdk/types/errors"
	stakingkeeper "github.com/cosmos/cosmos-sdk/x/staking/keeper"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

func validateValidatorCreationPolicy(
	denom string,
	selfDelegation cosmosmath.Int,
	minimumSelfDelegation cosmosmath.Int,
	commission stakingtypes.CommissionRates,
) error {
	if denom != BaseDenom {
		return errors.Wrapf(
			errortypes.ErrInvalidRequest,
			"validator self-delegation denom must be %s",
			BaseDenom,
		)
	}
	if selfDelegation.LT(toriumconfig.MinimumValidatorSelfDelegation) ||
		minimumSelfDelegation.LT(toriumconfig.MinimumValidatorSelfDelegation) {
		return errors.Wrapf(
			errortypes.ErrInvalidRequest,
			"validator self-delegation and minimum must each be at least %s%s",
			toriumconfig.MinimumValidatorSelfDelegation,
			BaseDenom,
		)
	}
	if commission.Rate.LT(toriumconfig.MinimumValidatorCommissionRate) ||
		commission.MaxRate.GT(toriumconfig.MaximumValidatorCommissionRate) ||
		commission.MaxChangeRate.GT(toriumconfig.MaximumCommissionChangeRate) {
		return errors.Wrapf(
			errortypes.ErrInvalidRequest,
			"validator commission must use rate >= %s, maximum rate <= %s, and maximum daily change <= %s",
			toriumconfig.MinimumValidatorCommissionRate,
			toriumconfig.MaximumValidatorCommissionRate,
			toriumconfig.MaximumCommissionChangeRate,
		)
	}
	return nil
}

// validatorPolicyHooks enforce the creation envelope inside x/staking, after
// the candidate has been materialized but before self-delegation. This covers
// every MsgServer caller, including the staking EVM precompile, rather than
// relying only on the outer Cosmos transaction ante handler.
type validatorPolicyHooks struct {
	keeper *stakingkeeper.Keeper
}

func (hooks validatorPolicyHooks) AfterValidatorCreated(ctx context.Context, valAddr sdk.ValAddress) error {
	validator, err := hooks.keeper.GetValidator(ctx, valAddr)
	if err != nil {
		return err
	}
	return validateValidatorCreationPolicy(
		BaseDenom,
		validator.MinSelfDelegation,
		validator.MinSelfDelegation,
		validator.Commission.CommissionRates,
	)
}

func (validatorPolicyHooks) BeforeValidatorModified(context.Context, sdk.ValAddress) error {
	return nil
}

func (validatorPolicyHooks) AfterValidatorRemoved(context.Context, sdk.ConsAddress, sdk.ValAddress) error {
	return nil
}

func (validatorPolicyHooks) AfterValidatorBonded(context.Context, sdk.ConsAddress, sdk.ValAddress) error {
	return nil
}

func (validatorPolicyHooks) AfterValidatorBeginUnbonding(context.Context, sdk.ConsAddress, sdk.ValAddress) error {
	return nil
}

func (validatorPolicyHooks) BeforeDelegationCreated(context.Context, sdk.AccAddress, sdk.ValAddress) error {
	return nil
}

func (validatorPolicyHooks) BeforeDelegationSharesModified(context.Context, sdk.AccAddress, sdk.ValAddress) error {
	return nil
}

func (validatorPolicyHooks) BeforeDelegationRemoved(context.Context, sdk.AccAddress, sdk.ValAddress) error {
	return nil
}

func (validatorPolicyHooks) AfterDelegationModified(context.Context, sdk.AccAddress, sdk.ValAddress) error {
	return nil
}

func (validatorPolicyHooks) BeforeValidatorSlashed(context.Context, sdk.ValAddress, cosmosmath.LegacyDec) error {
	return nil
}

func (validatorPolicyHooks) AfterUnbondingInitiated(context.Context, uint64) error {
	return nil
}

var _ stakingtypes.StakingHooks = validatorPolicyHooks{}
