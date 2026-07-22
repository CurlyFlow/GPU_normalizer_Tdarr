#!/usr/bin/env python3
from __future__ import annotations

import ast
import os
from pathlib import Path
import sys


MAX_LINES = int(os.environ.get('SOURCE_QUALITY_MAX_LINES', '1000'))
MAX_COMPLEXITY = int(os.environ.get('SOURCE_QUALITY_MAX_COMPLEXITY', '50'))
TEXT_SUFFIXES = {'.c', '.cu', '.cuh', '.js', '.py', '.sh'}


def python_complexity(node: ast.AST) -> int:
    score = 1
    pending = list(ast.iter_child_nodes(node))
    while pending:
        child = pending.pop()
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue
        if isinstance(child, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.IfExp, ast.Assert)):
            score += 1
        elif isinstance(child, ast.BoolOp):
            score += max(0, len(child.values) - 1)
        elif isinstance(child, ast.Try):
            score += len(child.handlers) + bool(child.orelse) + bool(child.finalbody)
        elif isinstance(child, ast.Match):
            score += len(child.cases)
        elif isinstance(child, ast.comprehension):
            score += 1 + len(child.ifs)
        pending.extend(ast.iter_child_nodes(child))
    return score


def python_module_name(root: Path, path: Path) -> str:
    relative = path.relative_to(root).with_suffix('')
    parts = list(relative.parts)
    if parts[-1] == '__init__':
        parts.pop()
    return '.'.join(parts)


def local_imports(tree: ast.AST) -> set[str]:
    imports = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imports.add(node.module)
    return imports


def check_root(root: Path) -> list[str]:
    findings = []
    python_trees = {}
    for path in sorted(item for item in root.rglob('*') if item.is_file() and item.suffix in TEXT_SUFFIXES):
        try:
            text = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            continue
        lines = text.count('\n') + bool(text)
        if lines > MAX_LINES:
            findings.append(f'{path}: {lines} lines exceeds {MAX_LINES}')
        if path.suffix != '.py':
            continue
        try:
            tree = ast.parse(text, filename=str(path))
        except SyntaxError as exc:
            findings.append(f'{path}:{exc.lineno}: Python syntax error: {exc.msg}')
            continue
        python_trees[path] = tree
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                complexity = python_complexity(node)
                if complexity > MAX_COMPLEXITY:
                    findings.append(f'{path}:{node.lineno}: {node.name} complexity {complexity} exceeds {MAX_COMPLEXITY}')

    modules = {python_module_name(root, path): path for path in python_trees}
    graph = {
        module: {name for name in local_imports(python_trees[path]) if name in modules}
        for module, path in modules.items()
    }
    visiting = []
    visited = set()

    def visit(module: str):
        if module in visiting:
            cycle = visiting[visiting.index(module):] + [module]
            findings.append(f'{root}: Python import cycle: {" -> ".join(cycle)}')
            return
        if module in visited:
            return
        visiting.append(module)
        for dependency in sorted(graph[module]):
            visit(dependency)
        visiting.pop()
        visited.add(module)

    for module in sorted(graph):
        visit(module)
    return findings


def main() -> int:
    roots = [Path(arg) for arg in sys.argv[1:] if Path(arg).is_dir()]
    if not roots:
        print('source-quality: no source roots', file=sys.stderr)
        return 1
    findings = []
    for root in roots:
        findings.extend(check_root(root))
    if findings:
        print('source-quality failed:\n' + '\n'.join(f'- {finding}' for finding in findings), file=sys.stderr)
        return 1
    print(f'source-quality passed: roots={len(roots)} max_lines={MAX_LINES} max_python_complexity={MAX_COMPLEXITY}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
