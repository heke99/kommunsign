from pathlib import Path
p = Path('scripts/apply-full-product-remediation.py')
s = p.read_text()
old_auth = r"\(\.\.\.\(cause instanceof Error\)"
new_auth = r"\(\(cause instanceof Error\)"
if old_auth in s:
    s = s.replace(old_auth, new_auth, 1)
old_get_tail = """          archiveCompleted: row.archive_completed,\n        };\n      });\n    },\n'''\ns, n = re.subn(get_pattern, get_replacement, s, count=1, flags=re.S)"""
# The main script's get replacement accidentally consumes the list method. Add it to the replacement string definition.
needle = """          archiveCompleted: row.archive_completed,\n        };\n      });\n    },\n'''\n"""
replacement = """          archiveCompleted: row.archive_completed,\n        };\n      });\n    },\n    async list(context, page)\n'''\n"""
if needle not in s:
    raise SystemExit('get replacement tail not found')
s = s.replace(needle, replacement, 1)
p.write_text(s)
print('REMEDIATION_SCRIPT_V2_REPAIRED')
