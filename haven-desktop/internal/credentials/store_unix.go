//go:build !windows

package credentials

import (
	"github.com/zalando/go-keyring"
)

func store(key, value string) error {
	return keyring.Set(serviceName, key, value)
}

func retrieve(key string) (string, error) {
	val, err := keyring.Get(serviceName, key)
	if err != nil {
		if err == keyring.ErrNotFound {
			return "", nil
		}
		return "", err
	}
	return val, nil
}

func deleteKey(key string) error {
	return keyring.Delete(serviceName, key)
}

func listKeys() ([]string, error) {
	// go-keyring doesn't support listing
	return nil, nil
}
