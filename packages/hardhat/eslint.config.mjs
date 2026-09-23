import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module", ecmaVersion: 2022 },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "off",
    },
  },
  {
    ignores: ["artifacts/**", "cache/**", "coverage/**", "typechain-types/**", "node_modules/**"],
  },
];
