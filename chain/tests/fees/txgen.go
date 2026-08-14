// Command txgen creates deterministic, disposable large EIP-1559 transactions
// for the local fee acceptance suite. It must never be used with a public or
// valuable network.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math/big"
	"os"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

const fixtureKeyDomain = "torium/localnet/valueless-fixture/v1/account/deployer"

func main() {
	chainID := flag.Int64("chain-id", 0, "local EIP-155 chain ID")
	to := flag.String("to", "", "recipient address")
	startNonce := flag.Uint64("start-nonce", 0, "first nonce")
	count := flag.Int("count", 1, "transaction count")
	dataBytes := flag.Int("data-bytes", 0, "number of non-zero calldata bytes")
	gasLimit := flag.Uint64("gas-limit", 0, "transaction gas limit")
	maxFeeText := flag.String("max-fee", "", "maximum fee per gas in base units")
	tipText := flag.String("tip", "", "maximum priority fee per gas in base units")
	flag.Parse()

	if *chainID <= 0 || !common.IsHexAddress(*to) || *count < 1 || *count > 32 ||
		*dataBytes < 0 || *gasLimit == 0 {
		fail("invalid chain, recipient, count, calldata, or gas-limit argument")
	}
	maxFee, ok := new(big.Int).SetString(*maxFeeText, 10)
	if !ok || maxFee.Sign() <= 0 {
		fail("max-fee must be a positive base-unit integer")
	}
	tip, ok := new(big.Int).SetString(*tipText, 10)
	if !ok || tip.Sign() <= 0 || tip.Cmp(maxFee) > 0 {
		fail("tip must be a positive base-unit integer at or below max-fee")
	}

	digest := sha256.Sum256([]byte(fixtureKeyDomain))
	privateKey, err := crypto.ToECDSA(digest[:])
	if err != nil {
		fail(fmt.Sprintf("derive disposable fixture key: %v", err))
	}
	recipient := common.HexToAddress(*to)
	signer := types.LatestSignerForChainID(big.NewInt(*chainID))
	data := bytes.Repeat([]byte{0xff}, *dataBytes)
	encoded := make([]string, 0, *count)
	for offset := 0; offset < *count; offset++ {
		transaction := types.NewTx(&types.DynamicFeeTx{
			ChainID:   big.NewInt(*chainID),
			Nonce:     *startNonce + uint64(offset),
			GasTipCap: new(big.Int).Set(tip),
			GasFeeCap: new(big.Int).Set(maxFee),
			Gas:       *gasLimit,
			To:        &recipient,
			Value:     big.NewInt(0),
			Data:      data,
		})
		signed, signErr := types.SignTx(transaction, signer, privateKey)
		if signErr != nil {
			fail(fmt.Sprintf("sign transaction %d: %v", offset, signErr))
		}
		raw, marshalErr := signed.MarshalBinary()
		if marshalErr != nil {
			fail(fmt.Sprintf("encode transaction %d: %v", offset, marshalErr))
		}
		encoded = append(encoded, "0x"+hex.EncodeToString(raw))
	}
	if err := json.NewEncoder(os.Stdout).Encode(encoded); err != nil {
		fail(fmt.Sprintf("encode transaction list: %v", err))
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
