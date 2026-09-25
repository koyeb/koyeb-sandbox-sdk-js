import { describe, expect, it } from 'vitest';

import { shellQuote } from './shell.js';

describe('shellQuote', () => {
  it('wraps ordinary values in single quotes', () => {
    expect(shellQuote('/data/file.txt')).toBe("'/data/file.txt'");
  });

  it('neutralizes shell metacharacters', () => {
    expect(shellQuote('/tmp/a b; rm -rf /')).toBe("'/tmp/a b; rm -rf /'");
    expect(shellQuote('$(whoami)')).toBe("'$(whoami)'");
  });

  it('escapes embedded single quotes the shlex way', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
