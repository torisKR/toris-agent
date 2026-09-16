export { parseFrontmatter, renderFrontmatter, splitTags, slugify, requireSlug, isSafeSlug } from './markdown.js';
export {
  EDGE_KINDS,
  ORDERING_KINDS,
  normalizeEdgeKind,
  parseDagDocument,
  renderDagDocument,
  detectCycles,
  wouldCreateCycle,
  addDagEdge,
  canReach,
} from './dag.js';
export {
  KnowledgeStore,
  USER_MD_LIMIT,
  MEMORY_MD_LIMIT,
  compressBounded,
} from './store.js';
export { searchIndex, tokenizeQuery } from './search.js';
export { proposeReflections, renderReflection } from './reflect.js';
export {
  matchDomains,
  renderKnowledgeBriefing,
  composeKnowledgeTurn,
  briefingForQuery,
} from './context.js';
export { createKnowledgeTools } from './tools.js';
export { knowledgeDoctorCheck } from './doctor.js';
export {
  knowledgeDir,
  projectKnowledgeDir,
  knowledgeSearchRoots,
  PACKS_DIR,
  STARTER_DOMAIN_SLUGS,
} from './paths.js';
