package torium

import (
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/holiman/uint256"
	protov2 "google.golang.org/protobuf/proto"

	cosmosmath "cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

type policyTestTx struct{ messages []sdk.Msg }

func (tx policyTestTx) GetMsgs() []sdk.Msg { return tx.messages }

func (policyTestTx) GetMsgsV2() ([]protov2.Message, error) { return nil, nil }

func TestEVMTransactionPolicyRejectsSetCode(t *testing.T) {
	setCodeTx := ethtypes.NewTx(&ethtypes.SetCodeTx{
		ChainID:   uint256.NewInt(LocalEVMChainID),
		GasTipCap: uint256.NewInt(1),
		GasFeeCap: uint256.NewInt(1_000_000_000),
		Gas:       250_000,
		To:        common.Address{0x01},
		Value:     uint256.NewInt(0),
	})
	message := new(evmtypes.MsgEthereumTx)
	message.FromEthereumTx(setCodeTx)
	message.From = common.Address{0x02}.Bytes()

	nextCalled := false
	_, err := (evmTransactionPolicyDecorator{maxEncodedBytes: toriumconfig.MustLocalFeeAndResourcePolicy().MaxEVMTransactionBytes}).AnteHandle(sdk.Context{}, message, false, func(ctx sdk.Context, _ sdk.Tx, _ bool) (sdk.Context, error) {
		nextCalled = true
		return ctx, nil
	})
	if err == nil || !strings.Contains(err.Error(), "EIP-7702") {
		t.Fatalf("set-code transaction was not rejected with the Torium policy: %v", err)
	}
	if nextCalled {
		t.Fatal("set-code transaction reached the upstream EVM ante handler")
	}
}

func TestEVMTransactionPolicyRejectsBlob(t *testing.T) {
	blobTx := ethtypes.NewTx(&ethtypes.BlobTx{
		ChainID:    uint256.NewInt(LocalEVMChainID),
		GasTipCap:  uint256.NewInt(1),
		GasFeeCap:  uint256.NewInt(1_000_000_000),
		Gas:        250_000,
		To:         common.Address{0x01},
		Value:      uint256.NewInt(0),
		BlobFeeCap: uint256.NewInt(1),
		BlobHashes: []common.Hash{{0x01}},
	})
	message := new(evmtypes.MsgEthereumTx)
	message.FromEthereumTx(blobTx)
	message.From = common.Address{0x02}.Bytes()

	nextCalled := false
	_, err := (evmTransactionPolicyDecorator{maxEncodedBytes: toriumconfig.MustLocalFeeAndResourcePolicy().MaxEVMTransactionBytes}).AnteHandle(sdk.Context{}, message, false, func(ctx sdk.Context, _ sdk.Tx, _ bool) (sdk.Context, error) {
		nextCalled = true
		return ctx, nil
	})
	if err == nil || !strings.Contains(err.Error(), "EIP-4844") {
		t.Fatalf("blob transaction was not rejected with the Torium policy: %v", err)
	}
	if nextCalled {
		t.Fatal("blob transaction reached the upstream EVM ante handler")
	}
}

func TestEVMTransactionPolicyAllowsDynamicFeeType(t *testing.T) {
	dynamicFeeTx := ethtypes.NewTx(&ethtypes.DynamicFeeTx{
		ChainID:   new(big.Int).SetUint64(LocalEVMChainID),
		GasTipCap: big.NewInt(1),
		GasFeeCap: big.NewInt(1_000_000_000),
		Gas:       21_000,
		To:        &common.Address{0x01},
		Value:     big.NewInt(0),
	})
	message := new(evmtypes.MsgEthereumTx)
	message.FromEthereumTx(dynamicFeeTx)
	message.From = common.Address{0x02}.Bytes()

	nextCalled := false
	_, err := (evmTransactionPolicyDecorator{maxEncodedBytes: toriumconfig.MustLocalFeeAndResourcePolicy().MaxEVMTransactionBytes}).AnteHandle(sdk.Context{}, message, false, func(ctx sdk.Context, _ sdk.Tx, _ bool) (sdk.Context, error) {
		nextCalled = true
		return ctx, nil
	})
	if err != nil {
		t.Fatalf("dynamic-fee transaction was rejected: %v", err)
	}
	if !nextCalled {
		t.Fatal("dynamic-fee transaction did not reach the upstream EVM ante handler")
	}
}

func TestEVMTransactionPolicyEnforcesExactEncodedSizeBoundary(t *testing.T) {
	limit := toriumconfig.MustLocalFeeAndResourcePolicy().MaxEVMTransactionBytes
	transactions := make(map[int]*ethtypes.Transaction, 2)
	for dataBytes := limit - 512; dataBytes <= limit; dataBytes++ {
		transaction := ethtypes.NewTx(&ethtypes.DynamicFeeTx{
			ChainID:   new(big.Int).SetUint64(LocalEVMChainID),
			GasTipCap: big.NewInt(1),
			GasFeeCap: big.NewInt(1_000_000_000),
			Gas:       5_000_000,
			To:        &common.Address{0x01},
			Value:     big.NewInt(0),
			Data:      make([]byte, dataBytes),
		})
		size := int(transaction.Size())
		if size == limit || size == limit+1 {
			transactions[size] = transaction
		}
	}
	if transactions[limit] == nil || transactions[limit+1] == nil {
		t.Fatalf("could not construct exact encoded EVM boundary vectors: %v", transactions)
	}

	for _, test := range []struct {
		name     string
		size     int
		wantErr  bool
		wantNext bool
	}{
		{name: "exact limit", size: limit, wantNext: true},
		{name: "one byte above", size: limit + 1, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			message := new(evmtypes.MsgEthereumTx)
			message.FromEthereumTx(transactions[test.size])
			message.From = common.Address{0x02}.Bytes()
			nextCalled := false
			_, err := (evmTransactionPolicyDecorator{maxEncodedBytes: limit}).AnteHandle(
				sdk.Context{},
				message,
				false,
				func(ctx sdk.Context, _ sdk.Tx, _ bool) (sdk.Context, error) {
					nextCalled = true
					return ctx, nil
				},
			)
			if test.wantErr != (err != nil) || test.wantNext != nextCalled {
				t.Fatalf("boundary size %d returned err=%v next=%v", test.size, err, nextCalled)
			}
			if test.wantErr && !strings.Contains(err.Error(), "131072") {
				t.Fatalf("oversize error did not identify the protocol limit: %v", err)
			}
		})
	}
}

