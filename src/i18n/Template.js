/**
 * Commentary template compiler (design §16, item 58).
 *
 * Token namespace:
 *   {minute}
 *   {player.<field>}   the event's actorIndex
 *   {player2.<field>}  secondaryIndices[0]
 *   {team.<field>}     the event's teamIndex
 *   {opponent.<field>} the other team
 *   {meta.<field>}     event meta
 *   {<ns>.g:masc|fem}  picks a word by the `gender` of player, player2, team or opponent
 * `{{` and `}}` produce literal braces.
 */

/** Fields readable on each namespace. `meta` fields depend on the event type. */
export const TOKEN_FIELDS = Object.freeze({
  player: Object.freeze(['name', 'number', 'role']),
  player2: Object.freeze(['name', 'number', 'role']),
  team: Object.freeze(['name', 'artDef', 'contractionDe', 'contractionEm']),
  opponent: Object.freeze(['name', 'artDef', 'contractionDe', 'contractionEm']),
});

/** Namespaces that accept the `g:masc|fem` gender choice. */
export const GENDER_NAMESPACES = Object.freeze(['player', 'player2', 'team', 'opponent']);

/**
 * @typedef {{kind: 'literal', text: string}
 *   | {kind: 'minute'}
 *   | {kind: 'field', ns: string, field: string}
 *   | {kind: 'meta', field: string}
 *   | {kind: 'gender', ns: string, masc: string, fem: string}
 *   | {kind: 'unknown', raw: string}} TemplateToken
 */

/**
 * @typedef {object} RenderContext
 * @property {number | string} [minute]
 * @property {Record<string, unknown>} [player]
 * @property {Record<string, unknown>} [player2]
 * @property {Record<string, unknown>} [team]
 * @property {Record<string, unknown>} [opponent]
 * @property {Record<string, unknown>} [meta]
 */

/**
 * @typedef {object} CompiledTemplate
 * @property {string} src
 * @property {TemplateToken[]} tokens
 * @property {(ctx: RenderContext) => string} render
 */

/**
 * @param {string} raw token text without braces
 * @returns {TemplateToken}
 */
function parseToken(raw) {
  if (raw === 'minute') return { kind: 'minute' };
  const dot = raw.indexOf('.');
  if (dot > 0) {
    const ns = raw.slice(0, dot);
    const rest = raw.slice(dot + 1);
    if (rest.startsWith('g:') && GENDER_NAMESPACES.includes(ns)) {
      const choices = rest.slice(2).split('|');
      if (choices.length === 2 && choices[0] !== '' && choices[1] !== '') {
        return { kind: 'gender', ns, masc: choices[0], fem: choices[1] };
      }
      return { kind: 'unknown', raw };
    }
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(rest)) {
      if (ns === 'meta') return { kind: 'meta', field: rest };
      const allowed = /** @type {Record<string, readonly string[]>} */ (TOKEN_FIELDS)[ns];
      if (allowed?.includes(rest)) return { kind: 'field', ns, field: rest };
    }
  }
  return { kind: 'unknown', raw };
}

/**
 * Splits a template into tokens. Never throws.
 * @param {string} src
 * @returns {TemplateToken[]}
 */
function tokenize(src) {
  /** @type {TemplateToken[]} */
  const tokens = [];
  let literal = '';
  const flush = () => {
    if (literal !== '') tokens.push({ kind: 'literal', text: literal });
    literal = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{' && src[i + 1] === '{') {
      literal += '{';
      i += 2;
    } else if (ch === '}' && src[i + 1] === '}') {
      literal += '}';
      i += 2;
    } else if (ch === '{') {
      const close = src.indexOf('}', i + 1);
      if (close === -1) {
        flush();
        tokens.push({ kind: 'unknown', raw: src.slice(i + 1) });
        i = src.length;
      } else {
        flush();
        tokens.push(parseToken(src.slice(i + 1, close)));
        i = close + 1;
      }
    } else {
      literal += ch;
      i += 1;
    }
  }
  flush();
  return tokens;
}

/**
 * @param {TemplateToken} token
 * @returns {string}
 */
function describe(token) {
  return token.kind === 'unknown' ? token.raw : token.kind;
}

/**
 * Precompiles a template into a token list with a `render` function.
 * Unknown tokens render as `?`; with `strict: true` they throw instead, both
 * at compile time (unrecognised syntax) and at render time (missing data).
 * @param {string} src
 * @param {{strict?: boolean}} [options]
 * @returns {CompiledTemplate}
 */
function compile(src, { strict = false } = {}) {
  const tokens = tokenize(src);
  if (strict) {
    const bad = tokens.find((t) => t.kind === 'unknown');
    if (bad) throw new Error(`Template: unknown token {${describe(bad)}} in "${src}"`);
  }

  /**
   * @param {TemplateToken} token
   * @param {unknown} value
   * @returns {string}
   */
  const orMissing = (token, value) => {
    if (value === undefined || value === null) {
      if (strict) throw new Error(`Template: no value for {${describe(token)}} in "${src}"`);
      return '?';
    }
    return String(value);
  };

  /** @param {RenderContext} ctx */
  const render = (ctx) => {
    let out = '';
    for (const token of tokens) {
      switch (token.kind) {
        case 'literal':
          out += token.text;
          break;
        case 'minute':
          out += orMissing(token, ctx.minute);
          break;
        case 'field':
          out += orMissing(token, /** @type {Record<string, any>} */ (ctx)[token.ns]?.[token.field]);
          break;
        case 'meta':
          out += orMissing(token, ctx.meta?.[token.field]);
          break;
        case 'gender': {
          const subject = /** @type {Record<string, any>} */ (ctx)[token.ns];
          out += subject ? (subject.gender === 'fem' ? token.fem : token.masc) : orMissing(token, undefined);
          break;
        }
        default:
          out += '?';
      }
    }
    return out;
  };

  return Object.freeze({ src, tokens, render });
}

export const Template = Object.freeze({ compile });
export { compile };
