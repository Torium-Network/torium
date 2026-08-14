package localnet

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	recoveryManifestName       = "manifest.json"
	recoveryMaxManifestBytes   = 2 << 20
	recoveryMaxPayloadBytes    = int64(20 << 30)
	recoveryMaxEntries         = 100_000
	recoveryArchivePermissions = 0o600
)

type recoveryPayload struct {
	absolute  string
	relative  string
	mode      os.FileMode
	size      int64
	sha256    string
	directory bool
}

// CreateRecoveryArchive captures a stopped localnet runtime. Callers must stop
// the selected nodes first so database files and signer state form one durable
// point-in-time image.
func CreateRecoveryArchive(options CreateRecoveryOptions) (RecoveryManifest, string, error) {
	root, err := safeRuntimeRoot(options.Root)
	if err != nil {
		return RecoveryManifest{}, "", err
	}
	if err := validateResetTarget(root, options.Profile); err != nil {
		return RecoveryManifest{}, "", fmt.Errorf("validate recovery source: %w", err)
	}
	names, err := recoveryNodeNames(options.Node)
	if err != nil {
		return RecoveryManifest{}, "", err
	}
	fixture := options.Fixture
	if fixture == "" {
		fixture = FixtureCustom
	}
	if _, ok := recoveryFixtureKinds[fixture]; !ok {
		return RecoveryManifest{}, "", fmt.Errorf("invalid recovery fixture %q", fixture)
	}
	output, err := safeRecoveryOutput(root, options.Output)
	if err != nil {
		return RecoveryManifest{}, "", err
	}
	nodes, chain, err := inspectRecoveryNodes(root, names)
	if err != nil {
		return RecoveryManifest{}, "", err
	}
	payload, files, err := collectRecoveryPayload(root, names)
	if err != nil {
		return RecoveryManifest{}, "", err
	}
	binary := options.Binary
	if binary.Name == "" {
		return RecoveryManifest{}, "", fmt.Errorf("toriumd binary metadata is required")
	}
	createdAt := options.CreatedAt.UTC()
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	manifest := RecoveryManifest{
		SchemaVersion: RecoverySchemaVersion,
		Format:        RecoveryFormat,
		Warning:       recoveryWarning,
		CreatedAt:     createdAt.Format(time.RFC3339),
		Scope:         SnapshotScopeNetwork,
		Fixture:       fixture,
		Profile:       options.Profile,
		Chain:         chain,
		Binary:        binary,
		Nodes:         nodes,
		Files:         files,
	}
	if options.Node != "" {
		manifest.Scope = SnapshotScopeNode
		manifest.Node = options.Node
	}
	if err := validateRecoveryManifest(manifest); err != nil {
		return RecoveryManifest{}, "", fmt.Errorf("validate generated recovery manifest: %w", err)
	}
	archiveDigest, err := writeRecoveryArchive(output, manifest, payload)
	if err != nil {
		return RecoveryManifest{}, "", err
	}
	if err := writeRecoverySidecar(output, archiveDigest); err != nil {
		_ = os.Remove(output)
		return RecoveryManifest{}, "", err
	}
	return manifest, archiveDigest, nil
}

// InspectRecoveryArchive validates the outer checksum, manifest, every payload
// path, mode, size and content checksum without extracting or mutating state.
func InspectRecoveryArchive(archive string) (RecoveryManifest, string, error) {
	digest, err := verifyRecoverySidecar(archive)
	if err != nil {
		return RecoveryManifest{}, "", err
	}
	manifest, err := readRecoveryArchive(archive, "")
	if err != nil {
		return RecoveryManifest{}, "", err
	}
	return manifest, digest, nil
}

