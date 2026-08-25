// LeetCode-style auto-driver injector.
//
// The question bank stores test cases as { input, expectedOutput } string
// blobs — no functionSignature schema exists (see [memory: bank probe]).
// So the judge has to figure out at run time whether the student's code:
//   (a) already reads stdin itself (stdio-style, run as-is), or
//   (b) is just a bare function definition (LeetCode-style; inject a driver
//       that reads stdin, calls the function, prints the return value).
//
// The detect() heuristic is intentionally forgiving: any hint of interactive
// I/O in the source drops us into stdio mode. That means a student who wants
// to write a full program never gets a driver appended behind their back, and
// the auto-driver only fires when the student clearly wrote a bare function.
//
// Function name discovery:
//   • Explicit "solutions.functionName" on the question wins (rare — the live
//     bank has it null everywhere, but new questions may set it).
//   • Otherwise: the LAST top-level function/method definition in the file
//     (LeetCode convention: helpers above, main solution last).
//
// Type inference:
//   • Python/JS/TS use runtime dispatch (JSON.parse per token), so no
//     signature parsing is needed.
//   • Java/C++/C/C#/Go need a typed driver. We parse the parameter list off
//     the signature (regex, primitive types only — int, long, double,
//     boolean, char, String and their common aliases) and emit the matching
//     Scanner/cin/scanf/Console/fmt.Scan calls. Complex types (arrays,
//     generics, custom classes) fall through to stdio mode with a clear
//     "type not supported" reason.

