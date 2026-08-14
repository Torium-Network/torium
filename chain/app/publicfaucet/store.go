package publicfaucet

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// Request statuses from the reviewed design contract.
const (
	StatusQueued    = "queued"
	StatusSubmitted = "submitted"
	StatusConfirmed = "confirmed"
	StatusDenied    = "denied"
	StatusFailed    = "failed"
)

// Request is the public view of one funding request.
type Request struct {
	ID              string    `json:"id"`
	Status          string    `json:"status"`
	Address         string    `json:"address"`
	AmountBaseUnits string    `json:"amountBaseUnits"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
	Reason          string    `json:"reason,omitempty"`
	TransactionHash string    `json:"transactionHash,omitempty"`
	BlockNumber     uint64    `json:"blockNumber,omitempty"`
	Nonce           uint64    `json:"nonce,omitempty"`
	SignerAddress   string    `json:"signerAddress,omitempty"`
}

type addressState struct {
	lastAccepted time.Time
	dailyCount   map[string]int
}

// Store is the persistent-state core: idempotent accept decisions, address
// cooldown and daily-cap enforcement, and global budget reservation happen
// under one mutex so concurrent requests cannot double-spend a slot.
type Store struct {
	mu           sync.Mutex
	journal      *Journal
	profile      Profile
	requests     map[string]*Request
	order        []string
	idempotency  map[string]string
	addresses    map[common.Address]*addressState
	spentByDay   map[string]*big.Int
	paused       bool
	pauseReason  string
	fencedKeys   map[common.Address]time.Time
	activeSigner common.Address
}

// NewStore replays the journal into memory. Replay is strict: any state the
// journal cannot explain is a startup failure, never a silent reset.
func NewStore(journal *Journal, entries []Entry, profile Profile) (*Store, error) {
	store := &Store{
		journal:     journal,
		profile:     profile,
		requests:    make(map[string]*Request),
		idempotency: make(map[string]string),
		addresses:   make(map[common.Address]*addressState),
		spentByDay:  make(map[string]*big.Int),
		fencedKeys:  make(map[common.Address]time.Time),
	}
	for _, entry := range entries {
		if err := store.applyEntry(entry); err != nil {
			return nil, fmt.Errorf("replay journal entry %d: %w", entry.Sequence, err)
		}
	}
	return store, nil
}

func (store *Store) applyEntry(entry Entry) error {
	payload := entry.Payload
	switch entry.Type {
	case EntryRequestAccepted:
		request := &Request{
			ID:              payload["requestId"],
			Status:          StatusQueued,
			Address:         payload["address"],
			AmountBaseUnits: payload["amountBaseUnits"],
			CreatedAt:       entry.At,
			UpdatedAt:       entry.At,
		}
		if request.ID == "" || request.Address == "" {
			return fmt.Errorf("accepted request entry is missing identifiers")
		}
		store.requests[request.ID] = request
		store.order = append(store.order, request.ID)
		store.idempotency[payload["idempotencyKey"]] = request.ID
		address := common.HexToAddress(request.Address)
		state := store.addressStateFor(address)
		state.lastAccepted = entry.At
		state.dailyCount[BudgetDay(entry.At)]++
		amount, ok := new(big.Int).SetString(request.AmountBaseUnits, 10)
		if !ok {
			return fmt.Errorf("accepted request entry has an invalid amount")
		}
		store.addSpent(BudgetDay(entry.At), amount)
	case EntryRequestDenied:
		if payload["requestId"] == "" {
			return nil
		}
		store.requests[payload["requestId"]] = &Request{
			ID:              payload["requestId"],
			Status:          StatusDenied,
			Address:         payload["address"],
			AmountBaseUnits: payload["amountBaseUnits"],
			Reason:          payload["reason"],
			CreatedAt:       entry.At,
			UpdatedAt:       entry.At,
		}
		store.order = append(store.order, payload["requestId"])
	case EntryTxSubmitted:
		request, ok := store.requests[payload["requestId"]]
		if !ok {
			return fmt.Errorf("submitted entry references unknown request %q", payload["requestId"])
		}
		request.Status = StatusSubmitted
		request.TransactionHash = payload["transactionHash"]
		request.SignerAddress = payload["signerAddress"]
		request.UpdatedAt = entry.At
		if _, err := fmt.Sscanf(payload["nonce"], "%d", &request.Nonce); err != nil {
			return fmt.Errorf("submitted entry has an invalid nonce: %w", err)
		}
	case EntryTxConfirmed:
		request, ok := store.requests[payload["requestId"]]
		if !ok {
			return fmt.Errorf("confirmed entry references unknown request %q", payload["requestId"])
		}
		request.Status = StatusConfirmed
		request.TransactionHash = payload["transactionHash"]
		request.UpdatedAt = entry.At
		if _, err := fmt.Sscanf(payload["blockNumber"], "%d", &request.BlockNumber); err != nil {
			return fmt.Errorf("confirmed entry has an invalid block number: %w", err)
		}
	case EntryTxFailed:
		request, ok := store.requests[payload["requestId"]]
		if !ok {
			return fmt.Errorf("failed entry references unknown request %q", payload["requestId"])
		}
		request.Status = StatusFailed
		request.Reason = payload["reason"]
		request.UpdatedAt = entry.At
		// A failed request releases its budget reservation.
		amount, ok := new(big.Int).SetString(request.AmountBaseUnits, 10)
		if !ok {
			return fmt.Errorf("failed entry has an invalid amount")
		}
		store.addSpent(BudgetDay(request.CreatedAt), new(big.Int).Neg(amount))
	case EntryServicePaused:
		store.paused = true
		store.pauseReason = payload["reason"]
	case EntryServiceResumed:
		store.paused = false
		store.pauseReason = ""
	case EntrySignerRotated:
		if payload["oldSigner"] != "" {
			store.fencedKeys[common.HexToAddress(payload["oldSigner"])] = entry.At
		}
		store.activeSigner = common.HexToAddress(payload["newSigner"])
	case EntryRefillObserved:
		// Informational; balances are read from the chain.
	default:
		return fmt.Errorf("unknown journal entry type %q", entry.Type)
	}
	return nil
}

func (store *Store) addressStateFor(address common.Address) *addressState {
	state, ok := store.addresses[address]
	if !ok {
		state = &addressState{dailyCount: make(map[string]int)}
		store.addresses[address] = state
	}
	return state
}

func (store *Store) addSpent(day string, amount *big.Int) {
	current, ok := store.spentByDay[day]
	if !ok {
		current = new(big.Int)
		store.spentByDay[day] = current
	}
	current.Add(current, amount)
	if current.Sign() < 0 {
		current.SetInt64(0)
	}
}

// DenialError is a structured accept-time rejection.
type DenialError struct {
	Reason            string
	RetryAfterSeconds int64
}

func (denial *DenialError) Error() string { return denial.Reason }

// IdempotencyKeyFor scopes a client idempotency key to (address, UTC day) as
// required by the design contract.
func IdempotencyKeyFor(clientKey string, address common.Address, at time.Time) string {
	return strings.ToLower(address.Hex()) + "|" + BudgetDay(at) + "|" + clientKey
}

// FindReplay returns the original request for a repeated idempotency key.
// Replays are status reads, not new funding, so callers may serve them even
// while breakers are open or the service is paused.
func (store *Store) FindReplay(clientKey string, address common.Address, at time.Time) (*Request, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	existingID, ok := store.idempotency[IdempotencyKeyFor(clientKey, address, at)]
	if !ok {
		return nil, false
	}
	existing := store.requests[existingID]
	if existing == nil {
		return nil, false
	}
	snapshot := *existing
	return &snapshot, true
}

// Accept atomically applies idempotency, pause state, cooldown, the
// per-address daily cap, and the global daily budget. It journals and
// returns the accepted request, or the original request for a replay, or a
// DenialError. The journal write happens inside the lock: a request is only
// accepted once it is durable.
func (store *Store) Accept(clientKey string, address common.Address, at time.Time, requestID string) (*Request, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	scopedKey := IdempotencyKeyFor(clientKey, address, at)
	if existingID, ok := store.idempotency[scopedKey]; ok {
		existing := store.requests[existingID]
		if existing == nil {
			return nil, false, fmt.Errorf("idempotency index references unknown request %q", existingID)
		}
		snapshot := *existing
		return &snapshot, true, nil
	}
	if store.paused {
		return nil, false, &DenialError{Reason: "service is paused"}
	}
	now := at.UTC()
	day := BudgetDay(now)
	state := store.addressStateFor(address)
	if !state.lastAccepted.IsZero() {
		cooldownEnds := state.lastAccepted.Add(store.profile.CooldownPerAddress)
		if now.Before(cooldownEnds) {
			return nil, false, &DenialError{
				Reason:            "address is in cooldown",
				RetryAfterSeconds: int64(cooldownEnds.Sub(now)/time.Second) + 1,
			}
		}
	}
	if state.dailyCount[day] >= store.profile.PerAddressDailyCap {
		return nil, false, &DenialError{Reason: "address reached the daily request cap"}
	}
	spent := store.spentByDay[day]
	if spent == nil {
		spent = new(big.Int)
	}
	projected := new(big.Int).Add(spent, store.profile.AmountPerRequest)
	if projected.Cmp(store.profile.GlobalDailyBudget) > 0 {
		return nil, false, &DenialError{Reason: "global daily budget is exhausted"}
	}
	entry, err := store.journal.Append(EntryRequestAccepted, now, map[string]string{
		"requestId":       requestID,
		"idempotencyKey":  scopedKey,
		"address":         address.Hex(),
		"amountBaseUnits": store.profile.AmountPerRequest.String(),
	})
	if err != nil {
		return nil, false, err
	}
	if err := store.applyEntry(entry); err != nil {
		return nil, false, err
	}
	accepted := *store.requests[requestID]
	return &accepted, false, nil
}

// RecordDenied journals a denial that carries a request identifier so
// clients polling /v1/requests/{id} see a terminal denied state.
func (store *Store) RecordDenied(requestID string, address common.Address, reason string, at time.Time) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	entry, err := store.journal.Append(EntryRequestDenied, at, map[string]string{
		"requestId":       requestID,
		"address":         address.Hex(),
		"amountBaseUnits": store.profile.AmountPerRequest.String(),
		"reason":          reason,
	})
	if err != nil {
		return err
	}
	return store.applyEntry(entry)
}

// RecordSubmitted journals a broadcast transaction for one request.
func (store *Store) RecordSubmitted(requestID string, transactionHash common.Hash, nonce uint64, signer common.Address, at time.Time) error {
	return store.transition(EntryTxSubmitted, at, map[string]string{
		"requestId":       requestID,
		"transactionHash": transactionHash.Hex(),
		"nonce":           fmt.Sprintf("%d", nonce),
		"signerAddress":   signer.Hex(),
	})
}

// RecordConfirmed journals a successful receipt for one request.
func (store *Store) RecordConfirmed(requestID string, transactionHash common.Hash, blockNumber uint64, at time.Time) error {
	return store.transition(EntryTxConfirmed, at, map[string]string{
		"requestId":       requestID,
		"transactionHash": transactionHash.Hex(),
		"blockNumber":     fmt.Sprintf("%d", blockNumber),
	})
}

// RecordFailed journals a terminal failure and releases the budget hold.
func (store *Store) RecordFailed(requestID, reason string, at time.Time) error {
	return store.transition(EntryTxFailed, at, map[string]string{
		"requestId": requestID,
		"reason":    reason,
	})
}

func (store *Store) transition(entryType string, at time.Time, payload map[string]string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	entry, err := store.journal.Append(entryType, at, payload)
	if err != nil {
		return err
	}
	return store.applyEntry(entry)
}

// Pause journals and applies the emergency pause switch.
func (store *Store) Pause(reason string, at time.Time) error {
	return store.transition(EntryServicePaused, at, map[string]string{"reason": reason})
}

// Resume journals and applies the end of a pause.
func (store *Store) Resume(at time.Time) error {
	return store.transition(EntryServiceResumed, at, map[string]string{})
}

// RecordRotation journals a signer rotation and fences the old key.
func (store *Store) RecordRotation(oldSigner, newSigner common.Address, at time.Time) error {
	payload := map[string]string{"newSigner": newSigner.Hex()}
	if oldSigner != (common.Address{}) {
		payload["oldSigner"] = oldSigner.Hex()
	}
	return store.transition(EntrySignerRotated, at, payload)
}

// RecordRefill journals an observed refill with public identifiers only.
func (store *Store) RecordRefill(source, amountBaseUnits string, at time.Time) error {
	return store.transition(EntryRefillObserved, at, map[string]string{
		"source":          source,
		"amountBaseUnits": amountBaseUnits,
	})
}

// Get returns a copy of one request by identifier.
func (store *Store) Get(requestID string) (Request, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	request, ok := store.requests[requestID]
	if !ok {
		return Request{}, false
	}
	return *request, true
}

// Paused reports the persistent pause switch.
func (store *Store) Paused() (bool, string) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.paused, store.pauseReason
}

// SignerFenced reports whether a signer address was rotated out. A fenced
// key must never sign again.
func (store *Store) SignerFenced(signer common.Address) bool {
	store.mu.Lock()
	defer store.mu.Unlock()
	_, fenced := store.fencedKeys[signer]
	return fenced
}

// SpentToday returns the reserved-plus-confirmed budget for the UTC day.
func (store *Store) SpentToday(at time.Time) *big.Int {
	store.mu.Lock()
	defer store.mu.Unlock()
	spent := store.spentByDay[BudgetDay(at)]
	if spent == nil {
		return new(big.Int)
	}
	return new(big.Int).Set(spent)
}

// PendingRequests returns queued and submitted requests in acceptance order;
// the worker uses this for restart reconciliation.
func (store *Store) PendingRequests() []Request {
	store.mu.Lock()
	defer store.mu.Unlock()
	var pending []Request
	for _, id := range store.order {
		request := store.requests[id]
		if request.Status == StatusQueued || request.Status == StatusSubmitted {
			pending = append(pending, *request)
		}
	}
	sort.SliceStable(pending, func(left, right int) bool {
		return pending[left].CreatedAt.Before(pending[right].CreatedAt)
	})
	return pending
}
