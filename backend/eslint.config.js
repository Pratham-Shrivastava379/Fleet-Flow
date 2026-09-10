// Flat ESLint config (backend). Phase 0 — style guardrails, no logic changes.
import js from "@eslint/js";

export default [
  { ignores: ["node_modules/**", "dist/**", "coverage/**", "prisma/migrations/**", "*.log"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        crypto: "readonly",
        URL: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
        URLSearchParams: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      eqeqeq: ["error", "smart"],
    },
  },
];
