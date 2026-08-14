package torium

import (
	"fmt"

	ethtypes "github.com/ethereum/go-ethereum/core/types"

	errorsmod "cosmossdk.io/errors"

	rootante "github.com/cosmos/evm/ante"
	cosmosante "github.com/cosmos/evm/ante/cosmos"
	evmdecorators "github.com/cosmos/evm/ante/evm"
	evmanteinterfaces "github.com/cosmos/evm/ante/interfaces"
	antetypes "github.com/cosmos/evm/ante/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	"github.com/cosmos/gogoproto/proto"

	"github.com/cosmos/cosmos-sdk/codec"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	errortypes "github.com/cosmos/cosmos-sdk/types/errors"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	"github.com/cosmos/cosmos-sdk/x/auth/ante"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	txsigning "github.com/cosmos/cosmos-sdk/x/tx/signing"
)

type toriumAnteOptions struct {
	Cdc                    codec.BinaryCodec
	AccountKeeper          evmanteinterfaces.AccountKeeper
	BankKeeper             evmanteinterfaces.BankKeeper
	FeeMarketKeeper        evmanteinterfaces.FeeMarketKeeper
	EvmKeeper              evmanteinterfaces.EVMKeeper
	ExtensionOptionChecker ante.ExtensionOptionChecker
	SignModeHandler        *txsigning.HandlerMap
	SigGasConsumer         func(storetypes.GasMeter, signing.SignatureV2, authtypes.Params) error
	MaxTxGasWanted         uint64
	MaxEVMTransactionBytes int
	DynamicFeeChecker      bool
	PendingTxListener      rootante.PendingTxListener
}

func (options toriumAnteOptions) validate() error {
	switch {
	case options.Cdc == nil:
		return fmt.Errorf("codec is required for the Torium ante handler")
	case options.AccountKeeper == nil:
		return fmt.Errorf("account keeper is required for the Torium ante handler")
	case options.BankKeeper == nil:
		return fmt.Errorf("bank keeper is required for the Torium ante handler")
	case options.FeeMarketKeeper == nil:
		return fmt.Errorf("fee market keeper is required for the Torium ante handler")
	case options.EvmKeeper == nil:
		return fmt.Errorf("EVM keeper is required for the Torium ante handler")
	case options.ExtensionOptionChecker == nil:
		return fmt.Errorf("extension option checker is required for the Torium ante handler")
	case options.SignModeHandler == nil:
		return fmt.Errorf("sign mode handler is required for the Torium ante handler")
	case options.SigGasConsumer == nil:
		return fmt.Errorf("signature gas consumer is required for the Torium ante handler")
	case options.MaxEVMTransactionBytes <= 0:
		return fmt.Errorf("maximum encoded EVM transaction bytes must be positive")
	case options.PendingTxListener == nil:
		return fmt.Errorf("pending transaction listener is required for the Torium ante handler")
	default:
		return nil
	}
}

func newToriumAnteHandler(options toriumAnteOptions) sdk.AnteHandler {
	if err := options.validate(); err != nil {
		panic(err)
	}
	ethereumExtension := "/" + proto.MessageName(&evmtypes.ExtensionOptionsEthereumTx{})
	dynamicFeeExtension := "/" + proto.MessageName(&antetypes.ExtensionOptionDynamicFeeTx{})

	return func(ctx sdk.Context, tx sdk.Tx, simulate bool) (sdk.Context, error) {
		txWithExtensions, ok := tx.(ante.HasExtensionOptionsTx)
		if ok {
			extensions := txWithExtensions.GetExtensionOptions()
			if len(extensions) > 0 {
				switch extensions[0].GetTypeUrl() {
				case ethereumExtension:
					return newToriumEVMAnteHandler(ctx, options)(ctx, tx, simulate)
				case dynamicFeeExtension:
					return newToriumCosmosAnteHandler(ctx, options)(ctx, tx, simulate)
				default:
					return ctx, errorsmod.Wrapf(
						errortypes.ErrUnknownExtensionOptions,
						"rejecting transaction with unsupported extension option %s",
						extensions[0].GetTypeUrl(),
					)
				}
			}
		}
		return newToriumCosmosAnteHandler(ctx, options)(ctx, tx, simulate)
	}
}

func newToriumEVMAnteHandler(ctx sdk.Context, options toriumAnteOptions) sdk.AnteHandler {
	evmParams := options.EvmKeeper.GetParams(ctx)
	feeMarketParams := options.FeeMarketKeeper.GetParams(ctx)
	return sdk.ChainAnteDecorators(
		evmTransactionPolicyDecorator{maxEncodedBytes: options.MaxEVMTransactionBytes},
		evmdecorators.NewEVMMonoDecorator(
			options.AccountKeeper,
			options.FeeMarketKeeper,
			options.EvmKeeper,
			options.MaxTxGasWanted,
			&evmParams,
			&feeMarketParams,
		),
		rootante.NewTxListenerDecorator(options.PendingTxListener),
	)
}

