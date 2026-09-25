import { describe, it, expect } from 'vitest';
import { PACKAGE } from '../src/index';

describe('floken-engine smoke', () => {
  it('exposes package name', () => {
    expect(PACKAGE).toBe('floken-engine');
  });
});
