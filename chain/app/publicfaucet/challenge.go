package publicfaucet

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ChallengeVerifier proves request liveness before any limiter state is
// spent. Verification failures are denials, never errors.
type ChallengeVerifier interface {
	Verify(ctx context.Context, token string) (bool, error)
	Mode() ChallengeMode
}

// TurnstileVerifier validates tokens with Cloudflare Turnstile siteverify.
// Only the token is forwarded; the client IP is deliberately withheld to
// keep the documented privacy impact minimal.
type TurnstileVerifier struct {
	secret   string
	endpoint string
	client   *http.Client
}

// NewTurnstileVerifier builds the production challenge verifier.
func NewTurnstileVerifier(secret, endpoint string) (*TurnstileVerifier, error) {
	if strings.TrimSpace(secret) == "" {
		return nil, fmt.Errorf("turnstile secret is required in turnstile challenge mode")
	}
	if endpoint == "" {
		endpoint = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
	}
	return &TurnstileVerifier{
		secret:   secret,
		endpoint: endpoint,
		client:   &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// Mode identifies the verifier for health reporting.
func (verifier *TurnstileVerifier) Mode() ChallengeMode { return ChallengeTurnstile }

// Verify posts the token to siteverify and returns its success flag.
func (verifier *TurnstileVerifier) Verify(ctx context.Context, token string) (bool, error) {
	form := url.Values{"secret": {verifier.secret}, "response": {token}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, verifier.endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return false, fmt.Errorf("build turnstile verification request: %w", err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := verifier.client.Do(request)
	if err != nil {
		return false, fmt.Errorf("verify turnstile token: %w", err)
	}
	defer response.Body.Close()
	var body struct {
		Success bool `json:"success"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return false, fmt.Errorf("decode turnstile verification response: %w", err)
	}
	return body.Success, nil
}

// StaticVerifier accepts exactly one rehearsal token. The profile loader
// only permits it for local-rehearsal profiles.
type StaticVerifier struct {
	token string
}

// NewStaticVerifier builds the local-rehearsal challenge verifier.
func NewStaticVerifier(token string) (*StaticVerifier, error) {
	if strings.TrimSpace(token) == "" {
		return nil, fmt.Errorf("static challenge token is required in static-local challenge mode")
	}
	return &StaticVerifier{token: token}, nil
}

// Mode identifies the verifier for health reporting.
func (verifier *StaticVerifier) Mode() ChallengeMode { return ChallengeStaticLocal }

// Verify compares the presented token in constant time.
func (verifier *StaticVerifier) Verify(_ context.Context, token string) (bool, error) {
	return subtle.ConstantTimeCompare([]byte(token), []byte(verifier.token)) == 1, nil
}
