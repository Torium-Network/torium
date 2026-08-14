// Command authority_tx builds one deterministic local-only governance proposal
// transaction whose embedded consensus message includes AuthorityParams. The
// pinned Cosmos SDK CLI descriptor omits that field, while protobuf encoding
// and the state machine support it. This fixture must never target a public or
// valuable network.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"os"

	cosmosmath "cosmossdk.io/math"
	"github.com/cometbft/cometbft/types"
	clienttx "github.com/cosmos/cosmos-sdk/client/tx"
	sdk "github.com/cosmos/cosmos-sdk/types"
	signingtypes "github.com/cosmos/cosmos-sdk/types/tx/signing"
	authsigning "github.com/cosmos/cosmos-sdk/x/auth/signing"
	consensustypes "github.com/cosmos/cosmos-sdk/x/consensus/types"
	govtypes "github.com/cosmos/cosmos-sdk/x/gov/types/v1"
	"github.com/cosmos/evm/crypto/ethsecp256k1"
	evmencoding "github.com/cosmos/evm/encoding"
	torium "github.com/torium-network/torium-chain"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

const validatorZeroKeyDomain = "torium/localnet/valueless-fixture/v1/account/validator-0"

func main() {
	accountNumber := flag.Uint64("account-number", 0, "current local proposer account number")
	sequence := flag.Uint64("sequence", 0, "current local proposer sequence")
	governanceAuthority := flag.String("governance-authority", "", "local governance module account")
	rogueAuthority := flag.String("rogue-authority", "", "authority transfer target and proposer")
	flag.Parse()

	if *governanceAuthority == "" || *rogueAuthority == "" {
		fail("governance-authority and rogue-authority are required")
	}

	sdkConfig := sdk.GetConfig()
	toriumconfig.SetBech32Prefixes(sdkConfig)
	toriumconfig.SetBip44CoinType(sdkConfig)
	sdkConfig.Seal()

	encodingConfig := evmencoding.MakeConfig(toriumconfig.LocalEVMChainID)
	basicManager := torium.NewBasicModuleManager()
	basicManager.RegisterLegacyAminoCodec(encodingConfig.Amino)
	basicManager.RegisterInterfaces(encodingConfig.InterfaceRegistry)

	digest := sha256.Sum256([]byte(validatorZeroKeyDomain))
	privateKey := &ethsecp256k1.PrivKey{Key: digest[:]}
	proposer := sdk.AccAddress(privateKey.PubKey().Address()).String()
	if proposer != *rogueAuthority {
		fail(fmt.Sprintf("derived proposer %s does not match requested rogue authority %s", proposer, *rogueAuthority))
	}

	consensusParams := types.DefaultConsensusParams()
	feePolicy := toriumconfig.MustLocalFeeAndResourcePolicy()
	consensusParams.Block.MaxBytes = feePolicy.BlockMaxBytes
	consensusParams.Block.MaxGas = feePolicy.BlockMaxGas
	consensusParams.Evidence.MaxAgeNumBlocks = toriumconfig.EvidenceMaxAgeBlocks
	consensusParams.Evidence.MaxAgeDuration = toriumconfig.EvidenceMaxAge
	consensusParams.Evidence.MaxBytes = toriumconfig.EvidenceMaximumBytes
	protoParams := consensusParams.ToProto()
	message := &consensustypes.MsgUpdateParams{
		Authority: *governanceAuthority,
		Block:     protoParams.Block,
		Evidence:  protoParams.Evidence,
		Validator: protoParams.Validator,
		Abci:      protoParams.Abci,
		Auth:      protoParams.Authority,
	}
	message.Auth.Authority = *rogueAuthority

	proposal, err := govtypes.NewMsgSubmitProposal(
		[]sdk.Msg{message},
		sdk.NewCoins(sdk.NewCoin(torium.BaseDenom, cosmosmath.NewInt(10_000_000_000_000_000).MulRaw(1_000))),
		proposer,
		"ipfs://torium-localnet-governance-rehearsal",
		"Consensus authority transfer rejection",
		"Consensus authority transfer rejection local acceptance",
		false,
	)
	if err != nil {
		fail(fmt.Sprintf("create proposal: %v", err))
	}

	builder := encodingConfig.TxConfig.NewTxBuilder()
	if err := builder.SetMsgs(proposal); err != nil {
		fail(fmt.Sprintf("set proposal message: %v", err))
	}
	builder.SetGasLimit(1_000_000)
	builder.SetFeeAmount(sdk.NewCoins(sdk.NewInt64Coin(torium.BaseDenom, 1_000_000_000_000_000)))
	placeholder := signingtypes.SignatureV2{
		PubKey: privateKey.PubKey(),
		Data: &signingtypes.SingleSignatureData{
			SignMode: signingtypes.SignMode_SIGN_MODE_DIRECT,
		},
		Sequence: *sequence,
	}
	if err := builder.SetSignatures(placeholder); err != nil {
		fail(fmt.Sprintf("set signer metadata: %v", err))
	}
	signerData := authsigning.SignerData{
		Address:       proposer,
		ChainID:       toriumconfig.LocalCosmosChainID,
		AccountNumber: *accountNumber,
		Sequence:      *sequence,
		PubKey:        privateKey.PubKey(),
	}
	signature, err := clienttx.SignWithPrivKey(
		context.Background(),
		signingtypes.SignMode_SIGN_MODE_DIRECT,
		signerData,
		builder,
		privateKey,
		encodingConfig.TxConfig,
		*sequence,
	)
	if err != nil {
		fail(fmt.Sprintf("sign proposal transaction: %v", err))
	}
	if err := builder.SetSignatures(signature); err != nil {
		fail(fmt.Sprintf("attach signature: %v", err))
	}
	encoded, err := encodingConfig.TxConfig.TxEncoder()(builder.GetTx())
	if err != nil {
		fail(fmt.Sprintf("encode proposal transaction: %v", err))
	}
	fmt.Printf("0x%s\n", hex.EncodeToString(encoded))
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