func TestValidatorCreationPolicyDecorator(t *testing.T) {
	valid := &stakingtypes.MsgCreateValidator{
		Value: sdk.NewCoin(BaseDenom, toriumconfig.MinimumValidatorSelfDelegation),
		Commission: stakingtypes.CommissionRates{
			Rate:          toriumconfig.MinimumValidatorCommissionRate,
			MaxRate:       toriumconfig.MaximumValidatorCommissionRate,
			MaxChangeRate: toriumconfig.MaximumCommissionChangeRate,
		},
		MinSelfDelegation: toriumconfig.MinimumValidatorSelfDelegation,
	}

	tests := []struct {
		name    string
		mutate  func(*stakingtypes.MsgCreateValidator)
		wantErr string
	}{
		{name: "exact boundary"},
		{
			name: "self delegation below one power unit",
			mutate: func(message *stakingtypes.MsgCreateValidator) {
				message.Value.Amount = toriumconfig.MinimumValidatorSelfDelegation.SubRaw(1)
			},
			wantErr: "at least",
		},
		{
			name: "declared minimum below protocol floor",
			mutate: func(message *stakingtypes.MsgCreateValidator) {
				message.MinSelfDelegation = toriumconfig.MinimumValidatorSelfDelegation.SubRaw(1)
			},
			wantErr: "at least",
		},
		{
			name: "wrong denom",
			mutate: func(message *stakingtypes.MsgCreateValidator) {
				message.Value.Denom = "stake"
			},
			wantErr: BaseDenom,
		},
		{
			name: "commission below floor",
			mutate: func(message *stakingtypes.MsgCreateValidator) {
				message.Commission.Rate = cosmosmath.LegacyMustNewDecFromStr("0.049999999999999999")
			},
			wantErr: "commission",
		},
		{
			name: "commission maximum above cap",
			mutate: func(message *stakingtypes.MsgCreateValidator) {
				message.Commission.MaxRate = cosmosmath.LegacyMustNewDecFromStr("0.200000000000000001")
			},
			wantErr: "commission",
		},
		{
			name: "daily change above cap",
			mutate: func(message *stakingtypes.MsgCreateValidator) {
				message.Commission.MaxChangeRate = cosmosmath.LegacyMustNewDecFromStr("0.010000000000000001")
			},
			wantErr: "daily change",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := *valid
			if test.mutate != nil {
				test.mutate(&message)
			}
			nextCalled := false
			_, err := (validatorCreationPolicyDecorator{}).AnteHandle(
				sdk.Context{},
				policyTestTx{messages: []sdk.Msg{&message}},
				false,
				func(ctx sdk.Context, _ sdk.Tx, _ bool) (sdk.Context, error) {
					nextCalled = true
					return ctx, nil
				},
			)
			if test.wantErr == "" {
				if err != nil || !nextCalled {
					t.Fatalf("valid validator policy returned %v, next=%v", err, nextCalled)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantErr) || nextCalled {
				t.Fatalf("invalid validator policy returned %v, next=%v", err, nextCalled)
			}
		})
	}
}
