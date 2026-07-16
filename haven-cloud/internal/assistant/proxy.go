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
	"time"

	"github.com/ruscopeland/haven-cloud/internal/auth"
)

// Service proxies chat requests to DeepSeek.
type Service struct {
	apiKey     string
	logger     *slog.Logger
	httpClient *http.Client
	verifier   *auth.ClerkVerifier
}

// ChatRequest is the incoming request from the desktop app.
type ChatRequest struct {
	Messages []ChatMessage `json:"messages"`
	Model    string        `json:"model,omitempty"`
}

// ChatMessage is a single message in the conversation.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// NewService creates an assistant proxy service.
func NewService(apiKey string, logger *slog.Logger) *Service {
	return &Service{
		apiKey: apiKey,
		logger: logger,
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

// SetVerifier sets the Clerk verifier for auth checks.
func (s *Service) SetVerifier(v *auth.ClerkVerifier) {
	s.verifier = v
}

// HandleChat is the POST /v1/assistant/chat handler.
// It verifies the user's subscription, then proxies to DeepSeek with streaming.
func (s *Service) HandleChat(w http.ResponseWriter, r *http.Request) {
	// Verify subscription
	if s.verifier != nil {
		_, err := s.verifier.VerifyTokenFromRequest(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "Authentication failed")
			return
		}
	}

	// Parse request
	var chatReq ChatRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&chatReq); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if len(chatReq.Messages) == 0 {
		writeError(w, http.StatusBadRequest, "Messages array is required")
		return
	}

	model := chatReq.Model
	if model == "" {
		model = "deepseek-chat"
	}

	// Build DeepSeek request
	dsReq := map[string]interface{}{
		"model":    model,
		"messages": chatReq.Messages,
		"stream":   false,
	}

	body, err := json.Marshal(dsReq)
	if err != nil {
		s.logger.Error("marshal deepseek request", "error", err)
		writeError(w, http.StatusInternalServerError, "Internal error")
		return
	}

	dsHTTPReq, err := http.NewRequest("POST", "https://api.deepseek.com/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		s.logger.Error("create deepseek request", "error", err)
		writeError(w, http.StatusInternalServerError, "Internal error")
		return
	}
	dsHTTPReq.Header.Set("Authorization", "Bearer "+s.apiKey)
	dsHTTPReq.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(dsHTTPReq)
	if err != nil {
		s.logger.Error("deepseek api call", "error", err)
		writeError(w, http.StatusBadGateway, "AI service unavailable")
		return
	}
	defer resp.Body.Close()

	// Check for streaming response
	contentType := resp.Header.Get("Content-Type")
	if strings.Contains(contentType, "text/event-stream") {
		s.handleStreaming(w, resp)
		return
	}

	// Non-streaming — pass through
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, io.LimitReader(resp.Body, 1<<20))

	s.logger.Info("assistant chat completed",
		"model", model,
		"messages", len(chatReq.Messages),
		"status", resp.StatusCode,
	)
}

func (s *Service) handleStreaming(w http.ResponseWriter, resp *http.Response) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		s.logger.Error("streaming not supported")
		return
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 4096), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if _, err := fmt.Fprintf(w, "%s\n", line); err != nil {
			return
		}
		flusher.Flush()
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}
