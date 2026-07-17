package subscription

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ruscopeland/haven-cloud/internal/auth"
)

// Tier represents a subscription tier.
type Tier struct {
	Name     string `json:"name"`
	ClerkSlug string `json:"clerk_slug"`
	Features struct {
		MaxStrategies     int  `json:"max_strategies"`
		MaxFinders        int  `json:"max_finders"`
		MaxBots           int  `json:"max_bots"`
		UniverseTokens    int  `json:"universe_tokens"`
		LiveTrading       bool `json:"live_trading"`
		FinderEnabled     bool `json:"finder_enabled"`
		EngineAccess      bool `json:"engine_access"`
		DataRefreshSec    int  `json:"data_refresh_sec"`
	} `json:"features"`
}

// Entitlement is the response sent to the desktop app.
type Entitlement struct {
	AppAccess       bool   `json:"app_access"`
	Tier            string `json:"tier"`
	TrialEnd        string `json:"trial_end,omitempty"`
	MaxStrategies   int    `json:"max_strategies"`
	MaxFinders      int    `json:"max_finders"`
	MaxBots         int    `json:"max_bots"`
	UniverseTokens  int    `json:"universe_tokens"`
	LiveTrading     bool   `json:"live_trading"`
	FinderEnabled   bool   `json:"finder_enabled"`
	EngineAccess    bool   `json:"engine_access"`
	DataRefreshSec  int    `json:"data_refresh_sec"`
	SubscriptionEnd string `json:"subscription_end,omitempty"`
	BuildWarning    string `json:"build_warning,omitempty"`
}

// Service handles subscription verification against Clerk.
type Service struct {
	verifier        *auth.ClerkVerifier
	clerkKey        string
	logger          *slog.Logger
	tiers           map[string]Tier
	cache           sync.Map // userID → cachedEntitlement
	cacheTTL        time.Duration
	latestBuildHash string
}

type cachedEntitlement struct {
	entitlement Entitlement
	expiresAt   time.Time
}

// NewService creates a subscription verification service.
func NewService(verifier *auth.ClerkVerifier, clerkKey string, logger *slog.Logger, latestBuildHash string) *Service {
	svc := &Service{
		verifier:        verifier,
		clerkKey:        clerkKey,
		logger:          logger,
		tiers:           defaultTiers(),
		cacheTTL:        5 * time.Minute,
		latestBuildHash: latestBuildHash,
	}
	return svc
}

func defaultTiers() map[string]Tier {
	return map[string]Tier{
		"starter": {
			Name:      "Starter",
			ClerkSlug: "starter",
			Features: struct {
				MaxStrategies     int  `json:"max_strategies"`
				MaxFinders        int  `json:"max_finders"`
				MaxBots           int  `json:"max_bots"`
				UniverseTokens    int  `json:"universe_tokens"`
				LiveTrading       bool `json:"live_trading"`
				FinderEnabled     bool `json:"finder_enabled"`
				EngineAccess      bool `json:"engine_access"`
				DataRefreshSec    int  `json:"data_refresh_sec"`
			}{
				MaxStrategies:  5,
				MaxFinders:     2,
				MaxBots:        1,
				UniverseTokens: 20,
				LiveTrading:    false,
				FinderEnabled:  false,
				EngineAccess:   true,
				DataRefreshSec: 30,
			},
		},
		"pro": {
			Name:      "Pro",
			ClerkSlug: "pro",
			Features: struct {
				MaxStrategies     int  `json:"max_strategies"`
				MaxFinders        int  `json:"max_finders"`
				MaxBots           int  `json:"max_bots"`
				UniverseTokens    int  `json:"universe_tokens"`
				LiveTrading       bool `json:"live_trading"`
				FinderEnabled     bool `json:"finder_enabled"`
				EngineAccess      bool `json:"engine_access"`
				DataRefreshSec    int  `json:"data_refresh_sec"`
			}{
				MaxStrategies:  20,
				MaxFinders:     10,
				MaxBots:        5,
				UniverseTokens: 100,
				LiveTrading:    true,
				FinderEnabled:  true,
				EngineAccess:   true,
				DataRefreshSec: 10,
			},
		},
		"advanced": {
			Name:      "Advanced",
			ClerkSlug: "advanced",
			Features: struct {
				MaxStrategies     int  `json:"max_strategies"`
				MaxFinders        int  `json:"max_finders"`
				MaxBots           int  `json:"max_bots"`
				UniverseTokens    int  `json:"universe_tokens"`
				LiveTrading       bool `json:"live_trading"`
				FinderEnabled     bool `json:"finder_enabled"`
				EngineAccess      bool `json:"engine_access"`
				DataRefreshSec    int  `json:"data_refresh_sec"`
			}{
				MaxStrategies:  100,
				MaxFinders:     50,
				MaxBots:        20,
				UniverseTokens: 500,
				LiveTrading:    true,
				FinderEnabled:  true,
				EngineAccess:   true,
				DataRefreshSec: 5,
			},
		},
	}
}

