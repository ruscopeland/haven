//go:build windows

package credentials

import (
	"errors"
	"fmt"

	"github.com/danieljoos/wincred"
)

func store(key, value string) error {
	cred := wincred.NewGenericCredential(serviceName + "/" + key)
	cred.CredentialBlob = []byte(value)
	cred.Persist = wincred.PersistLocalMachine
	return cred.Write()
}

func retrieve(key string) (string, error) {
	cred, err := wincred.GetGenericCredential(serviceName + "/" + key)
	if err != nil {
		if errors.Is(err, wincred.ErrElementNotFound) {
			return "", nil // not found is expected, not an error
		}
		return "", fmt.Errorf("credential retrieve %q: %w", key, err)
	}
	return string(cred.CredentialBlob), nil
}

func deleteKey(key string) error {
	cred, err := wincred.GetGenericCredential(serviceName + "/" + key)
	if err != nil {
		if errors.Is(err, wincred.ErrElementNotFound) {
			return nil // already gone
		}
		return fmt.Errorf("credential delete %q: %w", key, err)
	}
	return cred.Delete()
}

func listKeys() ([]string, error) {
	creds, err := wincred.List()
	if err != nil {
		return nil, err
	}
	var keys []string
	prefix := serviceName + "/"
	for _, c := range creds {
		if len(c.TargetName) > len(prefix) && c.TargetName[:len(prefix)] == prefix {
			keys = append(keys, c.TargetName[len(prefix):])
		}
	}
	return keys, nil
}
