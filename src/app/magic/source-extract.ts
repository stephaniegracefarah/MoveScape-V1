/**
 * "Show the magic" verbatim-source helper (UX Stage 2, docs/UX/develop.md
 * Live-session decision C, third feedback pass: "raw source, not a curated
 * formula ... someone who reads code should be able to watch the panel and
 * verify what's actually running").
 *
 * The panel imports the real style module as a string via Vite's `?raw`
 * suffix (e.g. `import branchSource from '.../branch.ts?raw'`) and calls
 * this to slice out exactly the one function a tab shows. Loading the real
 * file — rather than keeping a hand-pasted copy — is the whole point: the
 * copy would silently drift the moment the function is edited, and the
 * panel would then be lying.
 *
 * `extractFunctionSource(moduleSource, 'growthStepFor')` returns the source
 * from the start of the function's declaration (`export function NAME` or a
 * bare `function NAME`, no leading indentation, no preceding JSDoc) through
 * the `}` that closes its body, inclusive, with no trailing newline. Braces
 * inside line/block comments and string/template literals in the body are
 * not miscounted. Throws (rather than returning null/'') if the function
 * isn't found or the braces never balance — a broken panel should fail
 * loudly in dev, not render half a function.
 *
 * Pure string function: no DOM, no imports. Keep it that way.
 */
export function extractFunctionSource(moduleSource: string, functionName: string): string {
  const declRe = new RegExp(`(^|\\n)((?:export\\s+)?function\\s+${escapeRegExp(functionName)}\\s*[(<])`);
  const match = declRe.exec(moduleSource);
  if (!match) {
    throw new Error(`extractFunctionSource: function "${functionName}" not found`);
  }
  // Start at the declaration keyword itself, not the leading newline the
  // regex also captured.
  const start = match.index + (match[1] ?? '').length;

  // The body-opening `{` is the first `{` AFTER the parameter list closes.
  // Walking past the whole `( ... )` first is what stops an object-typed
  // parameter (`growthStepFor(args: { ... })`) from being mistaken for the
  // body. Return-type annotations between `)` and `{` in this codebase are
  // always brace-free scalars (`): number {`), so "next `{` after the
  // matching `)`" is unambiguous here.
  let i = moduleSource.indexOf(functionName, start) + functionName.length;
  // 1. Advance to the parameter list's opening `(`.
  for (; i < moduleSource.length; i++) {
    const skipped = skipCommentOrString(moduleSource, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (moduleSource[i] === '(') break;
  }
  if (i >= moduleSource.length) {
    throw new Error(`extractFunctionSource: no parameter list for "${functionName}"`);
  }
  // 2. Walk to the matching `)`.
  let parenDepth = 0;
  for (; i < moduleSource.length; i++) {
    const skipped = skipCommentOrString(moduleSource, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = moduleSource[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        i++;
        break;
      }
    }
  }
  // 3. Next `{` is the body.
  let bodyOpen = -1;
  for (; i < moduleSource.length; i++) {
    const skipped = skipCommentOrString(moduleSource, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (moduleSource[i] === '{') {
      bodyOpen = i;
      break;
    }
  }
  if (bodyOpen === -1) {
    throw new Error(`extractFunctionSource: no body opening brace for "${functionName}"`);
  }

  let depth = 0;
  for (i = bodyOpen; i < moduleSource.length; i++) {
    const skipped = skipCommentOrString(moduleSource, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = moduleSource[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return moduleSource.slice(start, i + 1);
    }
  }
  throw new Error(`extractFunctionSource: unbalanced braces in "${functionName}"`);
}

/**
 * If `src[i]` begins a line comment, block comment, or single/double/back
 * quoted string, returns the index just past that construct's end;
 * otherwise returns `i` unchanged. Template-literal `${ }` expressions are
 * walked as normal code (their own braces balance), so a template holding
 * unbalanced literal braces is a known non-goal — the functions this panel
 * targets are pure math with none.
 */
function skipCommentOrString(src: string, i: number): number {
  const two = src.slice(i, i + 2);
  if (two === '//') {
    const nl = src.indexOf('\n', i + 2);
    return nl === -1 ? src.length : nl;
  }
  if (two === '/*') {
    const end = src.indexOf('*/', i + 2);
    return end === -1 ? src.length : end + 2;
  }
  const q = src[i];
  if (q === '"' || q === "'" || q === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') {
        j++;
        continue;
      }
      if (src[j] === q) return j + 1;
      if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
        // Walk the interpolation with its own brace counter, then resume
        // scanning the template string after the matching `}`.
        let depth = 1;
        let k = j + 2;
        for (; k < src.length && depth > 0; k++) {
          const skipped = skipCommentOrString(src, k);
          if (skipped !== k) {
            k = skipped - 1;
            continue;
          }
          if (src[k] === '{') depth++;
          else if (src[k] === '}') depth--;
        }
        j = k - 1;
      }
    }
    return src.length;
  }
  return i;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
