package publicfaucet

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Journal entry types. The journal is the append-only, hash-chained audit
// log required by the #172 design; it doubles as the persistent request and
// budget state that survives restarts.
const (
	EntryRequestAccepted = "request-accepted"
	EntryRequestDenied   = "request-denied"
	EntryTxSubmitted     = "tx-submitted"
	EntryTxConfirmed     = "tx-confirmed"
	EntryTxFailed        = "tx-failed"
	EntryServicePaused   = "service-paused"
	EntryServiceResumed  = "service-resumed"
	EntrySignerRotated   = "signer-rotated"
	EntryRefillObserved  = "refill-observed"
)

// Entry is one hash-chained audit record. Payload only ever contains public
// identifiers: addresses, hashes, amounts, reasons — never secrets or IPs.
type Entry struct {
	Sequence uint64            `json:"sequence"`
	At       time.Time         `json:"at"`
	Type     string            `json:"type"`
	Payload  map[string]string `json:"payload"`
	PrevHash string            `json:"prevHash"`
	Hash     string            `json:"hash"`
}

// Journal is an append-only JSONL file with a SHA-256 hash chain.
type Journal struct {
	mu       sync.Mutex
	file     *os.File
	sequence uint64
	lastHash string
}

const journalGenesisHash = "0000000000000000000000000000000000000000000000000000000000000000"

// OpenJournal opens or creates the journal, verifying the existing chain and
// returning the replayed entries.
func OpenJournal(dataDir string) (*Journal, []Entry, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, nil, fmt.Errorf("create public faucet data directory: %w", err)
	}
	path := filepath.Join(dataDir, "journal.jsonl")
	entries, err := ReadJournal(path)
	if err != nil {
		return nil, nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, nil, fmt.Errorf("open public faucet journal: %w", err)
	}
	journal := &Journal{file: file, lastHash: journalGenesisHash}
	if len(entries) > 0 {
		last := entries[len(entries)-1]
		journal.sequence = last.Sequence
		journal.lastHash = last.Hash
	}
	return journal, entries, nil
}

// ReadJournal loads and verifies a journal file without opening it for
// writes. A missing file yields zero entries.
func ReadJournal(path string) ([]Entry, error) {
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read public faucet journal: %w", err)
	}
	defer file.Close()
	var entries []Entry
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	prevHash := journalGenesisHash
	line := 0
	for scanner.Scan() {
		line++
		var entry Entry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			return nil, fmt.Errorf("journal line %d is not valid JSON: %w", line, err)
		}
		if entry.PrevHash != prevHash {
			return nil, fmt.Errorf("journal line %d breaks the hash chain", line)
		}
		if entry.Sequence != uint64(line) {
			return nil, fmt.Errorf("journal line %d has sequence %d", line, entry.Sequence)
		}
		expected, err := entryHash(entry)
		if err != nil {
			return nil, err
		}
		if entry.Hash != expected {
			return nil, fmt.Errorf("journal line %d fails hash verification", line)
		}
		prevHash = entry.Hash
		entries = append(entries, entry)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan public faucet journal: %w", err)
	}
	return entries, nil
}

// Append writes one entry, extending the hash chain and syncing to disk
// before returning so accepted state survives a crash.
func (journal *Journal) Append(entryType string, at time.Time, payload map[string]string) (Entry, error) {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	entry := Entry{
		Sequence: journal.sequence + 1,
		At:       at.UTC(),
		Type:     entryType,
		Payload:  payload,
		PrevHash: journal.lastHash,
	}
	hash, err := entryHash(entry)
	if err != nil {
		return Entry{}, err
	}
	entry.Hash = hash
	encoded, err := json.Marshal(entry)
	if err != nil {
		return Entry{}, fmt.Errorf("encode journal entry: %w", err)
	}
	if _, err := journal.file.Write(append(encoded, '\n')); err != nil {
		return Entry{}, fmt.Errorf("append journal entry: %w", err)
	}
	if err := journal.file.Sync(); err != nil {
		return Entry{}, fmt.Errorf("sync journal entry: %w", err)
	}
	journal.sequence = entry.Sequence
	journal.lastHash = entry.Hash
	return entry, nil
}

// Close releases the journal file handle.
func (journal *Journal) Close() error {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	return journal.file.Close()
}

func entryHash(entry Entry) (string, error) {
	hashable := Entry{
		Sequence: entry.Sequence,
		At:       entry.At,
		Type:     entry.Type,
		Payload:  entry.Payload,
		PrevHash: entry.PrevHash,
	}
	encoded, err := json.Marshal(hashable)
	if err != nil {
		return "", fmt.Errorf("encode journal entry for hashing: %w", err)
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}
