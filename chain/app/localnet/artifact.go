package localnet

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
)

var artifactFileNames = []string{genesisFileName, manifestFileName, checksumFileName}

// Files returns the canonical relative filenames and contents.
func (artifact Artifact) Files() map[string][]byte {
	return map[string][]byte{
		genesisFileName:  artifact.Genesis,
		manifestFileName: artifact.Manifest,
		checksumFileName: artifact.Checksums,
	}
}

// Write stores the generated public files. Local validator and account signing
// material is deliberately outside this artifact surface.
func (artifact Artifact) Write(directory string) error {
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("create genesis output directory: %w", err)
	}
	files := artifact.Files()
	temporaryFiles := make(map[string]string, len(files))
	defer func() {
		for _, temporary := range temporaryFiles {
			_ = os.Remove(temporary)
		}
	}()
	for _, name := range artifactFileNames {
		temporary, err := os.CreateTemp(directory, "."+name+".*")
		if err != nil {
			return fmt.Errorf("create temporary genesis artifact %s: %w", name, err)
		}
		temporaryFiles[name] = temporary.Name()
		if err := temporary.Chmod(0o644); err != nil {
			_ = temporary.Close()
			return fmt.Errorf("set temporary genesis artifact mode %s: %w", name, err)
		}
		if _, err := temporary.Write(files[name]); err != nil {
			_ = temporary.Close()
			return fmt.Errorf("write temporary genesis artifact %s: %w", name, err)
		}
		if err := temporary.Close(); err != nil {
			return fmt.Errorf("close temporary genesis artifact %s: %w", name, err)
		}
	}
	for _, name := range artifactFileNames {
		path := filepath.Join(directory, name)
		if err := os.Rename(temporaryFiles[name], path); err != nil {
			return fmt.Errorf("replace genesis artifact %s: %w", name, err)
		}
		delete(temporaryFiles, name)
	}
	return nil
}

// Verify proves the checked-in files are exactly reproducible.
func (artifact Artifact) Verify(directory string) error {
	files := artifact.Files()
	for _, name := range artifactFileNames {
		expected := files[name]
		path := filepath.Join(directory, name)
		actual, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read canonical genesis artifact %s: %w", name, err)
		}
		if !bytes.Equal(actual, expected) {
			return fmt.Errorf("canonical genesis artifact %s differs from clean regeneration", name)
		}
	}
	return nil
}
