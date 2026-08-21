import eslintJs from "@eslint/js";
import globals from "globals";

export const NODE_ESLINT_VERSION = "10.8.1";
export const NODE_COMPLEXITY_MAXIMUM = 15;

const INLINE_DIRECTIVE = /^\s*(?:eslint(?:-env|-disable(?:-line|-next-line)?|-enable)?|exported|global)\b/u;

const noInlineConfigDirectives = Object.freeze({
  meta: {
    type: "problem",
    docs: { description: "reject target-owned inline ESLint configuration directives" },
    schema: [],
    messages: { forbidden: "Package-owned lint policy rejects inline ESLint configuration directives." },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (INLINE_DIRECTIVE.test(comment.value)) {
            context.report({ loc: comment.loc, messageId: "forbidden" });
          }
        }
      },
    };
  },
});

export const NODE_ESLINT_CONFIG = Object.freeze([
  Object.freeze({
    files: ["**/*.js"],
    languageOptions: Object.freeze({
      ecmaVersion: 2024,
      sourceType: "module",
      globals: Object.freeze({ ...globals.nodeBuiltin }),
    }),
    plugins: Object.freeze({
      sdd: Object.freeze({
        rules: Object.freeze({ "no-inline-config-directives": noInlineConfigDirectives }),
      }),
    }),
    rules: Object.freeze({
      ...eslintJs.configs.recommended.rules,
      complexity: ["error", { max: NODE_COMPLEXITY_MAXIMUM, variant: "classic" }],
      "sdd/no-inline-config-directives": "error",
    }),
  }),
]);
