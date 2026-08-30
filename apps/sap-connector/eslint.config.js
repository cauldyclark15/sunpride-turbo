import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["data/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.nodeBuiltin, ...globals.browser, Bun: "readonly" },
    },
  },
];
