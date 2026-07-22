//go:build dev

package api

import "os"

// getCloudURL allows developers to override the cloud URL using an environment
// variable during local testing (wails dev).
func getCloudURL() string {
	if url := os.Getenv("HAVEN_CLOUD_URL"); url != "" {
		return url
	}
	return "https://api.haven.trading"
}
