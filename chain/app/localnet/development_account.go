package localnet

import (
	"crypto/ecdsa"
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
)

// DeriveDisposableDevelopmentAccount returns a deterministic localnet-only
// development signer. The caller must keep the key in process memory, must not
// log or persist it, and must never reuse it on a public or valuable network.
// Consensus validator accounts are deliberately unavailable through this API.
func DeriveDisposableDevelopmentAccount(name string) (*ecdsa.PrivateKey, common.Address, error) {
	fixture, err := LoadFixture()
	if err != nil {
		return nil, common.Address{}, err
	}
	for _, account := range fixture.Accounts {
		if account.Name != name {
			continue
		}
		if account.Role != "development" {
			return nil, common.Address{}, fmt.Errorf("localnet account %q is not a development account", name)
		}
		key, err := deriveAccountKey(account.DerivationContext)
		if err != nil {
			return nil, common.Address{}, fmt.Errorf("derive disposable development account %q: %w", name, err)
		}
		privateKey, err := ethcrypto.ToECDSA(key.Key)
		if err != nil {
			return nil, common.Address{}, fmt.Errorf("convert disposable development account %q: %w", name, err)
		}
		address := ethcrypto.PubkeyToAddress(privateKey.PublicKey)
		return privateKey, address, nil
	}
	return nil, common.Address{}, fmt.Errorf("unknown localnet development account %q", name)
}
