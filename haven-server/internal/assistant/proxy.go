// Package assistant proxies AI chat requests to DeepSeek with rate limiting,
// subscription-gated access, and context window management.
package assistant

import (
	"bufio"
	"bytes"
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

const (
	defaultModel       = "deepseek-chat"
	maxContextMessages = 10     // keep last 10 messages for context
	maxResponseBytes   = 1 << 18 // 256KB cap on responses
)

// Service proxies chat requests to DeepSeek.
type Service struct {
	apiKey     string
	logger     *slog.Logger
	httpClient *http.Client
	verifier   *auth.ClerkVerifier

	mu       sync.Mutex
	counters map[string]*rateWindow // userID → sliding window
}

type rateWindow struct {
	timestamps []time.Time
	limit      int
	window     time.Duration
}

// ChatRequest is the incoming request from the desktop app.
type ChatRequest struct {
	Messages       []ChatMessage `json:"messages"`
	Model          string        `json:"model,omitempty"`
	LLMLimit       int           `json:"llm_limit,omitempty"`        // from entitlement
	LLMWindowSec   int           `json:"llm_window_sec,omitempty"`   // from entitlement
}

// ChatMessage is a single message in the conversation.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// NewService creates an assistant proxy service.
func NewService(apiKey string, logger *slog.Logger) *Service {
	return &Service{
		apiKey:   apiKey,
		logger:   logger,
		counters: make(map[string]*rateWindow),
		httpClient: &http.Client{Timeout: 120 * time.Second},
	}
}

// SetVerifier sets the Clerk verifier for auth checks.
func (s *Service) SetVerifier(v *auth.ClerkVerifier) { s.verifier = v }

// HandleChat is the POST /v1/assistant/chat handler.
func (s *Service) HandleChat(w http.ResponseWriter, r *http.Request) {
	// Verify auth
	if s.verifier != nil {
		_, err := s.verifier.VerifyTokenFromRequest(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "Authentication failed")
			return
		}
	}

	var chatReq ChatRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&chatReq); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if len(chatReq.Messages) == 0 {
		writeError(w, http.StatusBadRequest, "Messages array is required")
		return
	}

	// Rate limit check
	limit := chatReq.LLMLimit
	if limit <= 0 {
		limit = 5
	}
	windowSec := chatReq.LLMWindowSec
	if windowSec <= 0 {
		windowSec = 900 // 15 minutes
	}

	userID := r.Header.Get("X-User-ID")
	if userID == "" {
		userID = "anon"
	}

	if !s.checkRate(userID, limit, time.Duration(windowSec)*time.Second) {
		s.logger.Warn("rate limit hit", "user_id", userID, "limit", limit)
		writeError(w, http.StatusTooManyRequests,
			fmt.Sprintf("Rate limit reached: %d messages per %d seconds. Try again shortly.", limit, windowSec))
		return
	}

	model := chatReq.Model
	if model == "" {
		model = defaultModel
	}

	// Trim context window to keep token usage under control.
	// Always keep the system message if present; keep the last N user/assistant messages.
	messages := s.trimContext(chatReq.Messages)

	dsReq := map[string]interface{}{
		"model":       model,
		"messages":    messages,
		"stream":      false,
		"max_tokens":  1024,
	}

	body, _ := json.Marshal(dsReq)
	dsHTTPReq, _ := http.NewRequest("POST", "https://api.deepseek.com/v1/chat/completions", bytes.NewReader(body))
	dsHTTPReq.Header.Set("Authorization", "Bearer "+s.apiKey)
	dsHTTPReq.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(dsHTTPReq)
	if err != nil {
		s.logger.Error("deepseek api call", "error", err)
		writeError(w, http.StatusBadGateway, "AI service unavailable")
		return
	}
	defer resp.Body.Close()

	contentType := resp.Header.Get("Content-Type")
	if strings.Contains(contentType, "text/event-stream") {
		s.handleStreaming(w, resp)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, io.LimitReader(resp.Body, maxResponseBytes))

	s.logger.Info("assistant chat completed",
		"model", model,
		"messages_sent", len(messages),
		"original_messages", len(chatReq.Messages),
		"status", resp.StatusCode,
	)
}

// trimContext keeps the system message (if present) and the last N messages
// to control token usage. A typical message is ~200-500 tokens, so 10 messages
// keeps the context window around 2-5K tokens — enough for ongoing context
// without ballooning costs.
func (s *Service) trimContext(messages []ChatMessage) []ChatMessage {
	if len(messages) <= maxContextMessages {
		return messages
	}
	var system []ChatMessage
	var rest []ChatMessage
	for _, m := range messages {
		if m.Role == "system" {
			system = append(system, m)
		} else {
			rest = append(rest, m)
		}
	}
	if len(rest) <= maxContextMessages {
		return messages
	}
	// Keep last N conversation messages
	keep := rest[len(rest)-maxContextMessages:]
	result := append(system, keep...)
	s.logger.Info("context trimmed",
		"original", len(messages),
		"kept", len(result),
	)
	return result
}

// checkRate implements a sliding-window rate limiter.
func (s *Service) checkRate(userID string, limit int, window time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	rw, ok := s.counters[userID]
	if !ok {
		rw = &rateWindow{limit: limit, window: window}
		s.counters[userID] = rw
	}

	now := time.Now()
	cutoff := now.Add(-window)

	// Prune old entries
	valid := rw.timestamps[:0]
	for _, t := range rw.timestamps {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	rw.timestamps = valid

	if len(rw.timestamps) >= limit {
		return false
	}

	rw.timestamps = append(rw.timestamps, now)
	return true
}

func (s *Service) handleStreaming(w http.ResponseWriter, resp *http.Response) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 4096), 1<<20)
	for scanner.Scan() {
		fmt.Fprintf(w, "%s\n", scanner.Text())
		flusher.Flush()
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}
