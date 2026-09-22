import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Deliberately close to the recommended set. A migration toolkit's defects are
 * mapping defects, which no linter finds, so the rules here are the few that
 * catch the mistakes this codebase can actually make.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "fixtures/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Every unknown from someone else's API is narrowed by hand. An `any`
      // here means a field is being trusted without being checked.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
