/**
 * @file ./eslint.config.mjs
 * @description ESLint flat config enforcing the shared coding-style.md + coding-rules.md (ported
 *   from opencv-mark, 2026-07-04 revision, CommonJS variant). Style errors are auto-fixable; JSDoc
 *   gaps are warnings (the auto-fixer stubs are noisy garbage - reviewer fixes them by hand).
 * @scope project
 * @updated-at 2026-08-01
 */
import jsdoc from "eslint-plugin-jsdoc";

const NODE_GLOBALS = {
    require: "readonly"
  , module: "writable"
  , exports: "writable"
  , process: "readonly"
  , console: "readonly"
  , __dirname: "readonly"
  , __filename: "readonly"
  , setTimeout: "readonly"
  , clearTimeout: "readonly"
  , setInterval: "readonly"
  , clearInterval: "readonly"
  , URL: "readonly"
  , TextEncoder: "readonly"
  , TextDecoder: "readonly"
};

const STYLE_RULES = {
    indent: ["error", 2, {
      SwitchCase: 1
      // comma-first lists align their first item +2; indent cannot describe that shape
      , ignoredNodes: [
          "ObjectExpression"
        , "ArrayExpression"
        , "CallExpression"
        , "ArrowFunctionExpression"
      ]
    }]
  , quotes: ["error", "double", { avoidEscape: true, allowTemplateLiterals: true }]
  , semi: ["error", "always"]
  , "comma-style": ["error", "first", {
      exceptions: {
          ArrayExpression: false
        , ObjectExpression: false
        , VariableDeclaration: false
      }
    }]
  , "max-len": ["error", {
      code: 100
      , ignoreUrls: true
      , ignoreStrings: true
      , ignoreTemplateLiterals: true
      , ignoreRegExpLiterals: true
      , ignoreComments: true
    }]
  , "key-spacing": ["error", { align: "colon" }]
  , "no-trailing-spaces": "error"
  , "eol-last": ["error", "always"]
  , "linebreak-style": ["error", "unix"]
  , "no-var": "error"
  , "prefer-const": "error"
  , "prefer-arrow-callback": "error"
  , "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
  , "no-console": "error"
};

/**
 * Correctness rules, kept separate from STYLE_RULES so the pre-split 4-space entry file can be
 * checked for real faults without being failed for its indentation. no-undef is the one that
 * matters during the split: a symbol moved into src/ whose require line was forgotten is a
 * runtime crash on a path the parse suite never executes.
 */
const CORRECTNESS_RULES = {
    "no-undef": "error"
  , "no-redeclare": "error"
  , "no-dupe-keys": "error"
  , "no-dupe-args": "error"
  , "no-dupe-else-if": "error"
  , "no-duplicate-case": "error"
  , "no-unreachable": "error"
  , "no-fallthrough": "error"
  , "no-sparse-arrays": "error"
  , "no-self-compare": "error"
  , "no-cond-assign": "error"
  , "no-constant-condition": "error"
  , "use-isnan": "error"
  , "valid-typeof": "error"
};

/**
 * JSDoc rules use "warn" (not "error") because the auto-fixer inserts empty stubs that violate
 * project comment-style.md. A warning surfaces the gap without blocking and without polluting
 * code with rule-violating stubs.
 */
const JSDOC_RULES = {
    "jsdoc/require-jsdoc": ["warn", {
      publicOnly: true
      , require: {
          FunctionDeclaration: true
        , ArrowFunctionExpression: true
        , FunctionExpression: true
        , MethodDefinition: true
        , ClassDeclaration: true
      }
      , enableFixer: false
    }]
  , "jsdoc/check-alignment": "warn"
  , "jsdoc/check-param-names": "warn"
  , "jsdoc/no-undefined-types": "off"
};

export default [
    {
      ignores: [
          "node_modules/**"
        , "docs/**"
        , ".claude/**"
        , ".vscode-test/**"
        // mocha suite/test globals, and it is not part of the split
        , "test/extension.test.js"
      ]
    }
  , {
      files: ["src/**/*.js", "test/*.js"]
      , languageOptions: {
          ecmaVersion: 2022
        , sourceType: "commonjs"
        , globals: NODE_GLOBALS
      }
      , plugins: { jsdoc }
      , rules: { ...CORRECTNESS_RULES, ...STYLE_RULES, ...JSDOC_RULES }
    }
  , {
      /**
       * The entry file is still pre-split 4-space code and converts to 2-space only once it has
       * shrunk to the thin entry (docs/architecture.md, migration order). Until then it is checked
       * for correctness but exempt from layout, so every remaining move is guarded.
       */
      files: ["extension.js"]
      , languageOptions: {
          ecmaVersion: 2022
        , sourceType: "commonjs"
        , globals: NODE_GLOBALS
      }
      , rules: {
          ...CORRECTNESS_RULES
        , "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
        , "no-var": "error"
        , "semi": ["error", "always"]
      }
    }
  , {
      // the test harness prints its tally and drives stubs through console on purpose
      files: ["test/*.js"]
      , rules: { "no-console": "off" }
    }
];
