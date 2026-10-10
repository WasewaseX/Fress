// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//

/**
 * Safe-subset validation for user/imported regular expressions.
 *
 * WHY THIS EXISTS
 * A syntactically valid regex can still be a denial-of-service vector:
 * patterns with nested quantification - `(a+)+`, `(.*)*`, `(a|aa)+$` -
 * backtrack exponentially on a near-miss input, and such a pattern can
 * enter Fress through an imported backup (`assetPatterns` / `tagPatterns`
 * in sanitizeAppItem) or a hand-edited catalog entry. A pattern length
 * limit alone does not help: `(a+)+` is five characters.
 *
 * THE APPROACH (documented per the resolver hardening spec)
 * Restrict imported patterns to a SAFE SUPPORTED SUBSET, enforced by a
 * single-pass structural analyzer. No new runtime dependency (a RE2/wasm
 * linear-time engine would be disproportionate for this app and would not
 * run in the Tauri webview sandbox without extra weight).
 *
 * The analyzer rejects the EXPONENTIAL backtracking class:
 *   R1a an UNBOUNDED quantifier (*, +, {n,}) applied to a group that
 *       contains any quantifier at all - the nested-ambiguity shape that
 *       produces 2^n and Fibonacci-style blowups: (a+)+, (a?)*, (.*)*,
 *       (a{0,2})*, (a+b)+
 *   R1b an UNBOUNDED quantifier applied to a group that contains an
 *       ALTERNATION - branch ambiguity is exponential without any nested
 *       quantifier: (a|aa)+$ needs no quantifier inside to go 2^n.
 *       Unquantified alternation stays fine everywhere: (exe|msi|zip)$,
 *       (Fress|fress)[-_.]?[\d.]+. The rule only fires when the GROUP
 *       carrying the alternation is itself repeated unboundedly, so the
 *       conservative false positives (e.g. (a|b)+, linear in theory) cost
 *       nothing real for this project's patterns.
 *   R2  a bounded quantifier {n,m} with m >= 2 applied to a group that
 *       contains an UNBOUNDED quantifier - the multiplicative equivalent,
 *       e.g. (a+){1,20}$
 *   R3  an unbounded quantifier applied to a group containing an empty
 *       alternation branch, e.g. (a||b)+
 *   R4  any pattern longer than MAX_PATTERN_LENGTH, a group repeated more
 *       than MAX_GROUP_REPETITION times, or one that does not compile -
 *       same length limit as before, now enforced in one place
 *
 * What stays allowed (and is provably linear-ish in the input length):
 *   - unbounded quantifiers on SINGLE tokens: .*, [\d.]+, [^-]+, v\d+
 *   - alternation with unquantified branches: (exe|msi|zip)$
 *   - bounded quantifiers on single tokens: \d{1,3}, a{0,2}
 *   - bounded groups over single-token quantifiers: (?:\d{1,3}\.){3},
 *     (v\d+)?-x64 (the `?` outer bound contributes at most x2, and R2 only
 *     fires for m >= 2)
 *
 * Polynomically-backtracking shapes (a*a*, .*.*  - O(n^2)) are accepted by
 * design: with the input caps at the call sites (asset and tag names are
 * bounded short strings) the worst case is a few hundred thousand engine
 * steps, which is harmless. The exponential class is the one that freezes
 * a webview, and that class is what this analyzer refuses.
 *
 * BUILT-IN CATALOG PATTERNS ARE AUDITED BY TEST: patternSafety.test.ts
 * compiles every assetPatterns/tagPatterns entry in the shipped catalog
 * through compileSafePattern, so tightening these rules can never silently
 * reject a working catalog entry.
 */

/** Hard length cap for imported patterns (same value the sanitizer used
 * to enforce with a bare slice check). */
export const MAX_PATTERN_LENGTH = 200;

/** Largest repetition count accepted on a group (R2's m bound). Groups
 * repeated more than this many times are rejected outright for imported
 * patterns; nothing legitimate needs more. */
const MAX_GROUP_REPETITION = 20;

export interface PatternSafetyVerdict {
  safe: boolean;
  /** Machine-readable rejection reason; 'ok' when safe. */
  reason:
    | 'ok'
    | 'too-long'
    | 'empty'
    | 'invalid-syntax'
    | 'unbounded-group-with-inner-quantifier'
    | 'unbounded-group-with-alternation'
    | 'over-bounded-group-with-inner-unbounded'
    | 'group-repetition-too-large'
    | 'unbounded-group-with-empty-branch';
  /** Human-readable explanation for logs/tests. */
  detail?: string;
}

/** One lexical token of the pattern subset the analyzer understands. */
interface Token {
  kind:
    | 'literal'      // a, \d, \., any single-char matcher
    | 'class'        // [...] - matches exactly one character
    | 'dot'          // .
    | 'group'        // (...)-shaped, incl. (?:...) and lookarounds
    | 'alternator'   // |
    | 'anchor';      // ^ $ (zero-width, no backtracking weight)
  /** Quantifier attached directly to this token, if any. */
  quant?: Quantifier;
}

