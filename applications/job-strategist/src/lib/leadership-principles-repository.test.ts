/**
 * @format
 * Leadership-principles repository — pure unit tests for the company→framework
 * mapping. The RDS load path is exercised by integration tests; here we only
 * cover the deterministic, I/O-free `frameworkForCompany` helper.
 */
import { frameworkForCompany } from './leadership-principles-repository.js';

describe('frameworkForCompany', () => {
  it('maps amazon → amazon, others → generic', () => {
    expect(frameworkForCompany('Amazon')).toBe('amazon');
    expect(frameworkForCompany('Amazon Web Services')).toBe('amazon');
    expect(frameworkForCompany('Stripe')).toBe('generic');
  });

  it('matches amazon case-insensitively as a whole word only', () => {
    expect(frameworkForCompany('amazon')).toBe('amazon');
    expect(frameworkForCompany('AMAZON')).toBe('amazon');
    expect(frameworkForCompany('Amazonian Co')).toBe('generic');
  });
});