// HandleVerify is the POST /v1/subscription/verify handler.
func (s *Service) HandleVerify(w http.ResponseWriter, r *http.Request) {
	user, err := s.verifier.VerifyTokenFromRequest(r)
	if err != nil {
		s.writeError(w, http.StatusUnauthorized, "invalid_token", "Authentication failed")
		return
	}

	// Parse optional build_hash from request body
	var req struct {
		BuildHash string `json:"build_hash"`
	}
	// Best-effort body parse — build_hash is optional
	if body, readErr := io.ReadAll(io.LimitReader(r.Body, 4096)); readErr == nil {
		json.Unmarshal(body, &req)
	}

	// Check cache (cache depends only on user ID, not build_hash)
	if cached, ok := s.cache.Load(user.ID); ok {
		c := cached.(cachedEntitlement)
		if time.Now().Before(c.expiresAt) {
			s.writeJSON(w, http.StatusOK, c.entitlement)
			return
		}
	}

	entitlement, err := s.resolveEntitlement(user.ID)
	if err != nil {
		s.logger.Error("resolve entitlement", "user_id", user.ID, "error", err)
		s.writeError(w, http.StatusInternalServerError, "subscription_error", "Unable to verify subscription")
		return
	}

	// Check build hash integrity
	if s.latestBuildHash != "" && req.BuildHash != "" {
		if req.BuildHash != s.latestBuildHash {
			s.logger.Warn("build hash mismatch",
				"user_id", user.ID,
				"received", req.BuildHash,
				"expected", s.latestBuildHash,
			)
			entitlement.BuildWarning = "This version of Haven could not be verified. " +
				"Only download Haven from haven.trading. " +
				"Unverified software can steal your wallet keys."
		}
	}

	// Cache the result
	s.cache.Store(user.ID, cachedEntitlement{
		entitlement: *entitlement,
		expiresAt:   time.Now().Add(s.cacheTTL),
	})

	s.writeJSON(w, http.StatusOK, entitlement)
}

func (s *Service) resolveEntitlement(userID string) (*Entitlement, error) {
	// Fetch user's organization memberships from Clerk to determine plan
	planSlug, subscriptionEnd, trialEnd, err := s.fetchClerkSubscription(userID)
	if err != nil {
		s.logger.Warn("clerk subscription fetch failed, falling back to trial", "user_id", userID, "error", err)
		// Default to a minimal entitlement — the app will verify on next poll
		return &Entitlement{
			AppAccess:       true,
			Tier:            "trial",
			MaxStrategies:   3,
			MaxFinders:      1,
			MaxBots:         1,
			UniverseTokens:  10,
			LiveTrading:     false,
			FinderEnabled:   false,
			EngineAccess:    true,
			DataRefreshSec:  60,
		}, nil
	}

	tier, ok := s.tiers[planSlug]
	if !ok {
		// Unknown plan — no access
		s.logger.Warn("unknown plan slug", "user_id", userID, "slug", planSlug)
		return &Entitlement{AppAccess: false}, nil
	}

	return &Entitlement{
		AppAccess:       true,
		Tier:            tier.Name,
		TrialEnd:        trialEnd,
		MaxStrategies:   tier.Features.MaxStrategies,
		MaxFinders:      tier.Features.MaxFinders,
		MaxBots:         tier.Features.MaxBots,
		UniverseTokens:  tier.Features.UniverseTokens,
		LiveTrading:     tier.Features.LiveTrading,
		FinderEnabled:   tier.Features.FinderEnabled,
		EngineAccess:    tier.Features.EngineAccess,
		DataRefreshSec:  tier.Features.DataRefreshSec,
		SubscriptionEnd: subscriptionEnd,
	}, nil
}

// fetchClerkSubscription queries Clerk for the user's subscription/plan status.
func (s *Service) fetchClerkSubscription(userID string) (planSlug, subscriptionEnd, trialEnd string, err error) {
	req, err := http.NewRequest("GET",
		fmt.Sprintf("https://api.clerk.com/v1/users/%s/organization_memberships", userID), nil)
	if err != nil {
		return "", "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+s.clerkKey)
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", "", "", fmt.Errorf("clerk memberships api returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var result struct {
		Data []struct {
			Organization struct {
				Slug         string `json:"slug"`
				PublicMetadata struct {
					Plan string `json:"plan,omitempty"`
				} `json:"public_metadata"`
			} `json:"organization"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", "", fmt.Errorf("decode memberships: %w", err)
	}

	// Find first organization with a recognized plan slug
	for _, m := range result.Data {
		slug := m.Organization.Slug
		if _, ok := s.tiers[slug]; ok {
			// Also check for subscription end in public metadata
			return slug, "", "", nil
		}
		// Check public_metadata for plan override
		if plan := m.Organization.PublicMetadata.Plan; plan != "" {
			if _, ok := s.tiers[plan]; ok {
				return plan, "", "", nil
			}
		}
	}

	// No paid plan — check for trial
	trialEnd, err = s.fetchTrialEnd(userID)
	if err != nil {
		return "", "", "", fmt.Errorf("no paid plan and trial check failed: %w", err)
	}
	if trialEnd != "" {
		return "starter", "", trialEnd, nil // Trial gets starter features
	}

	return "", "", "", fmt.Errorf("no active subscription or trial")
}

func (s *Service) fetchTrialEnd(userID string) (string, error) {
	req, err := http.NewRequest("GET",
		fmt.Sprintf("https://api.clerk.com/v1/users/%s", userID), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+s.clerkKey)
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("clerk user api returned %d", resp.StatusCode)
	}

	var result struct {
		PublicMetadata struct {
			TrialEnd string `json:"trial_end,omitempty"`
		} `json:"public_metadata"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	return result.PublicMetadata.TrialEnd, nil
}

func (s *Service) writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (s *Service) writeError(w http.ResponseWriter, status int, code, message string) {
	s.writeJSON(w, status, map[string]string{
		"error":   code,
		"message": message,
	})
}
