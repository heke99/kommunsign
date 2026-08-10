from pathlib import Path
p = Path('scripts/apply-full-product-remediation.py')
s = p.read_text()
# Correct the auth matcher if the original typo remains.
s = s.replace(r"\(\.\.\.\(cause instanceof Error\)", r"\(\(cause instanceof Error\)", 1)
# Correct the get replacement so the original list method is preserved.
old = "        };\n      });\n    },\n'''\ns, n = re.subn(get_pattern, get_replacement, s, count=1, flags=re.S)"
new = "        };\n      });\n    },\n    async list(context, page)\n'''\ns, n = re.subn(get_pattern, get_replacement, s, count=1, flags=re.S)"
if old in s:
    s = s.replace(old, new, 1)
p.write_text(s)
print('REMEDIATION_SCRIPT_V4_REPAIRED')
