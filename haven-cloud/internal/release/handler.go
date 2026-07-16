package release

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// ReleaseManifest describes a signed release artifact.
type ReleaseManifest struct {
	Version  string `json:"version"`
	Platform string `json:"platform"`
	Filename string `json:"filename"`
	SHA256   string `json:"sha256"`
}

// Service handles release distribution and update checks.
type Service struct {
	releaseDir string
	publicKey  ed25519.PublicKey
	logger     *slog.Logger
}

// NewService creates a release distribution service.
// RELEASE_PUBLIC_KEY env var should contain the base64-encoded Ed25519 public key.
func NewService(releaseDir string, logger *slog.Logger) *Service {
	svc := &Service{
		releaseDir: releaseDir,
		logger:     logger,
	}

	if pkStr := os.Getenv("RELEASE_PUBLIC_KEY"); pkStr != "" {
		pk, err := base64.StdEncoding.DecodeString(pkStr)
		if err != nil {
			logger.Error("invalid RELEASE_PUBLIC_KEY", "error", err)
		} else {
			svc.publicKey = ed25519.PublicKey(pk)
		}
	}

	return svc
}

// HandleLatest returns the latest release version and manifest for each platform.
func (s *Service) HandleLatest(w http.ResponseWriter, r *http.Request) {
	platforms := []string{"windows", "linux", "darwin"}
	releases := make([]ReleaseManifest, 0, len(platforms))

	for _, plat := range platforms {
		manifest, err := s.loadManifest(s.latestVersion(), plat)
		if err != nil {
			continue
		}
		releases = append(releases, manifest)
	}

	if len(releases) == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no releases found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"version":  s.latestVersion(),
		"releases": releases,
	})
}

// HandleDownload serves a specific release artifact after verifying its manifest.
func (s *Service) HandleDownload(w http.ResponseWriter, r *http.Request) {
	version := r.PathValue("version")
	platform := r.PathValue("platform")

	if version == "" || platform == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "version and platform required"})
		return
	}

	if version == "latest" {
		version = s.latestVersion()
	}

	manifest, err := s.loadManifest(version, platform)
	if err != nil {
		s.logger.Warn("manifest not found", "version", version, "platform", platform, "error", err)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "release not found"})
		return
	}

	// Verify manifest signature
	if err := s.verifyManifest(manifest); err != nil {
		s.logger.Error("manifest verification failed", "version", version, "platform", platform, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "release integrity check failed"})
		return
	}

	// Serve the binary
	filePath := filepath.Join(s.releaseDir, manifest.Filename)
	file, err := os.Open(filePath)
	if err != nil {
		s.logger.Error("release file not found", "path", filePath, "error", err)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "release file not found"})
		return
	}
	defer file.Close()

	stat, _ := file.Stat()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, manifest.Filename))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", stat.Size()))
	w.Header().Set("X-Haven-Release", manifest.Version)
	w.Header().Set("X-Haven-SHA256", manifest.SHA256)

	io.Copy(w, file)
}

func (s *Service) latestVersion() string {
	if v := os.Getenv("HAVEN_RELEASE_VERSION"); v != "" {
		return v
	}
	return "1.0.0"
}

func (s *Service) loadManifest(version, platform string) (ReleaseManifest, error) {
	var filename string
	switch platform {
	case "windows":
		filename = fmt.Sprintf("haven-%s-windows-installer.exe", version)
	case "linux":
		filename = fmt.Sprintf("haven-%s-linux.tar.gz", version)
	case "darwin":
		filename = fmt.Sprintf("haven-%s-darwin.dmg", version)
	default:
		return ReleaseManifest{}, fmt.Errorf("unknown platform: %s", platform)
	}

	manifestPath := filepath.Join(s.releaseDir, filename+".manifest.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return ReleaseManifest{}, err
	}

	var manifest ReleaseManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return ReleaseManifest{}, err
	}

	// Verify filename in manifest matches expected
	if manifest.Filename != filename {
		return ReleaseManifest{}, fmt.Errorf("manifest filename mismatch: %s vs %s", manifest.Filename, filename)
	}

	return manifest, nil
}

// verifyManifest checks that the manifest is signed with the expected public key.
// The signature is stored as {filename}.manifest.json.sig (base64-encoded Ed25519 signature).
func (s *Service) verifyManifest(manifest ReleaseManifest) error {
	if s.publicKey == nil {
		s.logger.Warn("no release public key configured, skipping signature verification")
		return nil
	}

	sigPath := filepath.Join(s.releaseDir, manifest.Filename+".manifest.json.sig")
	sigData, err := os.ReadFile(sigPath)
	if err != nil {
		return fmt.Errorf("signature file missing: %w", err)
	}

	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		return fmt.Errorf("marshal manifest: %w", err)
	}

	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigData)))
	if err != nil {
		return fmt.Errorf("decode signature: %w", err)
	}

	if !ed25519.Verify(s.publicKey, manifestJSON, signature) {
		return fmt.Errorf("manifest signature verification failed")
	}

	// Also verify the file hash matches
	filePath := filepath.Join(s.releaseDir, manifest.Filename)
	fileData, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("read release file: %w", err)
	}

	actualHash := fmt.Sprintf("%x", sha256.Sum256(fileData))
	if !strings.EqualFold(actualHash, manifest.SHA256) {
		return fmt.Errorf("file hash mismatch: expected %s, got %s", manifest.SHA256, actualHash)
	}

	return nil
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
