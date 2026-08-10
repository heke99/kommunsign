from pathlib import Path
p = Path('scripts/apply-full-product-remediation.py')
s = p.read_text()
s = s.replace("r'interface CaseRow\\s*\\{.*?\\n\\}'", "r'interface CaseRow\\s*\\{.*?\\}'", 1)
s = s.replace(r"\(\.\.\.\(cause instanceof Error\)", r"\(\(cause instanceof Error\)", 1)
s = s.replace("        };\n      });\n    },\n'''\ns, n = re.subn(get_pattern, get_replacement, s, count=1, flags=re.S)", "        };\n      });\n    },\n    async list(context, page)\n'''\ns, n = re.subn(get_pattern, get_replacement, s, count=1, flags=re.S)", 1)
p.write_text(s)
print('REMEDIATION_SCRIPT_V5_REPAIRED')
