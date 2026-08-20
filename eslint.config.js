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
  }
);
