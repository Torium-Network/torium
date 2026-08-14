// Command replaygen creates deterministic legacy transaction fixtures for the
// canonical local-only replay-domain acceptance test. It must never be used
// with a public or valuable network.
package main

import (
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
	"github.com/holiman/uint256"
)

const replayFixtureKeyDomain = "torium/localnet/valueless-fixture/v1/account/deployer"

type output struct {
	Raw       string `json:"raw"`
	Hash      string `json:"hash"`
	Protected bool   `json:"protected"`
	ChainID   string `json:"chainId"`
	Type      uint8  `json:"type"`
}

func main() {
	mode := flag.String("mode", "", "fixture mode: wrong-chain, unprotected, blob, or set-code")
	signingChainID := flag.Int64("signing-chain-id", 0, "EIP-155 chain ID used to sign a protected fixture")
	to := flag.String("to", "", "recipient address")
	nonce := flag.Uint64("nonce", 0, "transaction nonce")
	gasPriceText := flag.String("gas-price", "", "legacy gas price in base units")
	flag.Parse()

	if (*mode != "wrong-chain" && *mode != "unprotected" && *mode != "blob" && *mode != "set-code") || !common.IsHexAddress(*to) {
		failReplay("mode and recipient are required")
	}
	if *mode != "unprotected" && *signingChainID <= 0 {
		failReplay("protected fixture mode requires a positive signing chain ID")
	}
	gasPrice, ok := new(big.Int).SetString(*gasPriceText, 10)
	if !ok || gasPrice.Sign() <= 0 {
		failReplay("gas-price must be a positive base-unit integer")
	}

	digest := sha256.Sum256([]byte(replayFixtureKeyDomain))
	privateKey, err := crypto.ToECDSA(digest[:])
	if err != nil {
		failReplay(fmt.Sprintf("derive disposable fixture key: %v", err))
	}
	recipient := common.HexToAddress(*to)
	var transaction *types.Transaction
	var signer types.Signer
	switch *mode {
	case "wrong-chain":
		transaction = types.NewTx(&types.LegacyTx{
			Nonce:    *nonce,
			GasPrice: gasPrice,
			Gas:      21_000,
			To:       &recipient,
			Value:    big.NewInt(1),
		})
		signer = types.NewEIP155Signer(big.NewInt(*signingChainID))
	case "unprotected":
		transaction = types.NewTx(&types.LegacyTx{
			Nonce:    *nonce,
			GasPrice: gasPrice,
			Gas:      21_000,
			To:       &recipient,
			Value:    big.NewInt(1),
		})
		signer = types.HomesteadSigner{}
	case "blob":
		transaction = types.NewTx(&types.BlobTx{
			ChainID:    uint256.NewInt(uint64(*signingChainID)),
			Nonce:      *nonce,
			GasTipCap:  uint256.NewInt(100_000_000),
			GasFeeCap:  uint256.MustFromBig(gasPrice),
			Gas:        250_000,
			To:         recipient,
			Value:      uint256.NewInt(0),
			BlobFeeCap: uint256.NewInt(1),
			BlobHashes: []common.Hash{},
			Sidecar:    &types.BlobTxSidecar{Version: 1},
		})
		signer = types.LatestSignerForChainID(big.NewInt(*signingChainID))
	case "set-code":
		authorization, signAuthorizationErr := types.SignSetCode(privateKey, types.SetCodeAuthorization{
			ChainID: *uint256.NewInt(uint64(*signingChainID)),
			Address: recipient,
			Nonce:   0,
		})
		if signAuthorizationErr != nil {
			failReplay(fmt.Sprintf("sign set-code authorization: %v", signAuthorizationErr))
		}
		transaction = types.NewTx(&types.SetCodeTx{
			ChainID:   uint256.NewInt(uint64(*signingChainID)),
			Nonce:     *nonce,
			GasTipCap: uint256.NewInt(100_000_000),
			GasFeeCap: uint256.MustFromBig(gasPrice),
			Gas:       250_000,
			To:        recipient,
			Value:     uint256.NewInt(0),
			AuthList:  []types.SetCodeAuthorization{authorization},
		})
		signer = types.LatestSignerForChainID(big.NewInt(*signingChainID))
	}
	signed, err := types.SignTx(transaction, signer, privateKey)
	if err != nil {
		failReplay(fmt.Sprintf("sign transaction: %v", err))
	}
	raw, err := signed.MarshalBinary()
	if err != nil {
		failReplay(fmt.Sprintf("encode transaction: %v", err))
	}

	result := output{
		Raw:       "0x" + hex.EncodeToString(raw),
		Hash:      signed.Hash().Hex(),
		Protected: signed.Protected(),
		ChainID:   signed.ChainId().String(),
		Type:      signed.Type(),
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		failReplay(fmt.Sprintf("encode fixture: %v", err))
	}
}

func failReplay(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
