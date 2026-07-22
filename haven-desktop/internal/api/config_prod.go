//go:build !dev

package api

// getCloudURL hardcodes the cloud URL in production builds to prevent users
// from overriding it via environment variables.
func getCloudURL() string {
	return "https://api.haven.trading"
}
