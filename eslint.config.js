import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    ignores: ["node_modules/**", "media/**", "public/js/**"],
  },
  {
    files: ["server/**/*.js", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        Headers: "readonly",
        AbortController: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_|^req$|^res$|^next$" }],
    },
  },
];
