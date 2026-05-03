// tests/unit/security/redactor.test.ts
import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../../src/security/redactor.js';

describe('redactSecrets', () => {
  // --- Plan-specified tests ---

  it('redacts OpenAI/Anthropic-style API keys', () => {
    const out = redactSecrets(
      'key=sk-proj-abc123def456ghi789jklmnopqrstuvwxyzabc and sk-ant-api03-token12345678901234567890',
    );
    expect(out).not.toContain('sk-proj-abc');
    expect(out).not.toContain('sk-ant-api03');
    expect(out).toContain('[REDACTED:openai_key]');
    expect(out).toContain('[REDACTED:anthropic_key]');
  });

  it('redacts JWT tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactSecrets(`token: ${jwt}`);
    expect(out).toContain('[REDACTED:jwt]');
    expect(out).not.toContain(jwt);
  });

  it('redacts PEM blocks', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKc...\n-----END PRIVATE KEY-----';
    const out = redactSecrets(pem);
    expect(out).toContain('[REDACTED:pem]');
    expect(out).not.toContain('MIIEvQIBADAN');
  });

  it('redacts dotenv-style assignments for known sensitive keys', () => {
    const out = redactSecrets('DATABASE_URL=postgres://user:pass@host/db\nAPI_KEY=topsecret123');
    expect(out).toContain('[REDACTED:env_value]');
    expect(out).not.toContain('topsecret123');
    expect(out).not.toContain('pass@host');
  });

  it('leaves benign text untouched', () => {
    expect(redactSecrets('Just a normal sentence.')).toBe('Just a normal sentence.');
  });

  // --- Additional contract tests ---

  it('regression: sk-ant-... is labeled anthropic_key, not openai_key (defect #1 ordering fix)', () => {
    const out = redactSecrets('sk-ant-api03-token12345678901234567890');
    expect(out).toContain('[REDACTED:anthropic_key]');
    expect(out).not.toContain('[REDACTED:openai_key]');
  });

  it('redacts multiple secrets independently in the same string', () => {
    const out = redactSecrets('API_KEY=mysecret123 and TOKEN=anotherSecret');
    // Both env assignments should be redacted
    expect(out).not.toContain('mysecret123');
    expect(out).not.toContain('anotherSecret');
    // Original key names preserved, values replaced
    expect(out).toContain('API_KEY=');
    expect(out).toContain('TOKEN=');
    expect(out).toContain('[REDACTED:env_value]');
  });

  it('redactSecrets("") returns ""', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('mixed-case env keys are redacted (gi flag)', () => {
    const out = redactSecrets('api_key=lowercase_secret\nApi_Key=MixedCase_secret');
    expect(out).not.toContain('lowercase_secret');
    expect(out).not.toContain('MixedCase_secret');
    expect(out).toContain('[REDACTED:env_value]');
  });

  it('redacts PEM blocks with RSA PRIVATE KEY header', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(pem);
    expect(out).toContain('[REDACTED:pem]');
    expect(out).not.toContain('MIIEpAIBAAKCAQEA');
  });

  it('redacts PEM blocks with OPENSSH PRIVATE KEY header', () => {
    const pem =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAA...\n-----END OPENSSH PRIVATE KEY-----';
    const out = redactSecrets(pem);
    expect(out).toContain('[REDACTED:pem]');
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEAA');
  });

  it('preserves the key name when redacting env assignments', () => {
    const out = redactSecrets('DATABASE_URL=postgres://user:pass@localhost/mydb');
    expect(out).toContain('DATABASE_URL=');
    expect(out).toContain('[REDACTED:env_value]');
    expect(out).not.toContain('postgres://');
  });
});
