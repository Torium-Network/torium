package censorfixture

import (
	"encoding/hex"
	"testing"
)

func TestParsePolicy(t *testing.T) {
	t.Parallel()

	off, err := ParsePolicy("")
	if err != nil || off.Mode != ModeOff {
		t.Fatalf("empty switch produced %+v (%v)", off, err)
	}
	blank, err := ParsePolicy("   ")
	if err != nil || blank.Mode != ModeOff {
		t.Fatalf("blank switch produced %+v (%v)", blank, err)
	}
	all, err := ParsePolicy("all")
	if err != nil || all.Mode != ModeAll {
		t.Fatalf("\"all\" produced %+v (%v)", all, err)
	}
	needle, err := ParsePolicy("hex:DEADbeef")
	if err != nil || needle.Mode != ModeHexNeedle || needle.Needle != "deadbeef" {
		t.Fatalf("hex switch produced %+v (%v)", needle, err)
	}

	// A misconfigured drill must fail loudly. A silent no-op would report a
	// false negative: "the proposer did not censor" when it was never asked to.
	for _, value := range []string{"none", "off", "ALL", "hex:", "hex:zz", "drop-all", "hex: deadbeef"} {
		if _, err := ParsePolicy(value); err == nil {
			t.Fatalf("switch value %q was accepted", value)
		}
	}
}

func TestPolicyCensors(t *testing.T) {
	t.Parallel()

	payload, err := hex.DecodeString("0a1b2c3ddeadbeef4f5e")
	if err != nil {
		t.Fatal(err)
	}
	other, err := hex.DecodeString("0a1b2c3d99887766554f")
	if err != nil {
		t.Fatal(err)
	}

	off := Policy{Mode: ModeOff}
	if off.Censors(payload) || off.Censors(other) {
		t.Fatal("an off policy censored a transaction")
	}
	all := Policy{Mode: ModeAll}
	if !all.Censors(payload) || !all.Censors(other) || !all.Censors(nil) {
		t.Fatal("an all policy let a transaction through")
	}
	targeted := Policy{Mode: ModeHexNeedle, Needle: "deadbeef"}
	if !targeted.Censors(payload) {
		t.Fatal("a targeted policy missed its needle")
	}
	if targeted.Censors(other) {
		t.Fatal("a targeted policy censored an unrelated transaction")
	}
	if targeted.Censors(nil) {
		t.Fatal("a targeted policy censored an empty transaction")
	}
}

func TestDescribe(t *testing.T) {
	t.Parallel()

	cases := map[string]Policy{
		"off":                    {Mode: ModeOff},
		"drop-every-transaction": {Mode: ModeAll},
		"drop-transactions-containing-hex:abc123": {Mode: ModeHexNeedle, Needle: "abc123"},
	}
	for expected, policy := range cases {
		if policy.Describe() != expected {
			t.Fatalf("policy %+v described as %q, expected %q", policy, policy.Describe(), expected)
		}
	}
}
