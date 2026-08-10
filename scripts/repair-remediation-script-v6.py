from pathlib import Path
p = Path('scripts/apply-full-product-remediation.py')
s = p.read_text()
old_marker = "marker = re.search(r'interface CaseRow\\s*\\{.*?\\n\\}', s, re.S)\n    if not marker:\n        raise SystemExit('CaseRow interface not found')\n    detail = '''\\ninterface CaseDetailRow extends CaseRow {"
new_marker = "marker = re.search(r'const caseSelect =', s)\n    if not marker:\n        raise SystemExit('caseSelect marker not found')\n    detail = '''\\ninterface CaseDetailRow extends CaseRow {"
if old_marker in s:
    s = s.replace(old_marker, new_marker, 1)
else:
    # If a prior repair already changed the marker, do not fail.
    pass
s = s.replace(r"\(\.\.\.\(cause instanceof Error\)", r"\(\(cause instanceof Error\)", 1)
s = s.replace("        };\n      });\n    },\n'''\ns, n = re.subn(get_pattern, get_replacement, s, count=1, flags=re.S)", "        };\n      });\n    },\n    async list(context, page)\n'''\ns, n = re.subn(get_pattern, get_replacement, s, count=1, flags=re.S)", 1)
p.write_text(s)
print('REMEDIATION_SCRIPT_V6_REPAIRED')
