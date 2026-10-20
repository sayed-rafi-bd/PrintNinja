/** @type {import('dependency-cruiser').IConfiguration} */
// Layer rules from REFACTORING.md section 5, enforced by dependency-cruiser
// (chosen in the Phase 1 spike over ESLint's import/no-restricted-paths:
// purpose-built for exactly this, understands TypeScript, no second lint
// stack next to Biome).
export default {
  forbidden: [
    {
      name: "domain-imports-neither-http-nor-infra",
      comment: "domain imports neither http nor infra",
      severity: "error",
      from: { path: "^src/domain" },
      to: { path: "^src/(http|infra)" },
    },
    {
      name: "http-imports-only-domain",
      comment: "http imports domain, never infra",
      severity: "error",
      from: { path: "^src/http" },
      to: { path: "^src/infra" },
    },
    {
      name: "infra-imports-no-http",
      comment: "infra imports only types and ports from domain",
      severity: "error",
      from: { path: "^src/infra" },
      to: { path: "^src/http" },
    },
    {
      name: "prisma-stays-in-infra",
      comment: "no Prisma type or client outside infra (Phase 1 done-when)",
      severity: "error",
      from: { pathNot: "^src/infra" },
      to: { path: "(@prisma/client|^src/infra/prisma/generated)" },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    // The generated Prisma client is third-party code in our tree: its
    // hundreds of files would drown the layer check, and the
    // prisma-stays-in-infra rule above already guards who imports it.
    exclude: { path: "^(test|scripts|node_modules|src/infra/prisma/generated)" },
    reporterOptions: { "text": { "highlightFocused": true } },
  },
};
