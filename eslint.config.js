import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["node_modules/**", "**/*.json", "bun.lock*", "eslint.config.js"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Render paths are hot (TUI redraw every frame) — allow terse `?:` ternaries,
      // but keep everything else strict.
      "@typescript-eslint/no-unnecessary-condition": "off",
      // `string | undefined` / numbers in template literals are a deliberate convention here
      // (undefined renders as ""); object/array interpolation stays flagged.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNullish: true, allowRegExp: true },
      ],
      // `return voidFn()` inside void-returning functions is the codebase's fire-and-forget idiom.
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true, ignoreVoidReturningFunctions: true },
      ],
      // Async signatures kept for interface conformance (handler contracts) — no forced await.
      "@typescript-eslint/require-await": "off",
      // pi's ui.custom<T> contract uses `void` as the "no result" type arg and done(result: void).
      "@typescript-eslint/no-invalid-void-type": "off",
      // `_`-prefixed params mark deliberately-unused slots (TS noUnusedParameters convention).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  prettier,
);
