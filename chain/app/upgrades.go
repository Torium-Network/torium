package torium

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"
	toriumversion "github.com/torium-network/torium-chain/internal/version"
)

const (
	toriumUpgradeStoreKey      = "toriumupgrade"
	toriumLocalV1PlanName      = "torium-local-v1"
	toriumUpgradeMarkerVersion = 1
	toriumUpgradeInfoVersion   = 1
	toriumUpgradeProfilePre    = "pre"
	toriumUpgradeProfilePost   = "post"
	toriumUpgradeProfileFailed = "failed-rehearsal"

	// Any semantic change to the migration requires a new checksum in the
	// proposal info. This binds the named plan to reviewed migration intent,
	// while the operator preflight separately verifies the executable checksum.
	toriumLocalV1MigrationSpec = "torium-local-v1:add-marker-store;run-module-migrations;write-marker-v1;preserve-native-supply"
)

var toriumUpgradeMarkerKey = []byte{0x01}

type toriumUpgradeInfo struct {
	SchemaVersion   int    `json:"schemaVersion"`
	PlanName        string `json:"planName"`
	TargetVersion   string `json:"targetVersion"`
	BinarySHA256    string `json:"binarySha256"`
	ProtocolVersion string `json:"protocolVersion"`
	MigrationSHA256 string `json:"migrationSha256"`
}

type toriumUpgradeMarker struct {
	SchemaVersion            int    `json:"schemaVersion"`
	PlanName                 string `json:"planName"`
	Height                   int64  `json:"height"`
	TargetVersion            string `json:"targetVersion"`
	ProtocolVersion          string `json:"protocolVersion"`
	MigrationSHA256          string `json:"migrationSha256"`
	FromModuleVersionsSHA256 string `json:"fromModuleVersionsSha256"`
	ToModuleVersionsSHA256   string `json:"toModuleVersionsSha256"`
	NativeSupplyBaseUnits    string `json:"nativeSupplyBaseUnits"`
}

// RegisterUpgradeHandlers installs only the handler compiled into this binary.
// The profile is a build-time ldflag, never a runtime environment switch.
func (app *ToriumApp) RegisterUpgradeHandlers() {
	switch toriumversion.UpgradeProfile {
	case toriumUpgradeProfilePre:
		return
	case toriumUpgradeProfilePost:
		app.UpgradeKeeper.SetUpgradeHandler(toriumLocalV1PlanName, app.toriumLocalV1UpgradeHandler(false))
	case toriumUpgradeProfileFailed:
		app.UpgradeKeeper.SetUpgradeHandler(toriumLocalV1PlanName, app.toriumLocalV1UpgradeHandler(true))
	default:
		panic(fmt.Sprintf("unsupported Torium upgrade profile %q", toriumversion.UpgradeProfile))
	}
	app.configureToriumUpgradeStoreLoader()
}

func (app *ToriumApp) configureToriumUpgradeStoreLoader() {
	info, err := app.UpgradeKeeper.ReadUpgradeInfoFromDisk()
	if err != nil {
		panic(fmt.Sprintf("read Torium upgrade info: %s", err))
	}
	if info.Name == "" && info.Height == 0 {
		panic("BINARY UPDATED BEFORE TRIGGER: Torium upgrade profile requires data/upgrade-info.json from the pre-upgrade halt")
	}
	if info.Name != toriumLocalV1PlanName {
		panic(fmt.Sprintf("upgrade info names unsupported plan %q", info.Name))
	}
	app.SetStoreLoader(upgradetypes.UpgradeStoreLoader(info.Height, &storetypes.StoreUpgrades{
		Added: []string{toriumUpgradeStoreKey},
	}))
}

