import { describe, it, expect } from 'vitest';
import { calculateProfitLoss } from '../utils/txTracer';

// Mock token addresses
const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82'.toLowerCase();
const USDT = '0x55d398326f99059ff775485246999027b3197955'.toLowerCase();

describe('Cost Basis and PnL Calculations', () => {
  it('should compute the correct average cost basis on a single purchase', () => {
    // Scenario: Swapped 1 BNB ($600) for 100 CAKE. Gas fee: $0.50
    const mockTxs = [
      {
        hash: '0x1',
        timeStamp: 1620000000,
        type: 'swap',
        description: 'Swapped 1 BNB for 100 CAKE',
        gasFeeUsd: 0.5,
        isUserInitiated: true,
        details: {
          fromToken: { address: '0x0000000000000000000000000000000000000000', symbol: 'BNB', decimals: 18, value: '1.0' },
          toToken: { address: CAKE, symbol: 'CAKE', decimals: 18, value: '100.0' },
          valueUsd: 600.0
        }
      }
    ];

    const currentBalances = {
      [CAKE]: '100.0'
    };

    const currentPrices = {
      [CAKE]: 10.0 // Price goes up to $10.00
    };

    const pnl = calculateProfitLoss(mockTxs, currentBalances, currentPrices);

    expect(pnl[CAKE]).toBeDefined();
    // Avg Cost Basis should be (valueUsd + gasFee) / qty = (600.0 + 0.5) / 100 = 6.005
    expect(pnl[CAKE].avgCostBasis).toBeCloseTo(6.005, 5);
    // Current value is 100 * $10 = $1000
    expect(pnl[CAKE].currentValueUsd).toBeCloseTo(1000.0, 2);
    // Total cost is 100 * 6.005 = $600.5
    expect(pnl[CAKE].totalCostUsd).toBeCloseTo(600.5, 2);
    // PnL USD should be $1000 - $600.5 = $399.5
    expect(pnl[CAKE].pnlUsd).toBeCloseTo(399.5, 2);
    // PnL % should be (399.5 / 600.5) * 100 = 66.52789...
    expect(pnl[CAKE].pnlPercent).toBeCloseTo(66.5279, 4);
  });

  it('should handle sequential buys, updating average cost basis', () => {
    // Buy 1: 100 CAKE for $600 ($6.00 each) + $0.50 gas
    // Buy 2: 50 CAKE for $400 ($8.00 each) + $0.50 gas
    const mockTxs = [
      {
        hash: '0x1',
        timeStamp: 1620000000,
        type: 'swap',
        gasFeeUsd: 0.5,
        isUserInitiated: true,
        details: {
          fromToken: { address: '0x0', symbol: 'BNB', value: '1.0' },
          toToken: { address: CAKE, symbol: 'CAKE', value: '100.0' },
          valueUsd: 600.0
        }
      },
      {
        hash: '0x2',
        timeStamp: 1620100000,
        type: 'swap',
        gasFeeUsd: 0.5,
        isUserInitiated: true,
        details: {
          fromToken: { address: USDT, symbol: 'USDT', value: '400.0' },
          toToken: { address: CAKE, symbol: 'CAKE', value: '50.0' },
          valueUsd: 400.0
        }
      }
    ];

    const currentBalances = {
      [CAKE]: '150.0'
    };

    const currentPrices = {
      [CAKE]: 8.0
    };

    const pnl = calculateProfitLoss(mockTxs, currentBalances, currentPrices);

    // Total CAKE = 150
    // Total Cost = 600.5 (Buy 1) + 400.5 (Buy 2) = 1001.0
    // Avg Cost Basis = 1001.0 / 150 = 6.67333...
    expect(pnl[CAKE].avgCostBasis).toBeCloseTo(6.6733, 4);
    expect(pnl[CAKE].totalCostUsd).toBeCloseTo(1001.0, 2);
    // Current value = 150 * 8 = $1200
    expect(pnl[CAKE].currentValueUsd).toBeCloseTo(1200.0, 2);
    // PnL USD = $1200 - $1001 = $199
    expect(pnl[CAKE].pnlUsd).toBeCloseTo(199.0, 2);
  });

  it('should decrease holdings on sell while maintaining average cost basis', () => {
    // Buy 1: 100 CAKE for $600 ($6.00 each) + $0.50 gas. Avg cost basis = 6.005
    // Sell 1: Sell 40 CAKE for $320 ($8.00 each) + $0.50 gas. 
    // Remaining CAKE should be 60, with cost basis still at 6.005.
    const mockTxs = [
      {
        hash: '0x1',
        timeStamp: 1620000000,
        type: 'swap',
        gasFeeUsd: 0.5,
        isUserInitiated: true,
        details: {
          fromToken: { address: '0x0', symbol: 'BNB', value: '1.0' },
          toToken: { address: CAKE, symbol: 'CAKE', value: '100.0' },
          valueUsd: 600.0
        }
      },
      {
        hash: '0x2',
        timeStamp: 1620200000,
        type: 'swap',
        gasFeeUsd: 0.5,
        isUserInitiated: true,
        details: {
          fromToken: { address: CAKE, symbol: 'CAKE', value: '40.0' },
          toToken: { address: USDT, symbol: 'USDT', value: '320.0' },
          valueUsd: 320.0
        }
      }
    ];

    const currentBalances = {
      [CAKE]: '60.0'
    };

    const currentPrices = {
      [CAKE]: 10.0
    };

    const pnl = calculateProfitLoss(mockTxs, currentBalances, currentPrices);

    // Remaining CAKE = 60
    // Avg Cost Basis = 6.005
    expect(pnl[CAKE].avgCostBasis).toBeCloseTo(6.005, 5);
    // Total remaining cost should be 60 * 6.005 = 360.3
    expect(pnl[CAKE].totalCostUsd).toBeCloseTo(360.3, 2);
    // Current value = 60 * $10 = $600
    expect(pnl[CAKE].currentValueUsd).toBeCloseTo(600.0, 2);
    // PnL USD = $600 - $360.3 = $239.7
    expect(pnl[CAKE].pnlUsd).toBeCloseTo(239.7, 2);
  });

  it('should handle untraced starting balance, estimating cost basis using the oldest tracked price', () => {
    // Starting balance = currentBalance (100) - netHistoricalChange (40) = 60
    // Oldest tracked transaction has price valueUsd/qty = 200/40 = $5/CAKE.
    // So starting balance of 60 should have cost basis of $5.
    // Buy 1: 40 CAKE for $200 + $1 gas = $201
    // Total CAKE = 100.
    // Total Cost = 60 * $5 + $201 = $501.
    // Avg Cost Basis = 501 / 100 = 5.01
    const mockTxs = [
      {
        hash: '0x1',
        timeStamp: 1620000000,
        type: 'swap',
        gasFeeUsd: 1.0,
        isUserInitiated: true,
        details: {
          fromToken: { address: '0x0000000000000000000000000000000000000000', symbol: 'BNB', value: '1.0' },
          toToken: { address: CAKE, symbol: 'CAKE', value: '40.0' },
          valueUsd: 200.0
        }
      }
    ];

    const currentBalances = {
      [CAKE]: '100.0'
    };

    const currentPrices = {
      [CAKE]: 10.0
    };

    const pnl = calculateProfitLoss(mockTxs, currentBalances, currentPrices);

    expect(pnl[CAKE]).toBeDefined();
    expect(pnl[CAKE].avgCostBasis).toBeCloseTo(5.01, 5);
    expect(pnl[CAKE].totalCostUsd).toBeCloseTo(501.0, 2);
    expect(pnl[CAKE].currentValueUsd).toBeCloseTo(1000.0, 2);
    expect(pnl[CAKE].pnlUsd).toBeCloseTo(499.0, 2);
    expect(pnl[CAKE].pnlPercent).toBeCloseTo(99.6008, 4);
  });

  it('should fallback to current price for tokens with no transaction history (0% PnL)', () => {
    const mockTxs = [];
    const currentBalances = {
      [CAKE]: '100.0'
    };
    const currentPrices = {
      [CAKE]: 10.0
    };

    const pnl = calculateProfitLoss(mockTxs, currentBalances, currentPrices);

    expect(pnl[CAKE]).toBeDefined();
    expect(pnl[CAKE].avgCostBasis).toBeCloseTo(10.0, 2);
    expect(pnl[CAKE].totalCostUsd).toBeCloseTo(1000.0, 2);
    expect(pnl[CAKE].pnlUsd).toBeCloseTo(0.0, 2);
    expect(pnl[CAKE].pnlPercent).toBeCloseTo(0.0, 2);
  });

  it('should handle native BNB correctly (0% PnL)', () => {
    const mockTxs = [];
    const BNB = '0x0000000000000000000000000000000000000000';
    const currentBalances = {
      [BNB]: '2.5'
    };
    const currentPrices = {
      [BNB]: 600.0
    };

    const pnl = calculateProfitLoss(mockTxs, currentBalances, currentPrices);

    expect(pnl[BNB]).toBeDefined();
    expect(pnl[BNB].pnlUsd).toBeCloseTo(0.0, 2);
    expect(pnl[BNB].pnlPercent).toBeCloseTo(0.0, 2);
  });
});
