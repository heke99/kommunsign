from pathlib import Path
p = Path('scripts/apply-full-product-remediation.py')
s = p.read_text()
old_auth = r"\(\.\.\.\(cause instanceof Error\)"
new_auth = r"\(\(cause instanceof Error\)"
if old_auth in s:
    s = s.replace(old_auth, new_auth, 1)
needle = """          archiveCompleted: row.archive_completed,\n        };\n      });\n    },\n'''\n"""
replacement = """          archiveCompleted: row.archive_completed,\n        };\n      });\n    },\n    async list(context, page)\n'''\n"""
if needle not in s:
    raise SystemExit('get replacement tail not found')
s = s.replace(needle, replacement, 1)
p.write_text(s)
print('REMEDIATION_SCRIPT_V3_REPAIRED')
