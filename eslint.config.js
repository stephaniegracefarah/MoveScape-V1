import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Invariant 2: seeded randomness only in the world layer and styles.
    files: ['src/world/**/*.ts', 'src/styles/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Invariant 2: world/ and styles/ draw all randomness from labeled seeded PRNG streams, never Math.random.',
        },
      ],
    },
  },
  {
    // Invariant 4: the simulation engine ticks on the recording clock, never
    // the wall clock -- fixed-timestep replay must be a pure function of its
    // arguments.
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message:
            'Invariant 4: the engine ticks on the recording clock, never the wall clock.',
        },
        {
          object: 'performance',
          property: 'now',
          message:
            'Invariant 4: the engine ticks on the recording clock, never the wall clock.',
        },
      ],
    },
  }
);
