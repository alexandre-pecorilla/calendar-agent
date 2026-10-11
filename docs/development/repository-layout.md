# Repository layout

```
.
├── README.md  DEPLOYMENT.md  STATUS.md  CLAUDE.md
├── Makefile  Dockerfile  docker-compose.yml  compose.publish-2.yml
├── .env.example  manifest.json (rendered by `make manifest`, gitignored)
├── package.json  tsconfig.json  vitest.config.ts  eslint.config.js  .prettierrc
├── .githooks/pre-push   # private-words check before every push (`make hooks`)
├── scopes_of_work/  action_plans/  testing_plans/      # planning documents
├── scripts/                                            # host-side helpers (node, no deps)
│   ├── check-ports.mjs      # port free on every publish address
│   ├── scan-secrets.mjs     # committed-secret scan (from an earlier internal project)
│   ├── check-private-words.mjs  # owner's real terms (gitignored .private-words) absent from the tree
│   ├── copy-assets.mjs      # migrations, prompts, static files into dist/
│   └── docs-check.mjs       # documentation sweep
├── src/
│   ├── index.ts             # boot order
│   ├── config/              # env.ts (zod, fail closed), identity.ts (BOT_NAME derivation, elision)
│   ├── logging/             # pino with redaction
│   ├── db/                  # node:sqlite, migrations, repositories (S2)
│   ├── crypto/              # AES-256-GCM envelope, Secret wrapper (S2, from an earlier internal project)
│   ├── security/            # control-token neutralisation, input caps (S4)
│   ├── calcom/              # GET-only allowlisted client, cache (S3)
│   ├── availability/        # schedule, windows, timezone, formatting (S3)
│   ├── llm/                 # DeepSeek client, parse, phrase, verify, prompts/ (S4)
│   ├── pipeline/            # answer.ts, fixed replies, rate limits (S4)
│   ├── slack/               # Bolt app, handlers, installer, manifest (S6)
│   ├── admin/               # Fastify server, auth, pages, sandbox, static/ (S5)
│   └── cli/                 # ask, calcom-check, deepseek-check, manifest, backup; context.ts bootstraps them
├── tests/
│   ├── unit/  integration/  repo/  live/  fixtures/
└── docs/
    ├── README.md  user-guide.md  guide-utilisateur.md
    ├── architecture/  development/
    ├── testing/evidence/T<n>.md
    └── reviews/R<n>.md
```

Runtime data lives in the Docker volume `data` mounted at `/data` (`DATA_DIR`), never in the repository.
