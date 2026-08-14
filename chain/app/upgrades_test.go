package torium

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"cosmossdk.io/log/v2"
	"github.com/cosmos/cosmos-db"
	sdkserver "github.com/cosmos/cosmos-sdk/server"
	"github.com/cosmos/cosmos-sdk/types/module"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"
	toriumversion "github.com/torium-network/torium-chain/internal/version"
)

func TestToriumLocalV1UpgradeInfoIsStrictAndVersionBound(t *testing.T) {
	valid := toriumUpgradeInfo{
		SchemaVersion:   toriumUpgradeInfoVersion,
		PlanName:        toriumLocalV1PlanName,
		TargetVersion:   "0.2.0-local.1",
		BinarySHA256:    strings.Repeat("a", 64),
		ProtocolVersion: toriumversion.ProtocolVersion,
		MigrationSHA256: toriumLocalV1MigrationSHA256(),
	}
	contents, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	plan := upgradetypes.Plan{Name: toriumLocalV1PlanName, Height: 42, Info: string(contents)}
	actual, err := validateToriumUpgradeInfo(plan, valid.TargetVersion)
	if err != nil || actual != valid {
		t.Fatalf("valid upgrade info rejected: actual=%+v error=%v", actual, err)
	}

	tests := []struct {
		name   string
		mutate func(*upgradetypes.Plan)
		want   string
	}{
		{"wrong plan", func(plan *upgradetypes.Plan) { plan.Name = "sample" }, "invalid Torium upgrade plan"},
		{"zero height", func(plan *upgradetypes.Plan) { plan.Height = 0 }, "invalid Torium upgrade plan"},
		{"wrong target", func(plan *upgradetypes.Plan) { plan.Info = strings.ReplaceAll(plan.Info, valid.TargetVersion, "0.3.0") }, "target version"},
		{"wrong protocol", func(plan *upgradetypes.Plan) {
			plan.Info = strings.ReplaceAll(plan.Info, toriumversion.ProtocolVersion, "1.0.0-local.999")
		}, "protocol version"},
		{"wrong migration", func(plan *upgradetypes.Plan) {
			plan.Info = strings.ReplaceAll(plan.Info, valid.MigrationSHA256, strings.Repeat("b", 64))
		}, "migration checksum"},
		{"uppercase binary checksum", func(plan *upgradetypes.Plan) {
			plan.Info = strings.ReplaceAll(plan.Info, strings.Repeat("a", 64), strings.Repeat("A", 64))
		}, "lowercase SHA-256"},
		{"unknown field", func(plan *upgradetypes.Plan) { plan.Info = strings.TrimSuffix(plan.Info, "}") + `,"admin":true}` }, "unknown field"},
		{"trailing JSON", func(plan *upgradetypes.Plan) { plan.Info += `{}` }, "trailing JSON"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := plan
			test.mutate(&candidate)
			_, err := validateToriumUpgradeInfo(candidate, valid.TargetVersion)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error=%v, expected %q", err, test.want)
			}
		})
	}
}

func TestToriumMigrationChecksumAndVersionMapDigestAreDeterministic(t *testing.T) {
	if actual, expected := toriumLocalV1MigrationSHA256(), "47f5aa5306c8a116260395bb9f0a9ac0a7c8ddb96f9f6ac56af7156a65f8355d"; actual != expected {
		t.Fatalf("migration checksum %s, expected %s", actual, expected)
	}
	first := module.VersionMap{"staking": 5, "auth": 4, "evm": 1}
	second := module.VersionMap{"evm": 1, "auth": 4, "staking": 5}
	firstDigest, err := moduleVersionMapDigest(first)
	if err != nil {
		t.Fatal(err)
	}
	secondDigest, err := moduleVersionMapDigest(second)
	if err != nil {
		t.Fatal(err)
	}
	if firstDigest != secondDigest || !validSHA256(firstDigest) {
		t.Fatalf("version map digest is not canonical: %s/%s", firstDigest, secondDigest)
	}
	clone := cloneVersionMap(first)
	clone["auth"] = 99
	if first["auth"] != 4 {
		t.Fatal("version map clone aliases its source")
	}
}

func TestCurrentExecutableHasChecksummableUpgradeArtifact(t *testing.T) {
	digest, err := executableSHA256()
	if err != nil {
		t.Fatal(err)
	}
	if !validSHA256(digest) {
		t.Fatalf("invalid executable SHA-256 %q", digest)
	}
}

func TestToriumUpgradeStoreIsAddedOnlyByPostUpgradeProfile(t *testing.T) {
	if contractTestApp.GetKey(toriumUpgradeStoreKey) != nil {
		t.Fatal("pre-upgrade binary mounted the post-upgrade marker store at genesis")
	}
	if toriumversion.UpgradeProfile != toriumUpgradeProfilePre {
		t.Fatalf("test binary profile is %q, expected pre", toriumversion.UpgradeProfile)
	}
	if contractTestApp.UpgradeKeeper.HasHandler(toriumLocalV1PlanName) {
		t.Fatal("pre-upgrade binary registered the post-upgrade handler")
	}
}

func TestToriumRejectsUnsafeSkipUpgradeHeights(t *testing.T) {
	defer func() {
		value := recover()
		if value == nil || !strings.Contains(fmt.Sprint(value), "unsafe skip-upgrade heights are unsupported") {
			t.Fatalf("unexpected panic: %v", value)
		}
	}()
	NewToriumApp(log.NewNopLogger(), db.NewMemDB(), false, mapAppOptions{
		sdkserver.FlagUnsafeSkipUpgrades: []int{42},
	})
}
