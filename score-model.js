(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  if (root.GladiatusScoreModel) return;

  const VALID_CONSTRAINT_OPERATORS = new Set([">=", "<="]);

  function normalizeDefinition(definition, options = {}) {
    if (!definition || typeof definition !== "object") return null;

    const id = sanitizeId(definition.id) || makeId(options.idPrefix || "score");
    const name = String(definition.name || "").trim() || options.defaultName || "Untitled score";
    const appliesTo = normalizeAppliesTo(definition.appliesTo, options.validAppliesTo);
    const section = normalizeScoreSection(definition, options);

    return {
      id,
      name,
      appliesTo,
      terms: section.terms,
      constraints: section.constraints,
      enabled: definition.enabled !== false
    };
  }

  function normalizeDefinitions(definitions, options = {}) {
    return Array.isArray(definitions)
      ? definitions.map((definition) => normalizeDefinition(definition, options)).filter(Boolean)
      : [];
  }

  function normalizeScoreSection(section, options = {}) {
    const statKeys = makeStatKeySet(options.statKeys);
    const terms = Array.isArray(section?.terms)
      ? section.terms.map((term) => normalizeTerm(term, statKeys)).filter(Boolean)
      : [];
    const constraints = Array.isArray(section?.constraints)
      ? section.constraints.map((constraint) => normalizeConstraint(constraint, statKeys)).filter(Boolean)
      : [];

    return { terms, constraints };
  }

  function normalizeTerm(term, statKeys) {
    if (!term || typeof term !== "object" || (statKeys && !statKeys.has(term.stat))) return null;

    const weight = Number(term.weight);
    if (!Number.isFinite(weight) || weight === 0) return null;

    return { stat: term.stat, weight };
  }

  function normalizeConstraint(constraint, statKeys) {
    if (!constraint || typeof constraint !== "object" || (statKeys && !statKeys.has(constraint.stat))) return null;
    if (!VALID_CONSTRAINT_OPERATORS.has(constraint.op)) return null;

    const value = Number(constraint.value);
    if (!Number.isFinite(value)) return null;

    return { stat: constraint.stat, op: constraint.op, value };
  }

  function normalizeAppliesTo(appliesTo, validAppliesTo) {
    if (!Array.isArray(appliesTo)) return [];
    if (!validAppliesTo) return [...new Set(appliesTo.map(String).filter(Boolean))];

    const valid = new Set(validAppliesTo);
    return appliesTo
      .map(String)
      .filter((value, index, source) => valid.has(value) && source.indexOf(value) === index);
  }

  function score(record, section, getStat = defaultStat) {
    const normalized = section?.terms ? section : normalizeScoreSection(section);
    return normalized.terms.reduce((total, term) => total + getStat(record, term.stat) * term.weight, 0);
  }

  function matches(record, section, getStat = defaultStat) {
    const normalized = section?.constraints ? section : normalizeScoreSection(section);
    return normalized.constraints.every((constraint) => {
      const value = getStat(record, constraint.stat);
      return constraint.op === ">=" ? value >= constraint.value : value <= constraint.value;
    });
  }

  function summarizeSection(section, labels = {}) {
    const normalized = normalizeScoreSection(section, { statKeys: Object.keys(labels).length ? Object.keys(labels) : null });
    const terms = normalized.terms
      .map((term) => `${formatNumber(term.weight)} x ${labels[term.stat] || term.stat}`)
      .join(" + ");
    const constraints = normalized.constraints
      .map((constraint) => `${labels[constraint.stat] || constraint.stat} ${constraint.op} ${formatNumber(constraint.value)}`)
      .join(", ");

    return [terms || "0", constraints ? `requires ${constraints}` : ""].filter(Boolean).join("; ");
  }

  function summarizeDefinition(definition, labels = {}) {
    return summarizeSection(definition, labels);
  }

  function defaultStat(record, key) {
    return Number(record?.stats?.[key]) || 0;
  }

  function makeStatKeySet(statKeys) {
    if (statKeys instanceof Set) return statKeys;
    if (Array.isArray(statKeys)) return new Set(statKeys);
    return null;
  }

  function sanitizeId(value) {
    return String(value || "").trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function makeId(prefix = "score") {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) return "0";
    if (Number.isInteger(value)) return String(value);
    return value >= 10 ? value.toFixed(1) : value.toFixed(3);
  }

  root.GladiatusScoreModel = {
    validConstraintOperators: [...VALID_CONSTRAINT_OPERATORS],
    formatNumber,
    makeId,
    matches,
    normalizeDefinition,
    normalizeDefinitions,
    normalizeScoreSection,
    sanitizeId,
    score,
    summarizeDefinition,
    summarizeSection
  };
})();