interface Quantifier {
  /** Minimum repetitions. */
  min: number;
  /** Maximum repetitions; Infinity for * and +. */
  max: number;
  /** Lazy (?=after a quantifier) - does not change the safety math. */
  lazy?: boolean;
}

const isUnbounded = (q: Quantifier | undefined): boolean => !!q && q.max === Infinity;

/**
 * Structural safety analysis. Operates on a small hand-rolled tokenizer
 * that understands the regex constructs Fress accepts in imported
 * patterns. Anything the tokenizer cannot parse is rejected (fail closed)
 * - and rejected as 'invalid-syntax', which is the same handling imported
 * patterns already got for syntactically broken input.
 */
export function analyzePatternSafety(source: string): PatternSafetyVerdict {
  if (!source || source.length === 0) {
    return { safe: false, reason: 'empty', detail: 'empty pattern' };
  }
  if (source.length > MAX_PATTERN_LENGTH) {
    return { safe: false, reason: 'too-long', detail: `length ${source.length} > ${MAX_PATTERN_LENGTH}` };
  }

  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (e) {
    return { safe: false, reason: 'invalid-syntax', detail: (e as Error).message };
  }

  // Syntax check with the real engine too: the tokenizer is conservative,
  // the engine is the authority on validity.
  try {
    // eslint-disable-next-line no-new
    new RegExp(source, 'i');
  } catch (e) {
    return { safe: false, reason: 'invalid-syntax', detail: (e as Error).message };
  }

  for (const tok of tokens) {
    if (tok.kind !== 'group' || !tok.quant) continue;

    if (isUnbounded(tok.quant)) {
      const inner = groupContainsQuantifier(tok);
      if (inner) {
        return {
          safe: false,
          reason: 'unbounded-group-with-inner-quantifier',
          detail: `unbounded quantified group contains a quantifier: ${source}`,
        };
      }
      // Branch ambiguity: (a|aa)+ is exponential with NO inner quantifier.
      // Any alternator inside an unboundedly repeated group is refused.
      if (groupContainsAlternator(tok)) {
        return {
          safe: false,
          reason: 'unbounded-group-with-alternation',
          detail: `unbounded quantified group contains an alternation: ${source}`,
        };
      }
      if (groupContainsEmptyBranch(tok)) {
        return {
          safe: false,
          reason: 'unbounded-group-with-empty-branch',
          detail: `unbounded quantified group has an empty alternative: ${source}`,
        };
      }
    } else {
      // Bounded repetition of a group.
      if (tok.quant.max > MAX_GROUP_REPETITION) {
        return {
          safe: false,
          reason: 'group-repetition-too-large',
          detail: `group repeated up to ${tok.quant.max} times (max ${MAX_GROUP_REPETITION})`,
        };
      }
      if (tok.quant.max >= 2 && groupContainsUnboundedQuantifier(tok)) {
        return {
          safe: false,
          reason: 'over-bounded-group-with-inner-unbounded',
          detail: `group repeated ${tok.quant.max}x contains an unbounded quantifier: ${source}`,
        };
      }
    }
  }

  return { safe: true, reason: 'ok' };
}

/** Does this group (at any nesting depth) contain any quantifier? */
function groupContainsQuantifier(group: Token): boolean {
  return groupHas(group, (t) => !!t.quant);
}

/** Does this group (at any nesting depth) contain an unbounded quantifier? */
function groupContainsUnboundedQuantifier(group: Token): boolean {
  return groupHas(group, (t) => isUnbounded(t.quant));
}

/** Does this group contain an empty alternation branch? */
function groupContainsEmptyBranch(group: Token): boolean {
  const inner = groupInner(group);
  // An empty branch is: | at the start, | at the end, or two || with
  // nothing between (ignoring nesting - a nested group is never empty
  // from the parent's perspective).
  for (let i = 0; i < inner.length; i++) {
    const t = inner[i];
    if (t.kind === 'alternator') {
      const prev = inner[i - 1];
      const next = inner[i + 1];
      if (!prev || prev.kind === 'alternator' || !next || next.kind === 'alternator') {
        return true;
      }
    }
  }
  // Only children (no alternator): the group body itself is empty.
  if (inner.length === 0) return true;
  if (inner.length === 1 && inner[0].kind === 'alternator') return true;
  return false;
}

function groupInner(group: Token): Token[] {
  return ((group as Token & { inner?: Token[] }).inner ?? []);
}

function groupHas(group: Token, pred: (t: Token) => boolean): boolean {
  for (const t of groupInner(group)) {
    if (pred(t)) return true;
    if (t.kind === 'group' && groupHas(t, pred)) return true;
  }
  return false;
}

