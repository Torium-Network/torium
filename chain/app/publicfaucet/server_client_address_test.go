package publicfaucet

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestClientAddressTrustsOnlyTheDirectPeerByDefault(t *testing.T) {
	service := &Service{}
	request := httptest.NewRequest("POST", "/v1/fund", nil)
	request.RemoteAddr = "203.0.113.7:41000"
	request.Header.Set("X-Forwarded-For", "198.51.100.1")

	address, err := service.clientAddress(request)
	if err != nil {
		t.Fatalf("clientAddress: %v", err)
	}
	if want := netip.MustParseAddr("203.0.113.7"); address != want {
		t.Fatalf("client-supplied X-Forwarded-For must be ignored: got %s, want %s", address, want)
	}
}

func TestClientAddressUsesRightmostForwardedEntryBehindTrustedProxy(t *testing.T) {
	service := &Service{}
	service.SetTrustedProxies([]netip.Prefix{netip.MustParsePrefix("172.16.0.0/12")})
	request := httptest.NewRequest("POST", "/v1/fund", nil)
	request.RemoteAddr = "172.30.0.4:56000"
	// A forging client sent one entry; the trusted proxy appended the real one.
	request.Header.Set("X-Forwarded-For", "198.51.100.1, 203.0.113.7")

	address, err := service.clientAddress(request)
	if err != nil {
		t.Fatalf("clientAddress: %v", err)
	}
	if want := netip.MustParseAddr("203.0.113.7"); address != want {
		t.Fatalf("rightmost proxy-written entry must win: got %s, want %s", address, want)
	}
}

func TestClientAddressFailsClosedWhenTrustedProxySendsNoHeader(t *testing.T) {
	service := &Service{}
	service.SetTrustedProxies([]netip.Prefix{netip.MustParsePrefix("172.16.0.0/12")})
	request := httptest.NewRequest("POST", "/v1/fund", nil)
	request.RemoteAddr = "172.30.0.4:56000"

	if _, err := service.clientAddress(request); err == nil {
		t.Fatal("a trusted proxy without X-Forwarded-For must fail closed")
	}
}

func TestParseTrustedProxiesAcceptsCIDRsAndBareAddresses(t *testing.T) {
	prefixes, err := ParseTrustedProxies("172.16.0.0/12, 10.90.0.3")
	if err != nil {
		t.Fatalf("ParseTrustedProxies: %v", err)
	}
	if len(prefixes) != 2 {
		t.Fatalf("expected 2 prefixes, got %d", len(prefixes))
	}
	if !prefixes[1].Contains(netip.MustParseAddr("10.90.0.3")) {
		t.Fatal("bare address must become a single-address range")
	}
	if _, err := ParseTrustedProxies("not-an-address"); err == nil {
		t.Fatal("invalid entries must be rejected")
	}
}
