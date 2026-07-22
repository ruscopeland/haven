package auth

import (
	"testing"
)

func TestJWKSParsing(t *testing.T) {
	// Test that our JWKS key parsing handles well-formed inputs
	// Real Clerk JWK values (the public ones, not secret)
	nStr := "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw"
	eStr := "AQAB"

	key, err := parseJWKKey(nStr, eStr)
	if err != nil {
		t.Fatalf("parseJWKKey failed: %v", err)
	}
	if key == nil {
		t.Fatal("expected non-nil key")
	}
	if key.N == nil {
		t.Fatal("key.N is nil")
	}
}
