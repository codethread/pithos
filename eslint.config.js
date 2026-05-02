// @ts-check
import eslintJs from "@eslint/js";
import tsEslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import unusedImports from "eslint-plugin-unused-imports";
import vitestPlugin from "@vitest/eslint-plugin";

export default tsEslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.js.map", "**/scripts/*.mjs"],
  },
  eslintJs.configs.recommended,
  ...tsEslint.configs.recommendedTypeChecked,
  ...tsEslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", "vitest.config.ts", "vitest.global-setup.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      // Ban explicit any
      "@typescript-eslint/no-explicit-any": "error",

      // Ban unsafe any propagation
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // Import hygiene
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],

      // Async safety
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // Ban raw console calls — all output must go through OutputService
      // (live layer → process.stdout/stderr; test layer → captured arrays).
      // This catches accidental console.log in application and command code
      // before it reaches the test suite or Vitest output.
      "no-console": "error",

      // Turn off base rule in favour of ts version
      "no-unused-vars": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    plugins: {
      vitest: vitestPlugin,
    },
    rules: {
      ...vitestPlugin.configs.recommended.rules,
      // Recognise project-level assertion helpers so vitest/expect-expect
      // does not flag tests that delegate assertions to named helpers.
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "assertRequiredSections"] },
      ],
    },
  },
  prettierConfig,
);
