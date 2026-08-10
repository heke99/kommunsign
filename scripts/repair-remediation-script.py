from pathlib import Path
p = Path('scripts/apply-full-product-remediation.py')
s = p.read_text()
old = r"\(\.\.\.\(cause instanceof Error\)"
new = r"\(\(cause instanceof Error\)"
if old not in s:
    raise SystemExit('expected remediation matcher typo not found')
p.write_text(s.replace(old, new, 1))
print('REMEDIATION_SCRIPT_REPAIRED')
