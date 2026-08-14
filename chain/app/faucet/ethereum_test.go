package faucet

import (
	"context"
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
)

func TestNewEthereumFunderRejectsMismatchedSignerAddressBeforeDial(t *testing.T) {
	t.Parallel()

	privateKey, err := ethcrypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate test signer: %v", err)
	}
	_, err = NewEthereumFunder(
		context.Background(),
		"http://127.0.0.1:1",
		privateKey,
		common.HexToAddress("0x1111111111111111111111111111111111111111"),
		big.NewInt(1414484556),
		time.Second,
	)
	if err == nil {
		t.Fatal("mismatched signer address was accepted")
	}
}