/** Does this group (at any nesting depth) contain an alternation? */
function groupContainsAlternator(group: Token): boolean {
  return groupHas(group, (t) => t.kind === 'alternator');
}

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

/**
 * Tokenizes the pattern top level; group tokens carry their inner token
 * list. Throws Error with a readable message when it meets a construct it
 * refuses to analyze (fail closed).
 */
function tokenize(source: string): Token[] {
  let i = 0;
  const n = source.length;

  const parseTokens = (stopAtGroupEnd: boolean): Token[] => {
    const out: Token[] = [];
    while (i < n) {
      const ch = source[i];
      if (ch === ')') {
        if (!stopAtGroupEnd) throw new Error('unmatched ")"');
        return out;
      }
      const tok = parseToken();
      const quant = parseQuantifier();
      if (quant) tok.quant = quant;
      out.push(tok);
    }
    if (stopAtGroupEnd) throw new Error('unmatched "("');
    return out;
  };

  const parseToken = (): Token => {
    const ch = source[i];
    if (ch === '(') {
      i++; // consume (
      // Group kind prefix: (?:, (?=, (?!, (?<=, (?<name>...
      if (source[i] === '?') {
        i++;
        const c = source[i];
        if (c === ':' || c === '=' || c === '!') {
          i++;
        } else if (c === '<') {
          const d = source[i + 1];
          if (d === '=' || d === '!') {
            i += 2;
          } else {
            // named group (?<name>: skip to '>'
            let j = i + 1;
            while (j < n && source[j] !== '>') j++;
            if (j >= n) throw new Error('unterminated group name');
            i = j + 1;
          }
        } else {
          throw new Error(`unsupported group modifier "?${c ?? ''}"`);
        }
      }
      const inner = parseTokens(true);
      i++; // consume )
      return { kind: 'group', inner } as Token;
    }
    if (ch === '[') {
      skipCharClass();
      return { kind: 'class' };
    }
    if (ch === '.') {
      i++;
      return { kind: 'dot' };
    }
    if (ch === '\\') {
      // Any escape: \d \w \. \\ \x41 \u1234 ... all match ONE character
      // (or assert for \b). Treat uniformly as a literal-width token.
      if (i + 1 >= n) throw new Error('dangling escape');
      i += 2;
      return { kind: 'literal' };
    }
    if (ch === '|' ) {
      i++;
      return { kind: 'alternator' };
    }
    if (ch === '^' || ch === '$') {
      i++;
      return { kind: 'anchor' };
    }
    if (ch === '*' || ch === '+' || ch === '?') {
      throw new Error(`quantifier with nothing to repeat at index ${i}`);
    }
    // Plain literal character.
    i++;
    return { kind: 'literal' };
  };

  const parseQuantifier = (): Quantifier | undefined => {
    let min = 0;
    let max = 0;
    const ch = source[i];
    if (ch === '*') {
      min = 0; max = Infinity; i++;
    } else if (ch === '+') {
      min = 1; max = Infinity; i++;
    } else if (ch === '?') {
      min = 0; max = 1; i++;
    } else if (ch === '{') {
      // {n} {n,} {n,m}
      const close = source.indexOf('}', i);
      if (close === -1) return undefined; // literal '{'
      const body = source.slice(i + 1, close);
      if (!/^\d+(,\d*)?$/.test(body)) return undefined; // literal braces
      if (body.includes(',')) {
        const [a, b] = body.split(',');
        min = parseInt(a || '0', 10);
        max = b === '' ? Infinity : parseInt(b, 10);
      } else {
        min = max = parseInt(body, 10);
      }
      if (min > max) throw new Error('quantifier {n,m} out of order');
      i = close + 1;
    } else {
      return undefined;
    }
    // Lazy / sticky modifier
    if (source[i] === '?' || source[i] === '+') {
      // "x+?" lazy, "x*+" possessive-style (sticky in V8 terms) - both
      // accepted, safety math unchanged.
      i++;
    }
    return { min, max };
  };

  /** Skips a [...] class body, honoring \ escapes and ] as the first char. */
  const skipCharClass = (): void => {
    i++; // consume [
    if (source[i] === '^') i++;
    if (source[i] === ']') i++; // ] as literal first char
    while (i < n && source[i] !== ']') {
      if (source[i] === '\\') {
        if (i + 1 >= n) throw new Error('dangling escape in class');
        i += 2;
      } else {
        i++;
      }
    }
    if (source[i] !== ']') throw new Error('unterminated character class');
    i++;
  };

  return parseTokens(false);
}

/* ------------------------------------------------------------------ */
/* Compilation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Compiles an imported pattern IF it is inside the safe subset; returns
 * null otherwise. Drop-in replacement for the try/catch-new-RegExp idiom:
 * null at every call site means "no pattern", which every resolver path
 * already handles by falling back to the heuristic.
 */
export function compileSafePattern(source: string, flags = 'i'): RegExp | null {
  const verdict = analyzePatternSafety(source);
  if (!verdict.safe) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}
