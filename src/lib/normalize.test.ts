import { describe, expect, it } from 'vitest'
import {
  AMBIGUITY_GAP,
  AUTO_ACCEPT_SIMILARITY,
  REVIEW_FLOOR_SIMILARITY,
  levenshtein,
  normalizeName,
  similarity,
} from './normalize'

describe('normalizeName', () => {
  it('ignores casing', () => {
    expect(normalizeName('ACME SHOP')).toBe(normalizeName('Acme Shop'))
    expect(normalizeName('acme shop')).toBe(normalizeName('AcMe ShOp'))
  })

  it('ignores punctuation and spacing', () => {
    expect(normalizeName('Cedar & Co.')).toBe(normalizeName('Cedar and Co'))
    expect(normalizeName('  Pine   &  Petal ')).toBe(normalizeName('Pine and Petal'))
    expect(normalizeName("O'Hara Goods")).toBe(normalizeName('O Hara Goods'))
  })

  it('collapses equivalent legal suffixes', () => {
    expect(normalizeName('Northwind Ltd')).toBe(normalizeName('Northwind Limited'))
    expect(normalizeName('Lumen Apparel Inc')).toBe(normalizeName('Lumen Apparel Incorporated'))
    expect(normalizeName('Atlas Homewares LLC')).toBe(normalizeName('Atlas Homewares'))
    expect(normalizeName('Kestrel Cycles Ltd')).toBe(normalizeName('Kestrel Cycles'))
  })

  it('strips diacritics', () => {
    expect(normalizeName('Café Noir')).toBe(normalizeName('Cafe Noir'))
  })

  it('is insensitive to token order', () => {
    expect(normalizeName('Outfitters, Riverstone')).toBe(normalizeName('Riverstone Outfitters'))
  })

  it('never reduces a name to an empty key', () => {
    expect(normalizeName('Ltd')).toBe('ltd')
    expect(normalizeName('Co.')).toBe('co')
  })

  it('does not collapse suffixes that can distinguish entities', () => {
    // "Group" and "Holdings" are not treated as noise: they can be the only
    // thing separating two real companies.
    expect(normalizeName('Halden Group')).not.toBe(normalizeName('Halden Holdings'))
    expect(normalizeName('Halden Group')).not.toBe(normalizeName('Halden'))
  })
})

describe('similarity', () => {
  it('scores identical keys at 1', () => {
    expect(similarity('acme shop', 'acme shop')).toBe(1)
  })

  it('scores disjoint keys at or near 0', () => {
    expect(similarity('acme', 'xyz')).toBeLessThan(0.3)
    expect(similarity('', 'acme')).toBe(0)
  })

  it('rates a one-letter spelling difference above the auto-accept line', () => {
    const a = normalizeName('Harbour Brew Co')
    const b = normalizeName('Harbor Brew')
    expect(similarity(a, b)).toBeGreaterThanOrEqual(AUTO_ACCEPT_SIMILARITY)
  })

  it('rates a different-word lookalike below the auto-accept line', () => {
    // "Ridgeway" vs "Ridgeline" is a different brand, not a typo.
    const a = normalizeName('Ridgeway Outdoors')
    const b = normalizeName('Ridgeline Outdoors')
    expect(similarity(a, b)).toBeLessThan(AUTO_ACCEPT_SIMILARITY)
  })

  it('is symmetric', () => {
    expect(similarity('harbor brew', 'harbour brew')).toBe(
      similarity('harbour brew', 'harbor brew'),
    )
  })
})

describe('levenshtein', () => {
  it('matches known distances', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', 'abc')).toBe(0)
  })
})

describe('thresholds', () => {
  it('keeps the review band open between the floor and auto-accept', () => {
    expect(REVIEW_FLOOR_SIMILARITY).toBeLessThan(AUTO_ACCEPT_SIMILARITY)
    expect(AMBIGUITY_GAP).toBeGreaterThan(0)
  })
})
