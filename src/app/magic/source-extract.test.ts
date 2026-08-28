import { describe, expect, it } from 'vitest';
// The real style module, imported as a string exactly the way the "Show the
// magic" panel does it in production (Vite `?raw`) — so this test exercises
// extraction against the same bytes the panel will.
import branchSource from '../../styles/botanical/branch.ts?raw';
import { extractFunctionSource } from './source-extract';

/** Wraps `body` in unrelated code above and below, so a test that asserts an
 *  exact slice also proves the extractor found the right boundaries. */
function surround(body: string): string {
  return `const before = 1;\n\n${body}\n\nconst after = 2;\n`;
}

describe('extractFunctionSource — declaration forms', () => {
  it('extracts an `export function` declaration from keyword through closing brace, no trailing newline', () => {
    const fn = 'export function add(a: number, b: number): number {\n  return a + b;\n}';
    expect(extractFunctionSource(surround(fn), 'add')).toBe(fn);
  });

  it('extracts a bare (non-exported) `function` declaration', () => {
    const fn = 'function bare(): number {\n  return 42;\n}';
    expect(extractFunctionSource(surround(fn), 'bare')).toBe(fn);
  });

  it('extracts a bare declaration sitting at the very start of the module (^ anchor, no leading newline)', () => {
    const src = 'function first(): number {\n  return 1;\n}\nconst x = 2;\n';
    expect(extractFunctionSource(src, 'first')).toBe('function first(): number {\n  return 1;\n}');
  });

  it('excludes a preceding JSDoc block (and its stray prose braces) and blank lines', () => {
    const fn = 'export function documented(): number {\n  return 1;\n}';
    const src = `/**\n * Doc comment mentioning a { brace } in prose.\n */\n${fn}\n`;
    expect(extractFunctionSource(src, 'documented')).toBe(fn);
  });

  it('matches the whole name, not a prefix of a longer-named function declared earlier', () => {
    const src =
      'export function totalWidth(): number {\n  return 10;\n}\n\n' +
      'export function total(): number {\n  return 1;\n}\n';
    expect(extractFunctionSource(src, 'total')).toBe('export function total(): number {\n  return 1;\n}');
  });
});

describe('extractFunctionSource — braces that must NOT be counted', () => {
  it('ignores braces inside a double-quoted string literal', () => {
    const fn =
      'export function stringy(): string {\n  const s = "a closing } then an opening { in a string";\n  return s;\n}';
    expect(extractFunctionSource(surround(fn), 'stringy')).toBe(fn);
  });

  it('ignores braces inside a single-quoted string literal', () => {
    const fn = "export function singleQuoted(): string {\n  return '} { }';\n}";
    expect(extractFunctionSource(surround(fn), 'singleQuoted')).toBe(fn);
  });

  it('ignores braces inside a template literal, including its ${} interpolation', () => {
    const fn =
      'export function templated(x: number): string {\n' +
      '  return `open { ${x > 0 ? "pos" : "neg"} close }`;\n' +
      '}';
    expect(extractFunctionSource(surround(fn), 'templated')).toBe(fn);
  });

  it('ignores braces inside a line comment', () => {
    const fn =
      'export function commentedLine(): number {\n  // a } then a { , both only in this comment\n  return 0;\n}';
    expect(extractFunctionSource(surround(fn), 'commentedLine')).toBe(fn);
  });

  it('ignores braces inside a block comment', () => {
    const fn = 'export function commentedBlock(): number {\n  /* } { } { still a comment */\n  return 0;\n}';
    expect(extractFunctionSource(surround(fn), 'commentedBlock')).toBe(fn);
  });
});

describe('extractFunctionSource — body structure', () => {
  it('balances nested if/for blocks in the body', () => {
    const fn = [
      'export function nested(n: number): number {',
      '  let total = 0;',
      '  for (let i = 0; i < n; i++) {',
      '    if (i % 2 === 0) {',
      '      total += i;',
      '    } else {',
      '      total -= i;',
      '    }',
      '  }',
      '  return total;',
      '}',
    ].join('\n');
    expect(extractFunctionSource(surround(fn), 'nested')).toBe(fn);
  });

  it('handles a generic function whose name is followed by a type-parameter list', () => {
    const fn = 'export function identity<T>(value: T): T {\n  return value;\n}';
    expect(extractFunctionSource(surround(fn), 'identity')).toBe(fn);
  });

  it('does not mistake a single-line object-typed parameter’s braces for the body', () => {
    const fn =
      'export function configured(args: { a: number; b: number }): number {\n  return args.a + args.b;\n}';
    expect(extractFunctionSource(surround(fn), 'configured')).toBe(fn);
  });

  it('does not mistake a multi-line object-typed parameter’s braces for the body (the real branch.ts shape)', () => {
    const fn = [
      'export function multiParam(args: {',
      '  dt: number;',
      '  speed: number;',
      '}): number {',
      '  return args.dt * args.speed;',
      '}',
    ].join('\n');
    expect(extractFunctionSource(surround(fn), 'multiParam')).toBe(fn);
  });
});

describe('extractFunctionSource — failure modes throw (never return partial output)', () => {
  it('throws when the function name is not found', () => {
    expect(() => extractFunctionSource('export function present(): void {}', 'absent')).toThrow(
      /function "absent" not found/,
    );
  });

  it('throws when the body’s braces never balance', () => {
    const src = 'export function broken(): void {\n  if (true) {\n    doThing();\n}\n';
    expect(() => extractFunctionSource(src, 'broken')).toThrow(/unbalanced braces in "broken"/);
  });
});

describe('extractFunctionSource — against the real src/styles/botanical/branch.ts', () => {
  for (const name of ['growthStepFor', 'wanderDeltaFor'] as const) {
    it(`returns ${name} starting with "export function ${name}" and ending with "}"`, () => {
      const out = extractFunctionSource(branchSource, name);
      expect(out.startsWith(`export function ${name}`)).toBe(true);
      expect(out.endsWith('}')).toBe(true);
      // Verbatim: the returned text is an exact contiguous substring of the file.
      expect(branchSource).toContain(out);
    });
  }

  it('growthStepFor comes back with its real body expression intact', () => {
    expect(extractFunctionSource(branchSource, 'growthStepFor')).toContain(
      'speedFloor + args.speed * (1 - speedFloor)',
    );
  });

  it('wanderDeltaFor comes back with its real return expression intact', () => {
    expect(extractFunctionSource(branchSource, 'wanderDeltaFor')).toContain(
      'signedNoise * wanderAmplitude + windPull + sweepPull',
    );
  });
});
