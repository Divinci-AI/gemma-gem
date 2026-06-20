import { describe, it, expect } from 'vitest'
import { generateCodeVerifier, generateState, computeCodeChallenge } from '@/shared/pkce'

describe('pkce', () => {
  it('generates an unreserved-charset verifier of RFC-legal length (43–128)', () => {
    const v = generateCodeVerifier()
    expect(v.length).toBeGreaterThanOrEqual(43)
    expect(v.length).toBeLessThanOrEqual(128)
    expect(v).toMatch(/^[A-Za-z0-9\-_]+$/) // base64url, no padding
  })

  it('produces distinct verifiers and states each call', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier())
    expect(generateState()).not.toBe(generateState())
  })

  it('computes the S256 challenge per the RFC 7636 appendix-B test vector', async () => {
    // RFC 7636 §appendix B canonical pair.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = await computeCodeChallenge(verifier)
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('challenge is base64url (no +/= chars)', async () => {
    const challenge = await computeCodeChallenge(generateCodeVerifier())
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/)
  })
})