// RestoreRecoveryArchive extracts into a staging directory, revalidates the
// archived databases and topology, and only then atomically swaps exact known
// validator homes. A validation error leaves the target untouched.
func RestoreRecoveryArchive(options RestoreRecoveryOptions) (RecoveryManifest, error) {
	root, err := safeRuntimeRoot(options.Root)
	if err != nil {
		return RecoveryManifest{}, err
	}
	if err := validateResetTarget(root, options.Profile); err != nil {
		return RecoveryManifest{}, fmt.Errorf("validate recovery target: %w", err)
	}
	archive, err := safeRecoveryInput(root, options.Archive)
	if err != nil {
		return RecoveryManifest{}, err
	}
	manifest, _, err := InspectRecoveryArchive(archive)
	if err != nil {
		return RecoveryManifest{}, err
	}
	if err := validateRecoveryCompatibility(manifest, root, options.Profile, options.CurrentBinary); err != nil {
		return RecoveryManifest{}, err
	}
	parent := filepath.Dir(root)
	staging, err := os.MkdirTemp(parent, ".torium-localnet-restore-*")
	if err != nil {
		return RecoveryManifest{}, fmt.Errorf("create recovery staging directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()
	if _, err := verifyRecoverySidecar(archive); err != nil {
		return RecoveryManifest{}, err
	}
	extractedManifest, err := readRecoveryArchive(archive, staging)
	if err != nil {
		return RecoveryManifest{}, err
	}
	if !recoveryManifestsEqual(manifest, extractedManifest) {
		return RecoveryManifest{}, fmt.Errorf("recovery manifest changed while restoring")
	}
	stagedRuntime := filepath.Join(staging, "runtime")
	if err := validateStagedRecovery(root, stagedRuntime, manifest); err != nil {
		return RecoveryManifest{}, err
	}
	names, err := recoveryNodeNames(manifest.Node)
	if err != nil {
		return RecoveryManifest{}, err
	}
	if err := activateRecoveryNodes(root, stagedRuntime, names); err != nil {
		return RecoveryManifest{}, err
	}
	return manifest, nil
}

func safeRecoveryInput(root, value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("recovery archive is required")
	}
	archive, err := filepath.Abs(filepath.Clean(value))
	if err != nil {
		return "", fmt.Errorf("resolve recovery archive: %w", err)
	}
	if !strings.HasSuffix(archive, ".tar.gz") {
		return "", fmt.Errorf("recovery archive must end in .tar.gz")
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve recovery runtime root: %w", err)
	}
	realArchiveDirectory, err := filepath.EvalSymlinks(filepath.Dir(archive))
	if err != nil {
		return "", fmt.Errorf("resolve recovery archive directory: %w", err)
	}
	archive = filepath.Join(realArchiveDirectory, filepath.Base(archive))
	relative, err := filepath.Rel(realRoot, archive)
	if err != nil {
		return "", fmt.Errorf("compare recovery archive with runtime root: %w", err)
	}
	if relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
		return "", fmt.Errorf("recovery archive must be outside the runtime root")
	}
	return archive, nil
}

func safeRecoveryOutput(root, value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("recovery output is required")
	}
	output, err := filepath.Abs(filepath.Clean(value))
	if err != nil {
		return "", fmt.Errorf("resolve recovery output: %w", err)
	}
	if !strings.HasSuffix(output, ".tar.gz") {
		return "", fmt.Errorf("recovery output must end in .tar.gz")
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve recovery runtime root: %w", err)
	}
	realOutputDirectory, err := filepath.EvalSymlinks(filepath.Dir(output))
	if err != nil {
		return "", fmt.Errorf("resolve recovery output directory: %w", err)
	}
	output = filepath.Join(realOutputDirectory, filepath.Base(output))
	relative, err := filepath.Rel(realRoot, output)
	if err != nil {
		return "", fmt.Errorf("compare recovery output with runtime root: %w", err)
	}
	if relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
		return "", fmt.Errorf("recovery output must be outside the runtime root")
	}
	for _, candidate := range []string{output, output + ".sha256"} {
		if _, statErr := os.Lstat(candidate); statErr == nil {
			return "", fmt.Errorf("refusing to overwrite existing recovery output %s", candidate)
		} else if !os.IsNotExist(statErr) {
			return "", fmt.Errorf("inspect recovery output %s: %w", candidate, statErr)
		}
	}
	return output, nil
}

