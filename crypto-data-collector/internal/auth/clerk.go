package auth

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ClerkVerifier validates Clerk session JWTs and extracts user identity.
type ClerkVerifier struct {
	secretKey      string
	publishableKey string
	jwksCache      *jwksCache
	logger         *slog.Logger
	httpClient     *http.Client
}

type jwksCache struct {
	mu         sync.RWMutex
	keys       map[string]*rsa.PublicKey
	lastFetch  time.Time
	ttl        time.Duration
	jwksURL    string
	secretKey  string
	httpClient *http.Client
}

type jwksResponse struct {
	Keys []jwkKey `json:"keys"`
}

type jwkKey struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// ClerkSessionClaims holds the claims from a Clerk session token.
type ClerkSessionClaims struct {
	jwt.RegisteredClaims
	Sub   string `json:"sub"` // user ID
	Sid   string `json:"sid"` // session ID
	OrgID string `json:"org_id,omitempty"`
}

// ClerkUser represents a verified user from Clerk.
type ClerkUser struct {
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
	Email     string `json:"email,omitempty"`
}

// NewClerkVerifier creates a new Clerk JWT verifier.
func NewClerkVerifier(secretKey, publishableKey string, logger *slog.Logger) *ClerkVerifier {
	cache := &jwksCache{
		keys:    make(map[string]*rsa.PublicKey),
		ttl:     1 * time.Hour,
		jwksURL: "https://api.clerk.com/v1/jwks",
		secretKey: secretKey,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
	return &ClerkVerifier{
		secretKey:      secretKey,
		publishableKey: publishableKey,
		jwksCache:      cache,
		logger:         logger,
		httpClient:     &http.Client{Timeout: 10 * time.Second},
	}
}

// VerifySessionToken takes a Clerk session JWT string and returns the verified user,
// or an error if the token is invalid, expired, or from a revoked session.
func (v *ClerkVerifier) VerifySessionToken(tokenString string) (*ClerkUser, error) {
	token, err := jwt.ParseWithClaims(tokenString, &ClerkSessionClaims{},
		func(token *jwt.Token) (interface{}, error) {
			if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
			}
			kid, ok := token.Header["kid"].(string)
			if !ok {
				return nil, fmt.Errorf("missing kid in token header")
			}
			key, err := v.jwksCache.getKey(kid)
			if err != nil {
				return nil, fmt.Errorf("jwks: %w", err)
			}
			return key, nil
		})
	if err != nil {
		return nil, fmt.Errorf("token validation: %w", err)
	}

	claims, ok := token.Claims.(*ClerkSessionClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}

	// Verify the session is still active with Clerk
	if err := v.verifySessionActive(claims.Sid); err != nil {
		return nil, fmt.Errorf("session verification: %w", err)
	}

	return &ClerkUser{
		ID:        claims.Sub,
		SessionID: claims.Sid,
	}, nil
}

// VerifyTokenFromRequest extracts and verifies a Bearer token from an HTTP request.
func (v *ClerkVerifier) VerifyTokenFromRequest(r *http.Request) (*ClerkUser, error) {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return nil, fmt.Errorf("missing Authorization header")
	}
	token, ok := strings.CutPrefix(auth, "Bearer ")
	if !ok {
		return nil, fmt.Errorf("invalid Authorization header format")
	}
	return v.VerifySessionToken(token)
}

// verifySessionActive checks with Clerk's API that the session hasn't been revoked.
func (v *ClerkVerifier) verifySessionActive(sessionID string) error {
	req, err := http.NewRequest("GET",
		fmt.Sprintf("https://api.clerk.com/v1/sessions/%s", sessionID), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+v.secretKey)
	req.Header.Set("Accept", "application/json")

	resp, err := v.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("clerk api error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		return fmt.Errorf("session not found")
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("clerk api returned %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode session response: %w", err)
	}
	if result.Status != "active" {
		return fmt.Errorf("session status is %s", result.Status)
	}
	return nil
}

// GetUserEmail fetches the user's primary email from Clerk.
func (v *ClerkVerifier) GetUserEmail(userID string) (string, error) {
	req, err := http.NewRequest("GET",
		fmt.Sprintf("https://api.clerk.com/v1/users/%s", userID), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+v.secretKey)
	req.Header.Set("Accept", "application/json")

	resp, err := v.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("clerk user api returned %d", resp.StatusCode)
	}

	var result struct {
		EmailAddresses []struct {
			EmailAddress string `json:"email_address"`
		} `json:"email_addresses"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if len(result.EmailAddresses) > 0 {
		return result.EmailAddresses[0].EmailAddress, nil
	}
	return "", nil
}

// getKey fetches or returns a cached JWKS public key by kid.
func (c *jwksCache) getKey(kid string) (*rsa.PublicKey, error) {
	c.mu.RLock()
	key, ok := c.keys[kid]
	age := time.Since(c.lastFetch)
	c.mu.RUnlock()

	if ok && age < c.ttl {
		return key, nil
	}

	// Fetch fresh JWKS
	if err := c.fetchJWKS(); err != nil {
		// If we have a cached key, return it even if stale
		c.mu.RLock()
		key, ok := c.keys[kid]
		c.mu.RUnlock()
		if ok {
			return key, nil
		}
		return nil, fmt.Errorf("jwks fetch failed: %w", err)
	}

	c.mu.RLock()
	key, ok = c.keys[kid]
	c.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("key %s not found in JWKS", kid)
	}
	return key, nil
}

func (c *jwksCache) fetchJWKS() error {
	req, err := http.NewRequest("GET", c.jwksURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.secretKey)
	
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != 200 {
		return fmt.Errorf("clerk jwks api returned %d", resp.StatusCode)
	}

	var jwks jwksResponse
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return err
	}

	newKeys := make(map[string]*rsa.PublicKey)
	for _, k := range jwks.Keys {
		if k.Kty != "RSA" {
			continue
		}
		pubKey, err := parseJWKKey(k.N, k.E)
		if err != nil {
			continue
		}
		newKeys[k.Kid] = pubKey
	}

	c.mu.Lock()
	c.keys = newKeys
	c.lastFetch = time.Now()
	c.mu.Unlock()

	return nil
}

func parseJWKKey(nStr, eStr string) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(nStr)
	if err != nil {
		return nil, fmt.Errorf("decode n: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(eStr)
	if err != nil {
		return nil, fmt.Errorf("decode e: %w", err)
	}

	n := new(big.Int).SetBytes(nBytes)
	e := int(new(big.Int).SetBytes(eBytes).Int64())

	return &rsa.PublicKey{N: n, E: e}, nil
}


