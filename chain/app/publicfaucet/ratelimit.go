package publicfaucet

import (
	"net/netip"
	"sync"
	"time"
)

type bucket struct {
	tokens   float64
	lastFill time.Time
}

// RateLimiter enforces per-IP and per-subnet token buckets plus the manual
// deny/allow lists from the reviewed profile. Bucket state is in-memory by
// design: it protects the accept path, while the durable budget and
// per-address limits live in the journal-backed store.
type RateLimiter struct {
	mu      sync.Mutex
	profile Profile
	ips     map[netip.Addr]*bucket
	subnets map[netip.Prefix]*bucket
	now     func() time.Time
}

// NewRateLimiter builds the limiter for one profile.
func NewRateLimiter(profile Profile, now func() time.Time) *RateLimiter {
	if now == nil {
		now = time.Now
	}
	return &RateLimiter{
		profile: profile,
		ips:     make(map[netip.Addr]*bucket),
		subnets: make(map[netip.Prefix]*bucket),
		now:     now,
	}
}

// subnetFor groups addresses into abuse-scoring subnets: /24 for IPv4 and
// /48 for IPv6.
func subnetFor(address netip.Addr) netip.Prefix {
	bits := 24
	if address.Is6() && !address.Is4In6() {
		bits = 48
	}
	prefix, err := address.Prefix(bits)
	if err != nil {
		return netip.PrefixFrom(address, address.BitLen())
	}
	return prefix
}

// Admit returns a denial reason for a client address, or an empty string
// when the request may proceed. Allowlisted sources bypass the buckets but
// never the store's address and budget limits.
func (limiter *RateLimiter) Admit(address netip.Addr) string {
	address = address.Unmap()
	for _, prefix := range limiter.profile.DenylistCIDRs {
		if prefix.Contains(address) {
			return "source address is denylisted"
		}
	}
	for _, prefix := range limiter.profile.AllowlistCIDRs {
		if prefix.Contains(address) {
			return ""
		}
	}
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	now := limiter.now()
	ipBucket, ok := limiter.ips[address]
	if !ok {
		ipBucket = &bucket{tokens: float64(limiter.profile.PerIPBurst), lastFill: now}
		limiter.ips[address] = ipBucket
	}
	refill(ipBucket, now, float64(limiter.profile.PerIPBurst), limiter.profile.PerIPRefillSeconds)
	subnet := subnetFor(address)
	subnetBucket, ok := limiter.subnets[subnet]
	if !ok {
		subnetBucket = &bucket{tokens: float64(limiter.profile.SubnetBurst), lastFill: now}
		limiter.subnets[subnet] = subnetBucket
	}
	refill(subnetBucket, now, float64(limiter.profile.SubnetBurst), limiter.profile.SubnetRefillSeconds)
	if ipBucket.tokens < 1 {
		return "source address exceeded its request rate"
	}
	if subnetBucket.tokens < 1 {
		return "source network exceeded its request rate"
	}
	ipBucket.tokens--
	subnetBucket.tokens--
	return ""
}

func refill(target *bucket, now time.Time, capacity float64, secondsPerToken int) {
	elapsed := now.Sub(target.lastFill).Seconds()
	if elapsed <= 0 {
		return
	}
	target.tokens += elapsed / float64(secondsPerToken)
	if target.tokens > capacity {
		target.tokens = capacity
	}
	target.lastFill = now
}
