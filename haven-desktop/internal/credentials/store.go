// Package credentials provides encrypted storage for sensitive data
// (wallet private keys, seed phrases, API keys) using the OS native credential store.
//
//   Windows: DPAPI via Windows Credential Manager
//   Linux:   Secret Service via D-Bus
//   macOS:   Keychain
package credentials

const serviceName = "haven-desktop"

// Well-known credential key names.
const (
	WalletKey  = "wallet-private-key"
	SeedPhrase = "wallet-seed-phrase"
	CloudToken = "cloud-subscription-token"
)

// Store securely saves a credential under the given key.
func Store(key, value string) error {
	return store(key, value)
}

// Retrieve reads a securely stored credential. Returns "" if not found.
func Retrieve(key string) (string, error) {
	return retrieve(key)
}

// Delete removes a stored credential.
func Delete(key string) error {
	return deleteKey(key)
}

// List returns all stored credential key names.
func List() ([]string, error) {
	return listKeys()
}
