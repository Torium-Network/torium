package publicfaucet

import (
	"math/big"
	"net/netip"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

func testProfile(t *testing.T) Profile {
	t.Helper()
	profile := Profile{
		Name:                "unit",
		LocalRehearsal:      true,
		CosmosChainID:       "torium-localnet-1",
		EVMChainID:          big.NewInt(1414484556),
		AmountPerRequest:    big.NewInt(1_000),
		CooldownPerAddress:  24 * time.Hour,
		PerAddressDailyCap:  1,
		GlobalDailyBudget:   big.NewInt(3_000),
		HotBalanceCap:       big.NewInt(6_000),
		RefillBelow:         big.NewInt(3_000),
		AlertBelow:          big.NewInt(1_500),
		HaltBelow:           big.NewInt(300),
		QueueCapacity:       16,
		MaximumBodyBytes:    4096,
		TransactionTimeout:  5 * time.Second,
		ChallengeMode:       ChallengeStaticLocal,
		PerIPBurst:          2,
		PerIPRefillSeconds:  60,
		SubnetBurst:         3,
		SubnetRefillSeconds: 60,
		ErrorRateWindow:     4,
		ErrorRateTripCount:  3,
		RPCProbeInterval:    time.Second,
		RPCTripAfter:        2,
	}
	if err := profile.Validate(); err != nil {
		t.Fatalf("test profile is invalid: %v", err)
	}
	return profile
}

func newTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	dataDir := t.TempDir()
	journal, entries, err := OpenJournal(dataDir)
	if err != nil {
		t.Fatalf("open journal: %v", err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	store, err := NewStore(journal, entries, testProfile(t))
	if err != nil {
		t.Fatalf("build store: %v", err)
	}
	return store, dataDir
}

func TestAcceptIsIdempotentPerAddressAndDay(t *testing.T) {
	store, _ := newTestStore(t)
	address := common.HexToAddress("0x1111111111111111111111111111111111111111")
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)

	first, replayed, err := store.Accept("client-key-1", address, now, "request-1")
	if err != nil || replayed {
		t.Fatalf("first accept failed: replayed=%v err=%v", replayed, err)
	}
	if first.Status != StatusQueued {
		t.Fatalf("first accept status = %s", first.Status)
	}
	again, replayed, err := store.Accept("client-key-1", address, now.Add(time.Minute), "request-2")
	if err != nil || !replayed {
		t.Fatalf("replay was not detected: replayed=%v err=%v", replayed, err)
	}
	if again.ID != first.ID {
		t.Fatalf("replay returned a different request: %s != %s", again.ID, first.ID)
	}
	if got := store.SpentToday(now); got.Cmp(big.NewInt(1_000)) != 0 {
		t.Fatalf("replay double-reserved the budget: %s", got)
	}
}

func TestAcceptEnforcesCooldownAndDailyCap(t *testing.T) {
	store, _ := newTestStore(t)
	address := common.HexToAddress("0x2222222222222222222222222222222222222222")
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	if _, _, err := store.Accept("key-one-aaa", address, now, "request-1"); err != nil {
		t.Fatalf("first accept failed: %v", err)
	}
	_, _, err := store.Accept("key-two-bbb", address, now.Add(time.Hour), "request-2")
	denial, ok := err.(*DenialError)
	if !ok || denial.Reason != "address is in cooldown" {
		t.Fatalf("expected cooldown denial, got %v", err)
	}
	if denial.RetryAfterSeconds <= 0 {
		t.Fatalf("cooldown denial must carry a retry-after hint")
	}
	// Even past the cooldown, the same UTC day stays capped at one request.
	_, _, err = store.Accept("key-three-cc", address, now.Add(25*time.Hour), "request-3")
	if err != nil {
		t.Fatalf("new-day accept failed: %v", err)
	}
}

func TestConcurrentAcceptsCannotOverspendBudget(t *testing.T) {
	store, _ := newTestStore(t)
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	var wg sync.WaitGroup
	accepted := make(chan string, 32)
	for index := range 32 {
		wg.Add(1)
		go func(sequence int) {
			defer wg.Done()
			address := common.BigToAddress(big.NewInt(int64(sequence + 1)))
			request, replayed, err := store.Accept("racing-key-0", address, now, common.BigToAddress(big.NewInt(int64(sequence+1000))).Hex())
			if err == nil && !replayed {
				accepted <- request.ID
			}
		}(index)
	}
	wg.Wait()
	close(accepted)
	total := 0
	for range accepted {
		total++
	}
	if total != 3 {
		t.Fatalf("budget admits exactly 3 requests, got %d", total)
	}
	if got := store.SpentToday(now); got.Cmp(big.NewInt(3_000)) != 0 {
		t.Fatalf("reserved budget mismatch: %s", got)
	}
}

func TestFailureReleasesBudgetReservation(t *testing.T) {
	store, _ := newTestStore(t)
	address := common.HexToAddress("0x3333333333333333333333333333333333333333")
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	request, _, err := store.Accept("release-key-1", address, now, "request-1")
	if err != nil {
		t.Fatalf("accept failed: %v", err)
	}
	if err := store.RecordFailed(request.ID, "test failure", now.Add(time.Second)); err != nil {
		t.Fatalf("record failed: %v", err)
	}
	if got := store.SpentToday(now); got.Sign() != 0 {
		t.Fatalf("failed request must release its reservation, got %s", got)
	}
}

func TestJournalReplayRebuildsIdenticalState(t *testing.T) {
	store, dataDir := newTestStore(t)
	address := common.HexToAddress("0x4444444444444444444444444444444444444444")
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	request, _, err := store.Accept("replay-key-11", address, now, "request-1")
	if err != nil {
		t.Fatalf("accept failed: %v", err)
	}
	hash := common.HexToHash("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err := store.RecordSubmitted(request.ID, hash, 7, common.HexToAddress("0x9999999999999999999999999999999999999999"), now.Add(time.Second)); err != nil {
		t.Fatalf("record submitted: %v", err)
	}
	if err := store.Pause("drill", now.Add(2*time.Second)); err != nil {
		t.Fatalf("pause: %v", err)
	}

	journal, entries, err := OpenJournal(dataDir)
	if err != nil {
		t.Fatalf("reopen journal: %v", err)
	}
	defer journal.Close()
	rebuilt, err := NewStore(journal, entries, testProfile(t))
	if err != nil {
		t.Fatalf("rebuild store: %v", err)
	}
	recovered, ok := rebuilt.Get(request.ID)
	if !ok {
		t.Fatalf("rebuilt store lost the request")
	}
	if recovered.Status != StatusSubmitted || recovered.Nonce != 7 || recovered.TransactionHash != hash.Hex() {
		t.Fatalf("rebuilt request state mismatch: %+v", recovered)
	}
	if paused, reason := rebuilt.Paused(); !paused || reason != "drill" {
		t.Fatalf("rebuilt pause state mismatch: %v %q", paused, reason)
	}
	if got := rebuilt.SpentToday(now); got.Cmp(big.NewInt(1_000)) != 0 {
		t.Fatalf("rebuilt budget mismatch: %s", got)
	}
	pending := rebuilt.PendingRequests()
	if len(pending) != 1 || pending[0].ID != request.ID {
		t.Fatalf("rebuilt pending set mismatch: %+v", pending)
	}
}

func TestJournalDetectsTampering(t *testing.T) {
	dataDir := t.TempDir()
	journalPath := filepath.Join(dataDir, "journal.jsonl")
	journal, _, err := OpenJournal(dataDir)
	if err != nil {
		t.Fatalf("open journal: %v", err)
	}
	if _, err := journal.Append(EntryServicePaused, time.Now(), map[string]string{"reason": "tamper-drill"}); err != nil {
		t.Fatalf("append: %v", err)
	}
	journal.Close()
	raw, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatalf("read journal: %v", err)
	}
	tampered := append([]byte(nil), raw...)
	// Flip one byte inside the recorded payload; the hash chain must notice.
	tampered[len(tampered)/2] ^= 0x01
	if err := os.WriteFile(journalPath, tampered, 0o600); err != nil {
		t.Fatalf("write tampered journal: %v", err)
	}
	if _, err := ReadJournal(journalPath); err == nil {
		t.Fatalf("tampered journal must fail verification")
	}
}

