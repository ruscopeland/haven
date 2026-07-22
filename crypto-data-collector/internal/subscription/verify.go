// Package subscription handles paid-plan verification against Clerk and Stripe.
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

	"github.com/ruscopeland/haven-server/internal/auth"
)

// Tier represents a subscription tier.
type Tier struct {
	Name     string `json:"name"`
	ClerkSlug string `json:"clerk_slug"`
	Features struct {
		MaxStrategies         int  `json:"max_strategies"`
		MaxFinders            int  `json:"max_finders"`
		MaxBots               int  `json:"max_bots"`
		UniverseTokens        int  `json:"universe_tokens"`
		LiveTrading           bool `json:"live_trading"`
		FinderEnabled         bool `json:"finder_enabled"`
		EngineAccess          bool `json:"engine_access"`
		DataRefreshSec        int  `json:"data_refresh_sec"`
		LLMMessagesPerWindow  int  `json:"llm_messages_per_window"`
		LLMWindowMinutes      int  `json:"llm_window_minutes"`
	} `json:"features"`
}

// Entitlement is the response sent to the desktop app.
type Entitlement struct {
	AppAccess            bool   `json:"app_access"`
	Tier                 string `json:"tier"`
	TrialEnd             string `json:"trial_end,omitempty"`
	MaxStrategies        int    `json:"max_strategies"`
	MaxFinders           int    `json:"max_finders"`
	MaxBots              int    `json:"max_bots"`
	UniverseTokens       int    `json:"universe_tokens"`
	LiveTrading          bool   `json:"live_trading"`
	FinderEnabled        bool   `json:"finder_enabled"`
	EngineAccess         bool   `json:"engine_access"`
	DataRefreshSec       int    `json:"data_refresh_sec"`
	LLMMessagesPerWindow int    `json:"llm_messages_per_window"`
	LLMWindowMinutes     int    `json:"llm_window_minutes"`
	SubscriptionEnd      string `json:"subscription_end,omitempty"`
	BuildWarning         string `json:"build_warning,omitempty"`
}

// Service handles subscription verification against Clerk.
type Service struct {
	verifier        *auth.ClerkVerifier
	clerkKey        string
	logger          *slog.Logger
	tiers           map[string]Tier
	cache           sync.Map
	cacheTTL        time.Duration
	latestBuildHash string
}

type cachedEntitlement struct {
	entitlement Entitlement
	expiresAt   time.Time
}

// NewService creates a subscription verification service.
func NewService(verifier *auth.ClerkVerifier, clerkKey string, logger *slog.Logger, latestBuildHash string) *Service {
	return &Service{
		verifier:        verifier,
		clerkKey:        clerkKey,
		logger:          logger,
		tiers:           defaultTiers(),
		cacheTTL:        5 * time.Minute,
		latestBuildHash: latestBuildHash,
	}
}

func defaultTiers() map[string]Tier {
	s := Tier{}.Features
	s.MaxStrategies = 5
	s.MaxFinders = 2
	s.MaxBots = 1
	s.UniverseTokens = 200
	s.LiveTrading = true
	s.FinderEnabled = false
	s.EngineAccess = true
	s.DataRefreshSec = 30
	s.LLMMessagesPerWindow = 5
	s.LLMWindowMinutes = 15

	p := Tier{}.Features
	p.MaxStrategies = 20
	p.MaxFinders = 10
	p.MaxBots = 5
	p.UniverseTokens = 500
	p.LiveTrading = true
	p.FinderEnabled = true
	p.EngineAccess = true
	p.DataRefreshSec = 10
	p.LLMMessagesPerWindow = 15
	p.LLMWindowMinutes = 15

	a := Tier{}.Features
	a.MaxStrategies = 100
	a.MaxFinders = 50
	a.MaxBots = 20
	a.UniverseTokens = 1000
	a.LiveTrading = true
	a.FinderEnabled = true
	a.EngineAccess = true
	a.DataRefreshSec = 5
	a.LLMMessagesPerWindow = 50
	a.LLMWindowMinutes = 15

	return map[string]Tier{
		"starter":  {Name: "Starter", ClerkSlug: "starter", Features: s},
		"pro":      {Name: "Pro", ClerkSlug: "pro", Features: p},
		"advanced": {Name: "Advanced", ClerkSlug: "advanced", Features: a},
	}
}

