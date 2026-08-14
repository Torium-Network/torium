package torium

import (
	"context"
	"fmt"

	"cosmossdk.io/core/address"
	"github.com/cosmos/cosmos-sdk/codec"
	"github.com/cosmos/cosmos-sdk/types/module"
	consensusmodule "github.com/cosmos/cosmos-sdk/x/consensus"
	consensuskeeper "github.com/cosmos/cosmos-sdk/x/consensus/keeper"
	consensustypes "github.com/cosmos/cosmos-sdk/x/consensus/types"
	upgrademodule "github.com/cosmos/cosmos-sdk/x/upgrade"
	upgradekeeper "github.com/cosmos/cosmos-sdk/x/upgrade/keeper"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"
	"google.golang.org/grpc"

	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

const toriumMinimumSchedulingLeadBlocks int64 = 10

// toriumConsensusAppModule preserves the upstream query/module behavior while
// preventing x/consensus AuthorityParams from transferring every SDK keeper's
// effective authority away from governance.
type toriumConsensusAppModule struct {
	consensusmodule.AppModule
	keeper    consensuskeeper.Keeper
	msgServer consensustypes.MsgServer
}

func newToriumConsensusAppModule(
	coder codec.Codec,
	keeper consensuskeeper.Keeper,
	authority string,
) toriumConsensusAppModule {
	return toriumConsensusAppModule{
		AppModule: consensusmodule.NewAppModule(coder, keeper),
		keeper:    keeper,
		msgServer: toriumConsensusMsgServer{delegate: keeper, authority: authority},
	}
}

func (module toriumConsensusAppModule) RegisterServices(registrar grpc.ServiceRegistrar) error {
	consensustypes.RegisterMsgServer(registrar, module.msgServer)
	consensustypes.RegisterQueryServer(registrar, module.keeper)
	return nil
}

type toriumConsensusMsgServer struct {
	delegate  consensustypes.MsgServer
	authority string
}

func (server toriumConsensusMsgServer) UpdateParams(
	ctx context.Context,
	message *consensustypes.MsgUpdateParams,
) (*consensustypes.MsgUpdateParamsResponse, error) {
	if message == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("consensus parameter message is required")
	}
	if message.Authority != server.authority {
		return nil, sdkerrors.ErrUnauthorized.Wrapf(
			"Torium consensus authority is immutable governance account %s, got %s",
			server.authority,
			message.Authority,
		)
	}
	if message.Auth != nil && message.Auth.Authority != server.authority {
		return nil, sdkerrors.ErrUnauthorized.Wrapf(
			"Torium consensus AuthorityParams cannot change from %s to %s",
			server.authority,
			message.Auth.Authority,
		)
	}
	return server.delegate.UpdateParams(ctx, message)
}

// toriumUpgradeAppModule keeps upstream pre-block/genesis/query/migration
// behavior but installs the Torium scheduling contract around Msg services.
type toriumUpgradeAppModule struct {
	upgrademodule.AppModule
	keeper    *upgradekeeper.Keeper
	msgServer upgradetypes.MsgServer
}

func newToriumUpgradeAppModule(
	keeper *upgradekeeper.Keeper,
	addressCodec address.Codec,
	authority string,
) toriumUpgradeAppModule {
	delegate := upgradekeeper.NewMsgServerImpl(keeper)
	return toriumUpgradeAppModule{
		AppModule: upgrademodule.NewAppModule(keeper, addressCodec),
		keeper:    keeper,
		msgServer: toriumUpgradeMsgServer{
			delegate:          delegate,
			authority:         authority,
			minimumLeadBlocks: toriumMinimumSchedulingLeadBlocks,
		},
	}
}

func (appModule toriumUpgradeAppModule) RegisterServices(configurator module.Configurator) {
	upgradetypes.RegisterMsgServer(configurator.MsgServer(), appModule.msgServer)
	upgradetypes.RegisterQueryServer(configurator.QueryServer(), appModule.keeper)

	migrator := upgradekeeper.NewMigrator(appModule.keeper)
	if err := configurator.RegisterMigration(upgradetypes.ModuleName, 1, migrator.Migrate1to2); err != nil {
		panic(fmt.Sprintf("failed to migrate x/%s from version 1 to 2: %v", upgradetypes.ModuleName, err))
	}
}

type toriumUpgradeMsgServer struct {
	delegate          upgradetypes.MsgServer
	authority         string
	minimumLeadBlocks int64
}

func (server toriumUpgradeMsgServer) SoftwareUpgrade(
	ctx context.Context,
	message *upgradetypes.MsgSoftwareUpgrade,
) (*upgradetypes.MsgSoftwareUpgradeResponse, error) {
	if message == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("software upgrade message is required")
	}
	if message.Authority != server.authority {
		return nil, sdkerrors.ErrUnauthorized.Wrapf(
			"Torium upgrade authority is governance account %s, got %s",
			server.authority,
			message.Authority,
		)
	}
	currentHeight := sdk.UnwrapSDKContext(ctx).BlockHeight()
	minimumHeight := currentHeight + server.minimumLeadBlocks
	if message.Plan.Height < minimumHeight {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf(
			"Torium upgrade height %d must be at least %d blocks after execution height %d (minimum %d)",
			message.Plan.Height,
			server.minimumLeadBlocks,
			currentHeight,
			minimumHeight,
		)
	}
	return server.delegate.SoftwareUpgrade(ctx, message)
}

func (server toriumUpgradeMsgServer) CancelUpgrade(
	ctx context.Context,
	message *upgradetypes.MsgCancelUpgrade,
) (*upgradetypes.MsgCancelUpgradeResponse, error) {
	if message == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("cancel upgrade message is required")
	}
	if message.Authority != server.authority {
		return nil, sdkerrors.ErrUnauthorized.Wrapf(
			"Torium upgrade authority is governance account %s, got %s",
			server.authority,
			message.Authority,
		)
	}
	return server.delegate.CancelUpgrade(ctx, message)
}