func TestSignerRotationFencesOldKey(t *testing.T) {
	store, _ := newTestStore(t)
	oldSigner := common.HexToAddress("0x5555555555555555555555555555555555555555")
	newSigner := common.HexToAddress("0x6666666666666666666666666666666666666666")
	if err := store.RecordRotation(oldSigner, newSigner, time.Now()); err != nil {
		t.Fatalf("record rotation: %v", err)
	}
	if !store.SignerFenced(oldSigner) {
		t.Fatalf("rotated-out signer must be fenced")
	}
	if store.SignerFenced(newSigner) {
		t.Fatalf("active signer must not be fenced")
	}
}

func TestRateLimiterBucketsAndLists(t *testing.T) {
	profile := testProfile(t)
	profile.DenylistCIDRs = []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}
	profile.AllowlistCIDRs = []netip.Prefix{netip.MustParsePrefix("198.51.100.0/24")}
	current := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	limiter := NewRateLimiter(profile, func() time.Time { return current })

	if reason := limiter.Admit(netip.MustParseAddr("192.0.2.10")); reason == "" {
		t.Fatalf("denylisted source must be rejected")
	}
	for range 10 {
		if reason := limiter.Admit(netip.MustParseAddr("198.51.100.9")); reason != "" {
			t.Fatalf("allowlisted source must bypass buckets: %s", reason)
		}
	}
	client := netip.MustParseAddr("203.0.113.7")
	if reason := limiter.Admit(client); reason != "" {
		t.Fatalf("first request rejected: %s", reason)
	}
	if reason := limiter.Admit(client); reason != "" {
		t.Fatalf("second request rejected: %s", reason)
	}
	if reason := limiter.Admit(client); reason == "" {
		t.Fatalf("per-IP bucket must reject the third burst request")
	}
	neighbour := netip.MustParseAddr("203.0.113.8")
	if reason := limiter.Admit(neighbour); reason != "" {
		t.Fatalf("neighbour first request rejected: %s", reason)
	}
	if reason := limiter.Admit(netip.MustParseAddr("203.0.113.9")); reason == "" {
		t.Fatalf("subnet bucket must reject the fourth burst request from one /24")
	}
	current = current.Add(2 * time.Minute)
	if reason := limiter.Admit(client); reason != "" {
		t.Fatalf("bucket must refill over time: %s", reason)
	}
}

