// Mock Anthropic SDK before requiring the module under test
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn(),
    },
  }));
});

const Anthropic = require('@anthropic-ai/sdk');
const { auditTrade, buildPrompt, ESTIMATED_COST_USD } = require('../src/analysis/ai-auditor');

function mockResponse(text) {
  const instance = new Anthropic();
  instance.messages.create.mockResolvedValueOnce({
    content: [{ type: 'text', text }],
  });
}

const BASE = {
  symbol: 'NVDA',
  price: 420,
  reason: 'L1 entry — all filters pass',
  scores: {
    market_state: 'RISK_ON', market_score: 75,
    trend: 'BULL', adx: 32.5, atr: 8.4,
    rs_score: 88, tech_score: 72,
  },
};

describe('auditTrade', () => {
  beforeEach(() => {
    // Fresh mock instance per test
    Anthropic.mockClear();
    Anthropic.mockImplementation(() => ({
      messages: { create: jest.fn() },
    }));
  });

  test('returns BUY verdict when model responds with BUY', async () => {
    const instance = { messages: { create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'BUY Strong momentum with broad market participation.' }] }) } };
    Anthropic.mockImplementation(() => instance);

    const result = await auditTrade(BASE);
    expect(result.verdict).toBe('BUY');
    expect(result.reason).toBeTruthy();
    expect(result.costUsd).toBe(ESTIMATED_COST_USD);
  });

  test('returns SKIP verdict when model responds with SKIP', async () => {
    const instance = { messages: { create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'SKIP Setup looks overextended after recent surge.' }] }) } };
    Anthropic.mockImplementation(() => instance);

    const result = await auditTrade(BASE);
    expect(result.verdict).toBe('SKIP');
    expect(result.reason).toContain('overextended');
  });

  test('treats any non-BUY response as SKIP', async () => {
    const instance = { messages: { create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'HOLD for now.' }] }) } };
    Anthropic.mockImplementation(() => instance);

    const result = await auditTrade(BASE);
    expect(result.verdict).toBe('SKIP');
  });

  test('case-insensitive BUY detection', async () => {
    const instance = { messages: { create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'buy looks good' }] }) } };
    Anthropic.mockImplementation(() => instance);

    const result = await auditTrade(BASE);
    expect(result.verdict).toBe('BUY');
  });

  test('passes custom model to API', async () => {
    const createMock = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'BUY solid.' }] });
    Anthropic.mockImplementation(() => ({ messages: { create: createMock } }));

    await auditTrade({ ...BASE, model: 'claude-haiku-4-5-20251001' });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' })
    );
  });

  test('throws when API call rejects', async () => {
    const instance = { messages: { create: jest.fn().mockRejectedValue(new Error('API error')) } };
    Anthropic.mockImplementation(() => instance);

    await expect(auditTrade(BASE)).rejects.toThrow('API error');
  });
});

describe('buildPrompt', () => {
  test('includes symbol and price', () => {
    const prompt = buildPrompt(BASE);
    expect(prompt).toContain('NVDA');
    expect(prompt).toContain('420.00');
  });

  test('includes all score fields', () => {
    const prompt = buildPrompt(BASE);
    expect(prompt).toContain('RISK_ON');
    expect(prompt).toContain('BULL');
    expect(prompt).toContain('88');  // rs_score
    expect(prompt).toContain('72');  // tech_score
  });

  test('includes entry reason', () => {
    const prompt = buildPrompt(BASE);
    expect(prompt).toContain('all filters pass');
  });

  test('handles null scores gracefully', () => {
    const prompt = buildPrompt({ ...BASE, scores: {} });
    expect(prompt).toContain('N/A');
  });

  test('instructs model to respond with BUY or SKIP', () => {
    const prompt = buildPrompt(BASE);
    expect(prompt).toContain('BUY');
    expect(prompt).toContain('SKIP');
  });
});