func collectRecoveryPayload(root string, names []string) ([]recoveryPayload, []RecoveryFile, error) {
	selected := append([]string{topologyFileName}, names...)
	payload := make([]recoveryPayload, 0, 128)
	files := make([]RecoveryFile, 0, 128)
	var total int64
	for _, selectedPath := range selected {
		absoluteRoot := filepath.Join(root, selectedPath)
		err := filepath.WalkDir(absoluteRoot, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("recovery refuses symlink %s", path)
			}
			relativeToRoot, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			relative := "runtime/" + filepath.ToSlash(relativeToRoot)
			item := recoveryPayload{
				absolute:  path,
				relative:  relative,
				mode:      info.Mode().Perm(),
				size:      info.Size(),
				directory: info.IsDir(),
			}
			switch {
			case info.IsDir():
				payload = append(payload, item)
			case info.Mode().IsRegular():
				digest, err := sha256File(path)
				if err != nil {
					return err
				}
				total += info.Size()
				if total > recoveryMaxPayloadBytes {
					return fmt.Errorf("recovery payload exceeds %d bytes", recoveryMaxPayloadBytes)
				}
				item.sha256 = digest
				payload = append(payload, item)
				files = append(files, RecoveryFile{
					Path: relative, Size: info.Size(), Mode: uint32(info.Mode().Perm()), SHA256: digest,
				})
			default:
				return fmt.Errorf("recovery refuses unsupported file type %s", path)
			}
			if len(payload) > recoveryMaxEntries {
				return fmt.Errorf("recovery payload exceeds %d entries", recoveryMaxEntries)
			}
			return nil
		})
		if err != nil {
			return nil, nil, fmt.Errorf("collect recovery payload %s: %w", selectedPath, err)
		}
	}
	sort.Slice(payload, func(i, j int) bool { return payload[i].relative < payload[j].relative })
	sortRecoveryFiles(files)
	return payload, files, nil
}

