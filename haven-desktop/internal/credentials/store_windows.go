//go:build windows

package credentials

import (
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
		return "", nil
	}
	return string(cred.CredentialBlob), nil
}

func deleteKey(key string) error {
	cred, err := wincred.GetGenericCredential(serviceName + "/" + key)
	if err != nil {
		return nil
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
