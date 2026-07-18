package market

import (
	"github.com/ruscopeland/haven-desktop/internal/api"
)

// Compile-time check that Service satisfies api.MarketProvider.
var _ api.MarketProvider = (*Service)(nil)

// GetTokens returns the cached token catalogue in the API-compatible format.
func (s *Service) GetTokens() []api.TokenEntry {
	tokens := s.Tokens()
	entries := make([]api.TokenEntry, len(tokens))
	for i, t := range tokens {
		entries[i] = api.TokenEntry{
			AlphaID:         t.AlphaID,
			Symbol:          t.Symbol,
			Name:            t.Name,
			ChainID:         t.ChainID,
			ContractAddress: t.ContractAddress,
			Price:           t.Price,
			PriceChange24h:  t.PriceChange24h,
			Volume24h:       t.Volume24h,
		}
	}
	return entries
}