// ─── Stdin markers per language (student wrote a full program) ────────────
const STDIO_MARKERS = {
  python:     [/\binput\s*\(/, /\bsys\.stdin\b/, /\bopen\s*\(/, /\braw_input\s*\(/],
  javascript: [/\bprocess\.stdin\b/, /\breadline\s*\(/, /\brequire\s*\(\s*['"]readline['"]/, /\bfs\.readFileSync\s*\(\s*0/, /\bfs\.readFileSync\s*\(\s*['"]\/dev\/stdin/],
  typescript: [/\bprocess\.stdin\b/, /\breadline\s*\(/, /\brequire\s*\(\s*['"]readline['"]/, /\bfs\.readFileSync\s*\(\s*0/],
  java:       [/\bnew\s+Scanner\b/, /\bBufferedReader\b/, /\bSystem\.in\b/, /\bpublic\s+static\s+void\s+main\s*\(/],
  cpp:        [/\bstd::cin\b/, /\bcin\s*>>/, /\bgetline\s*\(\s*std::cin/, /\bgetline\s*\(\s*cin/, /\bscanf\s*\(/, /\bint\s+main\s*\(/],
  c:          [/\bscanf\s*\(/, /\bgetchar\s*\(/, /\bfgets\s*\(/, /\bgets\s*\(/, /\bint\s+main\s*\(/],
  csharp:     [/\bConsole\.Read/, /\bstatic\s+void\s+Main\s*\(/],
  go:         [/\bfmt\.Scan/, /\bbufio\.NewReader\b/, /\bfunc\s+main\s*\(/],
};

function looksLikeStdio(language, code) {
  const markers = STDIO_MARKERS[language] || [];
  return markers.some((rx) => rx.test(code));
}

// Escape a string so it can be spliced into a RegExp literal safely.
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Function locator per language (returns { name, paramsStr, returnType }) ─
// Returns null when nothing parseable is found. Each locator picks the LAST
// top-level function/method so helpers above the solution are ignored.

function last(rx, code) {
  let m, last = null;
  while ((m = rx.exec(code)) !== null) last = m;
  return last;
}

function findSigPython(code) {
  const m = last(/^[ \t]*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gm, code);
  if (!m) return null;
  return { name: m[1], paramsStr: m[2].trim(), returnType: null };
}

function findSigJS(code) {
  // function name(...) OR const name = (...) => OR const name = function(...)
  const m = last(/(?:^|\n)\s*(?:function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>))/g, code);
  if (!m) return null;
  const name = m[1] || m[3];
  const paramsStr = m[2] || m[4] || m[5] || m[6] || '';
  return { name, paramsStr: paramsStr.trim(), returnType: null };
}

// Java: `public static <ret> name(<params>)` OR `<ret> name(<params>)` at
// class-body indentation. Skip anything named "main".
function findSigJava(code) {
  const rx = /(?:public|private|protected)?\s*(?:static\s+)?([A-Za-z_][\w<>\[\]]*(?:\s*\[\s*\])*)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:throws\s+[^{]+)?\s*\{/g;
  let m, best = null;
  while ((m = rx.exec(code)) !== null) {
    if (m[2] === 'main') continue;
    best = m;
  }
  if (!best) return null;
  return { name: best[2], paramsStr: best[3].trim(), returnType: best[1].trim() };
}

// C / C++: `<ret> name(<params>) {`. Skip main.
function findSigC(code) {
  const rx = /(?:^|\n)\s*([A-Za-z_][\w:<>\s\*&]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g;
  let m, best = null;
  while ((m = rx.exec(code)) !== null) {
    if (m[2] === 'main') continue;
    // Skip `if (...)` / `while (...)` etc — the first capture group would be
    // the keyword and there'd be no return type.
    if (/^(if|while|for|switch|return|else|do)\s*$/.test(m[1].trim())) continue;
    best = m;
  }
  if (!best) return null;
  return { name: best[2], paramsStr: best[3].trim(), returnType: best[1].trim() };
}

// C#: `public static <ret> Name(<params>)` inside a class.
function findSigCSharp(code) {
  const rx = /(?:public|private|internal|protected)?\s*(?:static\s+)?([A-Za-z_][\w<>\[\]]*(?:\s*\[\s*\])*)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g;
  let m, best = null;
  while ((m = rx.exec(code)) !== null) {
    if (m[2] === 'Main' || m[2] === 'main') continue;
    best = m;
  }
  if (!best) return null;
  return { name: best[2], paramsStr: best[3].trim(), returnType: best[1].trim() };
}

// Go: `func Name(<params>) <ret> {`.
function findSigGo(code) {
  const rx = /^\s*func\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:\(([^)]*)\)|([A-Za-z_][\w\[\]]*))?\s*\{/gm;
  let m, best = null;
  while ((m = rx.exec(code)) !== null) {
    if (m[1] === 'main') continue;
    best = m;
  }
  if (!best) return null;
  const rt = (best[3] || best[4] || '').trim();
  return { name: best[1], paramsStr: best[2].trim(), returnType: rt };
}

// ─── Parameter-type parsing (typed languages only) ────────────────────────
// Split a paramsStr like "int a, boolean b" into [{type,name}, ...].
// Handles common primitives + String/string; anything unrecognised returns
// null so the caller can bail to stdio mode with a "type not supported" note.
const PRIM_ALIASES = {
  // Java + C# + C++
  'int': 'int', 'long': 'long', 'short': 'int', 'byte': 'int',
  'double': 'double', 'float': 'double',
  'boolean': 'bool', 'bool': 'bool',
  'char': 'char',
  'String': 'string', 'string': 'string',
  // C
  'int32_t': 'int', 'int64_t': 'long', 'unsigned': 'int',
  // Go
  'int64': 'long', 'float64': 'double', 'string': 'string',
};

function parseParams(paramsStr, langFlavor) {
  if (!paramsStr || !paramsStr.trim()) return [];
  const raw = paramsStr.split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of raw) {
    // Go: "n int"  (name first, type second)
    // Others: "int n"
    let type, name;
    if (langFlavor === 'go') {
      const parts = p.split(/\s+/);
      if (parts.length < 2) return null;
      name = parts[0]; type = parts.slice(1).join(' ');
    } else {
      // strip modifiers (final/const/&/*)
      const parts = p.replace(/[&*]/g, ' ').split(/\s+/).filter(Boolean);
      if (parts.length < 2) return null;
      name = parts[parts.length - 1];
      type = parts.slice(0, -1).join(' ')
        .replace(/^(final|const)\s+/, '')
        .trim();
    }
    const norm = PRIM_ALIASES[type];
    if (!norm) return null;
    out.push({ type: norm, name });
  }
  return out;
}

// ─── Drivers ──────────────────────────────────────────────────────────────
// Every driver reads whitespace-separated tokens from stdin (matches how the
// live bank stores multi-arg inputs like "1 5") and prints the return value
// normalised (True→true, arrays→JSON) so compare.js matches.

const PY_DRIVER = (fn) => `
# ── auto-driver (server-injected) ──
import sys, json
_tok = sys.stdin.read().split()
def _p(t):
    try: return json.loads(t)
    except Exception: return t
_res = ${fn}(*[_p(t) for t in _tok])
if _res is True: print("true")
elif _res is False: print("false")
elif isinstance(_res, (list, dict)): print(json.dumps(_res))
elif _res is None: print("null")
else: print(_res)
`;

const JS_DRIVER = (fn) => `
// ── auto-driver (server-injected) ──
const _data = require('fs').readFileSync(0, 'utf8').split(/\\s+/).filter(Boolean);
const _parse = (t) => { try { return JSON.parse(t); } catch (_) { return t; } };
const _res = ${fn}(..._data.map(_parse));
const _out =
  _res === true ? 'true' :
  _res === false ? 'false' :
  _res === null || _res === undefined ? 'null' :
  (typeof _res === 'object') ? JSON.stringify(_res) : String(_res);
console.log(_out);
`;

// Java: emit a main() that Scans typed args and prints the return value.
// If the student's class is `class X { ... }`, we inject main() as a sibling
// method by pattern-matching the last `}` of the class body. To keep things
// simple, we require the top-level class to be named Main (which is Piston's
// convention and the codeJudge.pistonFilename() rewrite of the file).
const JAVA_READERS = {
  int:    (n) => `int ${n} = sc.hasNextInt() ? sc.nextInt() : Integer.parseInt(sc.next());`,
  long:   (n) => `long ${n} = sc.hasNextLong() ? sc.nextLong() : Long.parseLong(sc.next());`,
  double: (n) => `double ${n} = sc.hasNextDouble() ? sc.nextDouble() : Double.parseDouble(sc.next());`,
  bool:   (n) => `boolean ${n} = Boolean.parseBoolean(sc.next());`,
  char:   (n) => `char ${n} = sc.next().charAt(0);`,
  string: (n) => `String ${n} = sc.next();`,
};

function javaDriver(fn, params) {
  const decls = params.map((p) => '    ' + JAVA_READERS[p.type](p.name)).join('\n');
  const args = params.map((p) => p.name).join(', ');
  const call = `${fn}(${args})`;
  return `
  // ── auto-driver (server-injected) ──
  public static void main(String[] _args) throws Exception {
    java.util.Scanner sc = new java.util.Scanner(System.in);
${decls}
    Object _res = ${call};
    if (_res instanceof Boolean)      System.out.println(((Boolean)_res) ? "true" : "false");
    else if (_res == null)            System.out.println("null");
    else if (_res.getClass().isArray()) System.out.println(java.util.Arrays.deepToString((Object[])
                                          (_res instanceof Object[] ? (Object[])_res : new Object[]{_res})));
    else                              System.out.println(_res);
  }
`;
}

// Inject the driver as a sibling method inside the student's class body.
// Falls back to appending a new Main class if the student didn't wrap their
// method in a class (rare).
function injectJava(src, driverBody) {
  const classRx = /class\s+Main\b[^{]*\{/;
  if (classRx.test(src)) {
    // Insert driver just before the last `}` — that's the class-body closer
    // in the common case (single top-level class).
    const lastBrace = src.lastIndexOf('}');
    if (lastBrace > -1) {
      return src.slice(0, lastBrace) + '\n' + driverBody + '\n' + src.slice(lastBrace);
    }
  }
  // No `class Main` — wrap the whole thing.
  return `public class Main {\n${src}\n${driverBody}\n}`;
}

const CPP_READERS = {
  int:    (n) => `int ${n}; std::cin >> ${n};`,
  long:   (n) => `long ${n}; std::cin >> ${n};`,
  double: (n) => `double ${n}; std::cin >> ${n};`,
  bool:   (n) => `std::string ${n}_s; std::cin >> ${n}_s; bool ${n} = (${n}_s == "true" || ${n}_s == "1");`,
  char:   (n) => `char ${n}; std::cin >> ${n};`,
  string: (n) => `std::string ${n}; std::cin >> ${n};`,
};

function cppDriver(fn, params, returnType) {
  const decls = params.map((p) => '  ' + CPP_READERS[p.type](p.name)).join('\n');
  const args = params.map((p) => p.name).join(', ');
  const isBoolRet = /^bool$/.test(returnType || '');
  const isVoid = /^void$/.test(returnType || '');
  let printLine;
  if (isVoid)         printLine = `  ${fn}(${args}); std::cout << "";`;
  else if (isBoolRet) printLine = `  auto _res = ${fn}(${args}); std::cout << (_res ? "true" : "false");`;
  else                printLine = `  auto _res = ${fn}(${args}); std::cout << _res;`;
  return `

// ── auto-driver (server-injected) ──
#include <iostream>
#include <string>
int main() {
  std::ios_base::sync_with_stdio(false);
${decls}
${printLine}
  return 0;
}
`;
}

const C_READERS = {
  int:    (n) => `int ${n}; scanf("%d", &${n});`,
  long:   (n) => `long ${n}; scanf("%ld", &${n});`,
  double: (n) => `double ${n}; scanf("%lf", &${n});`,
  bool:   (n) => `char ${n}_s[16]; scanf("%15s", ${n}_s); int ${n} = (strcmp(${n}_s, "true") == 0 || strcmp(${n}_s, "1") == 0);`,
  char:   (n) => `char ${n}; scanf(" %c", &${n});`,
  string: (n) => `char ${n}[1024]; scanf("%1023s", ${n});`,
};
const C_PRINTF = {
  int: '%d\\n', long: '%ld\\n', double: '%g\\n', char: '%c\\n', string: '%s\\n',
};

function cDriver(fn, params, returnType) {
  const rt = (returnType || 'int').replace(/\s+/g, ' ');
  const rtNorm = PRIM_ALIASES[rt] || 'int';
  const decls = params.map((p) => '  ' + C_READERS[p.type](p.name)).join('\n');
  const args = params.map((p) => p.name).join(', ');
  let printLine;
  if (rt === 'void')       printLine = `  ${fn}(${args});`;
  else if (rtNorm === 'bool') printLine = `  int _res = ${fn}(${args}); printf("%s\\n", _res ? "true" : "false");`;
  else                     printLine = `  ${rt} _res = ${fn}(${args}); printf("${C_PRINTF[rtNorm]}", _res);`;
  return `

/* ── auto-driver (server-injected) ── */
#include <stdio.h>
#include <string.h>
int main(void) {
${decls}
${printLine}
  return 0;
}
`;
}

const CS_READERS = {
  int:    (n) => `int ${n} = int.Parse(_tk[_ix++]);`,
  long:   (n) => `long ${n} = long.Parse(_tk[_ix++]);`,
  double: (n) => `double ${n} = double.Parse(_tk[_ix++]);`,
  bool:   (n) => `bool ${n} = _tk[_ix++].ToLower() == "true";`,
  char:   (n) => `char ${n} = _tk[_ix++][0];`,
  string: (n) => `string ${n} = _tk[_ix++];`,
};

function csharpDriver(fn, params, returnType) {
  const decls = params.map((p) => '    ' + CS_READERS[p.type](p.name)).join('\n');
  const args = params.map((p) => p.name).join(', ');
  const isBoolRet = /^bool$/.test(returnType || '');
  const isVoid = /^void$/.test(returnType || '');
  let printLine;
  if (isVoid)         printLine = `    ${fn}(${args}); Console.Write("");`;
  else if (isBoolRet) printLine = `    var _res = ${fn}(${args}); Console.WriteLine(_res ? "true" : "false");`;
  else                printLine = `    var _res = ${fn}(${args}); Console.WriteLine(_res);`;
  return `
  // ── auto-driver (server-injected) ──
  public static void Main(string[] _args) {
    var _tk = System.Console.In.ReadToEnd().Split(new[]{' ','\\t','\\r','\\n'}, System.StringSplitOptions.RemoveEmptyEntries);
    int _ix = 0;
${decls}
${printLine}
  }
`;
}

function injectCSharp(src, driverBody) {
  // Piston's C# uses top-level `class` files. Inject into last `}` if any
  // class body exists, else wrap.
  const classRx = /class\s+[A-Z]\w*/;
  if (classRx.test(src)) {
    const lastBrace = src.lastIndexOf('}');
    if (lastBrace > -1) {
      return src.slice(0, lastBrace) + '\n' + driverBody + '\n' + src.slice(lastBrace);
    }
  }
  return `using System;\npublic class Solution {\n${src}\n${driverBody}\n}`;
}

const GO_READERS = {
  int:    (n) => `var ${n} int; fmt.Fscan(_r, &${n})`,
  long:   (n) => `var ${n} int64; fmt.Fscan(_r, &${n})`,
  double: (n) => `var ${n} float64; fmt.Fscan(_r, &${n})`,
  bool:   (n) => `var ${n}_s string; fmt.Fscan(_r, &${n}_s); ${n} := ${n}_s == "true" || ${n}_s == "1"`,
  char:   (n) => `var ${n}_s string; fmt.Fscan(_r, &${n}_s); ${n} := rune(${n}_s[0])`,
  string: (n) => `var ${n} string; fmt.Fscan(_r, &${n})`,
};

function goDriver(fn, params, returnType) {
  const decls = params.map((p) => '\t' + GO_READERS[p.type](p.name)).join('\n');
  const args = params.map((p) => p.name).join(', ');
  const isBoolRet = /^bool$/.test(returnType || '');
  const isVoid = returnType === '' || returnType == null;
  let printLine;
  if (isVoid)         printLine = `\t${fn}(${args})`;
  else if (isBoolRet) printLine = `\t_res := ${fn}(${args})\n\tif _res { fmt.Println("true") } else { fmt.Println("false") }`;
  else                printLine = `\t_res := ${fn}(${args})\n\tfmt.Println(_res)`;
  return `

// ── auto-driver (server-injected) ──
func main() {
\t_r := bufio.NewReader(os.Stdin)
${decls}
${printLine}
}
`;
}

function injectGo(src, driverBody) {
  // Ensure `package main` + necessary imports. Prepend if missing.
  let out = src;
  if (!/^\s*package\s+main\b/m.test(out)) out = 'package main\n' + out;
  if (!/^\s*import\s+/m.test(out)) {
    out = out.replace(/^\s*package\s+main\b[^\n]*\n/, (m) => m + 'import (\n\t"bufio"\n\t"fmt"\n\t"os"\n)\n');
  } else {
    // Best-effort: append missing imports individually.
    for (const pkg of ['bufio', 'fmt', 'os']) {
      if (!new RegExp(`"${pkg}"`).test(out)) {
        out = out.replace(/import\s+\(\s*/, (m) => m + `"${pkg}"\n\t`);
      }
    }
  }
  return out + driverBody;
}

// ─── decide() — the entry point codeJudge calls per submission ────────────
/**
 * @param {object} p
 * @param {string} p.language
 * @param {string} p.code
 * @param {string} [p.functionName]
 * @returns {{ mode: 'stdio'|'function', fullCode: string, injected: boolean, fnName: string|null, reason: string }}
 */
function decide({ language, code, functionName }) {
  const lang = (language || '').toLowerCase();
  const src = String(code || '');

  if (looksLikeStdio(lang, src)) {
    return {
      mode: 'stdio', fullCode: src, injected: false, fnName: null,
      reason: 'stdin marker (or main entry) detected — running as-is',
    };
  }

  // Untyped languages: use runtime dispatch, no signature parsing needed.
  if (lang === 'python' || lang === 'javascript' || lang === 'typescript') {
    const sig = (lang === 'python') ? findSigPython(src) : findSigJS(src);
    // Prefer the trainer's declared functionName BUT only when that function
    // is actually defined in the student's code — a stale field like "main"
    // left on the question would otherwise inject `main(...)` and blow up
    // with NameError when the student wrote `isEven`. If the declared name
    // isn't visible in the source, fall back to the last-defined function.
    const declared = functionName && functionName.trim();
    const declaredExists = declared && new RegExp(
      lang === 'python'
        ? `^\\s*def\\s+${escapeRe(declared)}\\s*\\(`
        : `\\b(?:function\\s+${escapeRe(declared)}\\b|(?:const|let|var)\\s+${escapeRe(declared)}\\s*=)`,
      'm',
    ).test(src);
    const fn = declaredExists ? declared : sig?.name;
    if (!fn) {
      return {
        mode: 'stdio', fullCode: src, injected: false, fnName: null,
        reason: declared
          ? `question expects function "${declared}" but no function is defined in the code`
          : 'no function definition found to auto-drive',
      };
    }
    const driver = (lang === 'python') ? PY_DRIVER(fn) : JS_DRIVER(fn);
    return {
      mode: 'function', fullCode: src + '\n' + driver, injected: true, fnName: fn,
      reason: declared && !declaredExists
        ? `auto-driver injected for ${fn} (question declared "${declared}" but student wrote "${fn}")`
        : `auto-driver injected for ${lang} function ${fn}`,
    };
  }

  // Typed languages: parse signature → primitive types only.
  let sig;
  if (lang === 'java')        sig = findSigJava(src);
  else if (lang === 'cpp')    sig = findSigC(src);
  else if (lang === 'c')      sig = findSigC(src);
  else if (lang === 'csharp') sig = findSigCSharp(src);
  else if (lang === 'go')     sig = findSigGo(src);
  else {
    return {
      mode: 'stdio', fullCode: src, injected: false, fnName: null,
      reason: `language "${lang}" is not supported by the auto-driver`,
    };
  }
  if (!sig) {
    return {
      mode: 'stdio', fullCode: src, injected: false, fnName: null,
      reason: 'could not parse a function/method signature',
    };
  }
  const params = parseParams(sig.paramsStr, lang === 'go' ? 'go' : 'other');
  if (params === null) {
    return {
      mode: 'stdio', fullCode: src, injected: false, fnName: null,
      reason: `unsupported parameter type in signature "${sig.paramsStr}" — primitives only`,
    };
  }

  // Same declared-name validation as the untyped branch — a stale
  // functionName on the question shouldn't silently take precedence over
  // what the student actually defined.
  const declaredT = functionName && functionName.trim();
  const declaredExistsT = declaredT && new RegExp(`\\b${escapeRe(declaredT)}\\s*\\(`, 'm').test(src);
  const fn = declaredExistsT ? declaredT : sig.name;
  let fullCode;
  if (lang === 'java')        fullCode = injectJava(src,        javaDriver(fn, params));
  else if (lang === 'cpp')    fullCode = src + cppDriver(fn, params, sig.returnType);
  else if (lang === 'c')      fullCode = src + cDriver(fn, params, sig.returnType);
  else if (lang === 'csharp') fullCode = injectCSharp(src,      csharpDriver(fn, params, sig.returnType));
  else if (lang === 'go')     fullCode = injectGo(src,          goDriver(fn, params, sig.returnType));

  return {
    mode: 'function', fullCode, injected: true, fnName: fn,
    reason: `auto-driver injected for ${lang} function ${fn} (${params.length} typed arg${params.length === 1 ? '' : 's'})`,
  };
}

module.exports = {
  decide,
  looksLikeStdio,
  // exported for tests / debugging
  findSigPython, findSigJS, findSigJava, findSigC, findSigCSharp, findSigGo,
  parseParams,
};