func (app *ToriumApp) toriumLocalV1UpgradeHandler(failRehearsal bool) upgradetypes.UpgradeHandler {
	return func(ctx context.Context, plan upgradetypes.Plan, fromVM module.VersionMap) (module.VersionMap, error) {
		info, err := validateToriumUpgradeInfo(plan, toriumversion.Version)
		if err != nil {
			return nil, err
		}
		beforeSupply := app.BankKeeper.GetSupply(ctx, BaseDenom).Amount
		fromDigest, err := moduleVersionMapDigest(fromVM)
		if err != nil {
			return nil, fmt.Errorf("digest pre-upgrade module versions: %w", err)
		}

		if failRehearsal {
			marker := toriumUpgradeMarker{
				SchemaVersion:            toriumUpgradeMarkerVersion,
				PlanName:                 plan.Name,
				Height:                   plan.Height,
				TargetVersion:            info.TargetVersion,
				ProtocolVersion:          info.ProtocolVersion,
				MigrationSHA256:          info.MigrationSHA256,
				FromModuleVersionsSHA256: fromDigest,
				ToModuleVersionsSHA256:   strings.Repeat("0", sha256.Size*2),
				NativeSupplyBaseUnits:    beforeSupply.String(),
			}
			if err := app.writeToriumUpgradeMarker(ctx, marker); err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("intentional Torium failed-migration rehearsal")
		}

		toVM, err := app.ModuleManager.RunMigrations(ctx, app.configurator, cloneVersionMap(fromVM))
		if err != nil {
			return nil, fmt.Errorf("run Torium module migrations: %w", err)
		}
		afterSupply := app.BankKeeper.GetSupply(ctx, BaseDenom).Amount
		if !afterSupply.Equal(beforeSupply) {
			return nil, fmt.Errorf("native supply changed during upgrade: before %s after %s", beforeSupply, afterSupply)
		}
		toDigest, err := moduleVersionMapDigest(toVM)
		if err != nil {
			return nil, fmt.Errorf("digest post-upgrade module versions: %w", err)
		}
		marker := toriumUpgradeMarker{
			SchemaVersion:            toriumUpgradeMarkerVersion,
			PlanName:                 plan.Name,
			Height:                   plan.Height,
			TargetVersion:            info.TargetVersion,
			ProtocolVersion:          info.ProtocolVersion,
			MigrationSHA256:          info.MigrationSHA256,
			FromModuleVersionsSHA256: fromDigest,
			ToModuleVersionsSHA256:   toDigest,
			NativeSupplyBaseUnits:    afterSupply.String(),
		}
		if err := app.writeToriumUpgradeMarker(ctx, marker); err != nil {
			return nil, err
		}
		markerBytes, err := json.Marshal(marker)
		if err != nil {
			return nil, fmt.Errorf("marshal Torium upgrade marker event: %w", err)
		}
		markerDigest := sha256.Sum256(markerBytes)
		sdk.UnwrapSDKContext(ctx).EventManager().EmitEvent(sdk.NewEvent(
			"torium_upgrade_applied",
			sdk.NewAttribute("plan", plan.Name),
			sdk.NewAttribute("height", fmt.Sprintf("%d", plan.Height)),
			sdk.NewAttribute("target_version", info.TargetVersion),
			sdk.NewAttribute("migration_sha256", info.MigrationSHA256),
			sdk.NewAttribute("marker_sha256", hex.EncodeToString(markerDigest[:])),
		))
		return toVM, nil
	}
}

func validateToriumUpgradeInfo(plan upgradetypes.Plan, targetVersion string) (toriumUpgradeInfo, error) {
	if plan.Name != toriumLocalV1PlanName || plan.Height <= 0 {
		return toriumUpgradeInfo{}, fmt.Errorf("invalid Torium upgrade plan %q at height %d", plan.Name, plan.Height)
	}
	decoder := json.NewDecoder(bytes.NewBufferString(plan.Info))
	decoder.DisallowUnknownFields()
	var info toriumUpgradeInfo
	if err := decoder.Decode(&info); err != nil {
		return toriumUpgradeInfo{}, fmt.Errorf("decode Torium upgrade info: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return toriumUpgradeInfo{}, err
	}
	if info.SchemaVersion != toriumUpgradeInfoVersion || info.PlanName != plan.Name {
		return toriumUpgradeInfo{}, fmt.Errorf("torium upgrade info identity mismatch")
	}
	if info.TargetVersion != targetVersion {
		return toriumUpgradeInfo{}, fmt.Errorf("upgrade target version %q does not match binary %q", info.TargetVersion, targetVersion)
	}
	if info.ProtocolVersion != toriumversion.ProtocolVersion {
		return toriumUpgradeInfo{}, fmt.Errorf("upgrade protocol version %q does not match %q", info.ProtocolVersion, toriumversion.ProtocolVersion)
	}
	if info.MigrationSHA256 != toriumLocalV1MigrationSHA256() {
		return toriumUpgradeInfo{}, fmt.Errorf("upgrade migration checksum mismatch")
	}
	if !validSHA256(info.BinarySHA256) {
		return toriumUpgradeInfo{}, fmt.Errorf("upgrade binary checksum must be lowercase SHA-256")
	}
	return info, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("torium upgrade info contains trailing JSON")
		}
		return fmt.Errorf("decode trailing Torium upgrade info: %w", err)
	}
	return nil
}

func toriumLocalV1MigrationSHA256() string {
	digest := sha256.Sum256([]byte(toriumLocalV1MigrationSpec))
	return hex.EncodeToString(digest[:])
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func executableSHA256() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable: %w", err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read executable: %w", err)
	}
	digest := sha256.Sum256(contents)
	return hex.EncodeToString(digest[:]), nil
}

func moduleVersionMapDigest(versionMap module.VersionMap) (string, error) {
	names := make([]string, 0, len(versionMap))
	for name := range versionMap {
		names = append(names, name)
	}
	sort.Strings(names)
	type moduleVersion struct {
		Name    string `json:"name"`
		Version uint64 `json:"version"`
	}
	versions := make([]moduleVersion, 0, len(names))
	for _, name := range names {
		versions = append(versions, moduleVersion{Name: name, Version: versionMap[name]})
	}
	contents, err := json.Marshal(versions)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(contents)
	return hex.EncodeToString(digest[:]), nil
}

func cloneVersionMap(source module.VersionMap) module.VersionMap {
	clone := make(module.VersionMap, len(source))
	for name, version := range source {
		clone[name] = version
	}
	return clone
}

func (app *ToriumApp) writeToriumUpgradeMarker(ctx context.Context, marker toriumUpgradeMarker) error {
	contents, err := json.Marshal(marker)
	if err != nil {
		return fmt.Errorf("marshal Torium upgrade marker: %w", err)
	}
	sdk.UnwrapSDKContext(ctx).KVStore(app.keys[toriumUpgradeStoreKey]).Set(toriumUpgradeMarkerKey, contents)
	return nil
}
