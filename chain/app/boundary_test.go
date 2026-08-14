package torium

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestStandaloneBoundaryHasNoProductImports(t *testing.T) {
	forbiddenImports := []string{
		"/packages/backend",
		"clerk",
		"go-redis",
		"pgx",
		"postgres",
	}
	forbiddenConfiguration := []string{
		"CLERK_SECRET_KEY",
		"DATABASE_URL",
		"REDIS_URL",
	}

	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if entry.Name() == "build" || entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}

		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, forbidden := range forbiddenConfiguration {
			if strings.Contains(string(contents), forbidden) {
				t.Errorf("%s references product configuration %q", path, forbidden)
			}
		}

		parsed, err := parser.ParseFile(token.NewFileSet(), path, contents, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imported := range parsed.Imports {
			pathValue, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			for _, forbidden := range forbiddenImports {
				if strings.Contains(strings.ToLower(pathValue), strings.ToLower(forbidden)) {
					t.Errorf("%s imports forbidden product dependency %q", path, pathValue)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
