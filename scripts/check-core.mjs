import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const coreRoot = resolve(root, 'src/core');
const manifest = JSON.parse(readFileSync(resolve(root, 'docs/upstream-core.json'), 'utf8'));
for (const file of manifest.files) {
  const hash = createHash('sha256').update(readFileSync(resolve(root, file.target))).digest('hex');
  if (hash !== file.targetSha256 || hash !== file.sourceSha256 && !(typeof file.localModification === 'string' && file.localModification.trim())) throw new Error(`Core source differs from its recorded extraction or documented local extension: ${file.target}`);
}
const files = readdirSync(coreRoot).filter(name => name.endsWith('.ts'));
for (const name of files) {
  const file = resolve(coreRoot, name);
  if (!manifest.files.some(entry => resolve(root, entry.target) === file)) throw new Error(`Untracked core source: ${name}`);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function check(specifier) {
    if (specifier === 'node:crypto') return;
    const target = resolve(dirname(file), specifier);
    if (!specifier.startsWith('./') || relative(coreRoot, target).startsWith(`..${sep}`) || !files.includes(relative(coreRoot, target))) {
      throw new Error(`Core dependency escaped its boundary: ${name} -> ${specifier}`);
    }
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) check(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
      throw new Error(`Dynamic dependency is not allowed in extracted core: ${name}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
console.log(`Verified ${manifest.files.length} recorded hashes (${manifest.files.filter(file => file.localModification).length} documented local extensions); ${files.length} core files depend only on core and node:crypto.`);