func TestBreakersEvaluate(t *testing.T) {
	profile := testProfile(t)
	breakers := NewBreakers(profile)
	if state := breakers.Evaluate(big.NewInt(0)); state.OpenReason != "" {
		t.Fatalf("fresh breakers must be closed: %s", state.OpenReason)
	}
	if state := breakers.Evaluate(big.NewInt(3_000)); !state.BudgetSpent {
		t.Fatalf("budget breaker must open when the next request would overspend")
	}
	breakers.RecordRPCProbe(false)
	if state := breakers.Evaluate(big.NewInt(0)); state.RPCDown {
		t.Fatalf("one probe failure must not trip the RPC breaker")
	}
	breakers.RecordRPCProbe(false)
	if state := breakers.Evaluate(big.NewInt(0)); !state.RPCDown {
		t.Fatalf("consecutive probe failures must trip the RPC breaker")
	}
	breakers.RecordRPCProbe(true)
	if state := breakers.Evaluate(big.NewInt(0)); state.RPCDown {
		t.Fatalf("a healthy probe must close the RPC breaker")
	}
	breakers.RecordBalance(big.NewInt(100))
	if state := breakers.Evaluate(big.NewInt(0)); !state.BalanceFloor {
		t.Fatalf("balance below the halt floor must open the breaker")
	}
	breakers.RecordBalance(big.NewInt(10_000))
	for range 4 {
		breakers.RecordOutcome(false)
	}
	if state := breakers.Evaluate(big.NewInt(0)); !state.ErrorRateTripped {
		t.Fatalf("error-rate breaker must trip on a failing window")
	}
	breakers.ResetErrorWindow()
	if state := breakers.Evaluate(big.NewInt(0)); state.ErrorRateTripped {
		t.Fatalf("reset must close the error-rate breaker")
	}
}

func TestLoadSignerKeyFileRejectsLoosePermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "signer.key")
	key := "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
	if err := os.WriteFile(path, []byte(key), 0o644); err != nil {
		t.Fatalf("write key: %v", err)
	}
	if _, err := LoadSignerKeyFile(path); err == nil {
		t.Fatalf("world-readable key file must be rejected")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if _, err := LoadSignerKeyFile(path); err != nil {
		t.Fatalf("valid key file rejected: %v", err)
	}
}