func newToriumCosmosAnteHandler(ctx sdk.Context, options toriumAnteOptions) sdk.AnteHandler {
	feeMarketParams := options.FeeMarketKeeper.GetParams(ctx)
	var feeChecker ante.TxFeeChecker
	if options.DynamicFeeChecker {
		feeChecker = evmdecorators.NewDynamicFeeChecker(&feeMarketParams)
	}

	return sdk.ChainAnteDecorators(
		cosmosante.NewRejectMessagesDecorator(),
		ante.NewSetUpContextDecorator(),
		ante.NewExtensionOptionsDecorator(options.ExtensionOptionChecker),
		ante.NewValidateBasicDecorator(),
		validatorCreationPolicyDecorator{},
		ante.NewTxTimeoutHeightDecorator(),
		ante.NewValidateMemoDecorator(options.AccountKeeper),
		cosmosante.NewMinGasPriceDecorator(&feeMarketParams),
		ante.NewConsumeGasForTxSizeDecorator(options.AccountKeeper),
		ante.NewDeductFeeDecorator(options.AccountKeeper, options.BankKeeper, nil, feeChecker),
		ante.NewSetPubKeyDecorator(options.AccountKeeper),
		ante.NewValidateSigCountDecorator(options.AccountKeeper),
		ante.NewSigGasConsumeDecorator(options.AccountKeeper, options.SigGasConsumer),
		ante.NewSigVerificationDecorator(options.AccountKeeper, options.SignModeHandler),
		ante.NewIncrementSequenceDecorator(options.AccountKeeper),
	)
}

// validatorCreationPolicyDecorator makes the global Torium validator floor and
// commission envelope consensus admission rules. Cosmos SDK intentionally lets
// each MsgCreateValidator choose these values; Torium narrows that surface so
// a validator cannot enter below the reviewed local protocol contract.
type validatorCreationPolicyDecorator struct{}

func (validatorCreationPolicyDecorator) AnteHandle(
	ctx sdk.Context,
	tx sdk.Tx,
	simulate bool,
	next sdk.AnteHandler,
) (sdk.Context, error) {
	for _, message := range tx.GetMsgs() {
		createValidator, ok := message.(*stakingtypes.MsgCreateValidator)
		if !ok {
			continue
		}
		if err := validateValidatorCreationPolicy(
			createValidator.Value.Denom,
			createValidator.Value.Amount,
			createValidator.MinSelfDelegation,
			createValidator.Commission,
		); err != nil {
			return ctx, err
		}
	}
	return next(ctx, tx, simulate)
}

// evmTransactionPolicyDecorator keeps state-machine admission at least as
// strict as the upstream app pool. The pool's 128 KiB bound is compile-time;
// this explicit ante rule also protects proposal and execution paths that do
// not originate in the receiving node's pool.
type evmTransactionPolicyDecorator struct {
	maxEncodedBytes int
}

func (decorator evmTransactionPolicyDecorator) AnteHandle(
	ctx sdk.Context,
	tx sdk.Tx,
	simulate bool,
	next sdk.AnteHandler,
) (sdk.Context, error) {
	messages := tx.GetMsgs()
	if len(messages) != 1 {
		return ctx, errorsmod.Wrapf(
			errortypes.ErrInvalidRequest,
			"expected one EVM message, got %d",
			len(messages),
		)
	}
	_, ethereumTx, err := evmtypes.UnpackEthMsg(messages[0])
	if err != nil {
		return ctx, err
	}
	switch ethereumTx.Type() {
	case ethtypes.BlobTxType:
		return ctx, errorsmod.Wrap(
			errortypes.ErrInvalidRequest,
			"EIP-4844 blob transactions are disabled by Torium protocol v1",
		)
	case ethtypes.SetCodeTxType:
		return ctx, errorsmod.Wrap(
			errortypes.ErrInvalidRequest,
			"EIP-7702 set-code transactions are disabled by Torium protocol v1",
		)
	}
	if uint64(ethereumTx.Size()) > uint64(decorator.maxEncodedBytes) {
		return ctx, errorsmod.Wrapf(
			errortypes.ErrTxTooLarge,
			"encoded EVM transaction is %d bytes; Torium protocol limit is %d",
			uint64(ethereumTx.Size()),
			decorator.maxEncodedBytes,
		)
	}
	return next(ctx, tx, simulate)
}