func writeRecoveryArchive(output string, manifest RecoveryManifest, payload []recoveryPayload) (digest string, err error) {
	if err := os.MkdirAll(filepath.Dir(output), 0o700); err != nil {
		return "", fmt.Errorf("create recovery output directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(output), ".torium-recovery-*.tar.gz")
	if err != nil {
		return "", fmt.Errorf("create recovery archive: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() {
		if err != nil {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err = temporary.Chmod(recoveryArchivePermissions); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("set recovery archive permissions: %w", err)
	}
	archiveHash := sha256.New()
	gzipWriter, err := gzip.NewWriterLevel(io.MultiWriter(temporary, archiveHash), gzip.BestSpeed)
	if err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("create recovery gzip stream: %w", err)
	}
	gzipWriter.ModTime = time.Unix(0, 0).UTC()
	gzipWriter.OS = 255
	tarWriter := tar.NewWriter(gzipWriter)
	manifestContents, err := marshalRecoveryManifest(manifest)
	if err == nil {
		err = writeRecoveryBytes(tarWriter, recoveryManifestName, 0o600, manifestContents)
	}
	for _, item := range payload {
		if err != nil {
			break
		}
		if item.directory {
			header := recoveryTarHeader(item.relative+"/", item.mode, 0, tar.TypeDir)
			err = tarWriter.WriteHeader(header)
			continue
		}
		err = writeRecoveryFile(tarWriter, item)
	}
	if closeErr := tarWriter.Close(); err == nil && closeErr != nil {
		err = closeErr
	}
	if closeErr := gzipWriter.Close(); err == nil && closeErr != nil {
		err = closeErr
	}
	if closeErr := temporary.Close(); err == nil && closeErr != nil {
		err = closeErr
	}
	if err != nil {
		return "", fmt.Errorf("write recovery archive: %w", err)
	}
	if err = os.Rename(temporaryPath, output); err != nil {
		return "", fmt.Errorf("activate recovery archive: %w", err)
	}
	return hex.EncodeToString(archiveHash.Sum(nil)), nil
}

func writeRecoveryBytes(writer *tar.Writer, name string, mode os.FileMode, contents []byte) error {
	if err := writer.WriteHeader(recoveryTarHeader(name, mode, int64(len(contents)), tar.TypeReg)); err != nil {
		return err
	}
	_, err := writer.Write(contents)
	return err
}

func writeRecoveryFile(writer *tar.Writer, item recoveryPayload) error {
	file, err := os.Open(item.absolute)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	if err := writer.WriteHeader(recoveryTarHeader(item.relative, item.mode, item.size, tar.TypeReg)); err != nil {
		return err
	}
	digest := sha256.New()
	written, err := io.Copy(io.MultiWriter(writer, digest), file)
	if err != nil {
		return err
	}
	if written != item.size {
		return fmt.Errorf("recovery source %s changed size while archiving", item.relative)
	}
	if !strings.EqualFold(hex.EncodeToString(digest.Sum(nil)), item.sha256) {
		return fmt.Errorf("recovery source %s changed contents while archiving", item.relative)
	}
	return nil
}

func recoveryTarHeader(name string, mode os.FileMode, size int64, typeFlag byte) *tar.Header {
	return &tar.Header{
		Name: name, Mode: int64(mode.Perm()), Size: size, Typeflag: typeFlag,
		ModTime: time.Unix(0, 0).UTC(), AccessTime: time.Unix(0, 0).UTC(), ChangeTime: time.Unix(0, 0).UTC(),
		Uid: 0, Gid: 0, Uname: "", Gname: "", Format: tar.FormatPAX,
	}
}

func writeRecoverySidecar(archive, digest string) error {
	contents := []byte(fmt.Sprintf("%s  %s\n", digest, filepath.Base(archive)))
	temporary, err := os.CreateTemp(filepath.Dir(archive), ".torium-recovery-sha256-*")
	if err != nil {
		return fmt.Errorf("create recovery checksum sidecar: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o644); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(contents); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, archive+".sha256"); err != nil {
		return fmt.Errorf("activate recovery checksum sidecar: %w", err)
	}
	return nil
}

func verifyRecoverySidecar(archive string) (string, error) {
	contents, err := os.ReadFile(archive + ".sha256")
	if err != nil {
		return "", fmt.Errorf("read recovery checksum sidecar: %w", err)
	}
	if len(contents) > 4096 {
		return "", fmt.Errorf("recovery checksum sidecar is too large")
	}
	fields := strings.Fields(string(contents))
	if len(fields) != 2 || !validHexDigest(fields[0]) || fields[1] != filepath.Base(archive) {
		return "", fmt.Errorf("invalid recovery checksum sidecar")
	}
	actual, err := sha256File(archive)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(fields[0], actual) {
		return "", fmt.Errorf("recovery archive checksum mismatch")
	}
	return actual, nil
}

func readRecoveryArchive(archive, destination string) (RecoveryManifest, error) {
	file, err := os.Open(archive)
	if err != nil {
		return RecoveryManifest{}, fmt.Errorf("open recovery archive: %w", err)
	}
	defer func() { _ = file.Close() }()
	gzipReader, err := gzip.NewReader(bufio.NewReader(file))
	if err != nil {
		return RecoveryManifest{}, fmt.Errorf("open recovery gzip stream: %w", err)
	}
	defer func() { _ = gzipReader.Close() }()
	tarReader := tar.NewReader(gzipReader)
	header, err := tarReader.Next()
	if err != nil {
		return RecoveryManifest{}, fmt.Errorf("read recovery manifest header: %w", err)
	}
	if header.Name != recoveryManifestName || header.Typeflag != tar.TypeReg || header.Size <= 0 || header.Size > recoveryMaxManifestBytes {
		return RecoveryManifest{}, fmt.Errorf("recovery manifest must be the first bounded regular archive entry")
	}
	if header.Mode != 0o600 {
		return RecoveryManifest{}, fmt.Errorf("recovery manifest must use mode 0600")
	}
	manifestContents, err := io.ReadAll(io.LimitReader(tarReader, recoveryMaxManifestBytes+1))
	if err != nil || int64(len(manifestContents)) != header.Size {
		return RecoveryManifest{}, fmt.Errorf("read recovery manifest: %w", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(manifestContents)))
	decoder.DisallowUnknownFields()
	var manifest RecoveryManifest
	if err := decoder.Decode(&manifest); err != nil {
		return RecoveryManifest{}, fmt.Errorf("decode recovery manifest: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return RecoveryManifest{}, err
	}
	if err := validateRecoveryManifest(manifest); err != nil {
		return RecoveryManifest{}, err
	}
	expected := make(map[string]RecoveryFile, len(manifest.Files))
	for _, entry := range manifest.Files {
		expected[entry.Path] = entry
	}
	seen := make(map[string]struct{}, len(expected))
	seenDirectories := make(map[string]struct{})
	var entries int
	var total int64
	for {
		header, err = tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return RecoveryManifest{}, fmt.Errorf("read recovery payload header: %w", err)
		}
		entries++
		if entries > recoveryMaxEntries {
			return RecoveryManifest{}, fmt.Errorf("recovery archive exceeds %d entries", recoveryMaxEntries)
		}
		name := strings.TrimSuffix(header.Name, "/")
		if header.Typeflag == tar.TypeDir {
			if !validRecoveryDirectoryForManifest(name, manifest) || header.Mode < 0 || header.Mode > 0o777 {
				return RecoveryManifest{}, fmt.Errorf("invalid recovery directory %q", header.Name)
			}
			if _, duplicate := seenDirectories[name]; duplicate {
				return RecoveryManifest{}, fmt.Errorf("recovery archive repeats directory %q", header.Name)
			}
			seenDirectories[name] = struct{}{}
			if destination != "" {
				directory := filepath.Join(destination, filepath.FromSlash(name))
				if err := os.MkdirAll(directory, os.FileMode(header.Mode)); err != nil {
					return RecoveryManifest{}, err
				}
				if err := os.Chmod(directory, os.FileMode(header.Mode)); err != nil {
					return RecoveryManifest{}, err
				}
			}
			continue
		}
		if header.Typeflag != tar.TypeReg || !validRecoveryPath(header.Name) {
			return RecoveryManifest{}, fmt.Errorf("recovery archive contains unsupported entry %q", header.Name)
		}
		entry, ok := expected[header.Name]
		if !ok {
			return RecoveryManifest{}, fmt.Errorf("recovery archive contains unmanifested file %q", header.Name)
		}
		if _, duplicate := seen[header.Name]; duplicate {
			return RecoveryManifest{}, fmt.Errorf("recovery archive repeats file %q", header.Name)
		}
		if header.Mode < 0 || header.Mode > 0o777 || header.Size != entry.Size || uint32(header.Mode) != entry.Mode {
			return RecoveryManifest{}, fmt.Errorf("recovery metadata differs for %q", header.Name)
		}
		total += header.Size
		if total > recoveryMaxPayloadBytes {
			return RecoveryManifest{}, fmt.Errorf("recovery payload exceeds %d bytes", recoveryMaxPayloadBytes)
		}
		if err := readRecoveryFile(tarReader, destination, header.Name, entry); err != nil {
			return RecoveryManifest{}, err
		}
		seen[header.Name] = struct{}{}
	}
	if len(seen) != len(expected) {
		return RecoveryManifest{}, fmt.Errorf("recovery archive is missing %d manifested files", len(expected)-len(seen))
	}
	return manifest, nil
}

func readRecoveryFile(reader io.Reader, destination, name string, entry RecoveryFile) error {
	digest := sha256.New()
	var writer io.Writer = digest
	var output *os.File
	if destination != "" {
		path := filepath.Join(destination, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		var err error
		output, err = os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, os.FileMode(entry.Mode))
		if err != nil {
			return fmt.Errorf("create staged recovery file %q: %w", name, err)
		}
		writer = io.MultiWriter(output, digest)
	}
	written, copyErr := io.Copy(writer, reader)
	if output != nil {
		if closeErr := output.Close(); copyErr == nil && closeErr != nil {
			copyErr = closeErr
		}
	}
	if copyErr != nil {
		return fmt.Errorf("read recovery file %q: %w", name, copyErr)
	}
	if written != entry.Size || !strings.EqualFold(hex.EncodeToString(digest.Sum(nil)), entry.SHA256) {
		return fmt.Errorf("recovery content checksum mismatch for %q", name)
	}
	return nil
}

func validateStagedRecovery(currentRoot, stagedRoot string, manifest RecoveryManifest) error {
	currentTopology, err := os.ReadFile(filepath.Join(currentRoot, topologyFileName))
	if err != nil {
		return err
	}
	stagedTopology, err := os.ReadFile(filepath.Join(stagedRoot, topologyFileName))
	if err != nil {
		return fmt.Errorf("read staged recovery topology: %w", err)
	}
	if string(currentTopology) != string(stagedTopology) {
		return fmt.Errorf("recovery topology differs from the deterministic target topology")
	}
	names, err := recoveryNodeNames(manifest.Node)
	if err != nil {
		return err
	}
	nodes, chain, err := inspectRecoveryNodes(stagedRoot, names)
	if err != nil {
		return fmt.Errorf("inspect staged recovery databases: %w", err)
	}
	if !recoveryChainEqual(chain, manifest.Chain) || !recoveryNodesEqual(nodes, manifest.Nodes) {
		return fmt.Errorf("staged recovery database state differs from its manifest")
	}
	return nil
}

func activateRecoveryNodes(root, stagedRoot string, names []string) error {
	backup, err := os.MkdirTemp(filepath.Dir(root), ".torium-localnet-backup-*")
	if err != nil {
		return fmt.Errorf("create recovery rollback directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(backup) }()
	activated := make([]string, 0, len(names))
	rollback := func() {
		for index := len(activated) - 1; index >= 0; index-- {
			name := activated[index]
			target := filepath.Join(root, name)
			_ = os.RemoveAll(target)
			_ = os.Rename(filepath.Join(backup, name), target)
		}
	}
	for _, name := range names {
		target := filepath.Join(root, name)
		staged := filepath.Join(stagedRoot, name)
		preserved := filepath.Join(backup, name)
		if err := ensureRealDirectory(target); err != nil {
			rollback()
			return err
		}
		if err := ensureRealDirectory(staged); err != nil {
			rollback()
			return err
		}
		if err := os.Rename(target, preserved); err != nil {
			rollback()
			return fmt.Errorf("preserve %s before recovery: %w", name, err)
		}
		if err := os.Rename(staged, target); err != nil {
			_ = os.Rename(preserved, target)
			rollback()
			return fmt.Errorf("activate recovered %s: %w", name, err)
		}
		activated = append(activated, name)
	}
	return nil
}

func ensureRealDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect recovery directory %s: %w", path, err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("recovery path must be a real directory: %s", path)
	}
	return nil
}

func validRecoveryDirectoryForManifest(value string, manifest RecoveryManifest) bool {
	if value == "runtime" {
		return true
	}
	if !validRecoveryPath(value + "/placeholder") {
		return false
	}
	return validManifestFileForScope(manifest, value+"/placeholder")
}

func validManifestFileForScope(manifest RecoveryManifest, file string) bool {
	if file == "runtime/"+topologyFileName {
		return true
	}
	if manifest.Scope == SnapshotScopeNode {
		return strings.HasPrefix(file, "runtime/"+manifest.Node+"/")
	}
	for _, node := range []string{"validator-0", "validator-1", "validator-2", "validator-3"} {
		if strings.HasPrefix(file, "runtime/"+node+"/") {
			return true
		}
	}
	return false
}

func recoveryManifestsEqual(left, right RecoveryManifest) bool {
	leftDigest, leftErr := recoveryManifestDigest(left)
	rightDigest, rightErr := recoveryManifestDigest(right)
	return leftErr == nil && rightErr == nil && leftDigest == rightDigest
}

func recoveryChainEqual(left, right RecoveryChain) bool {
	return left.CosmosChainID == right.CosmosChainID && left.EVMChainID == right.EVMChainID &&
		strings.EqualFold(left.GenesisSHA256, right.GenesisSHA256) && left.Height == right.Height &&
		strings.EqualFold(left.BlockHash, right.BlockHash) && strings.EqualFold(left.AppHash, right.AppHash)
}

func recoveryNodesEqual(left, right []RecoveryNode) bool {
	if len(left) != len(right) {
		return false
	}
	// DataBytes is inventory metadata, not a trust anchor: opening LevelDB for
	// validation can rotate LOG/LOCK files. Per-file checksums already prove the
	// extracted bytes; height/block/app hashes prove the resulting state.
	for index := range left {
		if left[index].Name != right[index].Name || left[index].LatestHeight != right[index].LatestHeight ||
			!strings.EqualFold(left[index].BlockHash, right[index].BlockHash) ||
			!strings.EqualFold(left[index].AppHash, right[index].AppHash) {
			return false
		}
	}
	return true
}

func sha256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open %s for SHA-256: %w", path, err)
	}
	defer func() { _ = file.Close() }()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", fmt.Errorf("hash %s: %w", path, err)
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("recovery manifest has trailing JSON")
		}
		return fmt.Errorf("decode recovery manifest trailing data: %w", err)
	}
	return nil
}
