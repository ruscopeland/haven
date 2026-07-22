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
	Mode           string        `json:"mode,omitempty"`
	Code           string        `json:"code,omitempty"`
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
		apiKey:     apiKey,
		logger:     logger,
		counters:   make(map[string]*rateWindow),
		httpClient: &http.Client{Timeout: 120 * time.Second},
	}
}

// SetVerifier sets the Clerk verifier for auth checks.
func (s *Service) SetVerifier(v *auth.ClerkVerifier) { s.verifier = v }

func (s *Service) buildSystemPrompt(mode, code string) string {
	var sb strings.Builder
	sb.WriteString("You are an expert quantitative developer for the Haven crypto trading platform.\n")
	sb.WriteString("You write sandboxed JavaScript trading strategies and token finders.\n")
	sb.WriteString("You do not have access to the internet, you cannot run shell commands, and you cannot view external charts. You only write JavaScript code.\n")
	sb.WriteString("Never output placeholder implementations. Never output fake API integrations. Never output code that doesn't actually work.\n\n")

	if mode == "strategy" {
		sb.WriteString("You are writing a 'Strategy' using the strategy-sdk.\n")
		sb.WriteString("A strategy defines `onBar(bar, ctx)` which is called every tick.\n")
		sb.WriteString("You can access indicators like `ctx.rsi()`, `ctx.sma()`, `ctx.bb()`, `ctx.vwap()`, `ctx.roc()`, `ctx.stddev()`.\n")
		sb.WriteString("You can execute trades using `ctx.buy()` and `ctx.sell()`.\n")
		sb.WriteString("CRITICAL: `ctx` is ONLY available inside `onBar`. Do not reference `ctx` in the `params` object or at the top level of the script.\n")
		sb.WriteString("The `params` object must contain static default values (numbers, strings, booleans).\n")
		sb.WriteString("Example structure:\n")
		sb.WriteString("const strategy = {\n  name: 'My Strat',\n  params: { rsiLen: 14, overbought: 70 },\n  onBar(bar, ctx) { \n    const rsi = ctx.rsi(ctx.params.rsiLen);\n    // logic here \n  }\n};\n")
	} else if mode == "finder" {
		sb.WriteString("You are writing a 'Token Finder' using the strategy-sdk.\n")
		sb.WriteString("A finder defines `filter(ctx)` which returns a boolean, and `score(ctx)` which returns a number to rank tokens.\n")
		sb.WriteString("Finders rank tokens; they never execute trades.\n")
		sb.WriteString("CRITICAL: `ctx` is ONLY available inside `filter` and `score`. Do not reference `ctx` in the `params` object or at the top level of the script.\n")
		sb.WriteString("The `params` object must contain static default values.\n")
		sb.WriteString("Example structure:\n")
		sb.WriteString("const finder = {\n  name: 'My Finder',\n  params: { minVol: 50000 },\n  filter(ctx) { return ctx.token.volume24h >= ctx.params.minVol; },\n  score(ctx) { return 1; }\n};\n")
	}

	if code != "" {
		sb.WriteString("\nHere is the user's current code:\n")
		sb.WriteString("```javascript\n")
		sb.WriteString(code)
		sb.WriteString("\n```\n")
	}

	return sb.String()
}

// HandleChat is the POST /v1/assistant/chat handler.
func (s *Service) HandleChat(w http.ResponseWriter, r *http.Request) {
	// Verify auth
	if s.verifier != nil {
		_, err := s.verifier.VerifyTokenFromRequest(r)
		if err != nil {
			s.logger.Error("Authentication failed", "err", err.Error())
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

	// Inject System Prompt
	hasSystem := false
	for _, m := range chatReq.Messages {
		if m.Role == "system" {
			hasSystem = true
			break
		}
	}
	if !hasSystem {
		sysPrompt := s.buildSystemPrompt(chatReq.Mode, chatReq.Code)
		chatReq.Messages = append([]ChatMessage{{Role: "system", Content: sysPrompt}}, chatReq.Messages...)
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

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to read AI response")
		return
	}

	var dsResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}

	if err := json.Unmarshal(bodyBytes, &dsResp); err != nil {
		// Just proxy the raw text if we can't parse it as json
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		w.Write(bodyBytes)
	} else {
		var reply string
		if len(dsResp.Choices) > 0 {
			reply = dsResp.Choices[0].Message.Content
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		json.NewEncoder(w).Encode(map[string]string{"reply": reply})
	}

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