// HandleVerify is the POST /v1/subscription/verify handler.
func (s *Service) HandleVerify(w http.ResponseWriter, r *http.Request) {
	user, err := s.verifier.VerifyTokenFromRequest(r)
	if err != nil {
		s.writeError(w, http.StatusUnauthorized, "invalid_token", "Authentication failed")
		return
	}

	var req struct {
		BuildHash string `json:"build_hash"`
	}
	if body, readErr := io.ReadAll(io.LimitReader(r.Body, 4096)); readErr == nil {
		json.Unmarshal(body, &req)
	}

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

	if s.latestBuildHash != "" && req.BuildHash != "" && req.BuildHash != s.latestBuildHash {
		s.logger.Warn("build hash mismatch", "user_id", user.ID, "received", req.BuildHash, "expected", s.latestBuildHash)
		entitlement.BuildWarning = "This version of Haven could not be verified. Only download Haven from haven.trading. Unverified software can steal your wallet keys."
	}

	s.cache.Store(user.ID, cachedEntitlement{entitlement: *entitlement, expiresAt: time.Now().Add(s.cacheTTL)})
	s.writeJSON(w, http.StatusOK, entitlement)
}

func (s *Service) resolveEntitlement(userID string) (*Entitlement, error) {
	planSlug, subscriptionEnd, trialEnd, err := s.fetchClerkSubscription(userID)
	if err != nil {
		s.logger.Warn("clerk subscription fetch failed, falling back to trial", "user_id", userID, "error", err)
		return &Entitlement{
			AppAccess:            true,
			Tier:                 "trial",
			MaxStrategies:        3,
			MaxFinders:           1,
			MaxBots:              1,
			UniverseTokens:       100,
			LiveTrading:          true,
			FinderEnabled:        false,
			EngineAccess:         true,
			DataRefreshSec:       60,
			LLMMessagesPerWindow: 3,
			LLMWindowMinutes:     15,
		}, nil
	}

	t, ok := s.tiers[planSlug]
	if !ok {
		return &Entitlement{AppAccess: false}, nil
	}

	return &Entitlement{
		AppAccess:            true,
		Tier:                 t.Name,
		TrialEnd:             trialEnd,
		MaxStrategies:        t.Features.MaxStrategies,
		MaxFinders:           t.Features.MaxFinders,
		MaxBots:              t.Features.MaxBots,
		UniverseTokens:       t.Features.UniverseTokens,
		LiveTrading:          t.Features.LiveTrading,
		FinderEnabled:        t.Features.FinderEnabled,
		EngineAccess:         t.Features.EngineAccess,
		DataRefreshSec:       t.Features.DataRefreshSec,
		LLMMessagesPerWindow: t.Features.LLMMessagesPerWindow,
		LLMWindowMinutes:     t.Features.LLMWindowMinutes,
		SubscriptionEnd:      subscriptionEnd,
	}, nil
}

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
				Slug           string `json:"slug"`
				PublicMetadata struct {
					Plan string `json:"plan,omitempty"`
				} `json:"public_metadata"`
			} `json:"organization"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", "", fmt.Errorf("decode memberships: %w", err)
	}

	for _, m := range result.Data {
		slug := m.Organization.Slug
		if _, ok := s.tiers[slug]; ok {
			return slug, "", "", nil
		}
		if plan := m.Organization.PublicMetadata.Plan; plan != "" {
			if _, ok := s.tiers[plan]; ok {
				return plan, "", "", nil
			}
		}
	}

	trialEnd, err = s.fetchTrialEnd(userID)
	if err != nil {
		return "", "", "", fmt.Errorf("no paid plan and trial check failed: %w", err)
	}
	if trialEnd != "" {
		return "starter", "", trialEnd, nil
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
	s.writeJSON(w, status, map[string]string{"error": code, "message": message})
}
