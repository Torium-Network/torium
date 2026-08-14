package localnet

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestDeriveDisposableDevelopmentAccount(t *testing.T) {
	t.Parallel()

	key, address, err := DeriveDisposableDevelopmentAccount("faucet")
	if err != nil {
		t.Fatalf("derive faucet: %v", err)
	}
	if key == nil {
		t.Fatal("derived faucet key is nil")
	}
	expected := common.HexToAddress("0x05ae789955fa1804334e70C74893639592C4fB4f")
	if address != expected {
		t.Fatalf("faucet address mismatch: got %s, want %s", address.Hex(), expected.Hex())
	}
}

func TestDevelopmentAccountDerivationRejectsConsensusAndUnknownAccounts(t *testing.T) {
	t.Parallel()

	if _, _, err := DeriveDisposableDevelopmentAccount("validator-0"); err == nil {
		t.Fatal("validator account was exposed as a development signer")
	}
	if _, _, err := DeriveDisposableDevelopmentAccount("missing"); err == nil {
		t.Fatal("unknown development account was accepted")
	}
}
